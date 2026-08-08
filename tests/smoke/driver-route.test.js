// ============================================================================
// driver-route.test.js — end-to-end smoke coverage for the three delivery
// routing/batching routes (spec: docs/superpowers/specs/2026-08-08-delivery-
// routing-design.md §9), run against a REAL spawned server
// (tests/helpers/harness.js) and a REAL temp SQLite DB.
//
// tests/unit/routing.test.js already covers the ALGORITHM (haversine,
// complete-linkage clustering, optimal stop ordering, the score formula).
// This file covers the WIRING: batch membership is read from a seeded
// `delivery_batches` record (not recomputed here — see routing.js's header,
// note 2: batching is persisted, ranking is per-driver), the claim-batch
// route's all-or-nothing guarantee, split, and the DELETE-dissolves-batch
// path (spec §8.3.1).
//
// Fixtures are seeded directly into the temp DB (harness.seedRecord),
// bypassing the geocoder entirely — GEOCODE_DISABLED=1 is forced by the
// harness, so every order below carries its `geo`/`geoStatus` pre-set, the
// same shape scheduleGeocode() would have written.
//
// ONE shared server for the whole file, and the fixtures below are
// DELIBERATELY CUMULATIVE within the first describe block (cases 1-4 each
// add one more order to the same batch/route response, mirroring how a
// real shift would accrue orders) and use a fresh disjoint batch per case
// in the second describe block (cases 5-9, each of which mutates state and
// must not interfere with the others). Order of the `test()` calls within
// each describe block therefore matters and must not be reshuffled.
//
// Geo math: same north()/east() helpers as tests/unit/routing.test.js —
// ~111.32 km per degree of latitude, longitude scaled by cos(lat) — so an
// order built with east(RESTAURANT, 300) is genuinely ~300 m from
// RESTAURANT and the distances asserted below are checkable by hand.
// ============================================================================

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert");
const bcrypt = require("bcryptjs");

const harness = require("../helpers/harness");

const COL = harness.COL;

// The driver's reported GPS position IS the routing origin for these tests
// (POST /driver/route body {lat, lon}) — using the same point as the
// "restaurant" reference frame keeps the distance arithmetic simple and
// keeps every test independent of settings.business.address / geocoding.
const RESTAURANT = { lat: 50.4600, lon: 13.4100 };

function north(base, metres) {
    return { lat: base.lat + metres / 111320, lon: base.lon };
}
function east(base, metres) {
    return { lat: base.lat, lon: base.lon + metres / (111320 * Math.cos(base.lat * Math.PI / 180)) };
}

function geoOf(point) {
    return { lat: point.lat, lon: point.lon, quality: "building", provider: "nominatim", at: new Date().toISOString() };
}

// Mirrors the shape POST /orders actually writes (server.js's order record
// literal), including the geo/geoStatus/batchId fields this feature added.
function deliveryOrder(id, overrides = {}) {
    return {
        id,
        customerName: `Zákazník ${id}`,
        phone: "+420700000001",
        email: "",
        address: "Ulice 1",
        psc: "43001",
        note: "",
        items: [{ id: "dish1", name: "Svíčková", qty: 1, price: 150, vatRate: 21 }],
        itemsTotal: 150,
        deliveryFee: 0,
        total: 150,
        status: "pending",
        kitchenStatus: "pending",
        claimedBy: null,
        claimedByName: null,
        createdAt: new Date().toISOString(),
        claimedAt: null,
        geo: null,
        geoStatus: "pending",
        batchId: null,
        paymentMethod: "cash",
        paymentStatus: "unpaid",
        gatewayTransactionId: null,
        receiptId: null,
        ...overrides,
    };
}

function batchRecord(id, orderIds, overrides = {}) {
    return {
        id,
        createdAt: new Date().toISOString(),
        orderIds,
        status: "open",
        claimedBy: null,
        claimedAt: null,
        ...overrides,
    };
}

function seedOrder(dbPath, id, overrides = {}) {
    harness.seedRecord(dbPath, COL.orders, id, deliveryOrder(id, overrides));
}

function seedBatch(dbPath, id, orderIds, overrides = {}) {
    harness.seedRecord(dbPath, COL.deliveryBatches, id, batchRecord(id, orderIds, overrides));
}

// ── AUTH / CSRF PLUMBING ─────────────────────────────────────────────────
// Drivers are just user accounts with isDriver:true, authenticated via the
// same POST /users/login route admins use (see server.js's comment on
// POST /drivers/login). CSRF here is a double-submit cookie unrelated to
// the session (csrf.js) — GET /csrf-token hands back a cookie AND the same
// value in the body; both must ride together on every state-changing call.

