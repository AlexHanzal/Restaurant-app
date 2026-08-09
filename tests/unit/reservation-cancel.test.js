// ============================================================================
// reservation-cancel.test.js — the pure half of guest self-cancellation.
// Spec: docs/superpowers/specs/2026-08-09-reservation-self-cancellation-design.md
// ============================================================================

const test = require("node:test");
const assert = require("node:assert");

const cancel = require("../../src/server/reservation-cancel");

const MON = "2026-08-10";           // a Monday, dayIndex 0
const NOW = new Date("2026-08-10T09:30:00");

function slot(extra = {}) {
    return { content: "Jan Novák", abbreviation: "JN", isPermanent: false, cancelToken: "tok", ...extra };
}

function record(hours, dateStr = MON, dayIndex = 0) {
    const data = {};
    data[dateStr] = [];
    data[dateStr][dayIndex] = hours;
    return { className: "Stůl 1", fileId: "t1", data };
}

// ── tokens ──────────────────────────────────────────────────────────────

test("newToken returns 22 base64url chars and does not repeat", () => {
    const a = cancel.newToken();
    assert.match(a, /^[A-Za-z0-9_-]{22}$/);
    assert.notStrictEqual(a, cancel.newToken());
});

test("tokensMatch is true only for an exact match", () => {
    assert.strictEqual(cancel.tokensMatch("abc", "abc"), true);
    assert.strictEqual(cancel.tokensMatch("abc", "abd"), false);
});

test("tokensMatch returns false rather than throwing on bad input", () => {
    // timingSafeEqual throws on different lengths — that must never reach a route.
    for (const [a, b] of [["abc", "abcd"], ["", "a"], [null, "a"], ["a", undefined], [123, "a"]]) {
        assert.strictEqual(cancel.tokensMatch(a, b), false, `${JSON.stringify([a, b])}`);
    }
});

test("tokensMatch(\"\", \"\") is false — an empty token must never match", () => {
    assert.strictEqual(cancel.tokensMatch("", ""), false);
});

// ── findBooking ─────────────────────────────────────────────────────────

test("findBooking locates every hour of a multi-hour booking", () => {
    const r = record({ 5: slot(), 6: slot(), 7: slot({ cancelToken: "other" }) });
    const found = cancel.findBooking([r], "tok");

    assert.ok(found);
    assert.strictEqual(found.dateStr, MON);
    assert.strictEqual(found.dayIndex, 0);
    assert.deepStrictEqual(found.hourKeys, [5, 6]);
    assert.strictEqual(found.slots.length, 2);
});

test("findBooking returns null for an unknown or empty token", () => {
    const r = record({ 5: slot() });
    assert.strictEqual(cancel.findBooking([r], "nope"), null);
    assert.strictEqual(cancel.findBooking([r], ""), null);
    assert.strictEqual(cancel.findBooking([r], null), null);
});

test("findBooking ignores slots with no cancelToken at all", () => {
    // Bookings made before this feature shipped.
    const r = record({ 5: { content: "Starý host", isPermanent: false } });
    assert.strictEqual(cancel.findBooking([r], "tok"), null);
});

test("findBooking returns null rather than throwing on a non-iterable records value", () => {
    assert.strictEqual(cancel.findBooking({}, "tok"), null);
    assert.strictEqual(cancel.findBooking(null, "tok"), null);
    assert.strictEqual(cancel.findBooking(undefined, "tok"), null);
});

// ── canCancel ───────────────────────────────────────────────────────────

test("an unpaid future booking can be cancelled", () => {
    const found = cancel.findBooking([record({ 5: slot() })], "tok");
    assert.deepStrictEqual(cancel.canCancel(found, NOW), { ok: true, status: 200, reason: null });
});

test("a missing booking is 410 with the not-found wording", () => {
    const r = cancel.canCancel(null, NOW);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.status, 410);
    assert.match(r.reason, /nebyla nalezena/i);
});

test("a paid preorder is 409 and says to phone", () => {
    const found = cancel.findBooking([record({ 5: slot({ order: [{}], isPaid: true }) })], "tok");
    const r = cancel.canCancel(found, NOW);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.status, 409);
    assert.match(r.reason, /telefonicky/i);
});

test("a paid hour anywhere in the booking blocks the whole booking", () => {
    const found = cancel.findBooking([record({ 5: slot(), 6: slot({ order: [{}], isPaid: true }) })], "tok");
    assert.strictEqual(cancel.canCancel(found, NOW).status, 409);
});

test("an unpaid preorder does not block cancellation", () => {
    const found = cancel.findBooking([record({ 5: slot({ order: [{}], isPaid: false }) })], "tok");
    assert.strictEqual(cancel.canCancel(found, NOW).ok, true);
});

test("a booking whose start has passed is 409", () => {
    // hourIndex 1 is the 8:00 slot; NOW is 09:30 the same day.
    const found = cancel.findBooking([record({ 1: slot() })], "tok");
    const r = cancel.canCancel(found, NOW);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.status, 409);
    assert.match(r.reason, /proběhla/i);
});

test("the earliest hour decides whether the booking has started", () => {
    // 8:00-10:00: started at 08:00, so already under way at 09:30.
    const found = cancel.findBooking([record({ 1: slot(), 2: slot() })], "tok");
    assert.strictEqual(cancel.canCancel(found, NOW).ok, false);
});

test("a booking on an earlier date is 409 even at a later hour", () => {
    const found = cancel.findBooking([record({ 12: slot() }, "2026-08-09", 6)], "tok");
    assert.strictEqual(cancel.canCancel(found, NOW).ok, false);
});

test("a booking with an unparseable dateStr is refused as not-found, not silently allowed", () => {
    const found = cancel.findBooking([record({ 5: slot() }, "not-a-real-date", 0)], "tok");
    const r = cancel.canCancel(found, NOW);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.status, 410);
    assert.match(r.reason, /nebyla nalezena/i);
});

test("a booking with a well-formed but nonexistent dateStr (2026-02-29) is refused as not-found", () => {
    const found = cancel.findBooking([record({ 5: slot() }, "2026-02-29", 0)], "tok");
    const r = cancel.canCancel(found, NOW);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.status, 410);
    assert.match(r.reason, /nebyla nalezena/i);
});
