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
// ── RESERVE, don't check-then-act (finding L1) ──────────────────────────
//
// The original version of this file did `stored = db.get(key)`, and only
// stored the response later, inside the wrapped res.json. That is safe
// ONLY because POST /indoor-orders' handler happens to be fully
// synchronous and better-sqlite3 + single-threaded Node means no two
// requests' JS can interleave between that get() and the eventual set() —
// so two concurrent requests both see `stored === null` and both run. The
// day any `await` lands in that handler (mark-paid already has one, for
// EET), this becomes check-then-act for real, and a concurrent retry from
// the offline queue — which pos-sync.js explicitly treats as ORDINARY, not
// exotic (see that file's header) — files a duplicate sale.
//
// The fix is to RESERVE the key with a single atomic SQL statement (INSERT
// ... ON CONFLICT DO NOTHING, exposed as db.insertIfAbsent) BEFORE next()
// runs, so SQLite itself — not two racing pieces of JS — decides which of
// two simultaneous requests gets to proceed. That turns one hard problem
// (a live-in-JS race) into a second, narrower one: a request can now win a
// reservation and then never resolve it (throw, crash, hang), and a later
// request carrying the same key has to do something sane about that. The
// rest of this header is that "something sane".
//
// ── The five cases, precisely ───────────────────────────────────────────
//
//   1. FRESH KEY — no row exists. insertIfAbsent wins outright. The
//      handler runs. A 2xx response is stored as a completed row
//      (`status` set); anything else RELEASES the reservation (deletes the
//      row) instead of storing it — see case 5.
//
//   2. EXACT REPLAY — the row exists and is COMPLETE (`status` is not
//      null: a previous attempt finished with a 2xx). The handler never
//      runs; the caller gets byte-identical JSON to the first response.
//      Unchanged from before this fix.
//
//   3. CONCURRENT DUPLICATE — the row exists and is PENDING (`status` is
//      null — reserved, not yet answered) and its reservation is still
//      within RESERVATION_LEASE_MS. This is the case check-then-act could
//      not see. The handler does not run. The request is answered 429
//      ("Požadavek se již zpracovává") rather than guessed at — returning
//      an empty/fabricated body here would violate the "never look like a
//      real response" rule (requirement b in the finding), and letting it
//      through would violate "never execute twice" (requirement c). 429
//      is deliberate, not arbitrary: pos-sync.js's classify() (see that
//      file) already treats 429 as "retry" — the sale stays queued and
//      the next drain tick (POLL_MS = 30s, or sooner on reconnect) either
//      finds a completed row (case 2) or a released one (case 1/5), never
//      a permanent failure.
//
//   4. FIRST ATTEMPT THREW — a handler throws synchronously or an async
//      handler rejects. Express 5 (this app's version — see package.json)
//      auto-catches both and routes them to server.js's single global
//      error-handling middleware (setupErrorHandlers), which still
//      answers via `res.status(500).json(...)` on the SAME res object
//      this middleware wrapped — so the throw resolves exactly like case 5
//      below: the reservation is released, not stored, and a genuine
//      retry gets a truly fresh attempt. The one gap this doesn't cover
//      is a hard process crash (OOM/SIGKILL) between reserving the key and
//      answering — nothing in the process runs again to release anything.
//      That is what RESERVATION_LEASE_MS (case 3/5's staleness check)
//      exists for: an unresolved reservation is never permanent, only
//      unresolved for at most the lease window, after which a later
//      request is entitled to treat the original owner as gone and steal
//      it via db.compareAndSwap (an optimistic lock: if two later requests
//      both decide the same row looks abandoned at once, only one CAS
//      wins, and the loser falls back to the case-3 429 rather than also
//      running the handler).
//
//      RESERVATION_LEASE_MS is deliberately generous relative to every
//      handler this guards: POST /indoor-orders does no I/O at all
//      (instant), and mark-paid's one await (sendEetForReceipt) is bounded
//      by SERVER_CONFIG.eet.timeoutMs (5000ms by default — see
//      server.js). 20s is 4x that bound, so a request that is genuinely
//      still running is never mistaken for a crashed one — and it is
//      still comfortably under pos-sync.js's 30s POLL_MS, so a real crash
//      clears within about one drain cycle, not "days". A reservation
//      whose `at` cannot be parsed is treated the same as expired, the
//      same policy prune() already applies to corrupt timestamps below.
//
//      What the lease mechanism deliberately does NOT solve: if a handler
//      with real work spanning an await (mark-paid) crashes AFTER
//      committing that work but BEFORE answering, a later steal-and-rerun
//      re-executes the handler — which is exactly why mark-paid must stay
//      independently idempotent on its own terms (order.receiptId reuse,
//      per the header above), not merely rely on this module. For POST
//      /indoor-orders — the route that actually lacks that independent
//      idempotency — the handler is fully synchronous with no await
//      anywhere in it, so there is no window in which "committed the
//      order" and "answered" are two JS-observable moments a crash could
//      land between; this is the same single-threaded/synchronous-SQLite
//      argument db.js's own patch() comment relies on elsewhere in this
//      codebase, not a new assumption introduced here.
//
//   5. FIRST ATTEMPT RETURNED NON-2XX — e.g. the sold-out guard, a
//      validation 400. The wrapped res.json sees a status outside
//      [200, 300) and calls db.remove on the reservation instead of
//      storing it. The key becomes immediately available again: not
//      stored as a false "success" (requirement b), and not permanently
//      poisoned for a real retry either (requirement a).
//
// ── What is stored, and what deliberately is not ────────────────────────
//
// Only 2xx responses are recorded as completed. Storing a 500 would pin a
// transient failure permanently: the tablet would retry, get the cached
// 500 back forever, and a real sale would never reach the server. A failed
// attempt must always leave the door open for the next one.
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

