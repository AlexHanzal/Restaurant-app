// ============================================================================
// features.test.js — boots a real server with a temp restaurace.config.js
// that switches delivery off, and proves the switch reaches both the page
// routes and the API. The config file is written to os.tmpdir() and passed
// via RESTAURANT_CONFIG, so this never writes into the repo root (where the
// harness sets the child's cwd) and never disturbs a parallel test run.
// ============================================================================

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const harness = require("../helpers/harness");

function writeTempConfig(source) {
    const unique = `${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    const file = path.join(os.tmpdir(), `restaurace-config-${unique}.js`);
    fs.writeFileSync(file, source, "utf8");
    return file;
}

test("features: delivery off 404s its page and its API, reservations stay up", async (t) => {
    const configPath = writeTempConfig(`module.exports = {
        brand: { wordmark: "U Kalicha", name: "Restaurace U Kalicha" },
        features: { reservations: true, delivery: false, tableOrdering: true,
                    pos: true, dailyMenu: true, eet: false },
    };`);

    const server = await harness.start({ env: { RESTAURANT_CONFIG: configPath } });
    t.after(async () => {
        await server.stop();
        try { fs.unlinkSync(configPath); } catch { /* already gone */ }
    });

    const del = await fetch(`${server.baseUrl}/reservation/delivery`);
    assert.strictEqual(del.status, 404, "the delivery page must 404 when the feature is off");

    const driver = await fetch(`${server.baseUrl}/reservation/driver`);
    assert.strictEqual(driver.status, 404, "the driver page must 404 with delivery off");

    const order = await fetch(`${server.api}/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: [] }),
    });
    assert.strictEqual(order.status, 404,
        "POST /orders must 404 (not 403 — a disabled feature does not announce itself)");

    const app = await fetch(`${server.baseUrl}/reservation/app`);
    assert.strictEqual(app.status, 200, "reservations are on, so /app must still work");

    const html = await app.text();
    assert.ok(html.includes("U Kalicha"), "the configured wordmark must reach the page");
    assert.ok(!html.includes("{{"), "no unrendered token may reach the browser");
});

test("features: with no config file every feature is on", async (t) => {
    const server = await harness.start();
    t.after(() => server.stop());

    for (const route of ["/reservation/app", "/reservation/delivery", "/reservation/kitchen"]) {
        const res = await fetch(`${server.baseUrl}${route}`);
        assert.strictEqual(res.status, 200, `${route} must be reachable by default`);
    }
});

// go-live Task 4 review, finding 2 (point 1): the admin panel (inner.html /
// /admin) also serves menu/users/settings/layout management, which has
// nothing to do with the POS till. It must stay reachable with pos:false —
// server.js registers these two routes unconditionally specifically for this
// reason (see its comment above `app.get(`${base}/admin`, ...)`), but nothing
// before this test actually proved it.
test("features: pos off still leaves the admin panel reachable", async (t) => {
    const configPath = writeTempConfig(`module.exports = {
        brand: { wordmark: "U Kalicha", name: "Restaurace U Kalicha" },
        features: { reservations: true, delivery: true, tableOrdering: true,
                    pos: false, dailyMenu: true, eet: false },
    };`);

    const server = await harness.start({ env: { RESTAURANT_CONFIG: configPath } });
    t.after(async () => {
        await server.stop();
        try { fs.unlinkSync(configPath); } catch { /* already gone */ }
    });

    const admin = await fetch(`${server.baseUrl}/reservation/admin`);
    assert.strictEqual(admin.status, 200, "/admin must stay reachable with pos:false");

    const innerHtml = await fetch(`${server.baseUrl}/reservation/inner.html`);
    assert.strictEqual(innerHtml.status, 200, "/inner.html must stay reachable with pos:false");
});

// go-live Task 4 review, finding 2 (point 2): GET /kitchen (the page) and
// GET /api/kitchen/orders are gated requireFeature("pos", "delivery",
// "tableOrdering") — an OR, not an AND — because the kitchen board also
// displays delivery orders. Gating it on pos alone would 404 the kitchen
// board for a delivery-only restaurant that never turned POS on. This test
// would fail (kitchenOnDelivery.status would be 404 instead of 200) if that
// requireFeature call were narrowed to just "pos".
test("features: kitchen board is an OR-gate across pos/delivery/tableOrdering", async (t) => {
    const orConfigPath = writeTempConfig(`module.exports = {
        brand: { wordmark: "U Kalicha", name: "Restaurace U Kalicha" },
        features: { reservations: true, delivery: true, tableOrdering: false,
                    pos: false, dailyMenu: true, eet: false },
    };`);
    const allOffConfigPath = writeTempConfig(`module.exports = {
        brand: { wordmark: "U Kalicha", name: "Restaurace U Kalicha" },
        features: { reservations: true, delivery: false, tableOrdering: false,
                    pos: false, dailyMenu: true, eet: false },
    };`);

    const orServer = await harness.start({ env: { RESTAURANT_CONFIG: orConfigPath } });
    const allOffServer = await harness.start({ env: { RESTAURANT_CONFIG: allOffConfigPath } });
    t.after(async () => {
        await orServer.stop();
        await allOffServer.stop();
        try { fs.unlinkSync(orConfigPath); } catch { /* already gone */ }
        try { fs.unlinkSync(allOffConfigPath); } catch { /* already gone */ }
    });

    const kitchenOnDelivery = await fetch(`${orServer.baseUrl}/reservation/kitchen`);
    assert.strictEqual(kitchenOnDelivery.status, 200,
        "pos:false + delivery:true must still serve the kitchen board");

    const kitchenAllOff = await fetch(`${allOffServer.baseUrl}/reservation/kitchen`);
    assert.strictEqual(kitchenAllOff.status, 404,
        "pos, delivery, and tableOrdering all off must 404 the kitchen board");
});