function seedUser(dbPath, { id, abbreviation, password, name, isAdmin, isDriver }) {
    harness.seedRecord(dbPath, COL.users, id, {
        id, abbreviation, password: bcrypt.hashSync(password, 12), name, isAdmin, isDriver,
    });
}

async function postJson(url, body) {
    return fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
}

function extractSessionCookie(res) {
    // Same approach as tests/smoke/table-orders.test.js — Node's fetch
    // (undici) exposes multi-value Set-Cookie correctly via getSetCookie().
    if (typeof res.headers.getSetCookie === "function") {
        const all = res.headers.getSetCookie();
        if (all.length) return all[0].split(";")[0];
    }
    const raw = res.headers.get("set-cookie");
    return raw ? raw.split(";")[0] : null;
}

async function buildSession(h, { abbreviation, password }) {
    const loginRes = await postJson(`${h.api}/users/login`, { abbreviation, password });
    if (loginRes.status !== 200) {
        assert.fail(`login failed for ${abbreviation}: ${loginRes.status} ${await loginRes.text()}`);
    }
    const authCookie = extractSessionCookie(loginRes);
    assert.ok(authCookie, "login response did not set a session cookie");
    const user = await loginRes.json();

    const csrfRes = await fetch(`${h.api}/csrf-token`);
    assert.strictEqual(csrfRes.status, 200);
    const csrfCookie = extractSessionCookie(csrfRes);
    assert.ok(csrfCookie, "csrf-token response did not set a cookie");
    const { csrfToken } = await csrfRes.json();

    return {
        id: user.id,
        name: user.name,
        headers: {
            cookie: `${authCookie}; ${csrfCookie}`,
            "x-csrf-token": csrfToken,
        },
    };
}

