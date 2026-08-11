// ============================================================================
// account-lifecycle.test.js — deactivation, password reset, and the session
// revocation both of them depend on.
//
// Finding N3, docs/2026-08-10-architecture-security-review.md.
//
// What was wrong: accounts were create-only. No route could delete, disable or
// re-password one, and requireAuth verified the cookie's signature and then
// trusted the payload — it never re-read the user table. So offboarding a
// waiter or a driver meant editing SQLite by hand, and even that left their
// session working for the rest of its 12 hours — and at the time, GET
// /api/orders (every customer's name, address and phone) was guarded by
// requireAuth alone, so that session could read the lot. Finding M4 has since
// closed that particular route to admins, which narrows the blast radius but
// does not change what this file is about: a revoked session must stop working
// everywhere, not just on the worst route.
//
// THE CENTRAL CASE IN THIS FILE is "a session already open dies the moment the
// account is deactivated". Everything else — the routes, the flags, the
// refusals — is scaffolding around that one property. A regression that let a
// deactivated account keep using an open session would put the whole finding
// back while leaving every other test in this file green, so that case asserts
// against a cookie captured BEFORE the deactivation, never a fresh login.
//
// Real spawned server, real temp SQLite, real HTTP — same harness as the rest
// of tests/smoke.
// ============================================================================

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert");
const bcrypt = require("bcryptjs");

const harness = require("../helpers/harness");

const COL = harness.COL;
const DRIVERS_COLLECTION = "drivers"; // not in harness.COL — see server.js's SERVER_CONFIG.collections

const ADMIN = { id: "acct-admin-1", abbreviation: "lifecycle-admin", password: "L1fecycle!Admin" };
const ADMIN2 = { id: "acct-admin-2", abbreviation: "lifecycle-admin-2", password: "L1fecycle!Admin2" };
const WAITER = { id: "acct-waiter-1", abbreviation: "lifecycle-waiter", password: "L1fecycle!Waiter" };
const DRIVER = { id: "acct-driver-1", username: "lifecycle-driver", password: "L1fecycle!Driver" };

function seedUser(dbPath, { id, abbreviation, password }, extra = {}) {
    harness.seedRecord(dbPath, COL.users, id, {
        id,
        abbreviation,
        name: `Test ${abbreviation}`,
        password: bcrypt.hashSync(password, 12),
        isAdmin: false,
        isDriver: false,
        ...extra,
    });
}

function seedDriver(dbPath, { id, username, password }, extra = {}) {
    harness.seedRecord(dbPath, DRIVERS_COLLECTION, id, {
        id,
        username,
        name: `Test ${username}`,
        password: bcrypt.hashSync(password, 12),
        ...extra,
    });
}

// ── HTTP HELPERS ─────────────────────────────────────────────────────────

function extractCookie(res, namePrefix) {
    const all = typeof res.headers.getSetCookie === "function"
        ? res.headers.getSetCookie()
        : [res.headers.get("set-cookie")].filter(Boolean);
    const hit = all.find(c => c && c.startsWith(namePrefix));
    return hit ? hit.split(";")[0] : null;
}

