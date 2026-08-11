// ============================================================================
// reservation-retention.js — deletes past bookings that nothing requires the
// restaurant to keep.
//
// Review 2026-08-10, finding N1(b). This does not implement a new policy; it
// implements the one already PUBLISHED. src/html/ochrana-osobnich-udaju.html §5
// promises that reservations without an attached receipt are kept "pouze
// krátkodobě po proběhlém termínu … poté jsou smazány nebo anonymizovány".
// Nothing did that. Guest names and phone numbers lived in the `timetables`
// blob forever, and a published retention promise with no implementing job is
// the kind of finding a supervisory authority reads first.
//
// WHAT IS NEVER TOUCHED, and why each exception is load-bearing:
//
//   isPaid / receiptId / refundReceiptId
//       A paid booking is a tax record. Czech accounting and tax rules require
//       5-10 years, which beats data minimisation outright — deleting one to
//       satisfy a privacy promise would be trading a small compliance win for a
//       large compliance loss. The receipt itself lives in its own collection;
//       this only decides whether the SLOT that points at it survives, and a
//       receipt whose originating booking has vanished is an audit gap.
//
//   isPermanent
//       A standing reservation ("Firemní oběd, every Tuesday") is written on one
//       date and applied forward from it by timetable.isRangeFree. Its date is
//       therefore in the past almost immediately and gets further into the past
//       forever, while the booking is still live. Pruning by date would delete
//       the restaurant's standing bookings — the single most damaging thing this
//       file could do.
//
//   anything whose dateStr is not a real calendar date
//       Fails toward KEEPING. A slot this module cannot reason about is a slot
//       it has no business deleting, and the cost of keeping one is one stale
//       row rather than a booking nobody can explain the loss of.
//
// Dependency-free apart from timetable.js (itself dependency-free), so every
// rule is unit-testable without standing up a server or a database.
// ============================================================================

const { parseDateStr } = require("./timetable");

// Deliberately an env var rather than a settings field, matching
// LOGIN_AUDIT_RETENTION_DAYS in security.js: retention is a deployment-level
// legal decision, not something to leave behind a button in the admin UI where
// it can be changed to 0 by someone exploring the interface.
const RETENTION_DAYS = parseInt(process.env.RESERVATION_RETENTION_DAYS, 10) > 0
    ? parseInt(process.env.RESERVATION_RETENTION_DAYS, 10)
    : 90;

// Does anything oblige the restaurant to keep this slot?
function mustKeep(slot) {
    if (!slot || typeof slot !== "object") return true; // not a booking; leave it alone
    if (slot.isPermanent) return true;
    if (slot.isPaid) return true;
    if (slot.receiptId || slot.refundReceiptId) return true;
    return false;
}

// A booking is expired when the whole DAY it was booked for is further in the
// past than the retention window. Day granularity, not hour: "90 days" in a
// privacy policy means days, and a booking at 20:00 should not outlive the one
// at 08:00 on the same date by half a day.
function isExpired(dateStr, now, retentionDays) {
    const date = parseDateStr(dateStr);
    if (!date) return false; // unparseable — see the header
    date.setHours(23, 59, 59, 999); // end of the booked day
    return date.getTime() < now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
}

/**
 * Pure: what would be deleted, and from where.
 *
 * @returns {Array<{fileId: string, dateStr: string, dayKey: string, hourKeys: string[]}>}
 *          one entry per (table, date, weekday) that has slots to remove.
 */
function selectExpiredBookings(records, opts = {}) {
    if (!Array.isArray(records)) return [];

    const now = opts.now instanceof Date ? opts.now : new Date();
    const days = Number(opts.retentionDays);
    const retentionDays = Number.isFinite(days) && days > 0 ? days : RETENTION_DAYS;

    const plan = [];

    for (const record of records) {
        const data = (record && record.data) || {};
        if (!record || !record.fileId) continue;

        for (const dateStr of Object.keys(data)) {
            if (!isExpired(dateStr, now, retentionDays)) continue;

            const dayContainer = data[dateStr];
            if (!dayContainer || typeof dayContainer !== "object") continue;

            for (const dayKey of Object.keys(dayContainer)) {
                const hours = dayContainer[dayKey];
                if (!hours || typeof hours !== "object") continue;

                const hourKeys = Object.keys(hours).filter(h => !mustKeep(hours[h]));
                if (hourKeys.length) plan.push({ fileId: record.fileId, dateStr, dayKey, hourKeys });
            }
        }
    }

    return plan;
}

// True when a day/date container holds nothing worth keeping in the structure.
// Written for BOTH shapes on purpose: applyBookingToTimetable writes
// data[dateStr] as an array indexed by weekday, while PUT /timetables/:name
// accepts an object keyed by weekday — the same duality sanitizeTimetableForPublic
// handles.
function isEmptyContainer(container) {
    if (!container || typeof container !== "object") return true;
    return Object.keys(container).every(key => {
        const value = container[key];
        if (!value || typeof value !== "object") return true;
        return Object.keys(value).length === 0;
    });
}

