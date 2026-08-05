// ============================================================================
// kitchen-board.js — what GET /api/kitchen/orders still needs to send.
//
// The problem: that route returned db.list(COL.orders) and
// db.list(COL.indoorOrders) whole. db.js's list() reads every row of a
// collection and JSON.parses each one, so the board's cost grew with the
// restaurant's entire history, not with its workload — and the board refetches
// on every order event (see broadcastBoardEvent / the SSE stream). At a
// hundred orders that is invisible; a year in it is the slowest thing in the
// app, on the one screen that has to stay responsive during service.
//
// The rule is deliberately NOT "the last N days":
//
//   keep it if it is recent  OR  it is not finished yet
//
// A ticket still waiting to be cooked must never drop off the board, however
// old it is. An order stuck in "pending" overnight is rare but real, and the
// only thing worse than a slow board is one that quietly stops showing work.
// Age alone can therefore never hide anything actionable — it only retires
// tickets the kitchen has already marked done.
//
// Pure, and separate from server.js, so the rule is testable on its own —
// see tests/unit/kitchen-board.test.js.
// ============================================================================

// Two days rather than one: an order taken just before midnight should still
// be on the board through the following service, and the morning shift should
// be able to see what last night finished with.
const DEFAULT_WINDOW_DAYS = 2;

// "Finished" is exactly the one terminal value the board writes — see
// kitchenStatusSchema in validation.js, which permits "pending" and
// "completed" and nothing else. Anything that is not literally "completed"
// (including a missing status on an old row) counts as outstanding and is
// kept, which is the safe direction to be wrong in.
function isFinished(order) {
    return order && order.kitchenStatus === "completed";
}

function isWithinWindow(order, nowMs, windowMs) {
    const raw = order && order.createdAt;
    if (!raw) return true; // fail open — see the header
    const t = new Date(raw).getTime();
    if (!Number.isFinite(t)) return true; // unparseable timestamp: same
    return (nowMs - t) <= windowMs;
}

/**
 * @param {Array<object>} orders  rows straight out of db.list()
 * @param {object} [opts]
 * @param {Date}   [opts.now]         defaults to the current time
 * @param {number} [opts.windowDays]  defaults to DEFAULT_WINDOW_DAYS; a
 *                                    missing, zero or negative value falls
 *                                    back to it rather than retiring
 *                                    everything, because the failure mode of
 *                                    a bad config here is an empty board
 *                                    mid-service.
 * @returns {Array<object>} the rows the board still needs
 */
function filterForBoard(orders, opts = {}) {
    if (!Array.isArray(orders)) return [];

    const now = opts.now instanceof Date ? opts.now : new Date();
    const nowMs = now.getTime();

    const days = Number(opts.windowDays);
    const windowDays = Number.isFinite(days) && days > 0 ? days : DEFAULT_WINDOW_DAYS;
    const windowMs = windowDays * 24 * 60 * 60 * 1000;

    return orders.filter(o => !isFinished(o) || isWithinWindow(o, nowMs, windowMs));
}

module.exports = { filterForBoard, DEFAULT_WINDOW_DAYS };
