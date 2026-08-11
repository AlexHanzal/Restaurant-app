// ============================================================================
// harness.js — spawns a real instance of src/server/server.js as a child
// process, on a probed-free port, against a throwaway temp SQLite DB, for
// smoke tests to talk to over real HTTP (spec: docs/superpowers/specs/
// 2026-08-04-table-qr-self-order-design.md §9.2).
//
// This repo had NO test harness before the table-QR feature — tests/ only
// held unit tests plus one opt-in live EET integration test. This is a
// minimal one, built to be reusable by future smoke suites, not just this
// one.
//
// Design:
//   - A fresh temp SQLite file per start() call, so tests never touch the
//     owner's data/app.db and never see another test's data.
//   - The server is spawned as a CHILD PROCESS (not required in-process),
//     because src/server/server.js calls app.listen() and does real Node
//     process-level setup (SIGTERM handlers, etc.) at module load — running
//     it in-process would pollute this test process instead of exercising
//     the thing that actually runs in production.
//   - TWILIO_*/SMTP_*/GOPAY_* are force-blanked in the child's env. A smoke
//     run must NEVER be able to send a real SMS/email or reach a real
//     payment gateway, no matter what the owner's own shell happens to have
//     exported. Spreading process.env and then overwriting these specific
//     keys (rather than only setting them if unset) guarantees that even if
//     the shell that ran `npm run test:smoke` has real credentials loaded,
//     the child never sees them.
//   - Fixtures are seeded by writing straight into the `records` SQLite
//     table (same shape db.js uses: collection/id/data JSON), AFTER the
//     child has finished booting — src/server/server.js's initializeData()
//     is what creates that table and seeds the menu/combos singletons; a
//     write before that exists would either race it or get clobbered by it.
// ============================================================================

const net = require("net");
const os = require("os");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const http = require("http");
const { spawn, exec } = require("child_process");
const Database = require("better-sqlite3");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SERVER_PATH = path.join(REPO_ROOT, "src", "server", "server.js");

// Fixed test-only secrets. MUST be the same string every run (not random)
// because tests/smoke/table-orders.test.js mints table tokens in ITS OWN
// process via table-token.js — that module derives its signing key from
// JWT_SECRET (see auth.deriveSecret), so the test process and the spawned
// server must agree on JWT_SECRET or every minted token would fail
// verification against the very server that's supposed to accept it.
const TEST_JWT_SECRET = "table-qr-smoke-harness-jwt-secret-do-not-use-in-prod";
const TEST_CSRF_SECRET = "table-qr-smoke-harness-csrf-secret-do-not-use-in-prod";

// Collection name / singleton id literals, mirrored from server.js's
// SERVER_CONFIG.collections and MENU_SINGLETON_ID/settings.js's
// SETTINGS_ID — server.js does not export these, so smoke tests that need
// to seed fixtures directly (bypassing the authenticated/admin-only routes
// that would otherwise be required just to set up a scenario) use these
// literal strings, exactly as db.js itself does.
const COL = {
    timetables: "timetables",
    users: "users",
    indoorOrders: "indoor_orders",
    menu: "menu",
    settings: "settings",
    payments: "payments",
    orders: "orders",
    // Delivery routing/batching (spec 2026-08-08) — see server.js's COL.deliveryBatches.
    deliveryBatches: "delivery_batches",
    // Finding M3 (2026-08-11) — pending SMS-verification codes, one row per
    // phone currently mid-flow. See server.js's COL.reservationPendingCodes/
    // COL.reorderPendingCodes and src/server/verification-codes.js.
    reservationPendingCodes: "reservation_pending_codes",
    reorderPendingCodes: "reorder_pending_codes",
};
const MENU_SINGLETON_ID = "singleton";
const SETTINGS_ID = "restaurant";

// Binds to port 0 (OS picks a free ephemeral port), reads it back, and
// releases it immediately. There is a theoretical TOCTOU race (something
// else could grab the port between close() and the child's listen()), but
// it's the same approach every "find a free port for a test server" helper
// uses, and is dramatically less likely to collide with the owner's own
// running instances (which sit on fixed ports 3000/4310+) than hardcoding
// a port would be.
function getFreePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.unref();
        srv.on("error", reject);
        srv.listen(0, "127.0.0.1", () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
    });
}