// go-live Task 4 review, finding 2 (point 3): the single most valuable
// assertion in this file. GET /api/indoor-orders is mounted as
// requireFeature("pos"), requireAuth — feature gate BEFORE auth. Calling it
// with NO credentials while pos is off must answer 404, not 401. A 401 here
// would mean requireAuth ran (or ran first), which leaks the fact that this
// route exists even though the feature that owns it was never bought. If the
// middleware order in server.js were ever swapped to
// requireAuth, requireFeature("pos"), this test would fail with 401 !== 404.
test("features: a feature-gated route behind auth answers 404, not 401, with no credentials", async (t) => {
    const configPath = writeTempConfig(`module.exports = {
        brand: { wordmark: "U Kalicha", name: "Restaurace U Kalicha" },
        features: { reservations: true, delivery: true, tableOrdering: true,
                    pos: false, dailyMenu: true, eet: false },
    };`);

    const server = await harness.start({ env: { RESTAURANT_CONFIG: configPath } });
    t.after(async () => {
        await server.stop();
        try { fs.unlinkSync(configPath); } catch { /* already gone */ }
    });

    // Deliberately no credentials/cookies — proving the feature gate, not
    // the auth check, is what answers here.
    const res = await fetch(`${server.api}/indoor-orders`);
    assert.strictEqual(res.status, 404,
        "GET /api/indoor-orders with pos off must 404 even with zero credentials, " +
        "never 401 (a 401 would confirm the route exists)");
});

// go-live Task 4 review, finding 2 (point 4): dailyMenu is a standalone
// feature (Task 3), not covered by the existing delivery test above — proves
// its own API route (GET /api/daily-menu) is gated too.
test("features: dailyMenu off 404s its API route", async (t) => {
    const configPath = writeTempConfig(`module.exports = {
        brand: { wordmark: "U Kalicha", name: "Restaurace U Kalicha" },
        features: { reservations: true, delivery: true, tableOrdering: true,
                    pos: true, dailyMenu: false, eet: false },
    };`);

    const server = await harness.start({ env: { RESTAURANT_CONFIG: configPath } });
    t.after(async () => {
        await server.stop();
        try { fs.unlinkSync(configPath); } catch { /* already gone */ }
    });

    const res = await fetch(`${server.api}/daily-menu`);
    assert.strictEqual(res.status, 404, "GET /api/daily-menu must 404 when dailyMenu is off");
});

