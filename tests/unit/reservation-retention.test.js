// ============================================================================
// reservation-retention.test.js — the rule that deletes past bookings.
//
// Finding N1(b), docs/2026-08-10-architecture-security-review.md.
//
// The three exceptions (paid, permanent, unparseable date) matter more than the
// deletion itself: this is the one job in the codebase whose bugs destroy data
// rather than merely failing, and the standing-reservation case in particular
// would delete live bookings if it regressed, because a standing booking's date
// is in the past by design.
// ============================================================================

const test = require("node:test");
const assert = require("node:assert");

const retention = require("../../src/server/reservation-retention");

const NOW = new Date("2026-08-10T12:00:00");

// Days before NOW, as the YYYY-MM-DD key the timetable uses.
function daysAgo(n) {
    const d = new Date(NOW);
    d.setDate(d.getDate() - n);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function slot(extra = {}) {
    return { content: "Jan Novák", abbreviation: "JN", isPermanent: false, phone: "+420600111222", cancelToken: "tok", ...extra };
}

function record(dateStr, hours, fileId = "t1") {
    const data = {};
    data[dateStr] = [];
    data[dateStr][0] = hours;
    return { className: "Stůl 1", fileId, data };
}

const plan = (records, opts = {}) =>
    retention.selectExpiredBookings(records, { now: NOW, ...opts });

// ── the window ───────────────────────────────────────────────────────────

test("an ordinary booking older than the window is selected", () => {
    const out = plan([record(daysAgo(120), { 5: slot() })]);
    assert.strictEqual(out.length, 1);
    assert.deepStrictEqual(out[0].hourKeys, ["5"]);
    assert.strictEqual(out[0].fileId, "t1");
});

test("a booking inside the window is left alone", () => {
    assert.deepStrictEqual(plan([record(daysAgo(30), { 5: slot() })]), []);
});

test("a future booking is left alone", () => {
    assert.deepStrictEqual(plan([record("2026-12-24", { 5: slot() })]), []);
});

test("the boundary is the end of the booked day, not its start", () => {
    // Exactly 90 days ago is still inside the window: the day had not finished
    // 90 days ago, so deleting it would be one day early.
    assert.deepStrictEqual(plan([record(daysAgo(90), { 5: slot() })]), [], "day 90 survives");
    assert.strictEqual(plan([record(daysAgo(91), { 5: slot() })]).length, 1, "day 91 goes");
});

test("the window is configurable", () => {
    assert.strictEqual(plan([record(daysAgo(45), { 5: slot() })], { retentionDays: 30 }).length, 1);
    assert.deepStrictEqual(plan([record(daysAgo(45), { 5: slot() })], { retentionDays: 365 }), []);
    // A nonsense value falls back to the default rather than deleting
    // everything — the failure mode of a bad config here is lost bookings.
    for (const bad of [0, -1, NaN, "soon", null]) {
        assert.deepStrictEqual(plan([record(daysAgo(45), { 5: slot() })], { retentionDays: bad }), [],
            `retentionDays=${JSON.stringify(bad)} must fall back to the 90-day default`);
    }
});

// ── the exceptions ───────────────────────────────────────────────────────

test("a paid booking is never deleted, however old", () => {
    const old = daysAgo(4000);
    assert.deepStrictEqual(plan([record(old, { 5: slot({ isPaid: true }) })]), [], "isPaid");
    assert.deepStrictEqual(plan([record(old, { 5: slot({ receiptId: "r1" }) })]), [], "receiptId");
    assert.deepStrictEqual(plan([record(old, { 5: slot({ refundReceiptId: "r2" }) })]), [], "refundReceiptId");
});

test("a standing reservation is never deleted", () => {
    // The case that would destroy live data: a permanent booking is written on
    // one date and applied forward from it forever, so its date is in the past
    // almost immediately while the booking is still in force.
    assert.deepStrictEqual(plan([record(daysAgo(400), { 5: slot({ isPermanent: true }) })]), []);
});

test("an unparseable date is kept, not guessed at", () => {
    for (const bad of ["aaaa", "2026-02-29", "", "2026-13-01"]) {
        const data = {}; data[bad] = [{ 5: slot() }];
        assert.deepStrictEqual(plan([{ className: "Stůl 1", fileId: "t1", data }]), [],
            `${JSON.stringify(bad)} must not be reasoned about`);
    }
});

test("paid and unpaid hours in one day are separated", () => {
    const out = plan([record(daysAgo(120), { 5: slot(), 6: slot({ isPaid: true }), 7: slot() })]);
    assert.strictEqual(out.length, 1);
    assert.deepStrictEqual(out[0].hourKeys.sort(), ["5", "7"], "only the unpaid hours");
});

// ── shape robustness ─────────────────────────────────────────────────────

test("non-booking junk in the grid is ignored rather than deleted", () => {
    const data = { [daysAgo(120)]: [{ 5: null, 6: "obsazeno", 7: 42, 8: slot() }] };
    const out = plan([{ className: "Stůl 1", fileId: "t1", data }]);
    assert.deepStrictEqual(out[0].hourKeys, ["8"], "only the real booking");
});

test("day maps keyed as an object are handled like arrays", () => {
    // PUT /timetables/:name accepts an object keyed by weekday; bookings written
    // by the server are arrays. Both must prune.
    const data = { [daysAgo(120)]: { "3": { 5: slot() } } };
    const out = plan([{ className: "Stůl 1", fileId: "t1", data }]);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].dayKey, "3");
});