function tempDbPath() {
    const unique = `${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;
    return path.join(os.tmpdir(), `table-qr-smoke-${unique}.db`);
}

// Polls GET / until it answers (any status code — we only care that the
// HTTP server is up and Express is routing), or gives up after timeoutMs.
function waitForServer(baseUrl, timeoutMs, isAlive) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
        const attempt = () => {
            if (!isAlive()) {
                reject(new Error("server process exited before it started answering requests"));
                return;
            }
            const req = http.get(`${baseUrl}/`, { timeout: 2000 }, (res) => {
                res.resume();
                resolve();
            });
            req.on("error", () => {
                if (Date.now() > deadline) {
                    reject(new Error(`server did not answer GET / within ${timeoutMs}ms`));
                    return;
                }
                setTimeout(attempt, 150);
            });
            req.on("timeout", () => req.destroy());
        };
        attempt();
    });
}

// Deletes the main db file plus SQLite's WAL/SHM sidecar files (WAL mode —
// see db.js's `journal_mode = WAL` pragma — writes there until a
// checkpoint). Best-effort: a file that's still momentarily locked right
// after the child process exits is not worth failing the test run over.
function cleanupDbFiles(dbPath) {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
        try { fs.unlinkSync(dbPath + suffix); } catch { /* already gone / never existed */ }
    }
}

/**
 * Spawns src/server/server.js on a free port against a fresh temp DB.
 *
 * @param {object} [opts]
 * @param {object} [opts.env] extra env vars merged into the child's env
 *        (applied AFTER the Twilio/SMTP/GoPay env blanking below, so
 *        callers cannot accidentally re-enable a real integration here).
 * @param {number} [opts.timeoutMs] boot timeout, default 20000.
 * @returns {Promise<{baseUrl: string, api: string, dbPath: string, stop: () => Promise<void>}>}
 */
async function start(opts = {}) {
    const port = await getFreePort();
    const dbPath = tempDbPath();
    const baseUrl = `http://127.0.0.1:${port}`;
    const api = `${baseUrl}/reservation/api`;

    const env = {
        ...process.env,
        PORT: String(port),
        SQLITE_PATH: dbPath,
        JWT_SECRET: TEST_JWT_SECRET,
        CSRF_SECRET: TEST_CSRF_SECRET,
        // Explicitly NOT "production" — keeps cookies non-Secure so plain
        // HTTP loopback requests in this test can carry them, and skips
        // the hard-fail-without-JWT_SECRET production path (irrelevant
        // here since we always set one, but this keeps the harness honest
        // about what environment it's emulating: local dev, not prod).
        NODE_ENV: "test",

        // ── HARD BLANK: never let a smoke run touch a real integration ──
        // Every var these three modules read (notify.js, server.js's sms/
        // payments config blocks) is listed explicitly and forced to "" —
        // NOT merged/defaulted — regardless of what the invoking shell has
        // exported. This is the one non-negotiable safety property of this
        // harness (spec §9.2 / plan Task 7).
        TWILIO_ACCOUNT_SID: "",
        TWILIO_AUTH_TOKEN: "",
        TWILIO_FROM_NUMBER: "",
        SMTP_HOST: "",
        SMTP_PORT: "",
        SMTP_SECURE: "",
        SMTP_USER: "",
        SMTP_PASS: "",
        SMTP_FROM: "",
        GOPAY_GOID: "",
        GOPAY_CLIENT_ID: "",
        GOPAY_CLIENT_SECRET: "",
        GOPAY_SANDBOX: "",
        GOPAY_RETURN_URL: "",
        GOPAY_NOTIFICATION_URL: "",
        // Delivery routing: no test run may ever reach OpenStreetMap.
        GEOCODE_DISABLED: "1",

        ...(opts.env || {}),
    };

    const child = spawn(process.execPath, [SERVER_PATH], {
        cwd: REPO_ROOT,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
    });

    let exited = false;
    let exitInfo = null;
    child.once("exit", (code, signal) => {
        exited = true;
        exitInfo = { code, signal };
    });

    // Keep a rolling log for debugging a failed boot — not printed unless
    // something actually goes wrong.
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });

    try {
        await waitForServer(baseUrl, opts.timeoutMs || 20000, () => !exited);
    } catch (e) {
        cleanupDbFiles(dbPath);
        const detail = exitInfo ? ` (exited: code=${exitInfo.code} signal=${exitInfo.signal})` : "";
        throw new Error(`${e.message}${detail}\n--- child stdout ---\n${stdout}\n--- child stderr ---\n${stderr}`);
    }

    async function stop() {
        if (exited) {
            cleanupDbFiles(dbPath);
            return;
        }

        await new Promise((resolve) => {
            const onExit = () => resolve();
            child.once("exit", onExit);

            // On Windows, child.kill() does not reliably tear down the
            // process the way a POSIX signal would — Node emulates it, but
            // a leaked node.exe here silently keeps the temp DB file
            // locked and (worse) keeps a "free" port bound for whatever
            // test run picks it next. taskkill /T /F kills the process
            // (and any children) unconditionally, which is what "stop"
            // actually needs to guarantee. On POSIX, a plain SIGTERM is
            // enough and is the more graceful choice.
            if (process.platform === "win32") {
                exec(`taskkill /PID ${child.pid} /T /F`, () => { /* best-effort */ });
            } else {
                child.kill("SIGTERM");
            }

            // Hard fallback in case the 'exit' event never fires for some
            // reason — don't hang the test run forever.
            setTimeout(resolve, 5000);
        });

        cleanupDbFiles(dbPath);
    }

    // The child's console output so far (stdout + stderr), for tests that
    // need to observe something the HTTP API deliberately does not return.
    //
    // The reservation suite is the reason this exists: with TWILIO_* blanked
    // (which this harness guarantees) and NODE_ENV != production, notify.js
    // takes its simulated path and console.logs the message body — including
    // the verification code — instead of sending an SMS. That log line is
    // the only way for a test to complete the real send-code ->
    // verify-and-book flow, and reading it is exactly what a developer does
    // when running the app locally. It must NEVER become the way production
    // code learns a code: see notify.js's sendSms, which makes that fallback
    // unreachable when NODE_ENV=production precisely so a customer can never
    // be told to read one out of a log.
    function logs() {
        return stdout + stderr;
    }

    return { baseUrl, api, dbPath, port, stop, logs };
}