// Finding I2: reservations:false used to gate the /app page but NOT the
// underlying API — send-code would still fire a real Twilio SMS and
// verify-and-book would still write a real booking. requireFeature must be
// the first middleware on both routes, same as every other gated route.
test("features: reservations off 404s the reservation API, not just the page", async (t) => {
    const configPath = writeTempConfig(`module.exports = {
        brand: { wordmark: "U Kalicha", name: "Restaurace U Kalicha" },
        features: { reservations: false, delivery: true, tableOrdering: true,
                    pos: true, dailyMenu: true, eet: false },
    };`);

    const server = await harness.start({ env: { RESTAURANT_CONFIG: configPath } });
    t.after(async () => {
        await server.stop();
        try { fs.unlinkSync(configPath); } catch { /* already gone */ }
    });

    const sendCode = await fetch(`${server.api}/reservations/send-code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
    });
    assert.strictEqual(sendCode.status, 404,
        "POST /api/reservations/send-code must 404 (not proceed to send SMS) when reservations is off");

    const verifyAndBook = await fetch(`${server.api}/reservations/verify-and-book`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
    });
    assert.strictEqual(verifyAndBook.status, 404,
        "POST /api/reservations/verify-and-book must 404 when reservations is off");
});

test("seeding: a fresh DB takes its starting values from the config file", async (t) => {
    const configPath = writeTempConfig(`module.exports = {
        defaults: {
            delivery: { fee: 59, minOrder: 250, freeAbove: 700,
                        pscWhitelist: ["11000"], etaMinutes: 45 },
            dailyMenu: { from: "10:30", to: "13:30" },
        },
        business: { name: "U Kalicha s.r.o.", ico: "87654321",
                    dic: "CZ87654321", address: "Na Bojišti 12, 128 00 Praha 2",
                    email: "info@ukalicha.cz", phone: "+420 601 234 567" },
    };`);

    const server = await harness.start({ env: { RESTAURANT_CONFIG: configPath } });
    t.after(async () => {
        await server.stop();
        try { fs.unlinkSync(configPath); } catch { /* already gone */ }
    });

    const stored = harness.readRecord(server.dbPath, harness.COL.settings, harness.SETTINGS_ID);
    assert.ok(stored, "a fresh DB must get a seeded settings record");
    assert.strictEqual(stored.delivery.fee, 59);
    assert.strictEqual(stored.delivery.minOrder, 250);
    assert.deepStrictEqual(stored.delivery.pscWhitelist, ["11000"]);
    assert.strictEqual(stored.dailyMenu.from, "10:30");
    assert.strictEqual(stored.business.ico, "87654321");
    assert.strictEqual(stored.business.phone, "+420 601 234 567");

    // Values the config file said nothing about keep settings.js's defaults.
    assert.strictEqual(stored.reservations.paused, false);
    assert.strictEqual(stored.tableOrdering.enabled, false);
    // …including the ones one level below something the config DID set.
    assert.strictEqual(stored.delivery.days["0"].from, "10:30");
});

test("seeding: a nested preset reaches the settings record", async (t) => {
    const configPath = writeTempConfig(`module.exports = {
        defaults: {
            reservations: { days: { "6": { open: false, fromHour: 1, toHour: 12 } } },
            notifications: { smsReservationReminder: true },
        },
    };`);

    const server = await harness.start({ env: { RESTAURANT_CONFIG: configPath } });
    t.after(async () => {
        await server.stop();
        try { fs.unlinkSync(configPath); } catch { /* already gone */ }
    });

    const stored = harness.readRecord(server.dbPath, harness.COL.settings, harness.SETTINGS_ID);
    assert.strictEqual(stored.reservations.days["6"].open, false, "Sunday must be seeded closed");
    assert.strictEqual(stored.reservations.days["0"].open, true, "other days keep the default");
    assert.strictEqual(stored.notifications.smsReservationReminder, true);
});

test("seeding: an existing settings record is never overwritten", async (t) => {
    const configPath = writeTempConfig(`module.exports = {
        defaults: { delivery: { fee: 59 } },
    };`);

    // This test boots TWICE against ONE database, so it owns the DB path
    // itself instead of using the harness's. Two reasons, both learned the
    // hard way:
    //   - harness.stop() deletes the DB path IT generated. If the first boot
    //     used the harness's own path, stopping it would delete the very
    //     file the second boot is supposed to find already populated, and
    //     the "redeploy" being tested would silently become a fresh install.
    //   - passing SQLITE_PATH makes the harness's generated path unused, so
    //     its cleanup is a harmless no-op on a file that never existed.
    const dbUnique = `${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    const dbPath = path.join(os.tmpdir(), `seed-persist-${dbUnique}.db`);
    const bootEnv = { RESTAURANT_CONFIG: configPath, SQLITE_PATH: dbPath };

    const servers = [];
    t.after(async () => {
        // Registered BEFORE the first assertion runs. A failing assertion
        // must not orphan a spawned server: node:test will not exit while a
        // child process is alive, so a leaked one turns a red test into a
        // run that hangs forever with no output.
        for (const s of servers) await s.stop();
        for (const suffix of ["", "-wal", "-shm", "-journal"]) {
            try { fs.unlinkSync(dbPath + suffix); } catch { /* never existed */ }
        }
        try { fs.unlinkSync(configPath); } catch { /* already gone */ }
    });

    // First boot seeds fee = 59.
    const first = await harness.start({ env: bootEnv });
    servers.push(first);
    assert.strictEqual(
        harness.readRecord(dbPath, harness.COL.settings, harness.SETTINGS_ID).delivery.fee, 59);

    // The owner changes it in the panel.
    const settings = harness.readRecord(dbPath, harness.COL.settings, harness.SETTINGS_ID);
    settings.delivery.fee = 65;
    harness.seedRecord(dbPath, harness.COL.settings, harness.SETTINGS_ID, settings);
    await first.stop();
    servers.pop();

    // A redeploy must NOT revert it.
    const second = await harness.start({ env: bootEnv });
    servers.push(second);

    assert.strictEqual(
        harness.readRecord(dbPath, harness.COL.settings, harness.SETTINGS_ID).delivery.fee, 65,
        "a redeploy must not clobber the owner's own panel edit");
});
