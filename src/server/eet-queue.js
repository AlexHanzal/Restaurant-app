// ============================================================================
// eet-queue.js — persistence and retry for EET 2.0 sale reporting
// ============================================================================
//
// THE QUEUE IS THE SOURCE OF TRUTH. createReceiptForOrder() enqueues
// synchronously; the immediate send is only an optimisation to get a POK onto
// the receipt before it prints. If a call site ever forgets to await the send,
// the background worker still reports the sale — a forgotten await is a
// latency bug, never a compliance failure.
//
// Kept separate from eet.js (which stays pure and stateless) and from
// server.js (already 200 kB+). Takes `db` as a parameter rather than requiring
// it, so the state machine is testable against a plain Map.
// ============================================================================

const crypto = require("node:crypto");
const eet = require("./eet");

// ZoET allows 48 hours to get a sale through after a failed first attempt.
const DEADLINE_MS = 48 * 60 * 60 * 1000;

// Backoff from lastAttemptAt: 1min, 5min, 15min, then hourly. Bounded and
// predictable — a full 48h outage produces ~50 attempts, not thousands.
const BACKOFF_MS = [60_000, 300_000, 900_000];
const BACKOFF_TAIL_MS = 3_600_000;

// Owner's decision (2026-07-31): report every confirmed payment regardless of
// instrument, including GoPay BANK_ACCOUNT transfers. The arguments this would
// need are taken deliberately, so narrowing it later (e.g. if the restaurant's
// accountant rules bank transfers out as not being evidované tržby) is a
// one-line change with a test already pointing here.
function isEvidovanaTrzba(paymentMethod, gopayInstrument) {
    return true;
}

// A refund reports against the register of the sale it reverses, so a storno
// never lands in a different EET register than its original.
function registerFor(config, kind, originalKind) {
    const key = kind === "refund" ? originalKind : kind;
    return config.registers[key] || config.registers.indoor;
}

// Intended schedule, spelled out so an off-by-one can't silently creep back
// in: after the 1st attempt, wait 1 min; after the 2nd, wait 5 min; after the
// 3rd, wait 15 min; after the 4th and every one after that, wait an hour.
// `attempts` here is attempts ALREADY MADE (sendOnce increments it BEFORE
// sending, so by the time a record is checked for its next due time,
// `attempts` already reflects the attempt whose backoff we're waiting out) —
// so the stage is BACKOFF_MS[attempts - 1], not BACKOFF_MS[attempts]. Indexing
// by attempts directly (the bug this comment replaces) reads the NEXT stage
// early: after 1 attempt it would wait the 2nd stage's 5 min instead of the
// 1st stage's 1 min, and every later stage is shifted the same way, so the
// 1-minute stage never happens at all. attempts === 0 (never tried) has no
// prior attempt to back off from — dueRecords() already treats that case as
// immediately due via its `!lastAttemptAt` check, but we still return a safe
// value here (the first stage) rather than reading BACKOFF_MS[-1].
function nextAttemptDelay(attempts) {
    if (attempts <= 0) return BACKOFF_MS[0];
    const stage = attempts - 1;
    return BACKOFF_MS[stage] !== undefined ? BACKOFF_MS[stage] : BACKOFF_TAIL_MS;
}

