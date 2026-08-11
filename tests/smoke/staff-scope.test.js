// ============================================================================
// staff-scope.test.js — what a waiter's session can actually reach.
//
// Finding M4, docs/2026-08-08-architecture-dataflow-security-review.md:
// "one leaked waiter password reads the entire customer database".
//
// The unit tests cover the rules; this covers the wiring, which is where the
// finding actually lived — the rules were never wrong, they did not exist. Each
// case is written from the attacker's position: I have a valid waiter session,
// what can I get?
//
// The second half is the half that matters just as much: everything a waiter
// legitimately does must still work. The July audit already broke the kitchen's
// delete button by reaching for requireAdmin, and a privacy control that costs
// the floor its screens gets switched off by whoever is running the shift.
// ============================================================================

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert");
const bcrypt = require("bcryptjs");

const harness = require("../helpers/harness");

const COL = harness.COL;

const ADMIN = { id: "scope-admin", abbreviation: "scope-admin", password: "Sc0pe!Admin123" };
const WAITER = { id: "scope-waiter", abbreviation: "scope-waiter", password: "Sc0pe!Waiter123" };

const TABLE_FILE_ID = "scope-table-1";
const TABLE_NAME = "Stůl 1";
const CANCEL_TOKEN = "aBcDeFgHiJkLmNoPqRsTuV";

function seedUser(dbPath, { id, abbreviation, password }, extra = {}) {
    harness.seedRecord(dbPath, COL.users, id, {
        id, abbreviation, name: `Test ${abbreviation}`,
        password: bcrypt.hashSync(password, 12),
        isAdmin: false, isDriver: false, ...extra,
    });
}

function daysAgo(n) {
    return new Date(Date.now() - n * 86400000).toISOString();
}

function cookieFrom(res, prefix) {
    const all = typeof res.headers.getSetCookie === "function"
        ? res.headers.getSetCookie()
        : [res.headers.get("set-cookie")].filter(Boolean);
    const hit = all.find(c => c && c.startsWith(prefix));
    return hit ? hit.split(";")[0] : null;
}

