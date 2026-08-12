// ============================================================================
// deploy/backup.js — takes a consistent snapshot of the restaurant's database,
// verifies it, and rotates old ones. Meant to be run by cron or a systemd
// timer; safe to run while the app is serving.
//
// WHY THIS EXISTS. Everything the business has is one SQLite file: every
// reservation, every order, and every receipt — and receipts are tax documents
// the restaurant is legally required to keep for 5-10 years. Losing that file
// is not an outage, it is an accounting problem with a deadline. Until this
// script there was no backup at all: `GET /api/export` downloads the database,
// but it is a manual click by a logged-in admin, which is not a backup
// strategy, it is a person remembering.
//
// WHY NOT `cp app.db backups/`. Because it silently produces a corrupt or
// stale copy. The database runs in WAL mode (see db.js), so at any moment an
// unknown amount of committed data lives in `app.db-wal` and not in `app.db`
// itself. Copying the main file alone loses whatever is in the WAL; copying all
// three files with three separate `cp` calls copies them at three different
// instants, which can produce a set that does not agree with itself. Both
// failures are silent — you get a file, it looks like a database, and you find
// out at restore time.
//
// So this uses SQLite's ONLINE BACKUP API (better-sqlite3's db.backup()), which
// is the operation designed for exactly this: it copies pages under the
// database's own locking, restarting itself if a writer changes a page
// mid-copy, and produces a single file that is a transactionally consistent
// snapshot. The restaurant can be taking orders throughout.
//
// WHAT MAKES A BACKUP REAL. Two things this script insists on, because a backup
// nobody has verified is a hope:
//
//   1. Every snapshot is opened and checked before this script reports success
//      — PRAGMA integrity_check, plus a comparison of row counts per collection
//      against the live database. A file that cannot be opened, or that is
//      missing rows, is deleted rather than left to be discovered later.
//   2. deploy/restore.js exists, and tests/smoke/backup-restore.test.js
//      performs a real round trip: back up, destroy, restore, and assert the
//      data came back. An untested restore is not a backup.
//
// Usage:
//   node deploy/backup.js                  # snapshot into <db dir>/backups
//   node deploy/backup.js --dir /mnt/nas   # somewhere else
//   node deploy/backup.js --keep 30        # rotation depth (default 14)
//   node deploy/backup.js --quiet          # only errors, for cron
// ============================================================================

const fs = require("fs");
const path = require("path");
const { parseArgs } = require("util");
const Database = require("better-sqlite3");

const db = require("../src/server/db");

const DEFAULT_KEEP = 14;

// The prefix is what rotation matches on, so it must not collide with anything
// else an operator might park in the same folder. Timestamp is UTC and
// colon-free so the name is valid on every filesystem, and sorts lexically in
// chronological order — which is what makes rotation a slice rather than a
// date parse.
const PREFIX = "app-";
const SUFFIX = ".db";

function timestamp(now = new Date()) {
    return now.toISOString().replace(/[:.]/g, "-").replace(/Z$/, "Z");
}

function backupName(now) {
    return `${PREFIX}${timestamp(now)}${SUFFIX}`;
}

/** Row counts per collection, the cheap "is this the same database" check. */
function collectionCounts(database) {
    const rows = database
        .prepare(`SELECT collection, COUNT(*) AS n FROM records GROUP BY collection`)
        .all();
    const out = {};
    for (const row of rows) out[row.collection] = row.n;
    return out;
}

/**
 * Opens a finished snapshot and proves it is usable.
 *
 * Deliberately opens it as a SEPARATE connection rather than trusting the
 * backup call's return value: the thing we care about is whether this FILE can
 * be opened and read by something that knows nothing about the process that
 * wrote it, which is precisely the situation a restore is in.
 */
function verifyBackup(file, expectedCounts) {
    const checked = new Database(file, { readonly: true });
    try {
        const integrity = checked.pragma("integrity_check", { simple: true });
        if (integrity !== "ok") throw new Error(`integrity_check returned "${integrity}"`);

        const actual = collectionCounts(checked);
        const problems = [];
        for (const [collection, expected] of Object.entries(expectedCounts)) {
            const got = actual[collection] || 0;
            // Greater-than is fine and expected: the restaurant keeps taking
            // orders while the snapshot is being written, so a collection can
            // legitimately have gained rows between the copy and this check.
            // FEWER rows than the source had is the failure worth catching.
            if (got < expected) problems.push(`${collection}: ${got} rows, source had ${expected}`);
        }
        if (problems.length) throw new Error(`snapshot is missing rows — ${problems.join("; ")}`);

        return { integrity, counts: actual };
    } finally {
        checked.close();
    }
}