// Creates the pending record. Idempotent on receipt.id: calling twice returns
// the first record untouched, which matters because uuidZpravy and datTrzby
// must never change once assigned (see sendOnce).
//
// supersedesReceiptId exists for exactly one caller: createReceiptForOrder's
// fallback in server.js, which mints a brand-new receipt (new id, new
// issuedAt) when the receipt row `existingReceiptId` pointed at has gone
// missing. That new receipt is a new ROW, but it is NOT a new SALE — the
// eet_records entry tracks the sale, not the receipt row, and a sale must be
// reported exactly once. If we let the normal path run for the replacement
// receipt, it would mint an independent record with its own uuidZpravy and
// datTrzby, and the tax authority's uniqueness key is
// (eic_popl, id_jednotky, id_pokl, dat_trzby) — so the SAME sale would be
// reported a second time. Silent double-reported revenue. So: when a prior
// record exists under supersedesReceiptId, we keep it (frozen uuidZpravy,
// datTrzby, poradCis, celkTrzba, state — including poradCis, which must stay
// the sequence number the sale was/will be reported under, not the
// replacement receipt's number) and only repoint receiptId/receiptNumber at
// the new receipt, so future lookups (printing, sendOnce) find it by the new
// receipt's id. Do not "simplify" this into always re-deriving from
// `receipt` — that's the exact bug this branch exists to prevent.
function enqueue(db, col, { receipt, kind, originalKind, config, supersedesReceiptId }) {
    const existing = db.get(col, receipt.id);
    if (existing) return existing;

    if (supersedesReceiptId) {
        const prior = db.get(col, supersedesReceiptId);
        if (prior) {
            const carried = { ...prior, id: receipt.id, receiptId: receipt.id, receiptNumber: receipt.number };
            db.remove(col, supersedesReceiptId);
            return db.set(col, receipt.id, carried);
        }
        // No prior record under the stale id — nothing to carry forward
        // (e.g. the sale was never enqueued in the first place). Fall
        // through and create a normal new record below.
    }

    // receipt.issuedAt comes straight from createReceiptForOrder's
    // `new Date().toISOString()` (server.js) — which ALWAYS appends
    // milliseconds (".xxxZ"). assertEetDateTime (eet.js) requires
    // \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(Z|[+-]\d\d:\d\d) and deliberately
    // REJECTS fractional seconds — see its own header comment. Left
    // unstripped, buildTrzbaBody throws on EVERY real sale's datTrzby the
    // moment sendOnce tries to send it; sendOnce's try/catch swallows that
    // throw into lastError and leaves the record "pending" forever (it
    // never reaches "failed" — the throw happens before there is any
    // response to classify), while the receipt prints the reassuring
    // "Tržba je evidována v běžném režimu" notice for a sale that is never
    // actually reported. Every fixture in this codebase's own test suite
    // hand-writes a clean, millisecond-free issuedAt, which is exactly why
    // 102 passing unit tests never caught this — see
    // tests/unit/eet-queue-issuedat-normalisation.test.js, which drives
    // this through a REAL `new Date().toISOString()` value specifically to
    // close that gap. Strip milliseconds here, once, before the timestamp
    // is frozen into the record.
    //
    // A plain regex strip — NOT `new Date(receipt.issuedAt).toISOString()`
    // — is deliberate: round-tripping through Date/toISOString always
    // re-renders in UTC "Z" form, which would silently rewrite a
    // non-UTC-offset issuedAt (e.g. "...+02:00" — legal per the XSD, and
    // something a caller could hand-construct even though
    // createReceiptForOrder itself never does) into a different-looking
    // "Z" timestamp. That's not non-compliant, but it's an unnecessary,
    // easy-to-miss rewrite of a value this function's whole contract is to
    // freeze verbatim. A regex strip touches only the fractional-seconds
    // component and leaves the Z/offset suffix — and everything else about
    // the string — untouched.
    const datTrzby = String(receipt.issuedAt).replace(/\.\d+(?=Z|[+\-]\d\d:\d\d$)/, "");
    const record = {
        id: receipt.id,
        receiptId: receipt.id,
        receiptNumber: receipt.number,
        kind,
        originalKind: originalKind || null,
        uuidZpravy: crypto.randomUUID(),
        eic: config.eic,
        idJednotky: config.idJednotky,
        idPokl: registerFor(config, kind, originalKind),
        poradCis: receipt.number,
        datTrzby,
        celkTrzba: receipt.total,
        prvniZaslani: true,
        state: "pending",
        pok: null,
        warnings: [],
        attempts: 0,
        lastAttemptAt: null,
        lastError: null,
        sentAt: null,
        deadlineAt: new Date(new Date(datTrzby).getTime() + DEADLINE_MS).toISOString(),
    };
    return db.set(col, receipt.id, record);
}