async function login(server, user) {
    const res = await fetch(`${server.api}/users/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ abbreviation: user.abbreviation, password: user.password }),
    });
    if (res.status !== 200) assert.fail(`login failed for ${user.abbreviation}: ${res.status} ${await res.text()}`);
    return cookieFrom(res, "auth_token");
}

const get = (server, path, cookie) => fetch(`${server.api}${path}`, { headers: { cookie } });

describe("what a waiter's session can reach", () => {
    let server, adminCookie, waiterCookie;

    before(async () => {
        server = await harness.start();
        seedUser(server.dbPath, ADMIN, { isAdmin: true });
        seedUser(server.dbPath, WAITER);

        // A year of receipts, so "the archive" is a real thing to be denied.
        for (const [i, age] of [0, 1, 3, 30, 200, 360].entries()) {
            harness.seedRecord(server.dbPath, COL.receipts, `r${i}`, {
                id: `r${i}`, number: `2026-00000${i}`, issuedAt: daysAgo(age),
                total: 250 + i, kind: "indoor",
                items: [{ item: "Svíčková", qty: 1, price: 189, vatRate: 12 }],
            });
        }

        // A delivery order, complete with the PII the finding is about.
        harness.seedRecord(server.dbPath, COL.orders, "o1", {
            id: "o1", customerName: "Jan Novák", address: "Školní 50", psc: "43001",
            phone: "+420600999888", note: "zvonek vpravo", status: "pending",
            items: [], total: 300, createdAt: daysAgo(0), paymentStatus: "unpaid",
        });

        // A booking carrying the guest's cancel credential.
        harness.seedRecord(server.dbPath, COL.timetables, TABLE_FILE_ID, {
            className: TABLE_NAME, fileId: TABLE_FILE_ID,
            data: { "2026-09-14": [{ 5: {
                content: "Eva Malá", abbreviation: "EM", isPermanent: false,
                phone: "+420600111222", guests: 2, cancelToken: CANCEL_TOKEN,
            } }] },
            calendar: "", currentWeek: new Date().toISOString(), info: "", attributes: [],
            seats: 4, layout: null, permanentHours: {},
        });

        adminCookie = await login(server, ADMIN);
        waiterCookie = await login(server, WAITER);
    });

    after(async () => { if (server) await server.stop(); });

    // ── THE FINDING ─────────────────────────────────────────────────────

    test("the delivery order list — every customer's address — is closed to a waiter", async () => {
        const asWaiter = await get(server, "/orders", waiterCookie);
        assert.strictEqual(asWaiter.status, 403, "this was the worst PII read in the app");
        const body = await asWaiter.text();
        assert.ok(!body.includes("Školní 50") && !body.includes("+420600999888"), "and no PII in the refusal");

        const asAdmin = await get(server, "/orders", adminCookie);
        assert.strictEqual(asAdmin.status, 200, "the owner still has it");
        assert.ok((await asAdmin.text()).includes("Školní 50"));
    });

    test("a waiter gets a week of receipts, not the archive", async () => {
        const res = await get(server, "/receipts", waiterCookie);
        assert.strictEqual(res.status, 200, "the screen still works — this must not be a 403");
        const ids = (await res.json()).map(r => r.id);

        assert.ok(ids.includes("r0") && ids.includes("r1") && ids.includes("r2"), "this week's receipts are theirs");
        for (const old of ["r3", "r4", "r5"]) {
            assert.ok(!ids.includes(old), `${old} is older than a shift and must not be served`);
        }
        assert.strictEqual(res.headers.get("x-history-limited-days"), "7", "and the limit is stated, not silent");
    });

    test("a waiter cannot reach past the limit by asking nicely", async () => {
        // The clamp has to survive an explicit `from`, which is the obvious way
        // to try — the frontend sends one.
        for (const qs of ["?from=2020-01-01", "?from=2020-01-01&to=2026-12-31", "?from=not-a-date", "?from="]) {
            const res = await get(server, `/receipts${qs}`, waiterCookie);
            assert.strictEqual(res.status, 200, `${qs} should still render`);
            const ids = (await res.json()).map(r => r.id);
            assert.ok(!ids.includes("r5"), `${qs} must not reach a 360-day-old receipt`);
        }
    });

    test("an admin still gets the whole archive", async () => {
        const res = await get(server, "/receipts?from=2020-01-01", adminCookie);
        const ids = (await res.json()).map(r => r.id);
        assert.ok(ids.includes("r5"), "the owner's own history is not clamped");
        assert.strictEqual(res.headers.get("x-history-limited-days"), null, "and is not flagged as limited");
    });

    test("a waiter gets a week of revenue, not a quarter", async () => {
        const short = await (await get(server, "/stats/sales?days=7", waiterCookie)).json();
        assert.strictEqual(short.days, 7);
        assert.ok(!("historyLimitedTo" in short), "an in-window request is not flagged");

        const long = await (await get(server, "/stats/sales?days=90", waiterCookie)).json();
        assert.strictEqual(long.days, 7, "90 days of takings is the owner's screen");
        assert.strictEqual(long.historyLimitedTo, 7, "and the UI is told why the number shrank");

        const asAdmin = await (await get(server, "/stats/sales?days=90", adminCookie)).json();
        assert.strictEqual(asAdmin.days, 90);
        assert.ok(!("historyLimitedTo" in asAdmin));
    });

    test("the guest's cancel credential is on nobody's wire", async () => {
        // Not a scoping call — nothing client-side reads this, and whoever holds
        // it can cancel the booking. Stripped for the admin too.
        for (const [who, cookie] of [["waiter", waiterCookie], ["admin", adminCookie]]) {
            const body = await (await get(server, `/timetables/${encodeURIComponent(TABLE_NAME)}`, cookie)).text();
            assert.ok(!body.includes(CANCEL_TOKEN), `${who} must not receive cancelToken`);
            assert.ok(!body.includes("cancelToken"), `${who} must not even see the field`);
        }

        // ...and the anonymous view is unchanged: still no guest data at all.
        const anon = await (await fetch(`${server.api}/timetables/${encodeURIComponent(TABLE_NAME)}`)).text();
        assert.ok(!anon.includes(CANCEL_TOKEN) && !anon.includes("Eva Malá") && !anon.includes("+420600111222"));
    });

    test("the driver roster and the tax-filing state are the owner's", async () => {
        assert.strictEqual((await get(server, "/drivers", waiterCookie)).status, 403, "login names are reconnaissance");
        assert.strictEqual((await get(server, "/eet/health", waiterCookie)).status, 403);
    });

    // ── AND THE FLOOR MUST STILL WORK ───────────────────────────────────

    test("everything a waiter actually does still works", async () => {
        // If any of these regress, the shift loses a screen and someone turns
        // the whole thing off. This is the other half of the finding.
        const stillTheirs = [
            ["/kitchen/orders", "the kitchen board"],
            ["/indoor-orders", "the till's open tabs"],
            ["/menu", "prices"],
            ["/combos", "combo deals"],
            ["/settings", "opening hours and VAT"],
            ["/table-qr-tokens", "reprinting a damaged table card"],
            [`/timetables/${encodeURIComponent(TABLE_NAME)}`, "the table's bookings"],
            ["/timetables", "the table list"],
            ["/receipts", "today's receipts"],
            ["/stats/sales?days=1", "today's takings"],
        ];
        for (const [path, what] of stillTheirs) {
            const res = await get(server, path, waiterCookie);
            assert.strictEqual(res.status, 200, `${what} (${path}) must still work for a waiter — got ${res.status}`);
        }
    });

    test("a waiter still sees the guest data their job needs", async () => {
        // The scoping is about the ARCHIVE and about credentials, not about
        // hiding today's guests from the person seating them.
        const body = await (await get(server, `/timetables/${encodeURIComponent(TABLE_NAME)}`, waiterCookie)).text();
        assert.ok(body.includes("Eva Malá"), "the name on tonight's booking");
        assert.ok(body.includes("+420600111222"), "and the phone, for calling about a late table");
    });
});
