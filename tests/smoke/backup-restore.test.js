// ============================================================================
// backup-restore.test.js — the round trip, performed for real.
//
// The reason this file exists is one sentence: an untested restore is not a
// backup. Every case below runs the actual deploy/backup.js and
// deploy/restore.js against a real database — the same code an operator runs at
// 2am — rather than asserting that some helper returns the right shape.
//
// THE CENTRAL CASE is "destroy the database and get the business back": seed
// reservations, orders and receipts through a running server, back it up,
// delete the file, restore, start a server on it, and read the data back over
// HTTP. If that passes, the procedure works. If the rest of this file passed
// and that one did not, the backups would be worthless.
//
// The second theme is the ways people lose data WHILE recovering: restoring a
// truncated file over a good database, leaving a stale WAL sidecar beside a
// restored one, or discovering the wrong file was chosen after the old one is
// gone. Each has a case.
// ============================================================================

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");

const harness = require("../helpers/harness");

const COL = harness.COL;

// backup.js/restore.js resolve the live database through src/server/db.js,
// which reads SQLITE_PATH at require time — so it is set before either is
// loaded, exactly as tests/unit/db-patch.test.js does.
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "backup-restore-"));
const DB_PATH = path.join(WORK, "app.db");
process.env.SQLITE_PATH = DB_PATH;

const db = require("../../src/server/db");
const backupTool = require("../../deploy/backup");
const restoreTool = require("../../deploy/restore");

function seedBusinessData(counts = { receipts: 3, orders: 2 }) {
    for (let i = 0; i < counts.receipts; i++) {
        db.set(COL.receipts, `r${i}`, {
            id: `r${i}`, number: `2026-00000${i}`, issuedAt: new Date().toISOString(),
            kind: "indoor", total: 250 + i,
            items: [{ item: "Svíčková", qty: 1, price: 250 + i, vatRate: 12 }],
        });
    }
    for (let i = 0; i < counts.orders; i++) {
        db.set(COL.orders, `o${i}`, {
            id: `o${i}`, customerName: `Zákazník ${i}`, address: "Školní 50", psc: "43001",
            phone: "+42060000000" + i, total: 300, status: "pending", createdAt: new Date().toISOString(),
        });
    }
    db.set(COL.users, "admin1", {
        id: "admin1", abbreviation: "SEF", name: "Šéf",
        password: bcrypt.hashSync("Backup!Pass123", 12), isAdmin: true, isDriver: false,
    });
}

const recordIn = (file, collection, id) => {
    const conn = new Database(file, { readonly: true });
    try {
        const row = conn.prepare(`SELECT data FROM records WHERE collection = ? AND id = ?`).get(collection, id);
        return row ? JSON.parse(row.data) : null;
    } finally { conn.close(); }
};

const countIn = (file, collection) => {
    const conn = new Database(file, { readonly: true });
    try {
        return conn.prepare(`SELECT COUNT(*) AS n FROM records WHERE collection = ?`).get(collection).n;
    } finally { conn.close(); }
};

