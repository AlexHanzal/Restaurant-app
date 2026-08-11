// ============================================================================
// order-limits.test.js — the two limiters in front of POST /api/orders.
//
// Finding N2, docs/2026-08-10-architecture-security-review.md (and M1 in the
// 2026-08-08 review before it).
//
// This route is public, unauthenticated and unverified. Before these limiters
// the only bound on it was the 3000/15min /api backstop, so a script could post
// hundreds of cash-on-delivery orders with fabricated names and addresses and
// each one would land on the kitchen board as a real ticket — food cooked, a
// driver sent. Since the routing feature landed each accepted order also fires
// an outbound Nominatim lookup, and a flood of distinct fabricated addresses is
// exactly how an installation gets the restaurant's IP blocked by OSM.
//
// HOW THE PER-PHONE LIMITER IS TESTED AT ALL: both limiters are mounted, and the
// per-IP one (5/hour) would always fire first from a single address — so it
// would mask the phone limiter completely. `app.set("trust proxy", 1)` means
// Express takes req.ip from the first X-Forwarded-For entry, so varying that
// header is exactly how a test presents itself as a different client. That is
// not a trick: it is the same code path a real deployment behind Caddy or
// Render uses, so these tests also pin the trust-proxy behaviour the limiters
// depend on.
//
// GEOCODE_DISABLED=1 is forced by the harness, so nothing here can reach OSM.
// ============================================================================

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert");

const harness = require("../helpers/harness");

const COL = harness.COL;

const DISH_ID = "dish-limits-1";
const DISH_PRICE = 300; // over minOrder on its own, so one item is a valid order
const PSC = "43001";

function seedMenu(dbPath) {
    harness.seedRecord(dbPath, COL.menu, harness.MENU_SINGLETON_ID, {
        "hlavni-jidla": [{ id: DISH_ID, name: "Svíčková na smetaně", price: DISH_PRICE, vatRate: 21 }],
    });
}

// Delivery open all day every day, so the suite cannot start failing at 21:01.
function seedSettings(dbPath) {
    const days = {};
    for (let i = 0; i <= 6; i++) days[String(i)] = { open: true, from: "00:00", to: "23:59" };
    harness.seedRecord(dbPath, COL.settings, harness.SETTINGS_ID, {
        delivery: {
            paused: false,
            days,
            fee: 49,
            minOrder: 200,
            freeAbove: 600,
            pscWhitelist: [PSC],
            etaMinutes: 60,
            // Off: batching is not what this file is about, and leaving it on
            // would have every accepted order schedule a geocode.
            routing: { enabled: false },
        },
        notifications: {
            smsOrderConfirmed: false, smsOrderOnTheWay: false,
            smsReservationConfirmed: false, smsReservationReminder: false, emailEnabled: false,
        },
    });
}

let phoneCounter = 0;
function nextPhone() {
    phoneCounter += 1;
    return `+42077700${String(phoneCounter).padStart(4, "0")}`;
}

let ipCounter = 0;
function nextIp() {
    ipCounter += 1;
    return `203.0.113.${ipCounter}`; // TEST-NET-3, reserved for documentation
}

function order(server, { ip, phone }) {
    return fetch(`${server.api}/orders`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            // See the header: this is what makes the request look like it came
            // from `ip` to a server with `trust proxy: 1`.
            "x-forwarded-for": ip,
        },
        body: JSON.stringify({
            customerName: "Jan Novák",
            address: "Školní 50",
            psc: PSC,
            phone,
            items: [{ id: DISH_ID, qty: 1 }],
            paymentMethod: "cash",
        }),
    });
}

