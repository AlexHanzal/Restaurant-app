// ============================================================================
// create-admin.test.js — deploy/create-admin.js's account-creation core.
//
// Finding L3: a fresh install has no way to create its first admin account.
// This file pins the record createAdmin() writes (same shape POST /api/users
// produces), that the stored hash actually verifies the password and the
// plaintext appears nowhere in the row, and that a duplicate abbreviation is
// refused (it is the login identifier — see createAdmin()'s own comment on
// why two rows sharing one is a real, previously-seen bug shape).
//
// The end-to-end claim — "an installer can actually get in" — is a separate,
// smoke-level test: tests/smoke/create-admin.test.js starts a real server
// against the DB this script wrote to and logs in over HTTP.
// ============================================================================

const test = require("node:test");
const assert = require("node:assert");
const os = require("os");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");

// db.js resolves SQLITE_PATH at require time, so this has to happen before
// requiring either db.js or create-admin.js (which requires db.js itself).
const TMP_DB = path.join(os.tmpdir(), `create-admin-${process.pid}-${crypto.randomBytes(6).toString("hex")}.db`);
process.env.SQLITE_PATH = TMP_DB;

const db = require("../../src/server/db");
const { createAdmin, listAdmins, COL_USERS } = require("../../deploy/create-admin");

test.after(() => {
    try { db.getDb().close(); } catch { /* already closed */ }
    for (const suffix of ["", "-wal", "-shm"]) {
        try { fs.unlinkSync(TMP_DB + suffix); } catch { /* never existed */ }
    }
});

test("creates a record shaped exactly like POST /api/users would", async () => {
    const result = await createAdmin({ name: "Jana Nováková", abbreviation: "jn", password: "Sup3rSecret!" });
    assert.strictEqual(result.ok, true, JSON.stringify(result));

    const stored = db.get(COL_USERS, result.user.id);
    assert.ok(stored, "record must actually be persisted");
    assert.deepStrictEqual(Object.keys(stored).sort(), [
        "abbreviation", "createdAt", "id", "isAdmin", "isDriver", "name", "password",
    ].sort());
    assert.strictEqual(stored.name, "Jana Nováková");
    assert.strictEqual(stored.abbreviation, "jn");
    assert.strictEqual(stored.isAdmin, true);
    assert.strictEqual(stored.isDriver, false);
    assert.strictEqual(typeof stored.id, "string");
    assert.strictEqual(stored.id.length, 12, "ids must match generateFileId()'s default length");
    assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(stored.createdAt), "createdAt must be an ISO timestamp");
});

// This is the one assertion that actually pins "respects SQLITE_PATH",
// rather than trusting that db.js's own db.get() agrees with wherever db.js
// itself decided to write — that comparison would still pass even if db.js
// silently ignored SQLITE_PATH and wrote everywhere to one fixed file,
// because every caller in THIS process (the test's `db.get` above and
// create-admin.js's `db.set`) would still be reading and writing the same
// (wrong) file and agree with each other. Opening TMP_DB directly, with a
// connection that never went through db.js's module-level DB_PATH at all,
// is what actually catches that failure mode: if create-admin.js/db.js
// wrote somewhere else, this file would never have been created.
test("writes to the exact file named by SQLITE_PATH, not wherever db.js's default would be", async () => {
    const result = await createAdmin({ name: "Path Check", abbreviation: "path-check", password: "P4thCheck!" });
    assert.strictEqual(result.ok, true, JSON.stringify(result));

    assert.ok(fs.existsSync(TMP_DB), `SQLITE_PATH's file (${TMP_DB}) must exist after a write`);

    const raw = new Database(TMP_DB, { readonly: true });
    try {
        const row = raw.prepare(`SELECT data FROM records WHERE collection = ? AND id = ?`).get(COL_USERS, result.user.id);
        assert.ok(row, `the new admin must be readable straight out of the SQLITE_PATH file (${TMP_DB})`);
        assert.strictEqual(JSON.parse(row.data).abbreviation, "path-check");
    } finally {
        raw.close();
    }
});

test("the returned user has the password stripped, like every route that echoes one back", async () => {
    const result = await createAdmin({ name: "Petr Svoboda", abbreviation: "ps1", password: "An0therSecret!" });
    assert.strictEqual(result.ok, true);
    assert.ok(!("password" in result.user), "the hash must not be in the returned object");
});