async function login(server, path, body) {
    const res = await fetch(`${server.api}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
    return { status: res.status, cookie: extractCookie(res, "auth_token"), body: await res.json().catch(() => ({})) };
}

async function loginUser(server, user) {
    const out = await login(server, "/users/login", { abbreviation: user.abbreviation, password: user.password });
    assert.strictEqual(out.status, 200, `login failed for ${user.abbreviation}: ${JSON.stringify(out.body)}`);
    assert.ok(out.cookie, "no session cookie issued");
    return out.cookie;
}

// A session is more than a cookie once CSRF is involved: the mutating routes
// under test require a signed csrf_token cookie AND the same value echoed in a
// header. This bundles the three into one object so a test reads as "acting as
// this person" rather than as header plumbing.
async function sessionFor(server, cookie) {
    const res = await fetch(`${server.api}/csrf-token`, { headers: { cookie } });
    assert.strictEqual(res.status, 200, "could not obtain a CSRF token");
    const csrfCookie = extractCookie(res, "csrf_token");
    const { csrfToken } = await res.json();
    return { cookie: `${cookie}; ${csrfCookie}`, csrfToken };
}

function authedPost(server, session, path, body) {
    return fetch(`${server.api}${path}`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            cookie: session.cookie,
            "x-csrf-token": session.csrfToken,
        },
        body: JSON.stringify(body),
    });
}

// "Is this session still alive?" — asked of a route that ANY live staff session
// may reach, so a 403 can never be mistaken for a dead session.
//
// This used to ask GET /api/orders, chosen because that route was guarded by
// requireAuth alone and answered with every delivery customer's name, address
// and phone — the sharpest possible way to ask. Finding M4 closed it to admins
// (see staff-scope.js), so as a probe it now returns 403 for exactly the
// non-admin sessions these tests are about, which reads as "revoked" when the
// session is fine. GET /indoor-orders is the replacement: requireAuth, no role
// beyond that, and it is what the till itself polls.
function pingAsSession(server, cookie) {
    return fetch(`${server.api}/indoor-orders`, { headers: { cookie } });
}

// ── SUITE ────────────────────────────────────────────────────────────────

describe("account lifecycle", () => {
    let server;
    let adminSession;

    before(async () => {
        server = await harness.start();
        seedUser(server.dbPath, ADMIN, { isAdmin: true });
        seedUser(server.dbPath, ADMIN2, { isAdmin: true });
        seedUser(server.dbPath, WAITER);
        seedDriver(server.dbPath, DRIVER);
        adminSession = await sessionFor(server, await loginUser(server, ADMIN));
    });

    after(async () => { if (server) await server.stop(); });

    // ── the property the whole finding is about ─────────────────────────

    test("deactivating an account kills the session it already has open", async () => {
        const waiterCookie = await loginUser(server, WAITER);
        assert.strictEqual((await pingAsSession(server, waiterCookie)).status, 200, "the waiter's session should start out working");

        const res = await authedPost(server, adminSession, `/users/${WAITER.id}/active`, { active: false });
        assert.strictEqual(res.status, 200, await res.text());

        // The same cookie, not a fresh login. This is the case that used to be
        // impossible to make true.
        assert.strictEqual((await pingAsSession(server, waiterCookie)).status, 401,
            "a deactivated account's open session must stop working immediately");
    });

    test("a deactivated account cannot log back in, and is not told why", async () => {
        const out = await login(server, "/users/login", { abbreviation: WAITER.abbreviation, password: WAITER.password });
        assert.strictEqual(out.status, 401);
        // Byte-identical to a wrong password: telling the two apart would be a
        // free "this abbreviation exists" oracle.
        assert.strictEqual(out.body.error, "Nesprávné jméno nebo heslo");
        assert.strictEqual(out.cookie, null, "no session cookie may be issued");
    });

    test("the audit log records the real reason even though the response does not", async () => {
        const res = await fetch(`${server.api}/security/login-audit`, { headers: { cookie: adminSession.cookie } });
        assert.strictEqual(res.status, 200);
        const rows = await res.json();
        const hit = rows.find(r => r.identifier === WAITER.abbreviation && r.reason === "inactive");
        assert.ok(hit, "the refused login should be visible to staff as 'inactive'");
        assert.strictEqual(hit.success, false);
    });

    test("reactivating restores login, and does not resurrect the old session", async () => {
        const staleCookie = await (async () => {
            // Capture a cookie from BEFORE the deactivation bump by logging in
            // while active, then deactivating again.
            await authedPost(server, adminSession, `/users/${WAITER.id}/active`, { active: true });
            const cookie = await loginUser(server, WAITER);
            await authedPost(server, adminSession, `/users/${WAITER.id}/active`, { active: false });
            return cookie;
        })();

        const res = await authedPost(server, adminSession, `/users/${WAITER.id}/active`, { active: true });
        assert.strictEqual(res.status, 200);

        // Logging in works again...
        const fresh = await loginUser(server, WAITER);
        assert.strictEqual((await pingAsSession(server, fresh)).status, 200);

        // ...but the cookie that was revoked stays revoked. Reactivation must
        // not un-bump tokenVersion, or "deactivate, think better of it,
        // reactivate" would silently hand the leaver's tablet back.
        assert.strictEqual((await pingAsSession(server, staleCookie)).status, 401,
            "a revoked session must not come back to life when the account is reactivated");
    });

    // ── password reset ──────────────────────────────────────────────────

    test("changing a password logs the account out everywhere and takes effect at once", async () => {
        const oldCookie = await loginUser(server, WAITER);
        const newPassword = "N3w!Waiter!Pass";

        const res = await authedPost(server, adminSession, `/users/${WAITER.id}/password`, { password: newPassword });
        assert.strictEqual(res.status, 200, await res.text());

        assert.strictEqual((await pingAsSession(server, oldCookie)).status, 401,
            "a password reset must end sessions opened with the old one");

        const stale = await login(server, "/users/login", { abbreviation: WAITER.abbreviation, password: WAITER.password });
        assert.strictEqual(stale.status, 401, "the old password must stop working");

        const fresh = await login(server, "/users/login", { abbreviation: WAITER.abbreviation, password: newPassword });
        assert.strictEqual(fresh.status, 200, "the new password must work");

        WAITER.password = newPassword; // later cases log in with it
    });

    test("the response never carries the password hash", async () => {
        const res = await authedPost(server, adminSession, `/users/${WAITER.id}/password`, { password: WAITER.password });
        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.ok(!("password" in body), "the hash must be stripped, as it is everywhere else");
        assert.strictEqual(body.id, WAITER.id);
    });

    test("a password the create route would refuse is refused here too", async () => {
        const res = await authedPost(server, adminSession, `/users/${WAITER.id}/password`, { password: "x" });
        assert.strictEqual(res.status, 400);
        assert.match((await res.json()).error, /Heslo/i);
    });

    // ── lockout guards ──────────────────────────────────────────────────

    test("an admin cannot deactivate their own account", async () => {
        const res = await authedPost(server, adminSession, `/users/${ADMIN.id}/active`, { active: false });
        assert.strictEqual(res.status, 409);
        assert.match((await res.json()).error, /vlastní účet/i);

        assert.strictEqual((await pingAsSession(server, adminSession.cookie)).status, 200, "and is still logged in");
    });

    test("an admin can never deactivate the restaurant out of its own admin panel", async () => {
        // The invariant, stated as the thing that actually matters rather than
        // as the shape of the check that enforces it: however many admins get
        // switched off, at least one active admin is always left.
        //
        // The enforcement is a single rule (you may not deactivate yourself),
        // and this proves it is sufficient — deactivate EVERY other admin, and
        // the door is still open.
        seedUser(server.dbPath, { id: "acct-admin-3", abbreviation: "lifecycle-admin-3", password: "L1fecycle!Admin3" }, { isAdmin: true });

        for (const id of [ADMIN2.id, "acct-admin-3"]) {
            const res = await authedPost(server, adminSession, `/users/${id}/active`, { active: false });
            assert.strictEqual(res.status, 200, `deactivating ${id} should be allowed: ${await res.text()}`);
        }

        // Every other admin is now off, and the last one standing cannot
        // remove themselves.
        const suicide = await authedPost(server, adminSession, `/users/${ADMIN.id}/active`, { active: false });
        assert.strictEqual(suicide.status, 409);

        const admins = (await (await fetch(`${server.api}/users`, { headers: { cookie: adminSession.cookie } })).json())
            .filter(u => u.isAdmin && u.active !== false);
        assert.ok(admins.length >= 1, "at least one active admin must always remain");

        // A deactivated admin cannot log in to undo any of this either, which
        // is what makes the invariant worth having.
        const locked = await login(server, "/users/login", { abbreviation: ADMIN2.abbreviation, password: ADMIN2.password });
        assert.strictEqual(locked.status, 401);

        assert.strictEqual((await authedPost(server, adminSession, `/users/${ADMIN2.id}/active`, { active: true })).status, 200);
    });

    test("an account switched off directly in the database is refused too", async () => {
        // Pins the `active` check independently of tokenVersion. The route
        // bumps both, so without this case the two guards are indistinguishable
        // and one could be deleted with every test still green. This is also
        // the real historical workflow — before these routes existed, editing
        // SQLite by hand was the ONLY way to disable an account — so it has to
        // keep working.
        const target = { id: "acct-manual-1", abbreviation: "lifecycle-manual", password: "M4nual!Pass123" };
        seedUser(server.dbPath, target);
        const cookie = await loginUser(server, target);
        assert.strictEqual((await pingAsSession(server, cookie)).status, 200);

        const record = harness.readRecord(server.dbPath, COL.users, target.id);
        assert.ok(!record.tokenVersion, "fixture must not carry a bump, or this proves nothing");
        harness.seedRecord(server.dbPath, COL.users, target.id, { ...record, active: false });

        assert.strictEqual((await pingAsSession(server, cookie)).status, 401,
            "active:false alone must end the session, with no tokenVersion change involved");
    });

    // ── drivers ─────────────────────────────────────────────────────────

    test("a driver-collection account can be deactivated too, and its session dies", async () => {
        const out = await login(server, "/drivers/login", { username: DRIVER.username, password: DRIVER.password });
        assert.strictEqual(out.status, 200, JSON.stringify(out.body));
        assert.strictEqual((await pingAsSession(server, out.cookie)).status, 200);

        const res = await authedPost(server, adminSession, `/drivers/${DRIVER.id}/active`, { active: false });
        assert.strictEqual(res.status, 200, await res.text());

        assert.strictEqual((await pingAsSession(server, out.cookie)).status, 401,
            "drivers are the lowest-trust account here — their sessions must be revocable");

        const relogin = await login(server, "/drivers/login", { username: DRIVER.username, password: DRIVER.password });
        assert.strictEqual(relogin.status, 401);
        assert.strictEqual(relogin.body.error, "Nesprávné jméno nebo heslo");
    });

    // ── authorization on the new routes themselves ──────────────────────

    test("a non-admin cannot deactivate anyone", async () => {
        const waiterSession = await sessionFor(server, await loginUser(server, WAITER));
        const res = await authedPost(server, waiterSession, `/users/${ADMIN.id}/active`, { active: false });
        assert.strictEqual(res.status, 403);
    });

    test("an unauthenticated caller cannot either", async () => {
        const res = await fetch(`${server.api}/users/${ADMIN.id}/active`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ active: false }),
        });
        // 403 from the CSRF layer, which is mounted first — the point is that
        // it is refused, not which of the two guards catches it.
        assert.ok(res.status === 401 || res.status === 403, `expected a refusal, got ${res.status}`);
    });

    test("a valid session without the CSRF header is refused", async () => {
        const res = await fetch(`${server.api}/users/${WAITER.id}/active`, {
            method: "POST",
            headers: { "content-type": "application/json", cookie: adminSession.cookie },
            body: JSON.stringify({ active: false }),
        });
        assert.strictEqual(res.status, 403);
    });

    test("an unknown account id is a 404, not a 500", async () => {
        const res = await authedPost(server, adminSession, `/users/doesnotexist123/active`, { active: false });
        assert.strictEqual(res.status, 404);
    });

    test("the active flag must be a real boolean", async () => {
        for (const bad of [{ active: "false" }, { active: 0 }, {}, { active: null }]) {
            const res = await authedPost(server, adminSession, `/users/${WAITER.id}/active`, bad);
            assert.strictEqual(res.status, 400, `${JSON.stringify(bad)} must not be coerced into a state change`);
        }
    });

    // ── backwards compatibility ─────────────────────────────────────────

    test("accounts written before this feature keep working untouched", async () => {
        // No `active`, no `tokenVersion` — exactly what every existing row in
        // a live database looks like. Both must default rather than fail
        // closed, or deploying this would lock the whole restaurant out.
        const legacy = { id: "acct-legacy-1", abbreviation: "lifecycle-legacy", password: "L3gacy!Pass123" };
        harness.seedRecord(server.dbPath, COL.users, legacy.id, {
            id: legacy.id,
            abbreviation: legacy.abbreviation,
            name: "Legacy Account",
            password: bcrypt.hashSync(legacy.password, 12),
            isAdmin: false,
            isDriver: false,
        });

        const cookie = await loginUser(server, legacy);
        assert.strictEqual((await pingAsSession(server, cookie)).status, 200);

        // ...and are still revocable, from a stored tokenVersion of 0.
        assert.strictEqual((await authedPost(server, adminSession, `/users/${legacy.id}/active`, { active: false })).status, 200);
        assert.strictEqual((await pingAsSession(server, cookie)).status, 401);
    });

    test("a demotion takes effect without waiting for a re-login", async () => {
        // Same mechanism, one step further: requireAuth now rebuilds the
        // session's flags from storage, so admin rights lost mid-shift are
        // lost immediately rather than at the next login.
        const promoted = { id: "acct-temp-admin", abbreviation: "lifecycle-temp", password: "T3mp!Admin123" };
        seedUser(server.dbPath, promoted, { isAdmin: true });

        const cookie = await loginUser(server, promoted);
        assert.strictEqual((await fetch(`${server.api}/users`, { headers: { cookie } })).status, 200, "starts out an admin");

        const record = harness.readRecord(server.dbPath, COL.users, promoted.id);
        harness.seedRecord(server.dbPath, COL.users, promoted.id, { ...record, isAdmin: false });

        assert.strictEqual((await fetch(`${server.api}/users`, { headers: { cookie } })).status, 403,
            "the admin-only route must refuse them now, not after their cookie expires");
        assert.strictEqual((await pingAsSession(server, cookie)).status, 200, "but they are still logged in as staff");
    });

    test("a deactivated staff session stops seeing guest data on the public timetable route", async () => {
        // GET /timetables/:name decides between the full record and the
        // whitelisted public view by asking "is this a staff session?" through
        // its own cookie-reading helper, NOT through requireAuth — so that
        // helper needs the same account re-check, or it becomes the one place
        // a disabled session still counts as staff.
        harness.seedRecord(server.dbPath, COL.timetables, "acct-table-1", {
            className: "Stůl L", fileId: "acct-table-1",
            data: { "2026-09-01": [{ 5: { content: "Jan Novák", phone: "+420600111222", isPermanent: false } }] },
            calendar: "", currentWeek: new Date().toISOString(), info: "", attributes: [],
            seats: 4, layout: null, permanentHours: {},
        });

        const spy = { id: "acct-spy-1", abbreviation: "lifecycle-spy", password: "Sp1!Pass12345" };
        seedUser(server.dbPath, spy);
        const cookie = await loginUser(server, spy);

        const asStaff = await (await fetch(`${server.api}/timetables/${encodeURIComponent("Stůl L")}`, { headers: { cookie } })).text();
        assert.ok(asStaff.includes("+420600111222"), "a live staff session should see the guest's phone");

        assert.strictEqual((await authedPost(server, adminSession, `/users/${spy.id}/active`, { active: false })).status, 200);

        const afterwards = await (await fetch(`${server.api}/timetables/${encodeURIComponent("Stůl L")}`, { headers: { cookie } })).text();
        assert.ok(!afterwards.includes("+420600111222"), "a deactivated session must fall back to the public view");
        assert.ok(!afterwards.includes("Jan Novák"), "and must not carry the guest's name either");
    });
});
