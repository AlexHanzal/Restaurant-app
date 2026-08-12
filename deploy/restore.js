// ============================================================================
// deploy/restore.js — puts a backup back, carefully.
//
// This is the half that makes the other half real. A backup nobody has ever
// restored is a hope, not a plan, and the moment you find out is the moment you
// can least afford to. tests/smoke/backup-restore.test.js performs the whole
// round trip — back up, destroy, restore, verify — so the procedure below is
// exercised on every test run rather than first attempted during an incident.
//
// FOUR THINGS THIS DOES THAT A `cp` DOES NOT, each of which is a way people
// lose data while trying to recover it:
//
//   1. VERIFIES THE BACKUP FIRST. Opens it, runs integrity_check, confirms it
//      has the expected table and some rows — BEFORE touching the live file.
//      Restoring a truncated or half-downloaded backup over a working database
//      turns a bad day into an unrecoverable one.
//
//   2. SNAPSHOTS THE CURRENT DATABASE FIRST, to <db>.pre-restore-<timestamp>.
//      Restores get run in a hurry, from the wrong file, by someone who has
//      been awake too long. This is the undo. It is taken even when the current
//      database looks broken, because "looks broken" is a judgement made at 2am.
//
//   3. REMOVES THE -wal AND -shm SIDECARS. This is the subtle one and the most
//      likely to be missed by hand. The database runs in WAL mode, so if the
//      old `app.db-wal` is left next to the new `app.db`, SQLite may replay
//      that stale write-ahead log on top of the restored file — mixing two
//      different databases together. The result opens without complaint.
//
//   4. VERIFIES AGAIN AFTERWARDS, and tells you what came back: how many
//      reservations, orders, receipts. A restore that reports "done" without
//      saying what is in the file is asking to be trusted on nothing.
//
// The app must be STOPPED while this runs. That is not enforceable from here —
// nothing in a Node script can be sure another process does not hold the file —
// so it is asked for, and confirmed, rather than assumed.
//
// Usage:
//   node deploy/restore.js <záloha.db>
//   node deploy/restore.js <záloha.db> --force     # no prompt, for scripts
// ============================================================================

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { parseArgs } = require("util");
const Database = require("better-sqlite3");

const db = require("../src/server/db");

// SQLite's WAL sidecars. Both must go when the main file is replaced — see
// point 3 in the header.
const SIDECARS = ["-wal", "-shm"];

/**
 * Opens a candidate backup and confirms it is a usable database of the right
 * shape. Throws with a Czech message the operator can act on.
 */
