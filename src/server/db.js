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

function getDb() {
    if (db) return db;

    // Make sure the containing folder exists (e.g. "data/")
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.exec(`
        CREATE TABLE IF NOT EXISTS records (
            collection TEXT NOT NULL,
            id         TEXT NOT NULL,
            data       TEXT NOT NULL,
            PRIMARY KEY (collection, id)
        );
        CREATE INDEX IF NOT EXISTS idx_records_collection ON records(collection);
    `);
    return db;
}

// Returns an array of parsed JS objects for every record in `collection`.
function list(collection) {
    const rows = getDb()
        .prepare(`SELECT data FROM records WHERE collection = ?`)
        .all(collection);
    return rows.map(r => JSON.parse(r.data));
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

module.exports = { getDb, list, get, set, patch, remove, removeAll, DB_PATH };