// One send attempt against an existing record. Never throws — a transport
// failure (or any other unexpected problem) is recorded on the record and
// left pending, because a thrown error here runs on the payment hot path
// (createReceiptForOrder's caller just marked money as received) and a throw
// there would keep the order from ever being flagged paid. Compare: enqueue()
// above is allowed to be strict, because nothing has committed to a network
// call yet; sendOnce() is not, because by the time it runs the queue record
// already exists and the retry worker (Task 8) is the actual safety net.
//
// `client` is injected so tests can drive the whole state machine with no
// network at all — production always passes the real eet module (the
// default parameter below), which is the only caller that ever touches
// fetch.
async function sendOnce(db, col, id, { config, credentials, client = eet }) {
    const record = db.get(col, id);
    // A missing record should be unreachable from the payment hot path: every
    // caller of sendOnce (sendEetForReceipt in server.js, and the Task 8
    // retry worker walking the eet_records collection) only ever does so for
    // an id that createReceiptForOrder()/enqueue() just wrote or that is
    // already sitting in the collection. But "should be unreachable" is not
    // "throw is safe" — this function's whole contract (see the block
    // comment above) is that it never throws on the hot path, full stop. So
    // even this defensive case logs and returns null instead.
    if (!record) {
        console.error(`EET: no queue record ${id}`);
        return null;
    }

    // A confirmed sale already has its POK — resending it would report the
    // SAME sale a second time under a fresh prvni_zaslani=false envelope,
    // which the tax authority has no reason to treat as anything other than
    // a second, independent trzba. Once confirmed, this function is a no-op.
    if (record.state === "confirmed") return record;

    // A terminal failure means every retry for the rest of the 48h window
    // would hit the exact same rejection (bad signature, malformed request,
    // etc.) — retrying can't succeed, it can only burn time and spam logs.
    // Once failed, this function is a no-op too; a human has to fix whatever
    // caused the terminal error and re-open the record out of band.
    if (record.state === "failed") return record;

    // These three fields are the entire reason a retry reads as a RETRY and
    // not a second sale (see the header comment in this file and in
    // server.js's createReceiptForOrder): uuidZpravy and datTrzby are read
    // straight off the stored record — never regenerated, never `now()` — and
    // prvniZaslani is true only for the very first attempt (attempts === 0
    // BEFORE we increment below).
    const sale = {
        uuidZpravy: record.uuidZpravy,
        datOdesl: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        datTrzby: record.datTrzby,
        prvniZaslani: record.attempts === 0,
        eic: record.eic,
        idJednotky: record.idJednotky,
        idPokl: record.idPokl,
        poradCis: record.poradCis,
        celkTrzba: record.celkTrzba,
    };

    record.attempts += 1;
    record.lastAttemptAt = new Date().toISOString();
    record.prvniZaslani = false; // stored field mirrors the sale we just sent/are sending — never true again after attempt 1

    try {
        const res = await client.sendTrzba({ ...config, credentials }, sale);
        record.warnings = res.warnings || [];

        if (res.ok) {
            record.state = "confirmed";
            record.pok = res.pok;
            record.sentAt = record.lastAttemptAt;
            record.lastError = null;
        } else if (res.errorCode != null && eet.classifyError(res.errorCode) === "terminal") {
            // Terminal means retrying would fail identically for the full 48h
            // window and hide the fault from staff — stop here instead of
            // burning the deadline on a doomed retry loop.
            record.state = "failed";
            record.lastError = `EET ${res.errorCode}: ${res.errorText}`;
            console.error(`❌ EET terminal error on receipt ${record.receiptNumber} — ${record.lastError}`);
        } else {
            // Retryable: either an EET-level code the tax authority itself
            // marked retryable (-1 / 8), OR — just as importantly —
            // res.errorCode === null, meaning parseResponse() found neither
            // <Chyba> nor <Potvrzeni> at all (a SOAP fault, a captive-portal
            // login page, a truncated body from a flaky proxy — anything
            // that returns HTTP 200 with a body the tax authority never
            // actually produced). classifyError(null) alone would say
            // "terminal" (null is neither -1 nor 8), which would
            // permanently kill the sale on nothing more than an
            // infrastructure blip that happened to come back as a 200.
            // Terminal must mean "the tax authority looked at this sale and
            // rejected it for a reason no retry can fix" — an unparseable
            // body means no such verdict ever reached us, so stay pending
            // and let the background worker (Task 8) try again.
            record.lastError = res.errorCode != null
                ? `EET ${res.errorCode}: ${res.errorText}`
                : "EET: response had no parseable <Chyba> or <Potvrzeni> element — treating as a retryable infrastructure failure";
        }
    } catch (e) {
        // Transport-level failure (timeout, DNS, TLS, non-2xx) — eet.js
        // always marks these retryable, and there is nothing else to do here
        // but record the reason and leave the record pending for the worker.
        record.lastError = e.message;
    }

    // Re-check that this id still exists RIGHT BEFORE persisting. enqueue()'s
    // supersedesReceiptId path (see its own header comment in this file) can
    // db.remove() this exact id while the send above was in flight — the
    // lost-receipt-row fallback in server.js racing this very call. `record`
    // here was fetched via db.get() before that removal, so without this
    // check the write below would resurrect a row enqueue() just deleted —
    // and it would come back holding the SAME uuidZpravy as the new row
    // enqueue() created for the replacement receipt. Two rows, one
    // uuidZpravy: the new one legitimately tracked, this one orphaned and
    // retried forever by the background worker with nothing ever pointing
    // at it. Whatever id superseded this one now owns the sale's future —
    // just discard this attempt's outcome instead of writing it anywhere.
    if (!db.get(col, id)) {
        console.error(`EET: queue record ${id} was removed (likely superseded by a replacement receipt) while a send was in flight — discarding this attempt's result instead of resurrecting it`);
        return null;
    }

    // The persist itself has to be inside the protected region too: this
    // whole function sits on the payment hot path (see the block comment
    // above sendOnce), and its documented contract is that it never throws.
    // A storage failure here (disk full, whatever) can't be allowed to
    // propagate just because it happens to be the very last statement — that
    // would silently break the "never throws" contract for exactly the kind
    // of failure it exists to protect against. Log it and swallow it instead;
    // the in-memory record already reflects the outcome of this attempt, and
    // the next retry (worker or another hot-path call) will try the write
    // again from db.get().
    try {
        return db.set(col, id, record);
    } catch (e) {
        console.error(`EET: failed to persist queue record ${id} after send attempt:`, e.message);
        return null;
    }
}