/** Deletes all but the newest `keep` snapshots. Returns the names removed. */
function rotate(dir, keep) {
    const snapshots = fs.readdirSync(dir)
        .filter(name => name.startsWith(PREFIX) && name.endsWith(SUFFIX))
        .sort() // ISO timestamps sort chronologically
        .reverse();

    const doomed = snapshots.slice(keep);
    for (const name of doomed) fs.unlinkSync(path.join(dir, name));
    return doomed;
}

/**
 * Takes one verified snapshot.
 *
 * @returns {Promise<{file, bytes, counts, removed}>}
 */
// `verify` is injectable for one reason: the delete-on-failed-verification path
// below is the most important behaviour in this file and the hardest to reach
// honestly, because a faithful copy of a healthy database does not fail
// verification on demand. Without a seam that branch would be untested — and it
// is precisely the branch that stops a corrupt snapshot sitting in the folder
// looking like a good one. Production always uses the default.
async function backup({ dir, keep = DEFAULT_KEEP, now = new Date(), verify = verifyBackup } = {}) {
    const source = db.getDb();
    const targetDir = dir || path.join(path.dirname(db.DB_PATH), "backups");
    fs.mkdirSync(targetDir, { recursive: true });

    const file = path.join(targetDir, backupName(now));
    const expected = collectionCounts(source);

    // The online backup. Safe against concurrent writers — this is the whole
    // reason the script exists rather than a cp.
    await source.backup(file);

    let counts;
    try {
        ({ counts } = verify(file, expected));
    } catch (e) {
        // A snapshot that failed verification is worse than no snapshot: it
        // would sit in the folder looking like a good one and be picked by a
        // restore. Remove it and fail loudly.
        try { fs.unlinkSync(file); } catch { /* nothing to clean up */ }
        throw new Error(`Záloha se nezdařila a byla smazána: ${e.message}`);
    }

    return {
        file,
        bytes: fs.statSync(file).size,
        counts,
        removed: rotate(targetDir, keep),
    };
}

// ── CLI ──────────────────────────────────────────────────────────────────

function printHelp() {
    console.log(`
Vytvoří konzistentní zálohu databáze restaurace. Lze spustit i za provozu —
používá vestavěnou zálohovací funkci SQLite, ne kopírování souboru.

Použití:
  node deploy/backup.js [--dir <složka>] [--keep <počet>] [--quiet]

Volby:
  --dir     Kam zálohu uložit. Výchozí: <složka databáze>/backups
  --keep    Kolik posledních záloh ponechat. Výchozí: ${DEFAULT_KEEP}
  --quiet   Vypisovat jen chyby (pro cron).
  --help    Zobrazí tuhle nápovědu.

Databáze se bere z proměnné SQLITE_PATH, stejně jako ji čte aplikace.

Obnovení ze zálohy: node deploy/restore.js <soubor>
`.trim());
}

async function runCli() {
    let parsed;
    try {
        parsed = parseArgs({
            options: {
                dir: { type: "string" },
                keep: { type: "string" },
                quiet: { type: "boolean", default: false },
                help: { type: "boolean", short: "h", default: false },
            },
            allowPositionals: false,
        });
    } catch (e) {
        console.error(`Chyba: ${e.message}\n`);
        printHelp();
        process.exitCode = 1;
        return;
    }

    if (parsed.values.help) return printHelp();

    const keep = parsed.values.keep === undefined ? DEFAULT_KEEP : Number(parsed.values.keep);
    if (!Number.isInteger(keep) || keep < 1) {
        console.error("Chyba: --keep musí být celé číslo alespoň 1.");
        process.exitCode = 1;
        return;
    }

    const log = parsed.values.quiet ? () => {} : (...args) => console.log(...args);

    try {
        log(`Databáze: ${db.DB_PATH}`);
        const result = await backup({ dir: parsed.values.dir, keep });

        const total = Object.values(result.counts).reduce((sum, n) => sum + n, 0);
        log(`✅ Záloha vytvořena a ověřena: ${result.file}`);
        log(`   ${(result.bytes / 1024).toFixed(0)} kB, ${total} záznamů`);
        if (result.removed.length) {
            log(`   Smazáno starých záloh: ${result.removed.length} (ponecháno ${keep})`);
        }
    } catch (e) {
        // Non-zero exit so cron notices. A backup that fails quietly is the
        // same as no backup, discovered at the worst possible moment.
        console.error(`❌ ${e.message}`);
        process.exitCode = 1;
    }
}

if (require.main === module) runCli();

module.exports = { backup, verifyBackup, rotate, collectionCounts, backupName, PREFIX, SUFFIX, DEFAULT_KEEP };
