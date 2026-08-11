// ============================================================================
// idempotency.test.js — end-to-end proof for finding L1: two concurrent
// POST /indoor-orders carrying the SAME Idempotency-Key create exactly ONE
// order, against a REAL spawned server (tests/helpers/harness.js) and a REAL
// temp SQLite DB.
//
// This is the property the unit tests in tests/unit/idempotency.test.js
// exercise in isolation (a fake db, a fake req/res, a hand-driven race).
// This file exists to prove the same property holds through the real
// Express stack: real middleware order (requireAuth, csrf.requireCsrf,
// V.validate all sit between the route and the handler — see server.js's
// mount for POST /indoor-orders), a real better-sqlite3 file, and two
// requests that are ACTUALLY issued concurrently over HTTP, not merely
// simulated as concurrent inside one process.
//
// See idempotency.js's own header for the reasoning this test is checking:
// the reservation happens atomically BEFORE the handler runs, so it does
// not matter which of the two requests the OS/event loop services first —
// exactly one wins.
// ============================================================================

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert");
const bcrypt = require("bcryptjs");

const harness = require("../helpers/harness");

const COL = harness.COL;

const ADMIN = { id: "idem-admin-1", abbreviation: "idem-admin", password: "Idempot3nt!Admin" };

const DISH_ID = "dish1";
const DISH_PRICE = 150;

function seedMenu(dbPath) {
    harness.seedRecord(dbPath, COL.menu, harness.MENU_SINGLETON_ID, {
        "hlavni-jidla": [{ id: DISH_ID, name: "Svíčková na smetaně", price: DISH_PRICE, vatRate: 21 }],
    });
}

function seedAdmin(dbPath) {
    harness.seedRecord(dbPath, COL.users, ADMIN.id, {
        id: ADMIN.id,
        abbreviation: ADMIN.abbreviation,
        name: "Test Idempotency Admin",
        password: bcrypt.hashSync(ADMIN.password, 12),
        isAdmin: true,
        isDriver: false,
    });
}

// ── HTTP HELPERS (same shapes as tests/smoke/account-lifecycle.test.js /
// table-orders.test.js — duplicated rather than shared because this suite
// needs one extra header (Idempotency-Key) on its POSTs) ──────────────────

function extractCookie(res, namePrefix) {
    const all = typeof res.headers.getSetCookie === "function"
        ? res.headers.getSetCookie()
        : [res.headers.get("set-cookie")].filter(Boolean);
    const hit = all.find(c => c && c.startsWith(namePrefix));
    return hit ? hit.split(";")[0] : null;
}

async function login(server) {
    const res = await fetch(`${server.api}/users/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ abbreviation: ADMIN.abbreviation, password: ADMIN.password }),
    });
    assert.strictEqual(res.status, 200, `admin login failed: ${JSON.stringify(await res.json().catch(() => ({})))}`);
    const cookie = extractCookie(res, "auth_token");
    assert.ok(cookie, "no session cookie issued");
    return cookie;
}

async function sessionFor(server, cookie) {
    const res = await fetch(`${server.api}/csrf-token`, { headers: { cookie } });
    assert.strictEqual(res.status, 200, "could not obtain a CSRF token");
    const csrfCookie = extractCookie(res, "csrf_token");
    const { csrfToken } = await res.json();
    return { cookie: `${cookie}; ${csrfCookie}`, csrfToken };
}

function postIndoorOrder(server, session, body, idempotencyKey) {
    return fetch(`${server.api}/indoor-orders`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            cookie: session.cookie,
            "x-csrf-token": session.csrfToken,
            "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(body),
    });
}

describe("indoor order idempotency (finding L1)", () => {
    let server;
    let session;

    before(async () => {
        server = await harness.start();
        seedMenu(server.dbPath);
        seedAdmin(server.dbPath);
        session = await sessionFor(server, await login(server));
    });

    after(async () => { if (server) await server.stop(); });

    test("two concurrent POST /indoor-orders with the same Idempotency-Key create exactly ONE order", async () => {
        const key = `smoke-l1-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const body = {
            tableName: "Stůl L1",
            guestName: "Idempotency Test",
            items: [{ id: DISH_ID, qty: 2 }],
        };

        // Issued genuinely concurrently: both fetch() calls fire before
        // either is awaited, so both requests are in flight over real HTTP
        // at the same time, racing the server's actual middleware stack —
        // not merely simulated as concurrent inside one process.
        const [resA, resB] = await Promise.all([
            postIndoorOrder(server, session, body, key),
            postIndoorOrder(server, session, body, key),
        ]);

        const [bodyA, bodyB] = await Promise.all([resA.json(), resB.json()]);

        // Every possible legitimate outcome for the loser is one of:
        //   - a replay of the SAME order (200, same order.id as the winner)
        //   - a 429 "still in flight" if it arrived before the winner
        //     finished (should not happen under a real single request pair,
        //     but is not itself a bug if it does — see idempotency.js's
        //     header, case 3). Assert on the property that actually
        //     matters instead of the exact status split.
        for (const res of [resA, resB]) {
            assert.ok(
                res.status === 200 || res.status === 429,
                `unexpected status ${res.status} from a duplicate request`
            );
        }

        const succeeded = [
            { res: resA, body: bodyA },
            { res: resB, body: bodyB },
        ].filter(r => r.res.status === 200);

        assert.ok(succeeded.length >= 1, "at least one of the two requests must succeed");

        // THE property this test exists for: however many of the two
        // responses came back 200, they all name the SAME order id — never
        // two different ids, which is what a duplicate execution would
        // produce.
        const orderIds = new Set(succeeded.map(r => r.body.order && r.body.order.id));
        assert.strictEqual(orderIds.size, 1, `expected exactly one distinct order id, got ${JSON.stringify([...orderIds])}`);

        // And the database agrees: exactly one indoor order exists with
        // this table name — not one row per request. GET /indoor-orders
        // answers with a plain array (server.js ~line 5016), not wrapped.
        const listRes = await fetch(`${server.api}/indoor-orders`, { headers: { cookie: session.cookie } });
        assert.strictEqual(listRes.status, 200);
        const orders = await listRes.json();
        const matching = orders.filter(o => o.tableName === "Stůl L1");
        assert.strictEqual(matching.length, 1, `expected exactly one order in the DB, found ${matching.length}`);
        assert.strictEqual(matching[0].id, [...orderIds][0]);
    });

    test("a replay after the original completes returns the identical stored response, no new order", async () => {
        const key = `smoke-l1-replay-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const body = {
            tableName: "Stůl L1 Replay",
            guestName: "Idempotency Replay Test",
            items: [{ id: DISH_ID, qty: 1 }],
        };

        const first = await postIndoorOrder(server, session, body, key);
        assert.strictEqual(first.status, 200);
        const firstBody = await first.json();

        const second = await postIndoorOrder(server, session, body, key);
        assert.strictEqual(second.status, 200);
        const secondBody = await second.json();

        assert.strictEqual(secondBody.order.id, firstBody.order.id, "replay must return the SAME order id");

        const listRes = await fetch(`${server.api}/indoor-orders`, { headers: { cookie: session.cookie } });
        const orders = await listRes.json();
        const matching = orders.filter(o => o.tableName === "Stůl L1 Replay");
        assert.strictEqual(matching.length, 1, "a replay must never create a second order");
    });
});