// Records eligible for another attempt right now (Task 8's retry worker in
// server.js calls this on a timer and awaits sendOnce for each result). Only
// `pending` records are candidates at all — sendOnce() already treats
// `confirmed`/`failed` as terminal no-ops (see its own comments), so a record
// in either state would just come back unchanged; filtering here purely
// saves the wasted call.
//
// Deliberately does NOT filter out records past their deadlineAt. It is
// tempting to read DEADLINE_MS/deadlineAt and conclude "no point retrying
// after 48h, ZoET has already been violated" — but that reasoning is
// backwards. Blowing the 48h window is a compliance problem to be surfaced
// and fixed (loudly — see the ESCALATE_BEFORE_DEADLINE_MS logging in
// server.js's worker), not a signal to give up and let the sale sit
// unreported forever. Do not "optimise" this filter back in.
function dueRecords(db, col, now = new Date()) {
    return db.list(col).filter(r => {
        if (r.state !== "pending") return false;
        if (!r.lastAttemptAt) return true;
        const waited = now.getTime() - new Date(r.lastAttemptAt).getTime();
        return waited >= nextAttemptDelay(r.attempts);
    });
}

// Feeds the staff-only GET /api/eet/health route in server.js. Revenue-shaped
// (counts by state, the oldest unreported sale, the most recent failure
// reason) — nothing here is sensitive on its own, but combined it tells a
// competitor or a curious customer roughly how much unreported/failed
// business is flowing through, hence requireAuth at the route rather than
// leaving this endpoint open.
function healthSummary(db, col, now = new Date()) {
    const all = db.list(col);
    const pending = all.filter(r => r.state === "pending");
    // Oldest by the sale's own timestamp (datTrzby), not by when we happened
    // to look at it — that's what tells staff how long a sale has actually
    // been unreported, which is the number that matters for the 48h clock.
    //
    // A missing or unparseable datTrzby must sort LAST, not first. The naive
    // `new Date(r.datTrzby || 0)` maps a missing datTrzby to epoch 1970,
    // which then sorts before every real 2026 timestamp — so a single
    // corrupt record would permanently masquerade as "the oldest pending
    // sale" and bury the genuinely oldest one (the one actually closest to
    // blowing its 48h deadline) out of staff's view. Number.POSITIVE_INFINITY
    // for the unparseable case guarantees it sorts after every valid date
    // instead.
    const trzbyTimeOrInfinity = r => {
        const t = r.datTrzby ? new Date(r.datTrzby).getTime() : NaN;
        return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
    };
    const oldest = pending
        .slice()
        .sort((a, b) => trzbyTimeOrInfinity(a) - trzbyTimeOrInfinity(b))[0];
    // Last-seen error in list order, not last-seen chronologically — db.list
    // has no ordering guarantee, but for the health snapshot "some recent
    // failure reason" is enough; it exists so staff glancing at /eet/health
    // don't have to open individual records to see why things are stuck.
    const lastFailed = all.filter(r => r.lastError).slice(-1)[0];

    // Warnings (Varovani) come back on an otherwise-successful POK — see
    // sendOnce, which stores res.warnings on the record unconditionally,
    // success or not. They are not fatal to the sale, which is exactly why
    // nothing in this codebase surfaces them anywhere: they land on the
    // record and just sit there. That's the wrong default for something the
    // tax authority is actively trying to tell the operator (e.g. "kod_varov
    // 6" — id_jednotky/id_pokl format issues that don't block filing today
    // but may in a future crackdown). Counting them here, alongside the most
    // recent one's text, is the minimum needed to make /api/eet/health (the
    // only consumer of this function) stop hiding them entirely.
    const recordsWithWarnings = all.filter(r => Array.isArray(r.warnings) && r.warnings.length > 0);
    const warningCount = recordsWithWarnings.reduce((sum, r) => sum + r.warnings.length, 0);
    const lastWarningRecord = recordsWithWarnings.slice(-1)[0];
    const lastWarning = lastWarningRecord ? lastWarningRecord.warnings[lastWarningRecord.warnings.length - 1] : null;

    return {
        pending: pending.length,
        confirmed: all.filter(r => r.state === "confirmed").length,
        failed: all.filter(r => r.state === "failed").length,
        overdue: pending.filter(r => new Date(r.deadlineAt) < now).length,
        oldestPending: oldest ? oldest.id : null,
        lastError: lastFailed ? lastFailed.lastError : null,
        warningCount,
        lastWarning,
    };
}

module.exports = {
    DEADLINE_MS, BACKOFF_MS, BACKOFF_TAIL_MS,
    isEvidovanaTrzba, registerFor, nextAttemptDelay, enqueue, sendOnce,
    dueRecords, healthSummary,
};
