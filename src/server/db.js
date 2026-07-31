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

module.exports = { getDb, list, get, set, remove, removeAll, DB_PATH };
