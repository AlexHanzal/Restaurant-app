// ============================================================================
// timezone.test.js — the process timezone this app runs its day boundaries in.
//
// Why this is worth a test at all: nearly every business rule in this app is
// expressed in LOCAL time (settings.js's formatDateStrLocal/formatHHMM, and
// through them the daily-menu window, isDeliveryOpenNow,
// isTableOrderingOpenNow, the sales-stats day buckets and the reservation
// reminder scanner). A Linux container defaults to UTC, which in Czech summer
// is two hours off — the daily menu would switch at 02:00, "are we open now"
// would answer for the wrong hour, and a day's takings would be split across
// two report days. None of that throws; it just quietly reports the wrong
// numbers, which is the worst way for a bug like this to behave.
// ============================================================================

const test = require("node:test");
const assert = require("node:assert");

const tz = require("../../src/server/timezone");

test("defaults to Europe/Prague when TZ is not set", () => {
    assert.strictEqual(tz.resolveTimezone({}), "Europe/Prague");
});

test("an explicitly set TZ always wins", () => {
    assert.strictEqual(tz.resolveTimezone({ TZ: "UTC" }), "UTC");
    assert.strictEqual(tz.resolveTimezone({ TZ: "America/New_York" }), "America/New_York");
});

// A blank value is the case that actually bites in practice: .env files are
// full of `TZ=` with nothing after it, and tests/helpers/harness.js
// deliberately force-blanks a whole block of vars. Treating "" as "set" would
// hand the process an empty timezone, which Node reads as UTC — the exact
// failure this module exists to prevent, arrived at through the config that
// was supposed to prevent it.
test("a blank or whitespace-only TZ is treated as unset", () => {
    assert.strictEqual(tz.resolveTimezone({ TZ: "" }), "Europe/Prague");
    assert.strictEqual(tz.resolveTimezone({ TZ: "   " }), "Europe/Prague");
});

test("applyTimezone fills in an unset TZ on the env it is given", () => {
    const env = {};
    const applied = tz.applyTimezone(env);
    assert.strictEqual(applied, "Europe/Prague");
    assert.strictEqual(env.TZ, "Europe/Prague");
});

test("applyTimezone never overwrites an operator's explicit choice", () => {
    const env = { TZ: "Asia/Tokyo" };
    const applied = tz.applyTimezone(env);
    assert.strictEqual(applied, "Asia/Tokyo");
    assert.strictEqual(env.TZ, "Asia/Tokyo");
});

// The reason the default is not merely cosmetic. Same instant, two zones,
// two different calendar days — so whichever zone the process happens to run
// in decides which day a 00:30 sale is reported under.
test("the choice of zone moves a real day boundary", () => {
    const instant = new Date("2026-08-05T22:30:00Z"); // 00:30 on the 6th in Prague (CEST)

    const inPrague = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/Prague", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(instant);
    const inUtc = new Intl.DateTimeFormat("en-CA", {
        timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(instant);

    assert.strictEqual(inPrague, "2026-08-06");
    assert.strictEqual(inUtc, "2026-08-05");
    assert.notStrictEqual(inPrague, inUtc);
});
