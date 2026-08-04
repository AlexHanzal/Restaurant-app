// ============================================================================
// table-orders.test.js — end-to-end smoke coverage for the four public
// table-QR self-order routes (spec: docs/superpowers/specs/2026-08-04-
// table-qr-self-order-design.md §9.2), run against a REAL spawned server
// (tests/helpers/harness.js) and a REAL temp SQLite DB — no mocking of
// Express, zod, better-sqlite3 or the rate limiters.
//
// Split into two suites on purpose:
//   - "public routes" runs everything against ONE shared server, in a
//     careful order (settings/table state is mutated between cases), and
//     stays well under the 30-req/15min tableOrderIpLimiter budget shared
//     by every route in this file (see security.js).
//   - "per-table order limiter" gets its OWN server. Proving the 12-order
//     tableOrderTableLimiter trips needs 13 requests all by itself, and
//     running it in the shared suite would burn most of that suite's IP
//     budget for no reason — a fresh process is simpler than budgeting.
//
// JWT_SECRET must be set to the SAME value the harness gives the spawned
// server BEFORE table-token.js is required here: that module derives its
// signing key from JWT_SECRET (auth.deriveSecret), and this test process
// mints tokens independently of the server to build test URLs — see
// table-token.js's own header comment and tests/unit/table-token.test.js
// for the same requirement.
// ============================================================================

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert");
const bcrypt = require("bcryptjs");

const harness = require("../helpers/harness");

process.env.JWT_SECRET = harness.TEST_JWT_SECRET;
const tableToken = require("../../src/server/table-token");

const COL = harness.COL;

// ── FIXTURE HELPERS ───────────────────────────────────────────────────────

// Mirrors the shape POST /timetables actually writes (server.js ~line 2848)
// closely enough for the routes under test — they only ever read `fileId`
// and `className` off this record.
function tableRecord(fileId, className) {
    return {
        className,
        fileId,
        data: {},
        calendar: "",
        currentWeek: new Date().toISOString(),
        info: "",
        attributes: [],
        seats: 4,
        layout: null,
        permanentHours: { "0": {}, "1": {}, "2": {}, "3": {}, "4": {}, "5": {}, "6": {} },
    };
}

function seedTable(dbPath, fileId, className) {
    harness.seedRecord(dbPath, COL.timetables, fileId, tableRecord(fileId, className));
}

// One dish, enough for priceOrderItems() to resolve `{ id: "dish1", qty }`
// lines. 150 Kč / 21% VAT are arbitrary but fixed so totals are asserted
// exactly.
const DISH_ID = "dish1";
const DISH_PRICE = 150;
function seedMenu(dbPath) {
    harness.seedRecord(dbPath, COL.menu, harness.MENU_SINGLETON_ID, {
        "hlavni-jidla": [{ id: DISH_ID, name: "Svíčková na smetaně", price: DISH_PRICE, vatRate: 21 }],
    });
}

function daysAllOpen(from, to) {
    const days = {};
    for (let i = 0; i <= 6; i++) days[String(i)] = { open: true, from, to };
    return days;
}

function seedTableOrderingSettings(dbPath, tableOrdering) {
    // A PARTIAL settings object is enough — settingsStore.getSettings()
    // deep-merges whatever is stored over DEFAULT_SETTINGS (settings.js
    // mergeDefaults), exactly like it would for a real PUT /settings body
    // that only ever changed one section. No admin session needed to set
    // this up; see harness.js's header comment for why fixtures are seeded
    // straight into the DB rather than through the (requireAdmin-gated)
    // settings API.
    harness.seedRecord(dbPath, COL.settings, harness.SETTINGS_ID, { tableOrdering });
}

