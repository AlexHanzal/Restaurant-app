// ============================================================================
// reservation-slot.test.js — settings.js's reservation enforcement helpers.
//
// Covers three fixes made after the 2026-08-09 reservation review:
//
//   1. dayIndex is DERIVED from dateStr, never taken from the client. It used
//      to arrive in the request body (validated only as "an integer 0-6"), so
//      a caller could pair a Saturday `dateStr` with Monday's `dayIndex` and
//      slip past a closed weekday — and the booking then landed in a slot
//      bucket the customer-facing page never reads, i.e. an invisible
//      double-booking. isReservationSlotOpen no longer accepts a dayIndex
//      parameter at all, which is what makes that class of bug unreachable
//      rather than merely fixed.
//
//   2. dateStr is validated as a real calendar date and bounded on both
//      sides. It used to be `reqStr(20)` — any non-empty string up to 20
//      chars — so "aaaa", 1999 and 2099 were all bookable.
//
//   3. (see tests/unit/timetable.test.js for the permanent-booking half)
//
// `now` is injected into every case below rather than being read from the
// clock, so these assertions mean the same thing on every future run —
// mirroring how isDeliveryOpenNow already takes its own `now`.
// ============================================================================

const test = require("node:test");
const assert = require("node:assert");
const os = require("os");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

// db.js resolves DB_PATH at require time, so this has to be set first —
// same pattern as tests/unit/settings.test.js.
const TMP_DB = path.join(os.tmpdir(), `resv-slot-${process.pid}-${crypto.randomBytes(6).toString("hex")}.db`);
process.env.SQLITE_PATH = TMP_DB;

const db = require("../../src/server/db");
const settings = require("../../src/server/settings");

test.after(() => {
    try { db.getDb().close(); } catch { /* already closed */ }
    for (const suffix of ["", "-wal", "-shm"]) {
        try { fs.unlinkSync(TMP_DB + suffix); } catch { /* never existed */ }
    }
});

// Reference calendar (verified against the real calendar, not assumed):
//   2026-08-10 Mon (dayIndex 0)   2026-08-15 Sat (dayIndex 5)
//   2026-08-11 Tue (dayIndex 1)   2026-08-16 Sun (dayIndex 6)
const MON = "2026-08-10";
const SAT = "2026-08-15";

// A fixed "now" well inside the working day, so a same-day 12:00 booking
// (hourIndex 5) is still in the future and a same-day 8:00 one (hourIndex 1)
// is already past.
const NOW = new Date("2026-08-10T09:30:00");

function baseSettings(overrides = {}) {
    const s = settings.getSettings();
    return {
        ...s,
        ...overrides,
        reservations: { ...s.reservations, ...(overrides.reservations || {}) },
    };
}

// ── dayIndexFromDateStr ─────────────────────────────────────────────────

test("dayIndexFromDateStr maps dates to Monday-first 0-6", () => {
    assert.strictEqual(settings.dayIndexFromDateStr("2026-08-10"), 0); // Mon
    assert.strictEqual(settings.dayIndexFromDateStr("2026-08-11"), 1); // Tue
    assert.strictEqual(settings.dayIndexFromDateStr("2026-08-15"), 5); // Sat
    assert.strictEqual(settings.dayIndexFromDateStr("2026-08-16"), 6); // Sun
});

test("dayIndexFromDateStr returns null for anything that is not a real date", () => {
    for (const bad of ["", "aaaa", "2026-8-1", "2026-13-01", "2026-02-29", "10-08-2026", null, undefined, 20260810]) {
        assert.strictEqual(settings.dayIndexFromDateStr(bad), null, `${JSON.stringify(bad)} must not resolve to a weekday`);
    }
});

// ── dateStr validation (fix 2) ──────────────────────────────────────────

test("rejects a dateStr that is not YYYY-MM-DD", () => {
    const s = baseSettings();
    for (const bad of ["aaaa", "2026-8-1", "", "10-08-2026"]) {
        const r = settings.isReservationSlotOpen(s, bad, 5, 1, NOW);
        assert.strictEqual(r.ok, false, `${JSON.stringify(bad)} must be rejected`);
        assert.match(r.reason, /datum/i);
    }
});

test("rejects a well-formed string that is not a real calendar date", () => {
    // JS silently rolls 2026-02-29 over to 2026-03-01, so a plain
    // `new Date(...)` parse is NOT enough to catch this one.
    const s = baseSettings();
    for (const bad of ["2026-02-29", "2026-13-01", "2026-00-10", "2026-08-32"]) {
        const r = settings.isReservationSlotOpen(s, bad, 5, 1, NOW);
        assert.strictEqual(r.ok, false, `${bad} must be rejected`);
    }
});

