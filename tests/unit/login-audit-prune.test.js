// ============================================================================
// login-audit-prune.test.js — pruneLoginAudit() against a REAL SQLite file.
//
// tests/unit/login-audit-retention.test.js covers which ids the rule picks.
// This covers the part that actually destroys data: list -> select -> remove.
// A bug there deletes the wrong rows, and an audit trail is the one table in
// this app you cannot reconstruct afterwards, so "the survivors are still
// intact and unchanged" is asserted as carefully as "the old ones are gone".
// ============================================================================

const test = require("node:test");
const assert = require("node:assert");
const os = require("os");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

// Must precede the require of security.js -> db.js, which resolves DB_PATH at
// module load. Without it this would prune the owner's real data/app.db.
const TMP_DB = path.join(os.tmpdir(), `login-audit-${process.pid}-${crypto.randomBytes(6).toString("hex")}.db`);
process.env.SQLITE_PATH = TMP_DB;

const db = require("../../src/server/db");
const security = require("../../src/server/security");

const COLLECTION = "login_audit";
const DAY = 24 * 3600 * 1000;
const NOW = new Date("2026-08-05T12:00:00Z");

test.after(() => {
    try { db.getDb().close(); } catch { /* already closed */ }
    for (const suffix of ["", "-wal", "-shm"]) {
        try { fs.unlinkSync(TMP_DB + suffix); } catch { /* never existed */ }
    }
});

function writeEntry(id, ageDays, extra = {}) {
    db.set(COLLECTION, id, {
        id,
        scope: "user",
        identifier: "alex",
        success: false,
        ip: "203.0.113.7",
        reason: "bad_password",
        at: new Date(NOW.getTime() - ageDays * DAY).toISOString(),
        ...extra,
    });
}

test("prune deletes only the expired rows and leaves the rest byte-identical", () => {
    writeEntry("keep-1", 1);
    writeEntry("keep-2", 30);
    writeEntry("drop-1", 120);
    writeEntry("drop-2", 400);

    const before = db.get(COLLECTION, "keep-1");

    const removed = security.pruneLoginAudit(NOW);
    assert.strictEqual(removed, 2, "expected exactly the two out-of-window rows to go");

    assert.strictEqual(db.get(COLLECTION, "drop-1"), null);
    assert.strictEqual(db.get(COLLECTION, "drop-2"), null);

    // Survivors must be untouched, not merely present — prune must never
    // rewrite an audit record it decided to keep.
    assert.deepStrictEqual(db.get(COLLECTION, "keep-1"), before);
    assert.ok(db.get(COLLECTION, "keep-2"));
    assert.strictEqual(db.list(COLLECTION).length, 2);
});

test("prune is a no-op when nothing has expired", () => {
    for (const id of db.list(COLLECTION).map(r => r.id)) db.remove(COLLECTION, id);
    writeEntry("recent", 2);

    assert.strictEqual(security.pruneLoginAudit(NOW), 0);
    assert.strictEqual(db.list(COLLECTION).length, 1);
    assert.ok(db.get(COLLECTION, "recent"));
});

test("prune does not touch other collections", () => {
    db.set("orders", "order-1", { id: "order-1", total: 150 });
    writeEntry("ancient", 999);

    security.pruneLoginAudit(NOW);

    assert.deepStrictEqual(db.get("orders", "order-1"), { id: "order-1", total: 150 });
});
