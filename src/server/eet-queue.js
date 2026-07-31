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

function nextAttemptDelay(attempts) {
    return BACKOFF_MS[attempts] !== undefined ? BACKOFF_MS[attempts] : BACKOFF_TAIL_MS;
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

    const datTrzby = receipt.issuedAt;
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
    if (!record) throw new Error(`EET: no queue record ${id}`);

    // A confirmed sale already has its POK — resending it would report the
    // SAME sale a second time under a fresh prvni_zaslani=false envelope,
    // which the tax authority has no reason to treat as anything other than
    // a second, independent trzba. Once confirmed, this function is a no-op.
    if (record.state === "confirmed") return record;

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
        } else if (eet.classifyError(res.errorCode) === "terminal") {
            // Terminal means retrying would fail identically for the full 48h
            // window and hide the fault from staff — stop here instead of
            // burning the deadline on a doomed retry loop.
            record.state = "failed";
            record.lastError = `EET ${res.errorCode}: ${res.errorText}`;
            console.error(`❌ EET terminal error on receipt ${record.receiptNumber} — ${record.lastError}`);
        } else {
            // Retryable EET-level rejection (-1 / 8): stay pending, the
            // background worker (Task 8) will try again per nextAttemptDelay.
            record.lastError = `EET ${res.errorCode}: ${res.errorText}`;
        }
    } catch (e) {
        // Transport-level failure (timeout, DNS, TLS, non-2xx) — eet.js
        // always marks these retryable, and there is nothing else to do here
        // but record the reason and leave the record pending for the worker.
        record.lastError = e.message;
    }

    return db.set(col, id, record);
}

module.exports = {
    DEADLINE_MS, BACKOFF_MS, BACKOFF_TAIL_MS,
    isEvidovanaTrzba, registerFor, nextAttemptDelay, enqueue, sendOnce,
};