test("rejects a date in the past", () => {
    const r = settings.isReservationSlotOpen(baseSettings(), "2026-08-09", 5, 1, NOW);
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /minulosti/i);
});

test("accepts today for an hour that has not started yet", () => {
    assert.strictEqual(settings.isReservationSlotOpen(baseSettings(), MON, 5, 1, NOW).ok, true);
});

test("rejects an hour on today that has already passed", () => {
    // NOW is 09:30; hourIndex 1 is the 8:00 slot.
    const r = settings.isReservationSlotOpen(baseSettings(), MON, 1, 1, NOW);
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /minulosti/i);
});

test("accepts the last day inside the booking horizon and rejects the one past it", () => {
    const s = baseSettings({ reservations: { maxDaysAhead: 14 } });
    // NOW is 2026-08-10, so +14 days is 2026-08-24.
    assert.strictEqual(settings.isReservationSlotOpen(s, "2026-08-24", 5, 1, NOW).ok, true);

    const beyond = settings.isReservationSlotOpen(s, "2026-08-25", 5, 1, NOW);
    assert.strictEqual(beyond.ok, false);
    assert.match(beyond.reason, /dopředu/i);
});

test("the horizon follows the setting, not a hardcoded 14", () => {
    // Guards against the bound quietly reverting to a constant: the admin
    // panel's "Rezervovat lze dopředu (dny)" field has to actually do
    // something.
    const s = baseSettings({ reservations: { maxDaysAhead: 3 } });
    assert.strictEqual(settings.isReservationSlotOpen(s, "2026-08-13", 5, 1, NOW).ok, true, "day 3 is inside");
    assert.strictEqual(settings.isReservationSlotOpen(s, "2026-08-14", 5, 1, NOW).ok, false, "day 4 is not");

    // 0 means today only.
    const todayOnly = baseSettings({ reservations: { maxDaysAhead: 0 } });
    assert.strictEqual(settings.isReservationSlotOpen(todayOnly, MON, 5, 1, NOW).ok, true);
    assert.strictEqual(settings.isReservationSlotOpen(todayOnly, "2026-08-11", 5, 1, NOW).ok, false);
});

// ── weekday gate now follows the date (fix 1) ───────────────────────────

test("a closed weekday is closed for that date, with no dayIndex to override it", () => {
    const s = baseSettings();
    s.reservations.days = { ...s.reservations.days, "5": { open: false, fromHour: 1, toHour: 12 } };

    // SAT is a Saturday (dayIndex 5). Under the old signature a caller could
    // pass dayIndex 0 here and be let through; there is no such parameter now.
    const r = settings.isReservationSlotOpen(s, SAT, 5, 1, NOW);
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /nepřijímáme/i);
});

test("existing gates still hold: paused, closed day, and out-of-hours", () => {
    const paused = baseSettings({ reservations: { paused: true } });
    assert.strictEqual(settings.isReservationSlotOpen(paused, MON, 5, 1, NOW).ok, false);

    const closed = baseSettings({ closedDays: [{ date: MON, note: "Svátek" }] });
    assert.strictEqual(settings.isReservationSlotOpen(closed, MON, 5, 1, NOW).ok, false);

    const s = baseSettings();
    s.reservations.days = { ...s.reservations.days, "0": { open: true, fromHour: 4, toHour: 6 } };
    assert.strictEqual(settings.isReservationSlotOpen(s, MON, 3, 1, NOW).ok, false, "before fromHour");
    assert.strictEqual(settings.isReservationSlotOpen(s, MON, 6, 2, NOW).ok, false, "duration runs past toHour");
    assert.strictEqual(settings.isReservationSlotOpen(s, MON, 5, 2, NOW).ok, true, "fits exactly");
});

// ── settings/schema lockstep ────────────────────────────────────────────

test("maxDaysAhead ships as a default and survives the strict settings schema", () => {
    const V = require("../../src/server/validation");
    const s = settings.getSettings();

    assert.strictEqual(s.reservations.maxDaysAhead, 14);

    // The trap this guards: settingsSchema is .strict(), and the admin panel
    // always PUTs back the whole object it GET-ed. A default that the schema
    // does not declare 400s every settings save.
    const roundTrip = V.settingsSchema.safeParse(s);
    assert.strictEqual(roundTrip.success, true, roundTrip.error && JSON.stringify(roundTrip.error.issues));

    const tooFar = { ...s, reservations: { ...s.reservations, maxDaysAhead: 400 } };
    assert.strictEqual(V.settingsSchema.safeParse(tooFar).success, false, "an absurd horizon must not be settable");
});
