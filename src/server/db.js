// ============================================================================
// db.js — thin SQLite storage layer.
//
// Design goal: minimize changes to server.js. Instead of one JSON file per
// record (data/orders/<id>.json, data/timetables/<fileId>.json, ...), every
// record now lives as a row in a single generic table:
//
//   records(collection TEXT, id TEXT, data TEXT /* JSON */, PRIMARY KEY(collection, id))
//
// server.js keeps working with plain JS objects exactly as before — it just
// calls db.list/get/set/remove instead of fs.readdir/readFile/writeFile/unlink.
//
// Requires: npm install better-sqlite3
// ============================================================================

const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

const DB_PATH = process.env.SQLITE_PATH || path.resolve(process.cwd(), "data", "app.db");

let db = null;

// ── INDEXED FIELDS (H4) ─────────────────────────────────────────────────
//
// The generic records(collection, id, data JSON) table had exactly one index,
// on `collection`. Nothing inside `data` was indexable, so EVERY query with a
// predicate was "read the whole collection, JSON.parse every row, filter in
// JavaScript". That is what made the following ordinary operations O(rows):
//
//   POST /users/login          parsed every user row to find one abbreviation
//   POST /drivers/login        parsed every driver row
//   9 timetable routes         parsed every table to find one className
//   GET /receipts?from=&to=    parsed every receipt ever issued
//
// and because better-sqlite3 is synchronous and Node is single-threaded, a slow
// scan does not merely slow its own request down — it blocks the event loop for
// every other one, including the kitchen board and the till.
//
// The fix does NOT require restructuring the data. SQLite can index an
// expression over a JSON column via a VIRTUAL generated column, so each field
// below becomes indexable while the stored objects stay byte-identical: no
// migration, no change to what any route returns, and `data` remains the single
// source of truth (a generated column cannot drift from it — SQLite recomputes
// it from `data` on every read).
//
// VIRTUAL, not STORED, for two reasons: SQLite's ALTER TABLE only permits
// adding VIRTUAL generated columns, and STORED would rewrite the whole table on
// upgrade. VIRTUAL costs a json_extract per row scanned, which is exactly what
// the index exists to avoid doing.
//
// Adding a field here is not enough to make it fast — a call site has to ask
// for it through findBy/listByRange. Everything else keeps working unchanged.
const INDEXED_FIELDS = {
    className: "gen_class_name",
    abbreviation: "gen_abbreviation",
    username: "gen_username",
    issuedAt: "gen_issued_at",
};

function migrate(database) {
    database.exec(`
        CREATE TABLE IF NOT EXISTS records (
            collection TEXT NOT NULL,
            id         TEXT NOT NULL,
            data       TEXT NOT NULL,
            PRIMARY KEY (collection, id)
        );
        CREATE INDEX IF NOT EXISTS idx_records_collection ON records(collection);
    `);

    // Idempotent: an existing database gets the columns added, a fresh one gets
    // them here too, and a restart finds them already present. Checked rather
    // than swallowing a "duplicate column" error, so a real failure is not
    // mistaken for "already done".
    //
    // table_xinfo, NOT table_info — and this is not a detail. `table_info`
    // omits VIRTUAL generated columns entirely, so it reports every column here
    // as absent no matter how many times they have been added. The check would
    // pass on a fresh database (memoised connection, migration runs once) and
    // then throw "duplicate column name" on the FIRST RESTART against the
    // resulting file, i.e. the app would boot exactly once. `table_xinfo` is
    // the variant that lists hidden and generated columns.
    const existing = new Set(database.prepare(`PRAGMA table_xinfo(records)`).all().map(c => c.name));

    for (const [field, column] of Object.entries(INDEXED_FIELDS)) {
        if (!existing.has(column)) {
            // The field name is a hardcoded key of INDEXED_FIELDS, never
            // caller-supplied, so there is no injection surface here — but it is
            // interpolated into DDL, which is worth being explicit about.
            database.exec(
                `ALTER TABLE records ADD COLUMN ${column} TEXT ` +
                `GENERATED ALWAYS AS (json_extract(data, '$.${field}')) VIRTUAL`
            );
        }
        // Composite with `collection` first: every query is scoped to one
        // collection, and a bare index on the field alone would make SQLite
        // choose between filtering by collection or by field, not both.
        database.exec(
            `CREATE INDEX IF NOT EXISTS idx_records_${column} ON records(collection, ${column})`
        );
    }
}

