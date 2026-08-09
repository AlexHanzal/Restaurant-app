// ============================================================================
// timetable.js — the timetable's date/occupancy rules, as pure functions.
//
// Extracted from server.js after the 2026-08-09 reservation review, which
// found the server and the customer-facing page disagreeing about what a
// "free" slot is:
//
//   - renderer.js (isHourFree) has always applied PERMANENT bookings forward:
//     a slot marked isPermanent on an earlier date blocks that same weekday +
//     hour on every later date. That is what makes a standing reservation a
//     standing reservation.
//   - applyBookingToTimetable in server.js looked only at
//     data[dateStr][dayIndex][hour] on the requested date, so it never saw
//     those blocks — and the server is the side that actually writes.
//
// So any booking request that skipped the UI (a page left open from before
// the standing reservation was created, a replayed request, a hand-crafted
// POST) was written straight over the top of one. Having exactly one
// implementation of the rule, on the side that owns the write, is the fix.
//
// Deliberately dependency-free (no db, no settings) so it stays unit-testable
// as a plain function of a record — see tests/unit/timetable.test.js.
//
// Record shape, as written by applyBookingToTimetable:
//   record.data[dateStr][dayIndex][hourIndex] = { content, isPermanent, ... }
// `data[dateStr]` is an ARRAY indexed by dayIndex there, but PUT
// /timetables/:name accepts object-shaped day maps, and both shapes exist in
// real data — indexing with [] reads either one identically.
// ============================================================================

const DATE_STR_RE = /^\d{4}-\d{2}-\d{2}$/;

// "YYYY-MM-DD" -> a local-midnight Date, or null if the string is not that
// format or not a real calendar date.
//
// The round-trip check is not redundant: `new Date("2026-02-29T00:00:00")`
// does not throw and does not produce an Invalid Date — it silently rolls
// over to 2026-03-01. Comparing the parsed components back against the input
// is the only way to reject a date that does not exist.
function parseDateStr(dateStr) {
    if (typeof dateStr !== "string" || !DATE_STR_RE.test(dateStr)) return null;

    const [y, m, d] = dateStr.split("-").map(Number);
    const date = new Date(y, m - 1, d);
    if (Number.isNaN(date.getTime())) return null;
    if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null;

    return date;
}

// Monday-first weekday index (0=Po..6=Ne) for a "YYYY-MM-DD" string, or null
// if it is not a real date. Same convention as settings.dayIndexMonFirst()
// and renderer.js's getDayIndexFromDateString().
//
// This exists so the server can DERIVE dayIndex from the date rather than
// accept it from the client. It used to arrive in the request body, checked
// only as "an integer 0-6", which let a caller pair one day's date with
// another day's index — bypassing a closed weekday, and writing the booking
// into a slot bucket the customer-facing page never reads.
function dayIndexFromDateStr(dateStr) {
    const date = parseDateStr(dateStr);
    return date ? (date.getDay() + 6) % 7 : null;
}

// Is this one hour slot free on this date, for this table record?
//
// Two ways a slot can be taken:
//   1. a booking written on this very date, or
//   2. a PERMANENT booking on any EARLIER date at the same dayIndex + hour,
//      which repeats forward from the date it was created on.
//
// Mirrors renderer.js's isHourFree exactly, with one deliberate difference:
// both sides of the date comparison are parsed the same way (local midnight).
// renderer.js compares a local-midnight target against `new Date(weekDate)`,
// which parses a bare date as UTC midnight — off by up to a day depending on
// the timezone offset. Unparseable stored keys are skipped rather than
// compared as Invalid Date (which silently compares false either way).
function isSlotFree(record, dateStr, dayIndex, hourIndex) {
    if (!Number.isInteger(dayIndex) || dayIndex < 0 || dayIndex > 6) return false;

    const data = (record && record.data) || {};

    const direct = data[dateStr] && data[dateStr][dayIndex] && data[dateStr][dayIndex][hourIndex];
    if (direct && direct.content) return false;

    const target = parseDateStr(dateStr);
    if (!target) return false;

    for (const otherDateStr of Object.keys(data)) {
        if (otherDateStr === dateStr) continue;

        const other = parseDateStr(otherDateStr);
        if (!other || other > target) continue;

        const dayMap = data[otherDateStr];
        const slot = dayMap && dayMap[dayIndex] && dayMap[dayIndex][hourIndex];
        if (slot && slot.content && slot.isPermanent) return false;
    }

    return true;
}

// Is every hour of [startHour, startHour + duration) free? Returns the first
// taken hour so the caller can name it in the error the customer sees, which
// is what the booking route did before this module existed.
function isRangeFree(record, dateStr, dayIndex, startHour, duration) {
    for (let h = startHour; h < startHour + duration; h++) {
        if (!isSlotFree(record, dateStr, dayIndex, h)) return { ok: false, takenHour: h };
    }
    return { ok: true, takenHour: null };
}

module.exports = {
    parseDateStr,
    dayIndexFromDateStr,
    isSlotFree,
    isRangeFree,
};
