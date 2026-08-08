// ============================================================================
// api-rate-limit.test.js — REGRESSION GUARD for the /api backstop limiter
// (security.js apiLimiter, mounted in server.js's setupAPIRoutes via
// `app.use(api, security.apiLimiter)`).
//
// Why this file exists:
//   Every route that needs a real bound carries its own limiter, keyed on
//   the thing that identifies the abuser — the table for the QR routes, the
//   phone number for SMS, the IP for logins. Those numbers are sized for a
//   venue: 600 requests/15min per IP on the table routes, 240 status polls
//   per table. The backstop on the whole /api prefix sat at 300, BELOW both
//   of them, so it — not any of the carefully-keyed numbers — was the real
//   limit, and the whole restaurant shares it: every guest phone, both staff
//   tablets and the kitchen board reach this server from one NAT address.
//   Four open QR screens plus a kitchen board on its 5s SSE-fallback poll
//   burned 300 inside ten minutes of a Friday service, after which guests
//   could not load a menu and staff got 429s mid-order.
//
//   No existing suite caught it because none of them fires more than ~100
//   requests. This one deliberately crosses the old 300 line.
//
// The numbers below are chosen so that ONLY the backstop can fail the test:
//   401 table-route requests   (tableOrderIpLimiter allows 600)
//   200 of them status polls   (tableStatusLimiter allows 240 per table)
//     1 of them an order       (tableOrderTableLimiter allows 12 per table)
// Any 429 here therefore means the /api backstop is binding again. If a
// per-route limit is ever lowered below one of these counts, re-budget this
// file rather than loosening the assertion.
//
// Its own spawned server, like the other high-volume suites in tests/smoke —
// a fresh process is simpler than budgeting a shared one.
//
// JWT_SECRET must be set to the harness's value BEFORE table-token.js is
// required, exactly as in tests/smoke/table-orders.test.js: this process
// mints tokens the spawned server has to accept.
// ============================================================================

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert");
const bcrypt = require("bcryptjs");

const harness = require("../helpers/harness");

process.env.JWT_SECRET = harness.TEST_JWT_SECRET;
const tableToken = require("../../src/server/table-token");

const COL = harness.COL;

const DISH_ID = "dish1";
const DISH_PRICE = 150;

const ADMIN_ABBR = "ratelimit-admin";
const ADMIN_PASS = "R4teL1mit!Pass123";

// How many table-route requests to fire. Above the old 300 backstop (so the
// regression is caught), below the 600 tableOrderIpLimiter (so a pass means
// the backstop specifically is out of the way).
const BURST_SESSION_REQUESTS = 200;
const BURST_POLL_REQUESTS = 200;

// ── FIXTURES (same shapes as tests/smoke/table-orders.test.js) ─────────────

function seedTable(dbPath, fileId, className) {
    harness.seedRecord(dbPath, COL.timetables, fileId, {
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
    });
}

function seedMenu(dbPath) {
    harness.seedRecord(dbPath, COL.menu, harness.MENU_SINGLETON_ID, {
        "hlavni-jidla": [{ id: DISH_ID, name: "Svíčková na smetaně", price: DISH_PRICE, vatRate: 21 }],
    });
}

function seedOpenAllWeek(dbPath) {
    const days = {};
    for (let i = 0; i <= 6; i++) days[String(i)] = { open: true, from: "00:00", to: "23:59" };
    harness.seedRecord(dbPath, COL.settings, harness.SETTINGS_ID, { tableOrdering: { enabled: true, days } });
}

function seedAdminUser(dbPath) {
    harness.seedRecord(dbPath, COL.users, "admin0001", {
        id: "admin0001",
        abbreviation: ADMIN_ABBR,
        password: bcrypt.hashSync(ADMIN_PASS, 12),
        name: "Rate Limit Admin",
        isAdmin: true,
        isDriver: false,
    });
}

// Fires `count` GETs sequentially and returns the set of statuses seen.
// Bodies are drained so undici reuses the socket instead of opening 400 of
// them — without this the burst is slow enough to look like a hang.
async function fireGets(url, count) {
    const seen = new Map();
    for (let i = 0; i < count; i++) {
        const res = await fetch(url);
        seen.set(res.status, (seen.get(res.status) || 0) + 1);
        await res.arrayBuffer();
    }
    return seen;
}

