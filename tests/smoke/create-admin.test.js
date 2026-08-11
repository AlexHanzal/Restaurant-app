// ============================================================================
// create-admin.test.js (smoke) — THE test that proves finding L3 is actually
// fixed: an installer with a completely fresh database can create the first
// admin account and log in with it, over real HTTP against a real server.
//
// Everything else about deploy/create-admin.js (record shape, hashing,
// duplicate refusal) is covered at the unit level in
// tests/unit/create-admin.test.js. This file exists because none of that
// proves the actual claim — "the installer can get in" — only that the
// function that runs before the server exists behaves correctly in
// isolation. This starts the real src/server/server.js (via the same
// harness every other smoke suite uses) against the exact SQLite file
// create-admin.js just wrote to, and calls the real POST /users/login route.
// ============================================================================

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert");
const os = require("os");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const harness = require("../helpers/harness");

// db.js resolves SQLITE_PATH at require time — set it before requiring
// db.js or create-admin.js (same requirement as the unit test, and as
// db-patch.test.js).
const TMP_DB = path.join(os.tmpdir(), `create-admin-smoke-${process.pid}-${crypto.randomBytes(6).toString("hex")}.db`);
process.env.SQLITE_PATH = TMP_DB;

const db = require("../../src/server/db");
const { createAdmin } = require("../../deploy/create-admin");

function extractCookie(res, namePrefix) {
    const all = typeof res.headers.getSetCookie === "function"
        ? res.headers.getSetCookie()
        : [res.headers.get("set-cookie")].filter(Boolean);
    const hit = all.find(c => c && c.startsWith(namePrefix));
    return hit ? hit.split(";")[0] : null;
}

describe("create-admin.js closes the fresh-install gap (finding L3)", () => {
    let server;
    const ADMIN = { name: "Install Admin", abbreviation: "install-admin", password: "Inst4ll!Admin" };

    before(async () => {
        // The database create-admin.js writes to does not exist yet — this
        // IS the fresh-install scenario. createAdmin() calls db.getDb()
        // internally, which creates the file/table on first touch (same as
        // initializeData() does for the server itself), so nothing needs to
        // pre-create it.
        const result = await createAdmin(ADMIN);
        assert.strictEqual(result.ok, true, `admin creation must succeed on a fresh DB: ${JSON.stringify(result)}`);

        // Close this process's handle before the server (a separate child
        // process) opens the same file — avoids a Windows file-lock race
        // between the two processes.
        db.getDb().close();

        // Same file, handed to a REAL spawned server exactly as an
        // installer's SQLITE_PATH env var would.
        server = await harness.start({ env: { SQLITE_PATH: TMP_DB } });
    });

    after(async () => {
        if (server) await server.stop();
        for (const suffix of ["", "-wal", "-shm"]) {
            try { fs.unlinkSync(TMP_DB + suffix); } catch { /* already cleaned up or never existed */ }
        }
    });

    test("the installer-created admin can log in over real HTTP", async () => {
        const res = await fetch(`${server.api}/users/login`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ abbreviation: ADMIN.abbreviation, password: ADMIN.password }),
        });

        // Read the cookie header and the body ONCE, up front — a fetch
        // Response body can only be consumed once, and the earlier version
        // of this test called `await res.text()` INSIDE the assertion
        // message template. Template literals evaluate eagerly regardless
        // of whether the assertion goes on to pass or fail, so that drained
        // the body even on a 200, and the res.json() call below then threw
        // "Body has already been read" — a real bug in the test, not in
        // create-admin.js. Reusing one parsed body for both the failure
        // message and the assertions below is what actually fixes it.
        const cookie = extractCookie(res, "auth_token");
        const body = await res.json().catch(() => ({}));

        assert.strictEqual(res.status, 200, `login must succeed for the installer-created admin: ${JSON.stringify(body)}`);
        assert.ok(cookie, "a session cookie must be issued");
        assert.strictEqual(body.abbreviation, ADMIN.abbreviation);
        assert.strictEqual(body.isAdmin, true, "the account must actually carry admin rights");
        assert.ok(!("password" in body), "the login response must never carry the password hash");
    });

    test("the session actually works — an admin-only route accepts it", async () => {
        const login = await fetch(`${server.api}/users/login`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ abbreviation: ADMIN.abbreviation, password: ADMIN.password }),
        });
        const cookie = extractCookie(login, "auth_token");

        // GET /api/users is requireAdmin-gated (src/server/server.js) — the
        // whole point of finding L3 is that, before this script, NOTHING
        // could ever satisfy that gate on a fresh database. Reaching it now
        // is the actual "an installer can get in" claim, one level past
        // just accepting the login request.
        const res = await fetch(`${server.api}/users`, { headers: { cookie } });
        assert.strictEqual(res.status, 200, "the installer-created admin must be able to reach an admin-only route");

        const users = await res.json();
        assert.ok(users.some(u => u.abbreviation === ADMIN.abbreviation));
    });

    test("a wrong password for the installer-created account is still refused", async () => {
        const res = await fetch(`${server.api}/users/login`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ abbreviation: ADMIN.abbreviation, password: "wrong-password" }),
        });
        assert.strictEqual(res.status, 401);
    });
});
