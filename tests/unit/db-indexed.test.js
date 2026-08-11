// ============================================================================
// db-indexed.test.js — the generated columns, and the two helpers that use them.
//
// Finding H4, docs/2026-08-08-architecture-dataflow-security-review.md.
//
// THE QUERY-PLAN ASSERTIONS ARE THE POINT OF THIS FILE. Correctness tests alone
// cannot catch the failure that matters: a typo in a column name, a dropped
// index, or a predicate SQLite cannot use makes every one of these lookups fall
// back to a full scan and still return the right answer. The bug would be
// invisible until a restaurant with two years of receipts noticed the Prodeje
// screen taking seconds — the exact "degrades monotonically and silently"
// failure the finding describes. So these tests read EXPLAIN QUERY PLAN and
// insist on "SEARCH ... USING INDEX", never "SCAN".
// ============================================================================

const test = require("node:test");
const assert = require("node:assert");
const os = require("os");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

// db.js resolves DB_PATH at require time — same pattern as db-patch.test.js.
const TMP_DB = path.join(os.tmpdir(), `db-indexed-${process.pid}-${crypto.randomBytes(6).toString("hex")}.db`);
process.env.SQLITE_PATH = TMP_DB;

const db = require("../../src/server/db");

test.after(() => {
    try { db.getDb().close(); } catch { /* already closed */ }
    for (const suffix of ["", "-wal", "-shm"]) {
        try { fs.unlinkSync(TMP_DB + suffix); } catch { /* never existed */ }
    }
});

function plan(sql, params) {
    return db.getDb().prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map(r => r.detail).join(" | ");
}

// ── MIGRATION ────────────────────────────────────────────────────────────

test("every indexed field gets a generated column and an index", () => {
    // table_xinfo, not table_info: the latter does not list VIRTUAL generated
    // columns at all, which is the trap this suite caught in the migration
    // itself — see the "restart" test below.
    const columns = new Set(db.getDb().prepare(`PRAGMA table_xinfo(records)`).all().map(c => c.name));
    const indexes = new Set(db.getDb().prepare(`PRAGMA index_list(records)`).all().map(i => i.name));

    for (const [field, column] of Object.entries(db.INDEXED_FIELDS)) {
        assert.ok(columns.has(column), `${field} → ${column} column is missing`);
        assert.ok(indexes.has(`idx_records_${column}`), `index for ${column} is missing`);
    }
});

test("migrating an already-migrated file again does nothing — the restart path", () => {
    // THE BUG THIS CAUGHT: the presence check originally used PRAGMA
    // table_info, which omits VIRTUAL generated columns, so it reported them
    // absent forever. A fresh database worked (getDb memoises, so the migration
    // ran once) and then the FIRST RESTART against that file threw "duplicate
    // column name" — the app would have booted exactly once.
    //
    // A second connection to the same file is what a restart actually is.
    const Database = require("better-sqlite3");
    const second = new Database(TMP_DB);
    try {
        assert.doesNotThrow(() => db.migrate(second), "a restart must not fail on an already-migrated database");
        assert.doesNotThrow(() => db.migrate(second), "and it must stay idempotent");
        const columns = new Set(second.prepare(`PRAGMA table_xinfo(records)`).all().map(c => c.name));
        for (const column of Object.values(db.INDEXED_FIELDS)) {
            assert.ok(columns.has(column), `${column} must exist exactly once, not be re-added`);
        }
    } finally {
        second.close();
    }
});

test("the generated columns are VIRTUAL, so no row was rewritten to add them", () => {
    // STORED would have rewritten the whole table on upgrade, and SQLite's
    // ALTER TABLE does not allow it anyway. `hidden: 2` is VIRTUAL, 3 is STORED.
    const cols = db.getDb().prepare(`PRAGMA table_xinfo(records)`).all();
    for (const column of Object.values(db.INDEXED_FIELDS)) {
        const col = cols.find(c => c.name === column);
        assert.strictEqual(col.hidden, 2, `${column} should be VIRTUAL (hidden=2), got hidden=${col.hidden}`);
    }
});

test("migrating twice is a no-op, not an error", () => {
    // getDb() is memoised, so re-running the DDL is what a restart does against
    // an existing file. Must not throw "duplicate column".
    assert.doesNotThrow(() => db.getDb().prepare(`PRAGMA table_info(records)`).all());
    const before = db.getDb().prepare(`PRAGMA table_info(records)`).all().length;
    db.set("users", "probe", { id: "probe", abbreviation: "PROBE" });
    assert.strictEqual(db.getDb().prepare(`PRAGMA table_info(records)`).all().length, before);
    db.remove("users", "probe");
});