function getDb() {
    if (db) return db;

    // Make sure the containing folder exists (e.g. "data/")
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    migrate(db);
    return db;
}

// Returns an array of parsed JS objects for every record in `collection`.
function list(collection) {
    const rows = getDb()
        .prepare(`SELECT data FROM records WHERE collection = ?`)
        .all(collection);
    return rows.map(r => JSON.parse(r.data));
}

// Finds the ONE record in `collection` whose `field` equals `value`, or null.
//
// Drop-in replacement for `db.list(c).find(r => r[field] === value)`, and
// deliberately identical in behaviour including the tie-break: ORDER BY rowid
// means the oldest matching row wins, which is what Array.find() over an
// unordered SELECT returned in practice. That matters because duplicates are
// not merely theoretical here — a fileId-overwrite bug once produced two
// timetable rows with the same className, and whichever row the app picked
// needed to stay the same one.
//
// A field that is not indexed falls back to the scan it replaces rather than
// throwing. That keeps this safe to call anywhere: the worst case is today's
// performance, never a 500. Add the field to INDEXED_FIELDS to make it fast.
function findBy(collection, field, value) {
    const column = INDEXED_FIELDS[field];
    if (!column) {
        return list(collection).find(r => r && r[field] === value) || null;
    }
    const row = getDb()
        .prepare(`SELECT data FROM records WHERE collection = ? AND ${column} = ? ORDER BY rowid LIMIT 1`)
        .get(collection, value);
    return row ? JSON.parse(row.data) : null;
}

// CANDIDATES whose `field` falls in [fromIso, toIso], as a deliberately
// GENEROUS superset — the caller is expected to keep its own exact predicate.
//
// Why a superset rather than an exact answer: the stored values are ISO-8601
// strings, which sort chronologically only while every producer writes the same
// shape (`new Date().toISOString()` does). Comparing them as strings in SQL is
// therefore right for all data this app writes — but if one legacy row is in
// some other format, an exact SQL bound would silently DROP it, and a filter
// that loses records is worse than one that is slow. So both ends are padded by
// a day and the JavaScript predicate downstream stays the authority. A day of
// slack costs nothing against years of receipts; being wrong costs a receipt.
//
// Unindexed field, or a missing/unparseable bound: falls back to the full list,
// which is exactly what the call site did before.
const RANGE_PAD_MS = 24 * 60 * 60 * 1000;

function listByRange(collection, field, from, to) {
    const column = INDEXED_FIELDS[field];
    if (!column) return list(collection);

    const pad = (value, direction) => {
        if (value === undefined || value === null || value === "") return null;
        const t = new Date(value).getTime();
        if (!Number.isFinite(t)) return null; // unusable bound → do not bound
        return new Date(t + direction * RANGE_PAD_MS).toISOString();
    };

    const lower = pad(from, -1);
    const upper = pad(to, +1);
    if (!lower && !upper) return list(collection);

    const clauses = [`collection = ?`];
    const params = [collection];
    // IS NOT NULL keeps a row whose field is absent out of a bounded query —
    // json_extract returns NULL there, and NULL fails every comparison anyway;
    // stating it makes the intent legible in the query plan.
    clauses.push(`${column} IS NOT NULL`);
    if (lower) { clauses.push(`${column} >= ?`); params.push(lower); }
    if (upper) { clauses.push(`${column} <= ?`); params.push(upper); }

    return getDb()
        .prepare(`SELECT data FROM records WHERE ${clauses.join(" AND ")}`)
        .all(...params)
        .map(r => JSON.parse(r.data));
}

// Returns the parsed object for a single id, or null if missing.
function get(collection, id) {
    const row = getDb()
        .prepare(`SELECT data FROM records WHERE collection = ? AND id = ?`)
        .get(collection, id);
    return row ? JSON.parse(row.data) : null;
}

// Insert or overwrite a record.
function set(collection, id, dataObj) {
    getDb()
        .prepare(`
            INSERT INTO records (collection, id, data) VALUES (?, ?, ?)
            ON CONFLICT(collection, id) DO UPDATE SET data = excluded.data
        `)
        .run(collection, id, JSON.stringify(dataObj));
    return dataObj;
}