describe("backup and restore", () => {
    before(() => {
        seedBusinessData();
    });

    after(() => {
        try { db.getDb().close(); } catch { /* already closed */ }
        try { fs.rmSync(WORK, { recursive: true, force: true }); } catch { /* best effort */ }
    });

    // ── taking one ──────────────────────────────────────────────────────

    test("a backup is a real, openable database with the same data in it", async () => {
        const result = await backupTool.backup({ dir: path.join(WORK, "backups") });

        assert.ok(fs.existsSync(result.file), "the snapshot should exist");
        assert.ok(result.bytes > 0);
        assert.strictEqual(countIn(result.file, COL.receipts), 3);
        assert.strictEqual(countIn(result.file, COL.orders), 2);
        assert.strictEqual(countIn(result.file, COL.users), 1);
    });

    test("the backup is taken with the app running, and is still consistent", async () => {
        // The whole reason this uses SQLite's online backup rather than a file
        // copy: writes continue while the snapshot is being made. A `cp` here
        // could produce a file missing whatever was in the WAL.
        const writing = setInterval(() => {
            db.set(COL.orders, `live-${crypto.randomBytes(4).toString("hex")}`, {
                id: "live", customerName: "Během zálohy", total: 100, createdAt: new Date().toISOString(),
            });
        }, 2);

        let result;
        try {
            result = await backupTool.backup({ dir: path.join(WORK, "backups-live") });
        } finally {
            clearInterval(writing);
        }

        // backup() verifies integrity itself and deletes the file if it fails,
        // so reaching here already means integrity_check passed.
        assert.ok(fs.existsSync(result.file));
        assert.strictEqual(countIn(result.file, COL.receipts), 3, "the receipts must all be there");
    });

    test("verifyBackup rejects a file that is not a database", () => {
        const dir = path.join(WORK, "verify");
        fs.mkdirSync(dir, { recursive: true });
        const bogus = path.join(dir, "app-bogus.db");
        fs.writeFileSync(bogus, "this is not a database");

        assert.throws(() => backupTool.verifyBackup(bogus, {}), /./);
    });

    test("verifyBackup rejects a snapshot that is missing rows", () => {
        // The subtler corruption: a real, openable database that simply does
        // not contain everything the source had.
        const dir = path.join(WORK, "verify-short");
        fs.mkdirSync(dir, { recursive: true });
        const short = path.join(dir, "short.db");
        const conn = new Database(short);
        conn.exec("CREATE TABLE records (collection TEXT, id TEXT, data TEXT)");
        conn.close();

        assert.throws(
            () => backupTool.verifyBackup(short, { [COL.receipts]: 3 }),
            /missing rows/i,
            "a snapshot with fewer rows than the source must not pass",
        );
    });

    test("a snapshot that fails verification is DELETED, not left to be found later", async () => {
        // The behaviour that matters most in backup.js: a corrupt file sitting
        // in the backups folder is worse than no file, because it looks like a
        // good one and is what a restore would reach for.
        const dir = path.join(WORK, "failed-verify");

        await assert.rejects(
            () => backupTool.backup({
                dir,
                verify: () => { throw new Error("simulated corruption"); },
            }),
            /simulated corruption|nezdařila/i,
        );

        const leftovers = fs.readdirSync(dir).filter(n => n.startsWith(backupTool.PREFIX));
        assert.deepStrictEqual(leftovers, [], "the unverified snapshot must not survive");
    });

    test("rotation keeps the newest and removes the rest", async () => {
        const dir = path.join(WORK, "rotation");
        fs.mkdirSync(dir, { recursive: true });
        for (const n of [1, 2, 3, 4, 5]) {
            fs.writeFileSync(path.join(dir, `${backupTool.PREFIX}2026-08-0${n}T00-00-00-000Z${backupTool.SUFFIX}`), "x");
        }

        const removed = backupTool.rotate(dir, 2);
        const left = fs.readdirSync(dir).sort();

        assert.strictEqual(removed.length, 3);
        assert.deepStrictEqual(left, [
            `${backupTool.PREFIX}2026-08-04T00-00-00-000Z${backupTool.SUFFIX}`,
            `${backupTool.PREFIX}2026-08-05T00-00-00-000Z${backupTool.SUFFIX}`,
        ], "the two newest survive");
    });

    test("rotation never touches files it did not write", () => {
        const dir = path.join(WORK, "rotation-foreign");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "notes.txt"), "operator's notes");
        fs.writeFileSync(path.join(dir, "app.db"), "the live database someone parked here");
        fs.writeFileSync(path.join(dir, `${backupTool.PREFIX}2026-08-01T00-00-00-000Z${backupTool.SUFFIX}`), "x");

        backupTool.rotate(dir, 0);

        assert.ok(fs.existsSync(path.join(dir, "notes.txt")), "unrelated files are not ours to delete");
        assert.ok(fs.existsSync(path.join(dir, "app.db")), "and neither is a database without our prefix");
    });

    // ── refusing a bad restore ──────────────────────────────────────────

    function stageDeployment(name, fromBackup) {
        const target = path.join(WORK, name, "app.db");
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(fromBackup, target);
        return target;
    }


    test("a file that is not a database is refused before anything is touched", async () => {
        const junk = path.join(WORK, "truncated.db");
        fs.writeFileSync(junk, "half a download");

        // Targets a staged file, not the open one: the point is that the
        // refusal happens BEFORE anything is written, which is observable
        // either way, and the tool's contract is that the app is stopped.
        // Staged from a BACKUP, not `cp app.db`. Copying the live main file
        // gives a database with no `records` table at all, because the data is
        // still in the write-ahead log — which is the exact corruption
        // backup.js exists to prevent, and it caught this test writing it.
        const snapshot = await backupTool.backup({ dir: path.join(WORK, "refuse-backups") });
        const target = stageDeployment("refuse", snapshot.file);
        const before = countIn(target, COL.receipts);

        assert.throws(() => restoreTool.restore(junk, { target }), /není platná databáze|poškozená/i);
        assert.strictEqual(countIn(target, COL.receipts), before, "the target database must be untouched");
        assert.ok(!fs.existsSync(target + ".pre-restore"), "and no undo copy was even started");
    });

    test("someone else's database is refused", () => {
        // Right file extension, real SQLite, wrong application — the shape of
        // mistake that happens when several services back up to one folder.
        const stranger = path.join(WORK, "other-app.db");
        const conn = new Database(stranger);
        conn.exec("CREATE TABLE something_else (id TEXT)");
        conn.close();

        assert.throws(() => restoreTool.restore(stranger), /records/i);
    });

    test("a missing or empty file is refused", () => {
        assert.throws(() => restoreTool.restore(path.join(WORK, "nope.db")), /neexistuje/i);
        const empty = path.join(WORK, "empty.db");
        fs.writeFileSync(empty, "");
        assert.throws(() => restoreTool.restore(empty), /prázdný/i);
    });

    // ── THE CASE THIS FILE EXISTS FOR ───────────────────────────────────

    // Its own database file rather than the shared one, and not because that is
    // tidier: db.js memoises its connection, so closing it here — which
    // "destroying the database" requires, since Windows will not unlink an open
    // file — would leave every later test in this file writing through a closed
    // handle. The disaster is staged on a copy that stands in for a real
    // deployment's database.
    const DISASTER_DB = path.join(WORK, "disaster", "app.db");

    test("the database can be destroyed and the business recovered from a backup", async () => {
        const snapshot = await backupTool.backup({ dir: path.join(WORK, "disaster-backups") });

        fs.mkdirSync(path.dirname(DISASTER_DB), { recursive: true });
        fs.copyFileSync(snapshot.file, DISASTER_DB);
        assert.strictEqual(countIn(DISASTER_DB, COL.receipts), 3, "the stand-in deployment is live");

        // Everything gone: main file and both WAL sidecars, the way a disk
        // failure or a mistyped `rm` leaves it.
        for (const suffix of ["", "-wal", "-shm"]) {
            const f = DISASTER_DB + suffix;
            if (fs.existsSync(f)) fs.unlinkSync(f);
        }
        assert.ok(!fs.existsSync(DISASTER_DB), "the database really is gone");

        const result = restoreTool.restore(snapshot.file, { target: DISASTER_DB });

        assert.ok(fs.existsSync(DISASTER_DB));
        assert.strictEqual(result.counts[COL.receipts], 3, "every receipt came back — these are tax documents");
        assert.strictEqual(result.counts[COL.users], 1);
        assert.strictEqual(result.previous, null, "nothing to preserve — the old file was gone");

        // Named records rather than a count: an earlier case in this file writes
        // extra orders while a backup runs, so the total is not fixed — and
        // "the specific orders came back" is the stronger claim anyway.
        for (const id of ["r0", "r1", "r2"]) {
            assert.ok(recordIn(DISASTER_DB, COL.receipts, id), `receipt ${id} must be recoverable`);
        }
        for (const id of ["o0", "o1"]) {
            const order = recordIn(DISASTER_DB, COL.orders, id);
            assert.ok(order, `order ${id} must be recoverable`);
            assert.strictEqual(order.address, "Školní 50", "with the delivery address intact");
        }
    });

    test("and the restored database actually runs the app", async () => {
        // The strongest form of the claim: not "the file has rows in it" but
        // "a real server starts on it and answers with the business's data".
        const server = await harness.start({ env: { SQLITE_PATH: DISASTER_DB } });
        try {
            const login = await fetch(`${server.api}/users/login`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ abbreviation: "SEF", password: "Backup!Pass123" }),
            });
            assert.strictEqual(login.status, 200, "the restored admin account must be able to log in");

            const raw = typeof login.headers.getSetCookie === "function"
                ? login.headers.getSetCookie()[0] : login.headers.get("set-cookie");
            const cookie = raw.split(";")[0];

            const receipts = await fetch(`${server.api}/receipts?from=2020-01-01`, { headers: { cookie } });
            assert.strictEqual(receipts.status, 200);
            assert.strictEqual((await receipts.json()).length, 3, "the receipts are readable over HTTP again");
        } finally {
            await server.stop();
        }
    });

    // ── the ways a restore goes wrong ───────────────────────────────────

    // Restores below target their own file rather than the one this process
    // holds open. That is not a workaround — it is the tool's stated
    // precondition ("aplikace musí být zastavená"), and on Windows the
    // filesystem enforces it: the sidecars of an open database cannot be
    // unlinked. A test that restored over a live connection would be asserting
    // something the tool does not promise.
    function addReceiptDirectly(file, id) {
        const conn = new Database(file);
        try {
            conn.prepare(`INSERT INTO records (collection, id, data) VALUES (?, ?, ?)`)
                .run(COL.receipts, id, JSON.stringify({ id, number: "2026-999999", kind: "indoor", total: 1 }));
        } finally { conn.close(); }
    }

    test("restoring keeps a copy of what it overwrote, so a wrong file is undoable", async () => {
        const good = await backupTool.backup({ dir: path.join(WORK, "undo-backups") });
        const target = stageDeployment("undo", good.file);

        // The deployment has moved on since that backup was taken.
        addReceiptDirectly(target, "r-after-backup");
        assert.strictEqual(countIn(target, COL.receipts), 4);

        const result = restoreTool.restore(good.file, { target });

        assert.strictEqual(result.counts[COL.receipts], 3, "the backup's state is now live");
        assert.ok(result.previous && fs.existsSync(result.previous), "and the overwritten database was kept");
        assert.strictEqual(countIn(result.previous, COL.receipts), 4,
            "the copy holds what was there before — this is the undo");
    });

    test("a stale WAL sidecar cannot survive a restore", async () => {
        // The subtle one. WAL mode means a leftover app.db-wal beside a
        // restored app.db can be replayed onto it, mixing two databases into
        // one that opens without complaint.
        const snapshot = await backupTool.backup({ dir: path.join(WORK, "wal-backups") });
        const target = stageDeployment("wal", snapshot.file);

        fs.writeFileSync(target + "-wal", "stale write-ahead log from the old database");
        fs.writeFileSync(target + "-shm", "stale shared memory index");

        restoreTool.restore(snapshot.file, { target });

        for (const suffix of restoreTool.SIDECARS) {
            assert.ok(!fs.existsSync(target + suffix), `${suffix} must be removed, not left beside the restored file`);
        }
    });

    test("inspectBackup reports what is in a file without changing it", () => {
        const before = fs.statSync(DB_PATH).mtimeMs;
        const info = restoreTool.inspectBackup(DB_PATH);

        assert.ok(info.total > 0);
        assert.strictEqual(info.counts[COL.receipts], 3);
        assert.strictEqual(fs.statSync(DB_PATH).mtimeMs, before, "reading a backup must not modify it");
    });
});
