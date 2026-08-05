// ============================================================================
// kitchen-board.test.js — which orders GET /api/kitchen/orders still sends.
//
// That route used to return db.list(COL.orders) and db.list(COL.indoorOrders)
// whole — every order ever placed, parsed from JSON on every board refresh,
// for as long as the restaurant has been open. Fine at a hundred orders,
// steadily worse forever after, and the board refetches on every order event.
//
// The rule is deliberately not "the last N days". A ticket that is still
// waiting to be cooked must NEVER disappear from the board, however old it
// is — an order stuck in "pending" from yesterday is a real, if rare,
// operational event, and the one thing worse than a slow board is a board
// that quietly stops showing work. So: recent, OR not finished yet.
// ============================================================================

const test = require("node:test");
const assert = require("node:assert");

const board = require("../../src/server/kitchen-board");

const NOW = new Date("2026-08-05T12:00:00Z");

function order(id, ageHours, kitchenStatus = "completed") {
    return {
        id,
        kitchenStatus,
        createdAt: new Date(NOW.getTime() - ageHours * 3600 * 1000).toISOString(),
    };
}

function ids(rows) {
    return rows.map(r => r.id);
}

test("a recent finished order stays on the board", () => {
    const kept = board.filterForBoard([order("fresh", 3)], { now: NOW, windowDays: 2 });
    assert.deepStrictEqual(ids(kept), ["fresh"]);
});

test("an old finished order drops off", () => {
    const kept = board.filterForBoard([order("ancient", 24 * 30)], { now: NOW, windowDays: 2 });
    assert.deepStrictEqual(ids(kept), []);
});

// THE ONE THAT MATTERS. Age must never be able to hide outstanding work.
test("an old order that is still pending is kept regardless of age", () => {
    const rows = [
        order("ancient-done", 24 * 30, "completed"),
        order("ancient-pending", 24 * 30, "pending"),
    ];
    const kept = board.filterForBoard(rows, { now: NOW, windowDays: 2 });
    assert.deepStrictEqual(ids(kept), ["ancient-pending"]);
});

// Fail open. A row whose timestamp is missing or unparseable must show up,
// not vanish — a bad createdAt is a data problem, and dropping the ticket
// turns it into a customer never being served.
test("an unusable createdAt keeps the order rather than hiding it", () => {
    const rows = [
        { id: "no-date", kitchenStatus: "completed" },
        { id: "null-date", kitchenStatus: "completed", createdAt: null },
        { id: "junk-date", kitchenStatus: "completed", createdAt: "not a date" },
    ];
    const kept = board.filterForBoard(rows, { now: NOW, windowDays: 2 });
    assert.deepStrictEqual(ids(kept), ["no-date", "null-date", "junk-date"]);
});

test("the window edge is inclusive, so nothing falls between the cracks", () => {
    const exactly = order("edge", 48); // windowDays: 2
    const kept = board.filterForBoard([exactly], { now: NOW, windowDays: 2 });
    assert.deepStrictEqual(ids(kept), ["edge"]);
});

test("a missing or malformed window falls back to the default rather than dropping everything", () => {
    const rows = [order("recent", 3)];
    assert.deepStrictEqual(ids(board.filterForBoard(rows, { now: NOW })), ["recent"]);
    assert.deepStrictEqual(ids(board.filterForBoard(rows, { now: NOW, windowDays: 0 })), ["recent"]);
    assert.deepStrictEqual(ids(board.filterForBoard(rows, { now: NOW, windowDays: -5 })), ["recent"]);
    assert.deepStrictEqual(ids(board.filterForBoard(rows, {})), ["recent"]);
});

test("a non-array input yields an empty list instead of throwing", () => {
    assert.deepStrictEqual(board.filterForBoard(null, { now: NOW }), []);
    assert.deepStrictEqual(board.filterForBoard(undefined, { now: NOW }), []);
});