test("records with no data, and non-arrays, produce no plan and no throw", () => {
    assert.deepStrictEqual(plan([{ fileId: "t1" }]), []);
    assert.deepStrictEqual(plan([{ fileId: "t1", data: null }]), []);
    assert.deepStrictEqual(plan([null, undefined, 42]), []);
    assert.deepStrictEqual(retention.selectExpiredBookings(null), []);
    assert.deepStrictEqual(plan([{ data: { [daysAgo(120)]: [{ 5: slot() }] } }]), [], "no fileId means no target to write back to");
});

test("several tables and dates all appear in one plan", () => {
    const out = plan([
        record(daysAgo(120), { 5: slot() }, "t1"),
        record(daysAgo(200), { 6: slot() }, "t2"),
    ]);
    assert.deepStrictEqual(out.map(e => e.fileId).sort(), ["t1", "t2"]);
});

// ── applying it ──────────────────────────────────────────────────────────

test("applying removes the hours and tidies the empty containers", () => {
    const old = daysAgo(120);
    const rec = record(old, { 5: slot(), 6: slot() });
    const [entry] = plan([rec]);

    assert.strictEqual(retention.applyToRecord(rec, entry), 2);
    assert.ok(!(old in rec.data), "an emptied date key is removed, not left as scaffolding");
});

test("applying keeps the date when something survives in it", () => {
    const old = daysAgo(120);
    const rec = record(old, { 5: slot(), 6: slot({ isPaid: true }) });
    const [entry] = plan([rec]);

    assert.strictEqual(retention.applyToRecord(rec, entry), 1);
    assert.ok(rec.data[old], "the date must stay — a paid booking is still in it");
    assert.ok(rec.data[old][0][6], "and that booking is untouched");
    assert.ok(!rec.data[old][0][5], "while the expired one is gone");
});

test("applying a stale plan entry is a no-op, not a crash", () => {
    const rec = record(daysAgo(120), { 5: slot() });
    const bogus = { fileId: "t1", dateStr: "1999-01-01", dayKey: "0", hourKeys: ["5"] };
    assert.strictEqual(retention.applyToRecord(rec, bogus), 0);
    assert.strictEqual(retention.applyToRecord(rec, { ...bogus, dateStr: daysAgo(120), hourKeys: ["11"] }), 0);
});

test("isEmptyContainer sees through array holes and empty hour maps", () => {
    assert.strictEqual(retention.isEmptyContainer([]), true);
    assert.strictEqual(retention.isEmptyContainer({}), true);
    assert.strictEqual(retention.isEmptyContainer([{}, {}]), true);
    assert.strictEqual(retention.isEmptyContainer([{ 5: slot() }]), false);
    assert.strictEqual(retention.isEmptyContainer(null), true);
});

// ── prune() against a fake db ────────────────────────────────────────────