// ── DIRECT FIXTURE SEEDING ──────────────────────────────────────────────
// Writes/reads/deletes rows directly in the temp DB's `records` table,
// bypassing the HTTP API entirely. This is deliberate, not a shortcut: most
// of what these smoke tests need to set up (a table record, a menu item, a
// settings block, an admin user to prove the QR order lands correctly) sits
// behind requireAdmin/requireCsrf in the real app, and standing up a full
// admin session for every fixture would test the admin API, not the public
// table-ordering routes this suite exists to cover. The `records` table
// shape (collection/id/data-JSON, upsert semantics) is mirrored exactly
// from db.js's own set()/get()/remove() — see src/server/db.js.
//
// Must only be called AFTER start() resolves: the `records` table doesn't
// exist until the child's initializeData() creates it.
function withDb(dbPath, fn) {
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    try {
        return fn(db);
    } finally {
        db.close();
    }
}

function seedRecord(dbPath, collection, id, dataObj) {
    return withDb(dbPath, (db) => {
        db.prepare(`
            INSERT INTO records (collection, id, data) VALUES (?, ?, ?)
            ON CONFLICT(collection, id) DO UPDATE SET data = excluded.data
        `).run(collection, id, JSON.stringify(dataObj));
    });
}

function readRecord(dbPath, collection, id) {
    return withDb(dbPath, (db) => {
        const row = db.prepare(`SELECT data FROM records WHERE collection = ? AND id = ?`).get(collection, id);
        return row ? JSON.parse(row.data) : null;
    });
}

function removeRecord(dbPath, collection, id) {
    return withDb(dbPath, (db) => {
        db.prepare(`DELETE FROM records WHERE collection = ? AND id = ?`).run(collection, id);
    });
}

module.exports = {
    start,
    seedRecord,
    readRecord,
    removeRecord,
    COL,
    MENU_SINGLETON_ID,
    SETTINGS_ID,
    TEST_JWT_SECRET,
    TEST_CSRF_SECRET,
};