function inspectBackup(file) {
    if (!fs.existsSync(file)) throw new Error(`Soubor neexistuje: ${file}`);
    const bytes = fs.statSync(file).size;
    if (bytes === 0) throw new Error(`Soubor je prázdný: ${file}`);

    // The open itself is NOT where a bad file fails. better-sqlite3 opens
    // lazily, so `new Database("half a download")` succeeds and the real error
    // arrives on the first query — which means a try/catch around the
    // constructor alone lets a raw SqliteError escape to the operator instead
    // of the Czech sentence they can act on. Everything is inside one guard.
    let candidate;
    try {
        candidate = new Database(file, { readonly: true, fileMustExist: true });
    } catch (e) {
        throw new Error(`Soubor není platná databáze SQLite: ${e.message}`);
    }

    try {
        let integrity;
        try {
            integrity = candidate.pragma("integrity_check", { simple: true });
        } catch (e) {
            throw new Error(`Soubor není platná databáze SQLite: ${e.message}`);
        }
        if (integrity !== "ok") throw new Error(`Záloha je poškozená (integrity_check: ${integrity}).`);

        const hasTable = candidate
            .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='records'`)
            .get();
        if (!hasTable) {
            throw new Error("Záloha neobsahuje tabulku `records` — tohle není databáze téhle aplikace.");
        }

        const rows = candidate
            .prepare(`SELECT collection, COUNT(*) AS n FROM records GROUP BY collection ORDER BY collection`)
            .all();
        const counts = {};
        for (const row of rows) counts[row.collection] = row.n;

        return { bytes, counts, total: rows.reduce((sum, r) => sum + r.n, 0) };
    } finally {
        candidate.close();
    }
}

function removeSidecars(target) {
    for (const suffix of SIDECARS) {
        const sidecar = target + suffix;
        if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar);
    }
}

/** Copies the live database aside so a wrong restore is undoable. */
function snapshotCurrent(target, now = new Date()) {
    if (!fs.existsSync(target)) return null; // nothing to preserve — a fresh install
    const stamp = now.toISOString().replace(/[:.]/g, "-");
    const aside = `${target}.pre-restore-${stamp}`;
    fs.copyFileSync(target, aside);
    // Sidecars too: without them the copy is the same torn snapshot this whole
    // script exists to avoid, and this is the file someone reaches for when the
    // restore turns out to have been a mistake.
    for (const suffix of SIDECARS) {
        if (fs.existsSync(target + suffix)) fs.copyFileSync(target + suffix, aside + suffix);
    }
    return aside;
}

/**
 * Performs the restore.
 *
 * @returns {{restored, from, previous, counts, total}}
 */
function restore(backupFile, { target = db.DB_PATH, now = new Date() } = {}) {
    // Validate before touching anything. Called again here even though the CLI
    // already did it, so that restore() is safe on its own terms — a caller
    // that skipped the check must not be able to overwrite a live database
    // with a truncated file.
    inspectBackup(backupFile);

    const previous = snapshotCurrent(target, now);

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(backupFile, target);

    // See header point 3: a stale WAL beside a restored database can be
    // replayed on top of it, silently mixing two databases.
    removeSidecars(target);

    // Prove the thing we just wrote is readable where it now lives, rather than
    // trusting that a copy of a good file is a good file.
    const after = inspectBackup(target);

    // Opening a WAL-mode database creates fresh -wal/-shm files, so the
    // verification above puts sidecars back — empty ones belonging to the
    // restored database, not the dangerous stale ones, but still clutter that
    // makes "did this work?" harder to answer by looking at the folder. SQLite
    // checkpoints into the main file on a clean close, so by here they hold
    // nothing and can go. The operator is left with exactly one file.
    removeSidecars(target);

    return { restored: target, from: backupFile, previous, counts: after.counts, total: after.total };
}

// ── CLI ──────────────────────────────────────────────────────────────────

function printHelp() {
    console.log(`
Obnoví databázi restaurace ze zálohy.

Použití:
  node deploy/restore.js <soubor-zálohy.db> [--force]

Volby:
  --force   Neptat se na potvrzení (pro skripty).
  --help    Zobrazí tuhle nápovědu.

DŮLEŽITÉ: aplikace musí být zastavená. Obnovení za běhu může skončit
poškozenou databází — server drží soubor otevřený a přepsat ho pod ním
znamená, že si dál myslí, že v něm je něco jiného.

Před přepsáním se současná databáze zkopíruje vedle jako
  <databáze>.pre-restore-<datum>
takže omylem spuštěné obnovení jde vrátit zpět.

Zálohy vytváří: node deploy/backup.js
`.trim());
}

function confirm(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => rl.question(question, answer => {
        rl.close();
        resolve(answer.trim().toLowerCase());
    }));
}

async function runCli() {
    let parsed;
    try {
        parsed = parseArgs({
            options: {
                force: { type: "boolean", default: false },
                help: { type: "boolean", short: "h", default: false },
            },
            allowPositionals: true,
        });
    } catch (e) {
        console.error(`Chyba: ${e.message}\n`);
        printHelp();
        process.exitCode = 1;
        return;
    }

    if (parsed.values.help) return printHelp();

    const [backupFile] = parsed.positionals;
    if (!backupFile) {
        console.error("Chyba: chybí cesta k záloze.\n");
        printHelp();
        process.exitCode = 1;
        return;
    }

    try {
        // Everything the operator needs to realise this is the wrong file,
        // shown BEFORE anything is touched.
        const info = inspectBackup(backupFile);
        console.log(`Záloha:    ${backupFile}`);
        console.log(`           ${(info.bytes / 1024).toFixed(0)} kB, ${info.total} záznamů`);
        for (const [collection, n] of Object.entries(info.counts)) {
            console.log(`             ${collection}: ${n}`);
        }
        console.log(`Cíl:       ${db.DB_PATH}`);

        if (!parsed.values.force) {
            console.log("\n⚠️  Tímto se současná databáze PŘEPÍŠE. Aplikace musí být zastavená.");
            console.log("   (Kopie současné databáze se uloží vedle, takže krok jde vrátit.)");
            const answer = await confirm('Pokračovat? Napište "ano": ');
            if (answer !== "ano") {
                console.log("Zrušeno, nic se nezměnilo.");
                return;
            }
        }

        const result = restore(backupFile);

        console.log(`\n✅ Databáze obnovena: ${result.restored}`);
        console.log(`   Obnoveno ${result.total} záznamů`);
        if (result.previous) console.log(`   Původní databáze uložena jako: ${result.previous}`);
        console.log("   Spusťte aplikaci a zkontrolujte, že jsou vidět rezervace a účtenky.");
    } catch (e) {
        console.error(`❌ ${e.message}`);
        console.error("   Nic nebylo změněno.");
        process.exitCode = 1;
    }
}

if (require.main === module) runCli();

module.exports = { restore, inspectBackup, snapshotCurrent, SIDECARS };
