// ============================================================================
// idempotency.js — replay protection for money-making POST routes.
//
// Shaped like eet-queue.js: stateless with respect to storage, taking `db`
// and a collection name as arguments rather than importing server.js. That
// keeps it unit-testable against a plain in-memory stub with no Express, no
// SQLite and no network.
//
// ── Why this exists ─────────────────────────────────────────────────────
//
// The offline-first POS (docs/superpowers/specs/2026-08-02-offline-first-
// pos-design.md) replays queued sales from a tablet once the network comes
// back. The failure that makes replay dangerous is not "the request failed"
// — it's "the request SUCCEEDED and the response was lost", which is the
// single most common outcome on flaky bar Wi-Fi. The device cannot tell the
// two apart, so it retries, and without this module the retry is a brand
// new sale.
//
// The blast radius is specific and worth spelling out, because it is not
// obvious that only ONE of the two routes actually needed this:
//
//   POST /indoor-orders/:id/mark-paid  is ALREADY idempotent per order. It
//     reuses order.receiptId, createReceiptForOrder returns the existing
//     receipt when handed one, and eetQueue.enqueue dedupes on receipt id.
//     A second call is a no-op that returns the same receipt. The key here
//     is belt-and-braces plus a clean stored response body.
//
//   POST /indoor-orders  is NOT. It mints a fresh id via generateFileId()
//     on every single call. A retry therefore produces a second order, a
//     second receipt, a second porad_cis, and — the part that matters — a
//     SECOND SALE REPORTED TO FINANČNÍ SPRÁVA for money that was collected
//     once. That is the bug this module exists to make impossible.
//
// ── What is stored, and what deliberately is not ────────────────────────
//
// Only 2xx responses are recorded. Storing a 500 would pin a transient
// failure permanently: the tablet would retry, get the cached 500 back
// forever, and a real sale would never reach the server. A failed attempt
// must always leave the door open for the next one.
// ============================================================================

// Client-supplied strings become record ids, so they are constrained rather
// than trusted. A UUID v4 (36 chars) and "<uuid>:paid" (41) both fit
// comfortably; anything outside this is a malformed or hostile client, not
// a case worth accommodating.
const KEY_PATTERN = /^[A-Za-z0-9_:-]{8,128}$/;
const HEADER = "idempotency-key";

// Entries are pruned well after the queue could plausibly still be retrying.
// The drain gives up on a sale long before this; the window only needs to
// outlive "tablet left in a drawer over a long weekend".
const DEFAULT_MAX_AGE_DAYS = 30;

function isValidKey(key) {
    return typeof key === "string" && KEY_PATTERN.test(key);
}

// Express middleware. Routes without an Idempotency-Key header pass straight
// through and behave exactly as they did before this module existed — the
// online path is completely unaffected.
function middleware({ db, col }) {
    return function idempotencyGuard(req, res, next) {
        const key = req.get(HEADER);
        if (key === undefined || key === null || key === "") return next();

        if (!isValidKey(key)) {
            return res.status(400).json({ error: "Neplatný Idempotency-Key" });
        }

        const stored = db.get(col, key);
        if (stored) {
            // Replay. The handler never runs: no new order, no new receipt,
            // no new EET record. The caller gets byte-identical JSON to what
            // it would have got the first time, so a tablet that lost the
            // original response can still learn the server order id and
            // receipt id it needs to advance its own state machine.
            return res.status(stored.status).json(stored.body);
        }

        // Capture the response by wrapping res.json rather than listening on
        // "finish": the body itself has to be stored, and by the time
        // "finish" fires it is gone. Every route this guards answers with
        // res.json(), and a route that answered some other way would simply
        // not be recorded — a missed optimisation, never a wrong result.
        const originalJson = res.json.bind(res);
        res.json = body => {
            const status = res.statusCode || 200;
            if (status >= 200 && status < 300) {
                try {
                    db.set(col, key, { key, status, body, at: new Date().toISOString() });
                } catch (e) {
                    // The response has already been computed and the sale is
                    // already committed. Failing to record the key means a
                    // retry could duplicate — bad — but throwing here would
                    // turn a successful, paid-for sale into a 500 the client
                    // retries anyway, which is strictly worse. Surface it
                    // loudly and let the response through.
                    console.error(`Idempotency: failed to store key ${key}:`, e);
                }
            }
            return originalJson(body);
        };

        next();
    };
}

// Drops entries past the age cutoff. Returns how many were removed.
// Called from the same maintenance pass that prunes other expired records.
function prune(db, col, maxAgeDays = DEFAULT_MAX_AGE_DAYS) {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    let removed = 0;
    for (const entry of db.list(col)) {
        const at = Date.parse(entry && entry.at);
        // A record with an unparseable timestamp is corrupt, not young.
        // Sweeping it keeps one bad write from surviving forever.
        if (!Number.isFinite(at) || at < cutoff) {
            // Counted from the sweep, not from remove()'s return value —
            // db.js reports a boolean but a caller's stub need not, and this
            // count is only ever used for a log line.
            db.remove(col, entry.key);
            removed++;
        }
    }
    return removed;
}

module.exports = { middleware, prune, isValidKey, KEY_PATTERN, HEADER, DEFAULT_MAX_AGE_DAYS };