async function postAuthed(url, session, body) {
    return fetch(url, {
        method: "POST",
        headers: { ...session.headers, "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
    });
}

async function deleteAuthed(url, session) {
    return fetch(url, { method: "DELETE", headers: session.headers });
}

async function fetchRoute(h, session, body) {
    return postAuthed(`${h.api}/driver/route`, session, body ?? { lat: RESTAURANT.lat, lon: RESTAURANT.lon });
}

// ============================================================================
// SUITE 1 — POST /driver/route: batching, ranking, unlocated tail, privacy
// ============================================================================

describe("driver route — batching, ranking, privacy", () => {
    let h;
    let driver;

    const OTHER_DRIVER_ID = "otherDriver001";
    const OTHER_ORDER_PHONE = "+420799999999";
    const OTHER_ORDER_NAME = "Cizí Zákazník";

    before(async () => {
        h = await harness.start();

        seedUser(h.dbPath, {
            id: "driver0001", abbreviation: "smoke-driver", password: "Driver!Pass123",
            name: "Smoke Driver", isAdmin: false, isDriver: true,
        });
        driver = await buildSession(h, { abbreviation: "smoke-driver", password: "Driver!Pass123" });

        // Case 1 fixture: two orders ~300 m apart, both kitchen-completed,
        // pre-batched via a seeded delivery_batches record. Batch membership
        // is never recomputed by planRoute — it only reads the record.
        seedOrder(h.dbPath, "orderA", { geo: geoOf(east(RESTAURANT, 0)), geoStatus: "ok", kitchenStatus: "completed", batchId: "b1" });
        seedOrder(h.dbPath, "orderB", { geo: geoOf(east(RESTAURANT, 300)), geoStatus: "ok", kitchenStatus: "completed", batchId: "b1" });
        seedBatch(h.dbPath, "b1", ["orderA", "orderB"]);
    });

    after(async () => {
        await h.stop();
    });

    // 1. Two orders 300 m apart, pre-batched -> ONE item, kind "batch", both
    //    stop ids, in optimal order (starting from the closer stop, orderA).
    test("a pre-batched pair of nearby orders comes back as one batch item", async () => {
        const res = await fetchRoute(h, driver);
        assert.strictEqual(res.status, 200);
        const body = await res.json();

        assert.strictEqual(body.enabled, true);
        assert.strictEqual(body.items.length, 1);
        assert.strictEqual(body.items[0].kind, "batch");
        assert.strictEqual(body.items[0].batchId, "b1");
        assert.deepStrictEqual(body.items[0].stopIds.slice().sort(), ["orderA", "orderB"]);
        assert.strictEqual(body.items[0].claimable, true, "both members are kitchen-completed");
    });

    // 2. A third order 5 km away -> a separate "single" item, ranked AFTER
    //    the batch (the batch's -1.5 km bonus beats a fresh 5 km single).
    test("a distant unbatched order appears as a single, ranked after the batch", async () => {
        seedOrder(h.dbPath, "orderC", { geo: geoOf(north(RESTAURANT, 5000)), geoStatus: "ok" });

        const res = await fetchRoute(h, driver);
        assert.strictEqual(res.status, 200);
        const body = await res.json();

        assert.strictEqual(body.items.length, 2);
        assert.strictEqual(body.items[0].kind, "batch");
        assert.strictEqual(body.items[1].kind, "single");
        assert.deepStrictEqual(body.items[1].stopIds, ["orderC"]);
    });

    // 3. An order with geoStatus "failed" -> appears in `unlocated`, never
    //    in `items`.
    test("an order that failed to geocode lands in the unlocated tail, never in items", async () => {
        seedOrder(h.dbPath, "orderD", { geo: null, geoStatus: "failed" });

        const res = await fetchRoute(h, driver);
        assert.strictEqual(res.status, 200);
        const body = await res.json();

        assert.ok(body.unlocated.includes("orderD"));
        const allStopIds = body.items.flatMap(i => i.stopIds);
        assert.ok(!allStopIds.includes("orderD"));
    });

    // 4. PRIVACY: an order already claimed by ANOTHER driver must be absent
    //    from BOTH `items` and `orders` — and, critically, absent from the
    //    raw response text, not merely filtered out of the parsed items.
    //    driver.js used to filter this client-side (driver.js:280), which
    //    meant another driver's customer PII was already on the wire.
    test("another driver's already-claimed order never reaches the wire", async () => {
        seedOrder(h.dbPath, "orderE", {
            status: "claimed", claimedBy: OTHER_DRIVER_ID, claimedByName: "Other Driver",
            claimedAt: new Date().toISOString(),
            customerName: OTHER_ORDER_NAME, phone: OTHER_ORDER_PHONE,
            geo: geoOf(east(RESTAURANT, 50)), geoStatus: "ok",
        });

        const res = await fetchRoute(h, driver);
        assert.strictEqual(res.status, 200);
        const text = await res.text();

        assert.ok(!text.includes("orderE"), "another driver's order id leaked onto the wire");
        assert.ok(!text.includes(OTHER_ORDER_PHONE), "another driver's customer phone leaked onto the wire");
        assert.ok(!text.includes(OTHER_ORDER_NAME), "another driver's customer name leaked onto the wire");

        const body = JSON.parse(text);
        assert.ok(!body.orders.some(o => o.id === "orderE"));
        assert.ok(!body.items.some(i => i.stopIds.includes("orderE")));
    });
});

// ============================================================================
// SUITE 2 — claim-batch (all-or-nothing), split, delete-dissolves-batch
// ============================================================================

describe("driver route — claim-batch, split, delete", () => {
    let h;
    let driver;
    let admin;

    before(async () => {
        h = await harness.start();

        seedUser(h.dbPath, {
            id: "driver0002", abbreviation: "smoke-driver-2", password: "Driver!Pass456",
            name: "Smoke Driver Two", isAdmin: false, isDriver: true,
        });
        driver = await buildSession(h, { abbreviation: "smoke-driver-2", password: "Driver!Pass456" });

        seedUser(h.dbPath, {
            id: "admin0002", abbreviation: "smoke-admin-2", password: "Admin!Pass456",
            name: "Smoke Admin Two", isAdmin: true, isDriver: false,
        });
        admin = await buildSession(h, { abbreviation: "smoke-admin-2", password: "Admin!Pass456" });

        // Batch b1: happy-path claim target for case 5, then the
        // already-claimed target for case 6.
        seedOrder(h.dbPath, "orderA", { geo: geoOf(east(RESTAURANT, 0)), geoStatus: "ok", kitchenStatus: "completed", batchId: "b1" });
        seedOrder(h.dbPath, "orderB", { geo: geoOf(east(RESTAURANT, 300)), geoStatus: "ok", kitchenStatus: "completed", batchId: "b1" });
        seedBatch(h.dbPath, "b1", ["orderA", "orderB"]);

        // Batch b2: one member still cooking — case 7.
        seedOrder(h.dbPath, "orderF", { geo: geoOf(east(RESTAURANT, 0)), geoStatus: "ok", kitchenStatus: "completed", batchId: "b2" });
        seedOrder(h.dbPath, "orderG", { geo: geoOf(east(RESTAURANT, 300)), geoStatus: "ok", kitchenStatus: "pending", batchId: "b2" });
        seedBatch(h.dbPath, "b2", ["orderF", "orderG"]);

        // Batch b3: split target — case 8.
        seedOrder(h.dbPath, "orderH", { geo: geoOf(east(RESTAURANT, 0)), geoStatus: "ok", batchId: "b3" });
        seedOrder(h.dbPath, "orderI", { geo: geoOf(east(RESTAURANT, 300)), geoStatus: "ok", batchId: "b3" });
        seedBatch(h.dbPath, "b3", ["orderH", "orderI"]);

        // Batch b4: DELETE-one-member target — case 9.
        seedOrder(h.dbPath, "orderJ", { geo: geoOf(east(RESTAURANT, 0)), geoStatus: "ok", batchId: "b4" });
        seedOrder(h.dbPath, "orderK", { geo: geoOf(east(RESTAURANT, 300)), geoStatus: "ok", batchId: "b4" });
        seedBatch(h.dbPath, "b4", ["orderJ", "orderK"]);
    });

    after(async () => {
        await h.stop();
    });

    let firstClaimedAt;

    // 5. claim-batch happy path: 200, both orders become "claimed" with
    //    claimedBy the caller, and the batch becomes "claimed".
    test("claiming an open, fully-ready batch claims every member atomically", async () => {
        const res = await postAuthed(`${h.api}/orders/claim-batch`, driver, { batchId: "b1" });
        assert.strictEqual(res.status, 200);
        const body = await res.json();

        assert.strictEqual(body.success, true);
        assert.strictEqual(body.orders.length, 2);
        for (const order of body.orders) {
            assert.strictEqual(order.status, "claimed");
            assert.strictEqual(order.claimedBy, driver.id);
        }
        firstClaimedAt = body.orders[0].claimedAt;

        const batchAfter = harness.readRecord(h.dbPath, COL.deliveryBatches, "b1");
        assert.strictEqual(batchAfter.status, "claimed");
        assert.strictEqual(batchAfter.claimedBy, driver.id);
    });

    // 6. claim-batch on an already-claimed batch: 409, and NOTHING is
    //    written — re-read both orders and confirm they are untouched
    //    (same claimedAt as the first, successful claim).
    test("claiming an already-claimed batch is rejected 409 and writes nothing", async () => {
        const res = await postAuthed(`${h.api}/orders/claim-batch`, driver, { batchId: "b1" });
        assert.strictEqual(res.status, 409);

        const orderA = harness.readRecord(h.dbPath, COL.orders, "orderA");
        const orderB = harness.readRecord(h.dbPath, COL.orders, "orderB");
        assert.strictEqual(orderA.claimedAt, firstClaimedAt);
        assert.strictEqual(orderB.claimedAt, firstClaimedAt);
    });

    // 7. claim-batch where one member is still kitchenStatus "pending":
    //    409 with notReadyIds, and neither order is claimed.
    test("claiming a batch with an unready member is rejected 409 with notReadyIds", async () => {
        const res = await postAuthed(`${h.api}/orders/claim-batch`, driver, { batchId: "b2" });
        assert.strictEqual(res.status, 409);
        const body = await res.json();
        assert.deepStrictEqual(body.notReadyIds, ["orderG"]);

        const orderF = harness.readRecord(h.dbPath, COL.orders, "orderF");
        const orderG = harness.readRecord(h.dbPath, COL.orders, "orderG");
        assert.strictEqual(orderF.status, "pending");
        assert.strictEqual(orderG.status, "pending");
    });

    // 8. split: 200, both orders get batchId null, batch becomes
    //    "dissolved", and a second split attempt is 409.
    test("splitting a batch releases every member and cannot be repeated", async () => {
        const res = await postAuthed(`${h.api}/delivery-batches/b3/split`, driver, null);
        assert.strictEqual(res.status, 200);

        const orderH = harness.readRecord(h.dbPath, COL.orders, "orderH");
        const orderI = harness.readRecord(h.dbPath, COL.orders, "orderI");
        assert.strictEqual(orderH.batchId, null);
        assert.strictEqual(orderI.batchId, null);

        const batchAfter = harness.readRecord(h.dbPath, COL.deliveryBatches, "b3");
        assert.strictEqual(batchAfter.status, "dissolved");

        const res2 = await postAuthed(`${h.api}/delivery-batches/b3/split`, driver, null);
        assert.strictEqual(res2.status, 409);
    });

    // 9. DELETE one member of a 2-order batch -> the batch is dissolved and
    //    the survivor's batchId is null (spec §8.3.1).
    test("deleting one member of a 2-order batch dissolves it and frees the survivor", async () => {
        const res = await deleteAuthed(`${h.api}/orders/orderJ`, admin);
        assert.strictEqual(res.status, 200);

        const batchAfter = harness.readRecord(h.dbPath, COL.deliveryBatches, "b4");
        assert.strictEqual(batchAfter.status, "dissolved");

        const orderK = harness.readRecord(h.dbPath, COL.orders, "orderK");
        assert.strictEqual(orderK.batchId, null);

        const orderJ = harness.readRecord(h.dbPath, COL.orders, "orderJ");
        assert.strictEqual(orderJ, null, "deleted order should no longer exist");
    });
});