test("prune writes back only the tables it changed", () => {
    const rows = {
        t1: record(daysAgo(120), { 5: slot() }, "t1"),
        t2: record(daysAgo(10), { 5: slot() }, "t2"),
    };
    const written = [];
    const fakeDb = {
        list: () => Object.values(rows),
        set: (_c, id, value) => { written.push(id); rows[id] = value; },
    };

    assert.strictEqual(retention.prune(fakeDb, "timetables", { now: NOW }), 1);
    assert.deepStrictEqual(written, ["t1"], "t2 had nothing to prune and must not be rewritten");
});

test("prune is a no-op when nothing has expired", () => {
    const fakeDb = {
        list: () => [record(daysAgo(5), { 5: slot() })],
        set: () => assert.fail("nothing should be written"),
    };
    assert.strictEqual(retention.prune(fakeDb, "timetables", { now: NOW }), 0);
});

test("a throwing db is swallowed rather than taking the restaurant down", () => {
    const fakeDb = { list: () => { throw new Error("disk on fire"); }, set: () => {} };
    assert.strictEqual(retention.prune(fakeDb, "timetables", { now: NOW }), 0);
});

// ── DELIVERY BATCHES (H4) ────────────────────────────────────────────────

const batch = (id, daysAgoCreated, extra = {}) => ({
    id,
    createdAt: daysAgoCreated === null ? undefined
        : new Date(NOW.getTime() - daysAgoCreated * 86400000).toISOString(),
    orderIds: ["o1", "o2"],
    status: "dissolved",
    ...extra,
});

test("old batches are selected and recent ones are not", () => {
    const ids = retention.selectExpiredBatchIds(
        [batch("old", 40), batch("fresh", 2), batch("edge", 29)], { now: NOW });
    assert.deepStrictEqual(ids, ["old"]);
});

test("an open batch is not spared by its status — only by its age", () => {
    // Deliberate: a batch left "open" for 40 days is not a live delivery run,
    // it is a leak. Age is the only signal that means anything here.
    const ids = retention.selectExpiredBatchIds([batch("stuck-open", 40, { status: "open" })], { now: NOW });
    assert.deepStrictEqual(ids, ["stuck-open"]);
});

test("a batch with no usable createdAt is kept", () => {
    for (const bad of [null, undefined, "", "not-a-date"]) {
        const rows = [{ id: "x", createdAt: bad === null ? undefined : bad, orderIds: [] }];
        assert.deepStrictEqual(retention.selectExpiredBatchIds(rows, { now: NOW }), [],
            `createdAt=${JSON.stringify(bad)} must be kept, not guessed at`);
    }
});

test("the batch window is configurable and refuses nonsense", () => {
    const rows = [batch("b", 45)];
    assert.deepStrictEqual(retention.selectExpiredBatchIds(rows, { now: NOW, retentionDays: 30 }), ["b"]);
    assert.deepStrictEqual(retention.selectExpiredBatchIds(rows, { now: NOW, retentionDays: 90 }), []);
    for (const bad of [0, -1, NaN, "soon"]) {
        assert.deepStrictEqual(retention.selectExpiredBatchIds(rows, { now: NOW, retentionDays: bad }), ["b"],
            "a bad value falls back to the 30-day default, which still expires a 45-day-old batch");
    }
    assert.deepStrictEqual(retention.selectExpiredBatchIds(null), []);
});

test("pruneBatches removes exactly the expired ids", () => {
    const rows = { old: batch("old", 40), fresh: batch("fresh", 1) };
    const removed = [];
    const fakeDb = {
        list: () => Object.values(rows),
        remove: (_c, id) => { removed.push(id); delete rows[id]; },
    };

    assert.strictEqual(retention.pruneBatches(fakeDb, "delivery_batches", { now: NOW }), 1);
    assert.deepStrictEqual(removed, ["old"]);
    assert.ok(rows.fresh, "the recent batch is still there");
});

test("pruneBatches swallows a failing db", () => {
    const fakeDb = { list: () => { throw new Error("nope"); }, remove: () => {} };
    assert.strictEqual(retention.pruneBatches(fakeDb, "delivery_batches", { now: NOW }), 0);
});