describe("delivery order limits", () => {
    let server;

    before(async () => {
        server = await harness.start();
        seedMenu(server.dbPath);
        seedSettings(server.dbPath);
    });

    after(async () => { if (server) await server.stop(); });

    test("a genuine order still goes through untouched", async () => {
        const res = await order(server, { ip: nextIp(), phone: nextPhone() });
        // assert's message argument is evaluated eagerly, so `await res.text()`
        // in it would consume the body even on the success path and make the
        // res.json() below throw. Branch explicitly — same note as
        // tests/smoke/table-orders.test.js's loginAsAdmin.
        if (res.status !== 200) assert.fail(`order refused: ${res.status} ${await res.text()}`);
        const body = await res.json();
        assert.strictEqual(body.success, true);
        assert.strictEqual(body.order.total, DISH_PRICE + 49, "priced server-side, delivery fee included");
    });

    test("the sixth order from one address in an hour is refused", async () => {
        const ip = nextIp();
        const statuses = [];
        // Six attempts, each with its own phone number so ONLY the per-IP
        // limiter can be what refuses any of them.
        for (let i = 0; i < 6; i++) {
            const res = await order(server, { ip, phone: nextPhone() });
            statuses.push(res.status);
            await res.arrayBuffer();
        }

        assert.deepStrictEqual(statuses.slice(0, 5), [200, 200, 200, 200, 200], "five real orders must all land");
        assert.strictEqual(statuses[5], 429, `the sixth must be refused, got ${statuses[5]}`);
    });

    test("the refusal tells the customer to phone instead of just failing", async () => {
        const ip = nextIp();
        for (let i = 0; i < 5; i++) await (await order(server, { ip, phone: nextPhone() })).arrayBuffer();
        const res = await order(server, { ip, phone: nextPhone() });

        assert.strictEqual(res.status, 429);
        const body = await res.json();
        assert.match(body.error, /zavolejte/i, "a blocked real customer needs a way through");
    });

    test("rotating the address does not get past the per-phone limiter", async () => {
        // The per-IP limiter is defeated by rotating addresses, which is cheap.
        // The phone number is the field a fake order cannot make useless to
        // itself — a driver has to be able to ring the customer.
        const phone = nextPhone();
        const statuses = [];
        for (let i = 0; i < 6; i++) {
            const res = await order(server, { ip: nextIp(), phone });
            statuses.push(res.status);
            await res.arrayBuffer();
        }

        assert.deepStrictEqual(statuses.slice(0, 5), [200, 200, 200, 200, 200]);
        assert.strictEqual(statuses[5], 429, "same phone, six different addresses — the phone limiter must catch it");
    });

    test("phone formatting does not create a second bucket", async () => {
        // "+420 777 111 222" and "+420777111222" are one customer. Without the
        // shared normalizePhoneForRateLimit, a script would get a fresh budget
        // per spelling.
        // Every spelling below normalizes to "+420777112233": the normalizer
        // strips spaces, dashes, dots and parentheses, so all six land in one
        // bucket and the sixth is over the limit of five. (A spelling that drops
        // the leading "+" would genuinely be a different key — that is a
        // different number as far as this normalizer is concerned, and
        // phoneSchema is what refuses malformed input.)
        const digits = "+420777112233";
        const spellings = [digits, "+420 777 112 233", "+420-777-112-233", "+420 777-112 233", "+420(777)112233", digits];
        const statuses = [];
        for (const phone of spellings) {
            const res = await order(server, { ip: nextIp(), phone });
            statuses.push(res.status);
            await res.arrayBuffer();
        }
        assert.strictEqual(statuses[5], 429, `six spellings of one number must share a budget, got ${statuses.join(",")}`);
    });

    test("the limiter sits in front of validation, so junk floods are capped too", async () => {
        const ip = nextIp();
        for (let i = 0; i < 5; i++) await (await order(server, { ip, phone: nextPhone() })).arrayBuffer();

        const res = await fetch(`${server.api}/orders`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-forwarded-for": ip },
            body: JSON.stringify({ garbage: true }),
        });
        // 429, not the 400 the schema would give: a caller who has spent their
        // budget cannot make the server do validation work either.
        assert.strictEqual(res.status, 429, "refused by the limiter, not by validation");
    });

    // NOT tested here: that `delivery: false` answers 404 rather than a 429 that
    // would confirm the route exists. requireFeature is mounted first in the
    // chain for exactly that reason, and tests/smoke/features.test.js already
    // asserts the 404 for this route against a server started with the feature
    // off — repeating it here would mean spawning a second server to re-prove
    // someone else's case.
});