// Mutates `record` in place, applying one plan entry. Split out from the
// selector so the tidying logic is testable on its own.
function applyToRecord(record, entry) {
    const dayContainer = record.data && record.data[entry.dateStr];
    if (!dayContainer) return 0;
    const hours = dayContainer[entry.dayKey];
    if (!hours) return 0;

    let removed = 0;
    for (const hourKey of entry.hourKeys) {
        if (hourKey in hours) { delete hours[hourKey]; removed += 1; }
    }

    // Tidy up, so a restaurant that has been running for years does not carry a
    // growing skeleton of empty date keys. Arrays keep their holes (deleting an
    // index leaves `undefined`), which isEmptyContainer treats as empty.
    if (Object.keys(hours).length === 0) delete dayContainer[entry.dayKey];
    if (isEmptyContainer(dayContainer)) delete record.data[entry.dateStr];

    return removed;
}

/**
 * Applies the rule. Best-effort: a prune that throws must never be able to take
 * the restaurant down, which is why the caller is an unref'd interval.
 *
 * @param {object} db          the db.js module (injected, so this stays testable)
 * @param {string} collection  the timetables collection name
 * @returns {number} slots deleted
 */
function prune(db, collection, opts = {}) {
    try {
        const records = db.list(collection);
        const plan = selectExpiredBookings(records, opts);
        if (!plan.length) return 0;

        const byFileId = new Map(records.map(r => [r.fileId, r]));
        const touched = new Set();
        let removed = 0;

        for (const entry of plan) {
            const record = byFileId.get(entry.fileId);
            if (!record) continue;
            const n = applyToRecord(record, entry);
            if (n) { removed += n; touched.add(entry.fileId); }
        }

        for (const fileId of touched) db.set(collection, fileId, byFileId.get(fileId));

        if (removed) {
            console.log(`🧹 Rezervace: smazáno ${removed} starých záznamů (uchování ${opts.retentionDays || RETENTION_DAYS} dnů).`);
        }
        return removed;
    } catch (e) {
        console.error("Reservation retention prune failed:", e.message);
        return 0;
    }
}

// ── DELIVERY BATCHES ─────────────────────────────────────────────────────
// H4/N1(c). A batch is a grouping of order ids formed for one driver run. They
// were written and never deleted — a closed one is only marked "dissolved" — so
// the collection grew forever, and attachToBatch lists it on every geocode.
//
// Not personal data (order ids and a timestamp), which is why this sat with the
// storage work rather than with the privacy pass. It is still unbounded growth
// on a path an anonymous POST /orders reaches.
//
// 30 days: a batch is operationally dead within hours of being claimed, and the
// only reason to keep one at all afterwards is looking back at how a delivery
// run was grouped. The ORDERS survive regardless — they are their own
// collection, and receipts point at them, not at batches.
const BATCH_RETENTION_DAYS = parseInt(process.env.DELIVERY_BATCH_RETENTION_DAYS, 10) > 0
    ? parseInt(process.env.DELIVERY_BATCH_RETENTION_DAYS, 10)
    : 30;

// Pure, same shape as the booking selector above. A batch with no usable
// createdAt is KEPT: it is cheap to keep, and a batch a driver is mid-run on is
// not something to delete on the strength of a missing timestamp.
function selectExpiredBatchIds(rows, opts = {}) {
    if (!Array.isArray(rows)) return [];

    const now = opts.now instanceof Date ? opts.now : new Date();
    const days = Number(opts.retentionDays);
    const retentionDays = Number.isFinite(days) && days > 0 ? days : BATCH_RETENTION_DAYS;
    const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;

    const doomed = [];
    for (const row of rows) {
        if (!row || !row.id) continue;
        const t = row.createdAt ? new Date(row.createdAt).getTime() : NaN;
        if (!Number.isFinite(t)) continue; // undateable — keep
        if (t < cutoff) doomed.push(row.id);
    }
    return doomed;
}

function pruneBatches(db, collection, opts = {}) {
    try {
        const expired = selectExpiredBatchIds(db.list(collection), opts);
        for (const id of expired) db.remove(collection, id);
        if (expired.length) console.log(`🧹 Rozvozové skupiny: smazáno ${expired.length} starých záznamů.`);
        return expired.length;
    } catch (e) {
        console.error("Delivery batch prune failed:", e.message);
        return 0;
    }
}

module.exports = {
    RETENTION_DAYS,
    mustKeep,
    isExpired,
    selectExpiredBookings,
    isEmptyContainer,
    applyToRecord,
    prune,
    // Delivery batches
    BATCH_RETENTION_DAYS,
    selectExpiredBatchIds,
    pruneBatches,
};