function describeStatuses(seen) {
    return JSON.stringify(Object.fromEntries(seen));
}

describe("/api backstop rate limiter", () => {
    let h;
    let tokenG, tokenH;
    let orderId;

    before(async () => {
        h = await harness.start();
        seedTable(h.dbPath, "tableGId0007", "Stůl G");
        seedTable(h.dbPath, "tableHId0008", "Stůl H");
        seedMenu(h.dbPath);
        seedOpenAllWeek(h.dbPath);
        seedAdminUser(h.dbPath);

        tokenG = tableToken.mintTableToken("tableGId0007");
        tokenH = tableToken.mintTableToken("tableHId0008");

        const res = await fetch(`${h.api}/table-orders`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ token: tokenG, items: [{ id: DISH_ID, qty: 1 }] }),
        });
        if (res.status !== 200) {
            assert.fail(`fixture order failed: ${res.status} ${await res.text()}`);
        }
        orderId = (await res.json()).orderId;
    });

    after(async () => {
        await h.stop();
    });

    // The core guard: 400 requests from one address, spread over the two
    // routes a dining room actually generates traffic on, must all be served.
    // Each stays inside its own per-route budget, so a 429 can only come from
    // the /api-wide backstop.
    test("400 table-route requests from one address are all served", async () => {
        const sessionStatuses = await fireGets(`${h.api}/table-session/${tokenG}`, BURST_SESSION_REQUESTS);
        assert.deepStrictEqual(
            [...sessionStatuses.keys()], [200],
            `table-session burst was throttled — statuses: ${describeStatuses(sessionStatuses)}`
        );

        const pollStatuses = await fireGets(
            `${h.api}/table-orders/${orderId}/status?token=${tokenG}`,
            BURST_POLL_REQUESTS
        );
        assert.deepStrictEqual(
            [...pollStatuses.keys()], [200],
            `status-poll burst was throttled — statuses: ${describeStatuses(pollStatuses)}`
        );
    });

    // The other half of the same outage: while the backstop was the binding
    // limit, a busy dining room did not just lock out guests — it locked out
    // the staff sharing that address. The till and the kitchen board are on
    // routes with no limiter of their own, so the backstop is the ONLY thing
    // between them and a 429. Runs after the burst above on purpose.
    test("a staff request still succeeds after that burst", async () => {
        const loginRes = await fetch(`${h.api}/users/login`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ abbreviation: ADMIN_ABBR, password: ADMIN_PASS }),
        });
        if (loginRes.status !== 200) {
            assert.fail(`staff login was refused after the burst: ${loginRes.status} ${await loginRes.text()}`);
        }
        const setCookie = typeof loginRes.headers.getSetCookie === "function"
            ? loginRes.headers.getSetCookie()[0]
            : loginRes.headers.get("set-cookie");
        assert.ok(setCookie, "login response did not set a session cookie");
        const cookie = setCookie.split(";")[0];

        const listRes = await fetch(`${h.api}/indoor-orders`, { headers: { cookie } });
        if (listRes.status !== 200) {
            assert.fail(`staff order list was refused after the burst: ${listRes.status} ${await listRes.text()}`);
        }
        const orders = await listRes.json();
        assert.ok(orders.some(o => o.id === orderId), "the QR order placed in setup is missing from the staff list");
    });

    // Guards the invariant itself rather than a symptom, and does it without
    // spending 3000 requests to find the ceiling empirically. Asserting off
    // security.RATE_LIMITS (the object the limiters are actually built from,
    // not a copy) means the numbers stay free to be retuned — this only fails
    // when the ORDERING between them is wrong, which is the thing that
    // silently deletes a route's budget.
    test("the backstop is larger than every per-route limit it sits in front of", () => {
        const { RATE_LIMITS } = require("../../src/server/security");
        const { apiBackstop, ...perRoute } = RATE_LIMITS;

        assert.strictEqual(typeof apiBackstop, "number", "RATE_LIMITS.apiBackstop is missing");
        assert.ok(Object.keys(perRoute).length > 0, "RATE_LIMITS has no per-route limits to compare against");

        for (const [name, limit] of Object.entries(perRoute)) {
            assert.ok(
                apiBackstop > limit,
                `apiBackstop (${apiBackstop}) is not above ${name} (${limit}) — the /api backstop, not ${name}, would be the real limit on that route`
            );
        }
    });
});