// Builds an { open: true, from, to } window that provably does NOT contain
// "now" — used to test the hours-of-day rejection branch of
// isTableOrderingOpenNow() deterministically, without depending on what
// time of day the test happens to run.
//
// isTableOrderingOpenNow compares "HH:MM" strings lexicographically (same
// convention as every other hours block in this app — see settings.js) —
// that only agrees with real chronological ordering WITHIN a single day, so
// the window built here must never cross midnight. Near local midnight a
// "closed since 5 minutes ago" window would need to (00:00 minus a few
// minutes wraps to the previous day), so that one case uses a "not open
// yet today" window instead.
function hoursWindowExcludingNow(now = new Date()) {
    const hh = now.getHours();
    const mm = now.getMinutes();
    if (hh === 0 && mm < 10) {
        return { from: "00:20", to: "23:59" };
    }
    let toMin = hh * 60 + mm - 5;
    if (toMin < 0) toMin = 0;
    const toH = String(Math.floor(toMin / 60)).padStart(2, "0");
    const toM = String(toMin % 60).padStart(2, "0");
    return { from: "00:00", to: `${toH}:${toM}` };
}

function seedAdminUser(dbPath, { id, abbreviation, password, name }) {
    // BCRYPT_COST in auth.js is 12 — hashSync here matches what
    // auth.hashPassword() would produce, so POST /users/login's
    // comparePassword() (bcrypt.compare) accepts it exactly as it would a
    // real admin's stored hash.
    const hash = bcrypt.hashSync(password, 12);
    harness.seedRecord(dbPath, COL.users, id, {
        id,
        abbreviation,
        password: hash,
        name,
        isAdmin: true,
        isDriver: false,
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
    // Node's fetch (undici) exposes multi-value Set-Cookie correctly via
    // getSetCookie() (WHATWG fetch spec) — plain headers.get("set-cookie")
    // is unreliable once a response carries more than one Set-Cookie
    // header. issueSessionCookie() only ever sets one, but this is the
    // robust way to read it regardless.
    if (typeof res.headers.getSetCookie === "function") {
        const all = res.headers.getSetCookie();
        if (all.length) return all[0].split(";")[0];
    }
    const raw = res.headers.get("set-cookie");
    return raw ? raw.split(";")[0] : null;
}

async function loginAsAdmin(baseUrl, abbreviation, password) {
    const res = await postJson(`${baseUrl}/reservation/api/users/login`, { abbreviation, password });
    // NOTE: assert's optional message argument is evaluated eagerly (it's
    // just another JS argument), so `await res.text()` inside it would run
    // — and consume the body — even on the success path. Branch explicitly
    // instead so the body is only ever read once.
    if (res.status !== 200) {
        assert.fail(`admin login failed: ${res.status} ${await res.text()}`);
    }
    const cookie = extractSessionCookie(res);
    assert.ok(cookie, "login response did not set a session cookie");
    return cookie;
}

// ============================================================================
// SUITE 1 — public routes, one shared server
// ============================================================================

describe("table QR self-order — public routes", () => {
    let h;
    let tokenA, tokenB, tokenC;
    let happyPathOrderId;

    before(async () => {
        h = await harness.start();
        seedTable(h.dbPath, "tableAId0001", "Stůl A");
        seedTable(h.dbPath, "tableBId0002", "Stůl B");
        seedTable(h.dbPath, "tableCId0003", "Stůl C");
        seedMenu(h.dbPath);
        seedAdminUser(h.dbPath, {
            id: "admin0001",
            abbreviation: "smoketest-admin",
            password: "Sm0keTest!Pass123",
            name: "Smoke Test Admin",
        });

        tokenA = tableToken.mintTableToken("tableAId0001");
        tokenB = tableToken.mintTableToken("tableBId0002");
        tokenC = tableToken.mintTableToken("tableCId0003");
    });

    after(async () => {
        await h.stop();
    });

    test("GET /table-session/:token — invalid signature is rejected 404", async () => {
        const res = await fetch(`${h.api}/table-session/bogus.token`);
        assert.strictEqual(res.status, 404);
        const body = await res.json();
        assert.strictEqual(body.error, "Neplatný kód stolu");
    });

    test("GET /table-session/:token — resolves a live table, then 410s once it's deleted", async () => {
        const res1 = await fetch(`${h.api}/table-session/${tokenB}`);
        assert.strictEqual(res1.status, 200);
        const body1 = await res1.json();
        assert.strictEqual(body1.tableName, "Stůl B");
        // Settings have not been seeded yet at this point in the suite —
        // DEFAULT_SETTINGS.tableOrdering.enabled is false, so this is also
        // coverage of the "closed by default" gate (spec §7: an install
        // that never printed a QR code must not silently accept orders).
        assert.deepStrictEqual(body1.ordering, {
            enabled: false,
            open: false,
            notice: "Objednávky u stolu nejsou momentálně dostupné.",
        });

        harness.removeRecord(h.dbPath, COL.timetables, "tableBId0002");

        const res2 = await fetch(`${h.api}/table-session/${tokenB}`);
        assert.strictEqual(res2.status, 410);
        const body2 = await res2.json();
        assert.strictEqual(body2.error, "Tento stůl už neexistuje");
    });

    test("POST /table-orders — rejected 403 while tableOrdering.enabled is false", async () => {
        const res = await postJson(`${h.api}/table-orders`, {
            token: tokenA,
            items: [{ id: DISH_ID, qty: 1 }],
        });
        assert.strictEqual(res.status, 403);
        const body = await res.json();
        assert.strictEqual(body.error, "Objednávky u stolu nejsou momentálně dostupné.");
    });

    test("POST /table-orders — rejected 403 outside today's configured hours", async () => {
        const win = hoursWindowExcludingNow();
        seedTableOrderingSettings(h.dbPath, { enabled: true, days: daysAllOpen(win.from, win.to) });

        const res = await postJson(`${h.api}/table-orders`, {
            token: tokenA,
            items: [{ id: DISH_ID, qty: 1 }],
        });
        assert.strictEqual(res.status, 403);
        const body = await res.json();
        assert.strictEqual(body.error, `Objednávky u stolu přijímáme ${win.from}–${win.to}.`);
    });

    test("POST /table-orders — happy path writes a source:'qr' indoor order priced by the server", async () => {
        seedTableOrderingSettings(h.dbPath, { enabled: true, days: daysAllOpen("00:00", "23:59") });

        const res = await postJson(`${h.api}/table-orders`, {
            token: tokenC,
            guestName: "Petr Svoboda",
            note: "bez cibule",
            items: [{ id: DISH_ID, qty: 2 }],
        });
        // See loginAsAdmin's comment above on why the body is not read
        // inside an assert message on the success path.
        if (res.status !== 200) {
            assert.fail(`expected 200, got ${res.status}: ${await res.text()}`);
        }
        const body = await res.json();

        assert.strictEqual(body.success, true);
        assert.strictEqual(body.tableName, "Stůl C");
        // Server-derived total (2 x 150), never anything the client could
        // have sent — the request body above never included a price/total.
        assert.strictEqual(body.total, DISH_PRICE * 2);
        assert.strictEqual(body.items.length, 1);
        assert.strictEqual(body.items[0].price, DISH_PRICE);
        assert.strictEqual(body.items[0].qty, 2);
        assert.ok(body.orderId);

        happyPathOrderId = body.orderId;

        // Confirm the row actually landed in COL.indoorOrders with
        // source:"qr", via the SAME authenticated route the admin overview
        // and kitchen board read from — GET /indoor-orders — rather than
        // just re-reading our own direct DB write back.
        const cookie = await loginAsAdmin(h.baseUrl, "smoketest-admin", "Sm0keTest!Pass123");
        const listRes = await fetch(`${h.api}/indoor-orders`, { headers: { cookie } });
        assert.strictEqual(listRes.status, 200);
        const orders = await listRes.json();
        const row = orders.find(o => o.id === happyPathOrderId);
        assert.ok(row, "placed order not found in GET /indoor-orders");
        assert.strictEqual(row.source, "qr");
        assert.strictEqual(row.tableName, "Stůl C");
        assert.strictEqual(row.guestName, "Petr Svoboda");
        assert.strictEqual(row.note, "bez cibule");
        assert.strictEqual(row.total, DISH_PRICE * 2);
        assert.strictEqual(row.kitchenStatus, "pending");
        assert.strictEqual(row.paymentStatus, "unpaid");

        // REGRESSION GUARD — cart shape. This app has two cart line shapes
        // (validation.js:243): delivery lines carry `name`, indoor and
        // reservation lines carry `item`. priceOrderItems() passes client
        // fields through, so a guest page reusing the delivery-shaped cart
        // produced lines with NO `item` key — and every indoor consumer
        // reads exactly that. The live symptom was a kitchen ticket reading
        // "2× 298 Kč" with no dish name at all, which a cook cannot make,
        // plus "2× undefined" in the admin walk-in row. Normalised in
        // POST /table-orders; asserted here so it cannot silently return.
        for (const line of row.items) {
            assert.ok(
                line.item,
                `indoor order line is missing the \`item\` key the kitchen board renders: ${JSON.stringify(line)}`
            );
            assert.strictEqual(line.item, line.name);
        }
    });

    test("POST /table-orders — a client-supplied `total` is rejected 400 (schema is strict)", async () => {
        const res = await postJson(`${h.api}/table-orders`, {
            token: "irrelevant-because-schema-fails-first",
            items: [{ id: DISH_ID, qty: 1 }],
            total: 999,
        });
        assert.strictEqual(res.status, 400);
        const body = await res.json();
        assert.strictEqual(typeof body.error, "string");
        assert.ok(body.error.length > 0);
    });

    test("POST /table-orders — `offlineSale: true` is rejected 400 (schema is strict)", async () => {
        const res = await postJson(`${h.api}/table-orders`, {
            token: "irrelevant-because-schema-fails-first",
            items: [{ id: DISH_ID, qty: 1 }],
            offlineSale: true,
        });
        assert.strictEqual(res.status, 400);
        const body = await res.json();
        assert.strictEqual(typeof body.error, "string");
        assert.ok(body.error.length > 0);
    });

    test("GET /table-orders/:id/status — 200 for the order's own table, 404 for a foreign table's token", async () => {
        assert.ok(happyPathOrderId, "happy-path order must have run first");

        const own = await fetch(`${h.api}/table-orders/${happyPathOrderId}/status?token=${tokenC}`);
        assert.strictEqual(own.status, 200);
        const ownBody = await own.json();
        assert.strictEqual(ownBody.kitchenStatus, "pending");
        assert.strictEqual(ownBody.paymentStatus, "unpaid");
        assert.strictEqual(ownBody.total, DISH_PRICE * 2);
        assert.strictEqual(typeof ownBody.createdAt, "string");
        // Scoped tight: no item list, no guest name on the status payload.
        assert.strictEqual(ownBody.items, undefined);
        assert.strictEqual(ownBody.guestName, undefined);

        const foreign = await fetch(`${h.api}/table-orders/${happyPathOrderId}/status?token=${tokenA}`);
        assert.strictEqual(foreign.status, 404);
        const foreignBody = await foreign.json();
        assert.strictEqual(foreignBody.error, "Objednávka nenalezena");
    });
});

// ============================================================================
// SUITE 2 — per-table order limiter, its own server (see file header)
// ============================================================================

describe("table QR self-order — per-table order limiter", () => {
    let h;
    let tokenD;

    before(async () => {
        h = await harness.start();
        seedTable(h.dbPath, "tableDId0004", "Stůl D");
        seedMenu(h.dbPath);
        seedTableOrderingSettings(h.dbPath, { enabled: true, days: daysAllOpen("00:00", "23:59") });
        tokenD = tableToken.mintTableToken("tableDId0004");
    });

    after(async () => {
        await h.stop();
    });

    test("the 13th order from one table inside the 15-minute window is rejected 429", async () => {
        const statuses = [];
        for (let i = 0; i < 13; i++) {
            const res = await postJson(`${h.api}/table-orders`, {
                token: tokenD,
                items: [{ id: DISH_ID, qty: 1 }],
            });
            statuses.push(res.status);
            if (i === 12) {
                const body = await res.json();
                assert.strictEqual(typeof body.error, "string");
                assert.ok(body.error.length > 0);
            }
        }

        assert.deepStrictEqual(
            statuses,
            Array.from({ length: 12 }, () => 200).concat([429]),
            `unexpected status sequence: ${JSON.stringify(statuses)}`
        );
    });
});
