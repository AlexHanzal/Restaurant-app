// ============================================================================
// timetable.test.js — timetable.js's slot-occupancy rule.
//
// Fix 3 of the 2026-08-09 reservation review. The customer-facing page has
// always applied permanent bookings FORWARD across later dates
// (renderer.js's isHourFree: an earlier date's slot with isPermanent blocks
// the same weekday+hour on every date after it). The server's booking write
// did not — it only looked at data[dateStr][dayIndex][hour] — so the two
// disagreed about what "free" means, and the server is the one that writes.
// Any request that skipped the UI (stale page, replay, hand-crafted POST)
// booked straight over a standing reservation.
//
// This module is that rule, extracted so both the booking write and these
// tests use the exact same code path.
// ============================================================================

const test = require("node:test");
const assert = require("node:assert");

const timetable = require("../../src/server/timetable");

// 2026-08-10 and 2026-08-17 are both Mondays (dayIndex 0), a week apart.
const MON_1 = "2026-08-10";
const MON_2 = "2026-08-17";
const HOUR = 5;

function record(data) {
    return { className: "Stůl 1", fileId: "t1", data };
}

function slot(content, isPermanent) {
    return { content, abbreviation: "XX", isPermanent };
}

test("an empty timetable has every slot free", () => {
    assert.strictEqual(timetable.isSlotFree(record({}), MON_1, 0, HOUR), true);
    assert.strictEqual(timetable.isSlotFree(record(), MON_1, 0, HOUR), true);
});

test("a booking on the same date occupies its own slot", () => {
    const r = record({ [MON_1]: { 0: { [HOUR]: slot("Jan Novák", false) } } });
    assert.strictEqual(timetable.isSlotFree(r, MON_1, 0, HOUR), false);
    assert.strictEqual(timetable.isSlotFree(r, MON_1, 0, HOUR + 1), true, "neighbouring hour untouched");
});

test("a permanent booking blocks the same weekday and hour on later dates", () => {
    const r = record({ [MON_1]: { 0: { [HOUR]: slot("Firemní oběd", true) } } });
    assert.strictEqual(timetable.isSlotFree(r, MON_2, 0, HOUR), false, "the whole point of a standing reservation");
});

test("a one-off booking does NOT block later dates", () => {
    const r = record({ [MON_1]: { 0: { [HOUR]: slot("Jan Novák", false) } } });
    assert.strictEqual(timetable.isSlotFree(r, MON_2, 0, HOUR), true);
});

test("a permanent booking does not reach backwards to earlier dates", () => {
    const r = record({ [MON_2]: { 0: { [HOUR]: slot("Firemní oběd", true) } } });
    assert.strictEqual(timetable.isSlotFree(r, MON_1, 0, HOUR), true);
});

test("a permanent booking only blocks its own hour", () => {
    const r = record({ [MON_1]: { 0: { [HOUR]: slot("Firemní oběd", true) } } });
    assert.strictEqual(timetable.isSlotFree(r, MON_2, 0, HOUR + 1), true);
});

test("an empty-content slot is not an occupancy", () => {
    const r = record({ [MON_1]: { 0: { [HOUR]: slot("", true) } } });
    assert.strictEqual(timetable.isSlotFree(r, MON_2, 0, HOUR), true);
});

test("day maps stored as arrays behave the same as objects", () => {
    // applyBookingToTimetable writes data[dateStr] as an ARRAY indexed by
    // dayIndex; PUT /timetables/:name accepts object-shaped ones. Both shapes
    // exist in real records, so both must read identically.
    const asArray = record({ [MON_1]: Object.assign([], { 0: { [HOUR]: slot("Firemní oběd", true) } }) });
    assert.strictEqual(timetable.isSlotFree(asArray, MON_2, 0, HOUR), false);
});

test("junk date keys in stored data never crash the check", () => {
    const r = record({ "aaaa": { 0: { [HOUR]: slot("Nesmysl", true) } }, [MON_1]: {} });
    assert.strictEqual(timetable.isSlotFree(r, MON_2, 0, HOUR), true, "an unparseable key cannot block anything");
});

// ── the helper the booking write actually calls ─────────────────────────

test("isRangeFree reports the first hour that is taken", () => {
    const r = record({ [MON_1]: { 0: { 6: slot("Jan Novák", false) } } });
    assert.deepStrictEqual(timetable.isRangeFree(r, MON_1, 0, 5, 1), { ok: true, takenHour: null });
    assert.deepStrictEqual(timetable.isRangeFree(r, MON_1, 0, 5, 2), { ok: false, takenHour: 6 });
    assert.deepStrictEqual(timetable.isRangeFree(r, MON_1, 0, 6, 1), { ok: false, takenHour: 6 });
});

test("isRangeFree honours permanent blocks carried forward", () => {
    const r = record({ [MON_1]: { 0: { 6: slot("Firemní oběd", true) } } });
    assert.deepStrictEqual(timetable.isRangeFree(r, MON_2, 0, 5, 2), { ok: false, takenHour: 6 });
});