test("the stored hash actually verifies the password, at bcrypt cost 12", async () => {
    const password = "Cor3ctHorseBattery!";
    const result = await createAdmin({ name: "Cost Check", abbreviation: "cost-check", password });
    assert.strictEqual(result.ok, true);

    const stored = db.get(COL_USERS, result.user.id);
    assert.ok(await bcrypt.compare(password, stored.password), "stored hash must verify the plaintext password");
    assert.ok(!(await bcrypt.compare("wrong-password", stored.password)), "must not verify an unrelated password");

    // bcrypt hash format: $2<a|b|y>$<cost>$<22-char-salt><31-char-hash>
    const costField = stored.password.split("$")[2];
    assert.strictEqual(costField, "12", `expected bcrypt cost 12, got cost field "${costField}"`);
});

test("the plaintext password appears nowhere in the stored row", async () => {
    const password = "Th1sMustNeverAppearRaw!";
    const result = await createAdmin({ name: "Plaintext Check", abbreviation: "plaintext-check", password });
    assert.strictEqual(result.ok, true);

    const stored = db.get(COL_USERS, result.user.id);
    const serialized = JSON.stringify(stored);
    assert.ok(!serialized.includes(password), "the plaintext password must not appear anywhere in the stored record");
});

test("a duplicate abbreviation is refused — it is the login identifier", async () => {
    const first = await createAdmin({ name: "First Owner", abbreviation: "dup-test", password: "First!Pass123" });
    assert.strictEqual(first.ok, true);

    const usersBefore = db.list(COL_USERS).length;

    const second = await createAdmin({ name: "Second Owner", abbreviation: "dup-test", password: "Second!Pass123" });
    assert.strictEqual(second.ok, false);
    assert.match(second.error, /existuje/i);

    assert.strictEqual(db.list(COL_USERS).length, usersBefore, "nothing must be written on a refused duplicate");
});

test("a duplicate abbreviation is refused even with different surrounding whitespace", async () => {
    const first = await createAdmin({ name: "Trim Owner", abbreviation: "trim-test", password: "Trim!Pass123" });
    assert.strictEqual(first.ok, true);

    const second = await createAdmin({ name: "Trim Owner 2", abbreviation: "  trim-test  ", password: "Trim2!Pass123" });
    assert.strictEqual(second.ok, false, "abbreviation must be compared trimmed, the same way it is stored trimmed");
});

test("validation matches createUserSchema's bounds", async () => {
    const base = { name: "Bounds Check", abbreviation: "bounds-check", password: "Val1dPass!" };

    assert.strictEqual((await createAdmin({ ...base, name: "" })).ok, false, "empty name refused");
    assert.strictEqual((await createAdmin({ ...base, name: "x".repeat(151) })).ok, false, "name over 150 chars refused");
    assert.strictEqual((await createAdmin({ ...base, abbreviation: "" })).ok, false, "empty abbreviation refused");
    assert.strictEqual((await createAdmin({ ...base, abbreviation: "x".repeat(101) })).ok, false, "abbreviation over 100 chars refused");
    assert.strictEqual((await createAdmin({ ...base, password: "abc" })).ok, false, "password under 4 chars refused (createUserSchema's floor)");
    assert.strictEqual((await createAdmin({ ...base, password: "x".repeat(201) })).ok, false, "password over 200 chars refused");
    assert.strictEqual((await createAdmin({ ...base, password: "" })).ok, false, "empty password refused");
});

test("a valid 4-character password (createUserSchema's floor) is accepted", async () => {
    const result = await createAdmin({ name: "Floor Check", abbreviation: "floor-check", password: "abcd" });
    assert.strictEqual(result.ok, true, JSON.stringify(result));
});

test("listAdmins() returns only isAdmin accounts, for the CLI's second-admin warning", async () => {
    const before = listAdmins().length;
    const admin = await createAdmin({ name: "List Check", abbreviation: "list-check", password: "L1stCheck!" });
    assert.strictEqual(admin.ok, true);

    // A non-admin user written directly (mirrors what POST /api/users with
    // isAdmin unset would produce) must NOT show up in listAdmins().
    db.set(COL_USERS, "list-check-waiter", {
        id: "list-check-waiter", name: "Waiter", abbreviation: "list-check-waiter",
        password: "irrelevant-for-this-test", isAdmin: false, isDriver: false, createdAt: new Date().toISOString(),
    });

    const after = listAdmins();
    assert.strictEqual(after.length, before + 1, "only the new admin should have been added to the admin count");
    assert.ok(after.some(u => u.abbreviation === "list-check"));
    assert.ok(!after.some(u => u.abbreviation === "list-check-waiter"));
});
