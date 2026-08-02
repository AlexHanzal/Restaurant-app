const test = require("node:test");
const assert = require("node:assert");
const POSDB = require("../../src/js/pos-db");

// pos-db.js is a browser file. Requiring it here exercises only its pure
// half — the state machine and the backoff schedule — which is the half
// that decides when real money is re-sent. Nothing below touches IndexedDB.

const { STATE, advanceSale, nextBackoffMs, pendingStep, isDrainable, unsentMoneyCount, pendingCount, failedCount, createSale } = POSDB;

function openSale() {
    return createSale({
        tableName: "5",
        items: [{ id: "pilsner", name: "Pilsner", qty: 2, price: 55 }],
        total: 110,
        deviceId: "dev-1",
    });
}

test("a submitted sale owes the server its order straight away", () => {
    const sale = openSale();
    assert.strictEqual(sale.state, STATE.QUEUED);
    assert.strictEqual(pendingStep(sale), "create");
    assert.strictEqual(isDrainable(sale, Date.now()), true);
});

test("an order submitted offline and NEVER paid still syncs", () => {
    // The regression this guards: with a linear open→paid→created machine,
    // an unpaid offline order had no pending step, so it sat on the tablet
    // forever and the kitchen never learned about it even after the Wi-Fi
    // returned.
    let sale = openSale();
    assert.strictEqual(pendingStep(sale), "create");

    sale = advanceSale(sale, "created", { serverOrderId: "AbC123" });
    assert.strictEqual(sale.state, STATE.CREATED);
    assert.strictEqual(pendingStep(sale), null, "on the server and unpaid — nothing owed");
    assert.strictEqual(isDrainable(sale, Date.now()), false);
});

test("paying stamps the moment the money changed hands", () => {
    const paid = advanceSale(openSale(), "pay", { paidAt: "2026-08-02T19:40:00.000Z", paymentMethod: "cash" });
    assert.strictEqual(paid.state, STATE.PAID);
    assert.strictEqual(paid.paidAt, "2026-08-02T19:40:00.000Z");
    assert.strictEqual(paid.paymentMethod, "cash");
    assert.strictEqual(pendingStep(paid), "create", "server has neither the order nor the payment");
});

test("the full offline path — submitted and paid before any network", () => {
    let sale = advanceSale(openSale(), "pay", {});
    sale = advanceSale(sale, "created", { serverOrderId: "AbC123" });
    assert.strictEqual(sale.state, STATE.PAID, "creating the order must not erase the fact it was paid");
    assert.strictEqual(pendingStep(sale), "settle");

    sale = advanceSale(sale, "settled", { receiptId: "r1", receiptNumber: "2026-000123" });
    assert.strictEqual(sale.state, STATE.SYNCED);
    assert.strictEqual(sale.receiptNumber, "2026-000123");
    assert.strictEqual(pendingStep(sale), null, "a synced sale must never be drained again");
});

test("an online tab paid later settles without re-creating the order", () => {
    let sale = advanceSale(openSale(), "created", { serverOrderId: "AbC123" });
    sale = advanceSale(sale, "pay", { paidAt: "2026-08-02T19:40:00.000Z" });
    assert.strictEqual(pendingStep(sale), "settle");
    assert.strictEqual(sale.serverOrderId, "AbC123");
});

test("advanceSale never mutates its input", () => {
    const sale = openSale();
    const before = JSON.stringify(sale);
    advanceSale(sale, "pay", {});
    assert.strictEqual(JSON.stringify(sale), before);
});

test("backoff doubles from 1s and caps at 5 minutes", () => {
    assert.strictEqual(nextBackoffMs(0), 1000);
    assert.strictEqual(nextBackoffMs(1), 2000);
    assert.strictEqual(nextBackoffMs(2), 4000);
    assert.strictEqual(nextBackoffMs(3), 8000);
    // The cap is the point: a dead access point must not be hammered once a
    // second for an hour.
    assert.strictEqual(nextBackoffMs(20), 5 * 60 * 1000);
    assert.strictEqual(nextBackoffMs(99), 5 * 60 * 1000);
});

test("a retry schedules an absolute time, so a reload cannot reset it", () => {
    const now = 1_000_000;
    let sale = advanceSale(openSale(), "pay", {});
    sale = advanceSale(sale, "retry", { error: "offline", now });

    assert.strictEqual(sale.state, STATE.PAID, "a retry must not move the state");
    assert.strictEqual(sale.attempts, 1);
    assert.strictEqual(sale.nextAttemptAt, now + 1000);
    assert.strictEqual(isDrainable(sale, now + 500), false);
    assert.strictEqual(isDrainable(sale, now + 1000), true);

    sale = advanceSale(sale, "retry", { error: "offline", now: now + 1000 });
    assert.strictEqual(sale.attempts, 2);
    assert.strictEqual(sale.nextAttemptAt, now + 1000 + 2000);
});

test("reaching the server resets the backoff for the second step", () => {
    let sale = advanceSale(openSale(), "pay", {});
    sale = advanceSale(sale, "retry", { error: "offline", now: 1_000_000 });
    sale = advanceSale(sale, "retry", { error: "offline", now: 1_002_000 });
    assert.ok(sale.nextAttemptAt > 1_002_000);

    // The create call just proved the network works. The settle call must
    // not inherit a wait earned while the network was down.
    sale = advanceSale(sale, "created", { serverOrderId: "AbC123" });
    assert.strictEqual(sale.attempts, 0);
    assert.strictEqual(sale.nextAttemptAt, 0);
    assert.strictEqual(isDrainable(sale, 1_002_001), true);
});

test("a failed sale is terminal but never disappears", () => {
    let sale = advanceSale(openSale(), "pay", {});
    sale = advanceSale(sale, "fail", { error: "400 Neplatná položka" });
    assert.strictEqual(sale.state, STATE.FAILED);
    assert.strictEqual(pendingStep(sale), null, "failed sales must not be retried automatically");
    assert.strictEqual(isDrainable(sale, Date.now() + 1e9), false);
    assert.match(sale.lastError, /Neplatná položka/);
    assert.ok(sale.failedAt, "a human needs to know when it gave up");
});

test("an unknown event throws rather than silently doing nothing", () => {
    assert.throws(() => advanceSale(openSale(), "teleport", {}), /Unknown sale event/);
});

test("the three counters answer three different questions", () => {
    const queued = openSale();                                                   // unpaid, server has nothing
    const paid = advanceSale(openSale(), "pay", {});                             // money taken, server has nothing
    const onServer = advanceSale(openSale(), "created", { serverOrderId: "x" });  // unpaid tab, server has it
    const settled = advanceSale(advanceSale(paid, "created", { serverOrderId: "y" }), "settled", { receiptId: "r", receiptNumber: "n" });
    const failed = advanceSale(paid, "fail", { error: "nope" });

    const all = [queued, paid, onServer, settled, failed];

    // Money taken that the tax report knows nothing about. Only `paid`.
    // `failed` is excluded on purpose: waiting cannot fix it, so it belongs
    // in the failed list rather than in a counter that says "be patient".
    assert.strictEqual(unsentMoneyCount(all), 1);

    // Everything the server is still missing — including the unpaid order
    // the kitchen cannot see yet.
    assert.strictEqual(pendingCount(all), 2);

    assert.strictEqual(failedCount(all), 1);

    for (const fn of [unsentMoneyCount, pendingCount, failedCount]) {
        assert.strictEqual(fn([]), 0);
        assert.strictEqual(fn(null), 0);
    }
});