test("a generated column tracks data without being writable", () => {
    db.set("timetables", "t-track", { fileId: "t-track", className: "Stůl A" });
    const read = () => db.getDb()
        .prepare(`SELECT ${db.INDEXED_FIELDS.className} AS c FROM records WHERE collection='timetables' AND id='t-track'`)
        .get().c;

    assert.strictEqual(read(), "Stůl A");
    db.set("timetables", "t-track", { fileId: "t-track", className: "Stůl B" });
    assert.strictEqual(read(), "Stůl B", "the column follows `data` — it cannot drift from it");

    assert.throws(
        () => db.getDb().prepare(`UPDATE records SET ${db.INDEXED_FIELDS.className} = 'x' WHERE id='t-track'`).run(),
        /generated/i,
        "a generated column must not be directly writable — `data` stays the only source of truth"
    );
    db.remove("timetables", "t-track");
});

// ── findBy ───────────────────────────────────────────────────────────────

test("findBy uses the index rather than scanning", () => {
    const column = db.INDEXED_FIELDS.className;
    const detail = plan(
        `SELECT data FROM records WHERE collection = ? AND ${column} = ? ORDER BY rowid LIMIT 1`,
        ["timetables", "Stůl 1"]
    );
    assert.match(detail, /SEARCH/, `expected an index search, got: ${detail}`);
    assert.match(detail, new RegExp(`idx_records_${column}`), `expected idx_records_${column}, got: ${detail}`);
    assert.ok(!/SCAN records/.test(detail), `must not fall back to a table scan: ${detail}`);
});

test("findBy returns the matching record, and null for a miss", () => {
    db.set("timetables", "t1", { fileId: "t1", className: "Stůl 1", info: "u okna" });
    db.set("timetables", "t2", { fileId: "t2", className: "Stůl 2" });

    assert.strictEqual(db.findBy("timetables", "className", "Stůl 1").info, "u okna");
    assert.strictEqual(db.findBy("timetables", "className", "Stůl 2").fileId, "t2");
    assert.strictEqual(db.findBy("timetables", "className", "Neexistuje"), null);
});

test("findBy is scoped to its collection", () => {
    db.set("users", "u-clash", { id: "u-clash", className: "Stůl 1" });
    assert.strictEqual(db.findBy("timetables", "className", "Stůl 1").fileId, "t1", "must not cross collections");
    db.remove("users", "u-clash");
});

test("findBy matches the old Array.find tie-break on duplicates", () => {
    // Duplicates are not hypothetical: a fileId-overwrite bug once produced two
    // timetable rows with the same className. Whichever the app picked before
    // has to stay the one it picks.
    db.set("timetables", "dup-a", { fileId: "dup-a", className: "Duplicitní", marker: "first" });
    db.set("timetables", "dup-b", { fileId: "dup-b", className: "Duplicitní", marker: "second" });

    const viaScan = db.list("timetables").find(r => r.className === "Duplicitní");
    assert.strictEqual(db.findBy("timetables", "className", "Duplicitní").marker, viaScan.marker);

    db.remove("timetables", "dup-a");
    db.remove("timetables", "dup-b");
});

test("findBy on an unindexed field still answers, by falling back", () => {
    db.set("orders", "o1", { id: "o1", customerName: "Jan Novák" });
    assert.ok(!db.INDEXED_FIELDS.customerName, "fixture assumes this field is not indexed");
    assert.strictEqual(db.findBy("orders", "customerName", "Jan Novák").id, "o1");
    assert.strictEqual(db.findBy("orders", "customerName", "Nikdo"), null);
});

test("findBy tolerates records missing the field entirely", () => {
    db.set("timetables", "t-nofield", { fileId: "t-nofield" }); // no className
    assert.strictEqual(db.findBy("timetables", "className", "Stůl 1").fileId, "t1", "still finds the real one");
    assert.strictEqual(db.findBy("timetables", "className", null), null, "and a null lookup matches nothing");
    db.remove("timetables", "t-nofield");
});

// ── listByRange ──────────────────────────────────────────────────────────