// How long an unresolved (PENDING) reservation is treated as "somebody is
// still working on it" before a later request is allowed to assume the
// owner crashed and steal it. See the header's case 3/4 for the numbers
// this is measured against.
const RESERVATION_LEASE_MS = 20 * 1000;

function isValidKey(key) {
    return typeof key === "string" && KEY_PATTERN.test(key);
}

// A record with an unparseable timestamp is corrupt, not young — same
// policy prune() applies below. Returns Infinity (i.e. "definitely stale")
// for anything that doesn't parse, so a corrupt reservation can never
// survive by virtue of being unreadable.
function ageMs(isoAt) {
    const parsed = Date.parse(isoAt);
    return Number.isFinite(parsed) ? Date.now() - parsed : Infinity;
}

function pendingRecord(key) {
    return { key, status: null, body: null, at: new Date().toISOString() };
}

// Tries to make THIS caller the sole owner of `key`, atomically. Returns
// { won: true } if it succeeded — the caller must run the handler — or
// { won: false, replay } where `replay` is the stored response to return
// verbatim (case 2) or null if the key is genuinely still in flight / just
// out of reach (case 3), in which case the caller must refuse rather than
// guess.
function reserveKey(db, col, key) {
    if (db.insertIfAbsent(col, key, pendingRecord(key))) return { won: true };

    let existing = db.get(col, key);
    if (!existing) {
        // Should be unreachable in this app: a single Node process with
        // synchronous, single-threaded better-sqlite3 means nothing else
        // can run between our failed insert above and this read, so the
        // row we just lost a race for cannot also have vanished by now
        // (see db.js's patch() comment for the same invariant relied on
        // elsewhere). Kept as a cheap, harmless fallback rather than
        // assumed away, in case that invariant is ever weakened (e.g. a
        // future multi-process deployment).
        if (db.insertIfAbsent(col, key, pendingRecord(key))) return { won: true };
        existing = db.get(col, key);
    }

    if (existing && existing.status !== null) {
        // Completed — case 2, an exact replay.
        return { won: false, replay: existing };
    }

    if (existing && ageMs(existing.at) > RESERVATION_LEASE_MS) {
        // Pending, but past its lease: the owner is presumed crashed, not
        // slow (case 4). Steal it with a compare-and-swap rather than a
        // blind overwrite, so if two requests both reach this branch for
        // the same abandoned row, only one of them actually wins it — the
        // loser's CAS matches zero rows and falls through to "still
        // someone else's" below, exactly as if it had lost the original
        // insertIfAbsent race.
        if (db.compareAndSwap(col, key, existing, pendingRecord(key))) return { won: true };
        existing = db.get(col, key);
        if (existing && existing.status !== null) return { won: false, replay: existing };
    }

    // Still pending and within its lease (or a losing steal attempt just
    // above) — genuinely in flight from this module's point of view.
    // Case 3: refuse, don't guess.
    return { won: false, replay: null };
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

        const claim = reserveKey(db, col, key);

        if (!claim.won) {
            if (claim.replay) {
                // Replay. The handler never runs: no new order, no new
                // receipt, no new EET record. The caller gets byte-identical
                // JSON to what it would have got the first time, so a
                // tablet that lost the original response can still learn
                // the server order id and receipt id it needs to advance
                // its own state machine.
                return res.status(claim.replay.status).json(claim.replay.body);
            }
            // Genuinely (or presumably) still in flight. The one thing that
            // must never happen is a second execution, so refuse rather
            // than execute or fabricate a response. Not a rate limit —
            // 429 is chosen because pos-sync.js's classify() already
            // treats it as "retry" (see that file), so the queued sale
            // simply waits for the next drain tick instead of being
            // marked FAILED.
            return res.status(429).json({ error: "Požadavek se již zpracovává, zkuste to prosím znovu" });
        }

        // Reservation held: capture the response by wrapping res.json
        // rather than listening on "finish", the body itself has to be
        // stored, and by the time "finish" fires it is gone. Every route
        // this guards answers with res.json(), and a route that answered
        // some other way would simply not be recorded — a missed
        // optimisation, never a wrong result.
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
            } else {
                // No sale happened (validation failure, sold-out guard, or
                // the app's own error handler answering a thrown/rejected
                // handler with a 500 — see the header's case 4/5). The
                // reservation must not survive it: a real retry needs a
                // truly fresh attempt, not a cached failure it can never
                // get past. Never storing a non-2xx AS a completed row is
                // what keeps this from becoming a poisoned key.
                try {
                    db.remove(col, key);
                } catch (e) {
                    console.error(`Idempotency: failed to release key ${key}:`, e);
                }
            }
            return originalJson(body);
        };

        next();
    };
}

// Drops entries past the age cutoff. Returns how many were removed.
// Called from the same maintenance pass that prunes other expired records.
// Applies equally to completed rows and to reservations nobody ever came
// back to resolve — both are just rows keyed by `at`, and 30 days is far
// past anything RESERVATION_LEASE_MS is meant to bound.
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

module.exports = {
    middleware, prune, isValidKey, KEY_PATTERN, HEADER, DEFAULT_MAX_AGE_DAYS,
    RESERVATION_LEASE_MS,
};