// Inserts a NEW record only if `collection`/`id` is not already present, and
// reports which happened — true if this call created the row, false if a row
// was already there (regardless of who wrote it or when; the caller decides
// what "already there" means).
//
// This is the primitive a caller uses to RESERVE an id before doing any work,
// instead of checking then acting. set()'s ON CONFLICT DO UPDATE always
// writes, so two concurrent get()-then-set() callers can both "win" the
// check; ON CONFLICT DO NOTHING instead lets SQLite itself pick exactly one
// winner, and better-sqlite3's synchronous .run() makes that pick final
// before either caller's JS resumes — no interleaving is possible even if
// the two calls originate from requests that are otherwise racing.
//
// idempotency.js is the motivating caller (finding L1): it reserves an
// Idempotency-Key row BEFORE running the handler it guards, so two requests
// carrying the same key can no longer both observe "not used yet".
function insertIfAbsent(collection, id, dataObj) {
    const info = getDb()
        .prepare(`
            INSERT INTO records (collection, id, data) VALUES (?, ?, ?)
            ON CONFLICT(collection, id) DO NOTHING
        `)
        .run(collection, id, JSON.stringify(dataObj));
    return info.changes > 0;
}

// Overwrites an existing record only if its CURRENT data is byte-identical to
// the serialised form of `expectedDataObj`, and reports whether the swap
// happened. Safe to compare by serialised equality because every record this
// table holds is written exclusively through this module, so "the JSON I
// read back is the JSON already there" is exactly the condition that matters
// — nothing else in the process re-serialises the same object independently.
//
// This is an optimistic lock: two callers can both read the same row and
// both decide it should be replaced (e.g. both conclude an old reservation
// looks abandoned), but only the first UPDATE can still match the WHERE
// clause once SQLite has committed it — the loser's WHERE matches zero rows
// and its swap silently fails, which is the correct outcome for a loser.
// idempotency.js uses this to steal an expired reservation without racing
// another request doing the same thing at the same moment.
function compareAndSwap(collection, id, expectedDataObj, newDataObj) {
    const info = getDb()
        .prepare(`
            UPDATE records SET data = ?
            WHERE collection = ? AND id = ? AND data = ?
        `)
        .run(JSON.stringify(newDataObj), collection, id, JSON.stringify(expectedDataObj));
    return info.changes > 0;
}

// Applies `changes` on top of whatever is CURRENTLY stored — not on top of a
// copy the caller read earlier. Returns the merged record, or null if the id
// no longer exists (in which case nothing is written: a record deleted while
// a gateway call was in flight must not come back as a fragment made only of
// the fields being patched).
//
// This exists for the one write pattern in this app that spans an `await`:
// the pay-online routes read an order, call GoPay (a real network round trip,
// ~1s), then write the order back. Whatever else happened to that order in
// the meantime — most realistically the cook tapping "hotovo" — was silently
// reverted by that write, with nothing in any log to explain the ticket
// reappearing on the board.
//
// Every other read-modify-write in this codebase is already safe without it:
// better-sqlite3 is synchronous and Node is single-threaded, so a get() and a
// set() with no `await` between them cannot interleave with another request.
// The get/set pair below is likewise atomic with respect to other handlers
// for exactly that reason — which is why this is a plain merge and not a
// transaction.
function patch(collection, id, changes) {
    const current = get(collection, id);
    if (!current) return null;
    const merged = { ...current, ...changes };
    set(collection, id, merged);
    return merged;
}

// Deletes a single record. Returns true if something was actually deleted.
function remove(collection, id) {
    const info = getDb()
        .prepare(`DELETE FROM records WHERE collection = ? AND id = ?`)
        .run(collection, id);
    return info.changes > 0;
}

// Deletes every record in a collection (used by the "reset all timetables" route).
function removeAll(collection) {
    getDb().prepare(`DELETE FROM records WHERE collection = ?`).run(collection);
}

module.exports = {
    getDb, list, get, set, patch, remove, removeAll, DB_PATH,
    // Indexed lookups (H4)
    findBy, listByRange, INDEXED_FIELDS,
    // Atomic reserve / steal primitives (L1 — idempotency.js)
    insertIfAbsent, compareAndSwap,
    // Exported for one test only: that re-running it against an already-migrated
    // file does nothing, which is what every restart after the first one does.
    // getDb() memoises its connection, so nothing else can reach this path.
    migrate,
};