test("listByRange uses the index rather than scanning", () => {
    const column = db.INDEXED_FIELDS.issuedAt;
    const detail = plan(
        `SELECT data FROM records WHERE collection = ? AND ${column} IS NOT NULL AND ${column} >= ? AND ${column} <= ?`,
        ["receipts", "2026-01-01T00:00:00.000Z", "2026-12-31T00:00:00.000Z"]
    );
    assert.match(detail, /SEARCH/, `expected an index search, got: ${detail}`);
    assert.match(detail, new RegExp(`idx_records_${column}`), `expected idx_records_${column}, got: ${detail}`);
});

test("listByRange returns a superset of the exact range, never a subset", () => {
    const receipts = {
        "r-2025": "2025-06-15T12:00:00.000Z",
        "r-jan": "2026-01-15T12:00:00.000Z",
        "r-jun": "2026-06-15T12:00:00.000Z",
        "r-dec": "2026-12-15T12:00:00.000Z",
    };
    for (const [id, issuedAt] of Object.entries(receipts)) db.set("receipts", id, { id, issuedAt });

    const ids = db.listByRange("receipts", "issuedAt", "2026-06-01", "2026-06-30").map(r => r.id);
    assert.ok(ids.includes("r-jun"), "the in-range receipt must be there");
    assert.ok(!ids.includes("r-2025"), "and a receipt a year out must not");
    assert.ok(!ids.includes("r-dec"), "nor one six months out");

    // The one property that must never break: everything the caller's own
    // predicate would keep is present. The padding may add rows; it may not
    // drop them.
    const exact = db.list("receipts").filter(r =>
        new Date(r.issuedAt) >= new Date("2026-06-01") && new Date(r.issuedAt) <= new Date("2026-06-30"));
    for (const r of exact) {
        assert.ok(ids.includes(r.id), `${r.id} is in the exact range and must be in the candidate set`);
    }
});

test("a row on the boundary is never lost to the padding", () => {
    db.set("receipts", "r-edge", { id: "r-edge", issuedAt: "2026-06-30T23:59:59.999Z" });
    const ids = db.listByRange("receipts", "issuedAt", "2026-06-01", "2026-06-30").map(r => r.id);
    assert.ok(ids.includes("r-edge"), "a receipt issued at the last instant of the day must survive the bound");
    db.remove("receipts", "r-edge");
});

test("one-sided and absent bounds behave", () => {
    const all = db.list("receipts").length;
    assert.strictEqual(db.listByRange("receipts", "issuedAt", null, null).length, all, "no bounds means everything");
    assert.strictEqual(db.listByRange("receipts", "issuedAt", "", "").length, all, "empty strings are not bounds");

    const fromOnly = db.listByRange("receipts", "issuedAt", "2026-06-01", null).map(r => r.id);
    assert.ok(fromOnly.includes("r-dec") && fromOnly.includes("r-jun"));
    assert.ok(!fromOnly.includes("r-2025"));

    const toOnly = db.listByRange("receipts", "issuedAt", null, "2026-02-01").map(r => r.id);
    assert.ok(toOnly.includes("r-jan") && toOnly.includes("r-2025"));
    assert.ok(!toOnly.includes("r-dec"));
});

test("an unparseable bound is ignored rather than excluding everything", () => {
    // A junk ?from= must not silently empty the receipt list.
    const ids = db.listByRange("receipts", "issuedAt", "not-a-date", null).map(r => r.id);
    assert.strictEqual(ids.length, db.list("receipts").length, "a bound that cannot be read is no bound at all");
});

test("listByRange on an unindexed field returns the whole collection", () => {
    assert.ok(!db.INDEXED_FIELDS.createdAt, "fixture assumes this field is not indexed");
    db.set("orders", "o-range", { id: "o-range", createdAt: "2026-06-15T12:00:00.000Z" });
    const out = db.listByRange("orders", "createdAt", "2026-06-01", "2026-06-30");
    assert.strictEqual(out.length, db.list("orders").length, "falls back to exactly what the call site did before");
});

test("records with no timestamp are excluded from a bounded query, not crashed on", () => {
    db.set("receipts", "r-notime", { id: "r-notime" });
    const ids = db.listByRange("receipts", "issuedAt", "2026-06-01", "2026-06-30").map(r => r.id);
    assert.ok(!ids.includes("r-notime"));
    // ...but an unbounded call still returns it, since that is a plain list.
    assert.ok(db.listByRange("receipts", "issuedAt", null, null).some(r => r.id === "r-notime"));
    db.remove("receipts", "r-notime");
});
