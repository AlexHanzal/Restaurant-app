const test = require("node:test");
const assert = require("node:assert");
const stats = require("../../src/server/sales-stats");

// Sunday 2026-08-02 18:00 local — matches the spec's authoring date.
const NOW = new Date(2026, 7, 2, 18, 0, 0);
const at = (y, m, d, h = 12) => new Date(y, m, d, h).toISOString();

const deliveryOrder = (over = {}) => ({
    id: "o1", createdAt: at(2026, 7, 2), total: 300, paymentStatus: "paid",
    paymentMethod: "cash",
    items: [{ name: "Guláš", qty: 2, price: 120 }],
    ...over,
});

test("periodBounds: 1 day is today from local midnight", () => {
    const b = stats.periodBounds(1, NOW);
    assert.strictEqual(b.since.getHours(), 0);
    assert.strictEqual(b.since.getDate(), 2);
    assert.strictEqual(b.until.getTime(), NOW.getTime());
});

test("periodBounds: 7 days spans exactly 7 calendar days including today", () => {
    const b = stats.periodBounds(7, NOW);
    assert.strictEqual(b.since.getDate(), 27); // Jul 27 00:00
    assert.strictEqual(b.since.getMonth(), 6);
    assert.strictEqual(b.prevSince.getDate(), 20); // 7 days before that
});

test("empty input returns a well-formed zeroed object", () => {
    const r = stats.computeSalesStats({
        orders: [], timetables: [], indoorOrders: [], menu: {}, days: 7, now: NOW,
    });
    assert.strictEqual(r.totals.revenue, 0);
    assert.strictEqual(r.totals.orders, 0);
    assert.strictEqual(r.totals.avgOrder, null);
    assert.deepStrictEqual(r.items, []);
});

test("a delivery order contributes revenue, order count and item counts", () => {
    const r = stats.computeSalesStats({
        orders: [deliveryOrder()], timetables: [], indoorOrders: [],
        menu: {}, days: 7, now: NOW,
    });
    assert.strictEqual(r.totals.revenue, 300);
    assert.strictEqual(r.totals.orders, 1);
    assert.strictEqual(r.totals.items, 2);
    assert.strictEqual(r.totals.avgOrder, 300);
    assert.deepStrictEqual(r.items, [{ name: "Guláš", count: 2, revenue: 240 }]);
});

test("refunded orders are excluded from money but kept in item counts", () => {
    const r = stats.computeSalesStats({
        orders: [deliveryOrder({ paymentStatus: "refunded" })],
        timetables: [], indoorOrders: [], menu: {}, days: 7, now: NOW,
    });
    assert.strictEqual(r.totals.revenue, 0);
    assert.strictEqual(r.totals.orders, 0);
    assert.strictEqual(r.totals.items, 2, "kitchen still made the dish");
    assert.strictEqual(r.items[0].count, 2);
    assert.strictEqual(r.items[0].revenue, 240, "per-dish revenue counts refunded sales at gross value");
});

test("an order exactly at the period start is in; a second before it is out", () => {
    const b = stats.periodBounds(7, NOW);
    const inAt = new Date(b.since.getTime()).toISOString();
    const outAt = new Date(b.since.getTime() - 1000).toISOString();
    const r = stats.computeSalesStats({
        orders: [deliveryOrder({ id: "in", createdAt: inAt }),
                 deliveryOrder({ id: "out", createdAt: outAt })],
        timetables: [], indoorOrders: [], menu: {}, days: 7, now: NOW,
    });
    assert.strictEqual(r.totals.orders, 1);
});

test("unparseable and blank data is skipped, never bucketed into epoch zero", () => {
    const r = stats.computeSalesStats({
        orders: [deliveryOrder({ createdAt: "not-a-date" }),
                 deliveryOrder({ id: "o2", items: [{ name: "   ", qty: 1, price: 50 }] })],
        timetables: [], indoorOrders: [], menu: {}, days: 7, now: NOW,
    });
    assert.strictEqual(r.totals.orders, 1, "only the parseable order counts");
    assert.deepStrictEqual(r.items, [], "blank item name dropped");
});

test("deltas are null when the previous period had nothing", () => {
    const r = stats.computeSalesStats({
        orders: [deliveryOrder()], timetables: [], indoorOrders: [],
        menu: {}, days: 7, now: NOW,
    });
    assert.strictEqual(r.previous.revenue, 0);
    assert.strictEqual(r.deltas.revenue, null);
});

test("deltas compare against the previous equal period", () => {
    const prev = deliveryOrder({ id: "p1", createdAt: at(2026, 6, 22), total: 200 });
    const r = stats.computeSalesStats({
        orders: [deliveryOrder(), prev], timetables: [], indoorOrders: [],
        menu: {}, days: 7, now: NOW,
    });
    assert.strictEqual(r.previous.revenue, 200);
    assert.strictEqual(r.deltas.revenue, 50); // 200 -> 300
});

test("deltas.avgOrder is a number when both periods had orders", () => {
    const prev = deliveryOrder({ id: "p1", createdAt: at(2026, 6, 22), total: 200 });
    const r = stats.computeSalesStats({
        orders: [deliveryOrder(), prev], timetables: [], indoorOrders: [],
        menu: {}, days: 7, now: NOW,
    });
    // current avgOrder 300, previous avgOrder 200 -> +50%
    assert.strictEqual(typeof r.deltas.avgOrder, "number");
    assert.strictEqual(r.deltas.avgOrder, 50);
});

test("deltas.avgOrder is null when the previous period has no orders", () => {
    const r = stats.computeSalesStats({
        orders: [deliveryOrder()], timetables: [], indoorOrders: [],
        menu: {}, days: 7, now: NOW,
    });
    assert.strictEqual(r.previous.avgOrder, null);
    assert.strictEqual(r.deltas.avgOrder, null);
});

test("items come back sorted by count descending", () => {
    const r = stats.computeSalesStats({
        orders: [deliveryOrder({
            id: "o1",
            items: [
                { name: "Málo", qty: 1, price: 10 },
                { name: "Hodně", qty: 5, price: 10 },
                { name: "Středně", qty: 3, price: 10 },
            ],
        })],
        timetables: [], indoorOrders: [], menu: {}, days: 7, now: NOW,
    });
    assert.deepStrictEqual(r.items.map(i => i.name), ["Hodně", "Středně", "Málo"]);
});

// Written against Task 1's empty stubs; Task 3 makes `chart` and
// `patterns.weekday` unconditionally populated (zero-filled buckets, and
// one weekday entry per weekday that occurs in the window) even when there
// is no data, so those two are asserted on real shape here instead of `[]`.
// The other keys stay genuinely empty with no sales, so this still doubles
// as a "no sales" contract-shape check for them.
test("the returned object has every contract key, with the correct shapes for an empty period", () => {
    const r = stats.computeSalesStats({
        orders: [], timetables: [], indoorOrders: [], menu: {}, days: 7, now: NOW,
    });
    assert.strictEqual(r.chart.unit, "day");
    assert.deepStrictEqual(r.chart.buckets.map(b => b.key), [
        "2026-07-27", "2026-07-28", "2026-07-29", "2026-07-30",
        "2026-07-31", "2026-08-01", "2026-08-02",
    ]);
    assert.strictEqual(r.chart.buckets.every(b => b.revenue === 0), true);
    assert.deepStrictEqual(r.rankings, { topByCount: [], bottomByCount: [], topByRevenue: [] });
    assert.deepStrictEqual(r.neverSold, []);
    assert.strictEqual(r.patterns.weekday.length, 7, "every weekday occurs once in a 7-day window");
    assert.strictEqual(r.patterns.weekday.every(w => w.revenue === 0 && w.occurrences === 1), true);
    assert.strictEqual(r.patterns.bestWeekday, null, "no revenue anywhere -> no best weekday");
    assert.deepStrictEqual(r.patterns.hour, []);
    assert.strictEqual(r.patterns.bestHour, null);
    assert.deepStrictEqual(r.patterns.channels, []);
    assert.deepStrictEqual(r.patterns.payments, []);
    assert.deepStrictEqual(r.refunds, {
        total: 0, count: 0, rate: 0, topItems: [], reasons: [], orders: [],
    });
});

test("chart.unit is \"hour\" for a 1-day window", () => {
    const r = stats.computeSalesStats({
        orders: [], timetables: [], indoorOrders: [], menu: {}, days: 1, now: NOW,
    });
    assert.strictEqual(r.chart.unit, "hour");
});

test("since and until are ISO strings on the computeSalesStats return", () => {
    const r = stats.computeSalesStats({
        orders: [], timetables: [], indoorOrders: [], menu: {}, days: 7, now: NOW,
    });
    assert.strictEqual(typeof r.since, "string");
    assert.strictEqual(typeof r.until, "string");
    assert.ok(!Number.isNaN(Date.parse(r.since)), "since must parse as a valid date");
    assert.ok(!Number.isNaN(Date.parse(r.until)), "until must parse as a valid date");
});

const MENU = {
    main:     [{ name: "Guláš", price: 120 }, { name: "Svíčková", price: 180 }],
    drinks:   [{ name: " Kofola ", price: 40 }],
    desserts: [{ name: "Štrúdl", price: 60 }],
};

const sold = (name, qty, price) => deliveryOrder({
    id: `o-${name}`, items: [{ name, qty, price }], total: qty * price,
});

test("rankings split most-sold from highest-earning", () => {
    const r = stats.computeSalesStats({
        orders: [sold("Kofola", 20, 40), sold("Svíčková", 3, 180)],
        timetables: [], indoorOrders: [], menu: MENU, days: 7, now: NOW,
    });
    assert.strictEqual(r.rankings.topByCount[0].name, "Kofola");
    assert.strictEqual(r.rankings.topByRevenue[0].name, "Kofola"); // 800 vs 540
    assert.strictEqual(r.rankings.bottomByCount[0].name, "Svíčková");
});

test("bottomByCount never includes an item that sold zero times", () => {
    const r = stats.computeSalesStats({
        orders: [sold("Guláš", 1, 120)], timetables: [], indoorOrders: [],
        menu: MENU, days: 7, now: NOW,
    });
    assert.deepStrictEqual(r.rankings.bottomByCount.map(i => i.name), ["Guláš"]);
});

test("neverSold lists menu items with no sales, grouped by category", () => {
    const r = stats.computeSalesStats({
        orders: [sold("Guláš", 1, 120)], timetables: [], indoorOrders: [],
        menu: MENU, days: 7, now: NOW,
    });
    const byCat = Object.fromEntries(r.neverSold.map(g => [g.category, g.items]));
    assert.deepStrictEqual(byCat.main, ["Svíčková"]);
    assert.deepStrictEqual(byCat.desserts, ["Štrúdl"]);
    assert.deepStrictEqual(byCat.drinks, ["Kofola"], "names are emitted trimmed");
});

test("neverSold matches on trimmed names — whitespace is not a different dish", () => {
    const r = stats.computeSalesStats({
        orders: [sold("Kofola", 2, 40)], timetables: [], indoorOrders: [],
        menu: MENU, days: 7, now: NOW,   // menu has " Kofola " with spaces
    });
    const drinks = r.neverSold.find(g => g.category === "drinks");
    assert.strictEqual(drinks, undefined, "sold Kofola must not appear as never-sold");
});

test("everything sold means neverSold is empty, not missing", () => {
    const r = stats.computeSalesStats({
        orders: [sold("Guláš", 1, 120), sold("Svíčková", 1, 180),
                 sold("Kofola", 1, 40), sold("Štrúdl", 1, 60)],
        timetables: [], indoorOrders: [], menu: MENU, days: 7, now: NOW,
    });
    assert.deepStrictEqual(r.neverSold, []);
});

test("chart buckets one entry per day, zero-filled, oldest first", () => {
    const r = stats.computeSalesStats({
        orders: [deliveryOrder({ createdAt: at(2026, 7, 2), total: 300 })],
        timetables: [], indoorOrders: [], menu: {}, days: 7, now: NOW,
    });
    assert.strictEqual(r.chart.unit, "day");
    assert.strictEqual(r.chart.buckets.length, 7);
    assert.strictEqual(r.chart.buckets[0].key, "2026-07-27");
    assert.strictEqual(r.chart.buckets[6].key, "2026-08-02");
    assert.strictEqual(r.chart.buckets[6].revenue, 300);
    assert.strictEqual(r.chart.buckets[0].revenue, 0);
});

test("Dnes buckets by hour — 24 slots", () => {
    const r = stats.computeSalesStats({
        orders: [deliveryOrder({ createdAt: at(2026, 7, 2, 13), total: 300 })],
        timetables: [], indoorOrders: [], menu: {}, days: 1, now: NOW,
    });
    assert.strictEqual(r.chart.unit, "hour");
    assert.strictEqual(r.chart.buckets.length, 24);
    assert.strictEqual(r.chart.buckets[13].revenue, 300);
});

test("refunded orders are absent from the chart", () => {
    const r = stats.computeSalesStats({
        orders: [deliveryOrder({ paymentStatus: "refunded" })],
        timetables: [], indoorOrders: [], menu: {}, days: 7, now: NOW,
    });
    assert.strictEqual(r.chart.buckets.every(b => b.revenue === 0), true);
});

test("a chart bucket's orders count matches the number of orders that day", () => {
    const r = stats.computeSalesStats({
        orders: [
            deliveryOrder({ id: "o1", createdAt: at(2026, 7, 2, 10), total: 100 }),
            deliveryOrder({ id: "o2", createdAt: at(2026, 7, 2, 14), total: 150 }),
        ],
        timetables: [], indoorOrders: [], menu: {}, days: 7, now: NOW,
    });
    const today = r.chart.buckets[6];
    assert.strictEqual(today.key, "2026-08-02");
    assert.strictEqual(today.orders, 2, "two orders that day");
});

test("a refunded order contributes to neither revenue nor orders in its chart bucket", () => {
    const r = stats.computeSalesStats({
        orders: [deliveryOrder({ paymentStatus: "refunded" })],
        timetables: [], indoorOrders: [], menu: {}, days: 7, now: NOW,
    });
    const today = r.chart.buckets[6];
    assert.strictEqual(today.revenue, 0);
    assert.strictEqual(today.orders, 0);
});

test("channel split covers all three channels and shares sum to 100", () => {
    const timetable = { data: { "2026-08-01": [ { 12: {
        order: [{ item: "Guláš", qty: 1, price: 100 }], orderTotal: 100, isPaid: true,
    } } ] } };
    const r = stats.computeSalesStats({
        orders: [deliveryOrder({ total: 300 })],
        timetables: [timetable],
        indoorOrders: [{ id: "i1", createdAt: at(2026, 7, 2), total: 100,
                         items: [{ item: "Kofola", qty: 1, price: 100 }] }],
        menu: {}, days: 7, now: NOW,
    });
    const by = Object.fromEntries(r.patterns.channels.map(c => [c.id, c.revenue]));
    assert.strictEqual(by.delivery, 300);
    assert.strictEqual(by.table, 100);
    assert.strictEqual(by.indoor, 100);
    const total = r.patterns.channels.reduce((s, c) => s + c.share, 0);
    assert.ok(Math.abs(total - 100) < 0.1, `shares summed to ${total}`);
});

test("a reservation slot contributes its booked hour to the hour pattern", () => {
    const timetable = { data: { "2026-08-01": [ { 19: {
        order: [{ item: "Guláš", qty: 1, price: 100 }], orderTotal: 100, isPaid: true,
    } } ] } };
    const r = stats.computeSalesStats({
        orders: [], timetables: [timetable], indoorOrders: [],
        menu: {}, days: 7, now: NOW,
    });
    assert.strictEqual(r.patterns.bestHour, 19);
});

test("a repeated reservation slot is counted once, not once per hour", () => {
    const slot = { order: [{ item: "Guláš", qty: 1, price: 100 }], orderTotal: 100 };
    const timetable = { data: { "2026-08-01": [ { 18: slot, 19: { ...slot } } ] } };
    const r = stats.computeSalesStats({
        orders: [], timetables: [timetable], indoorOrders: [],
        menu: {}, days: 7, now: NOW,
    });
    assert.strictEqual(r.totals.orders, 1, "same order spanning two hours is one sale");
});

test("payment split gives unrecorded methods their own onsite slice", () => {
    const r = stats.computeSalesStats({
        orders: [deliveryOrder({ paymentMethod: "cash", total: 100 })],
        timetables: [], indoorOrders: [
            { id: "i1", createdAt: at(2026, 7, 2), total: 100, items: [] }],
        menu: {}, days: 7, now: NOW,
    });
    const by = Object.fromEntries(r.patterns.payments.map(p => [p.id, p.revenue]));
    assert.strictEqual(by.cash, 100);
    assert.strictEqual(by.onsite, 100);
});

test("bestWeekday is null when there are no sales at all", () => {
    const r = stats.computeSalesStats({
        orders: [], timetables: [], indoorOrders: [], menu: {}, days: 7, now: NOW,
    });
    assert.strictEqual(r.patterns.bestWeekday, null);
    assert.strictEqual(r.patterns.bestHour, null);
});

test("patterns.hour entries expose a numeric hour and an orders count", () => {
    const r = stats.computeSalesStats({
        orders: [deliveryOrder({ createdAt: at(2026, 7, 2, 13), total: 300 })],
        timetables: [], indoorOrders: [], menu: {}, days: 7, now: NOW,
    });
    const entry = r.patterns.hour.find(h => h.hour === 13);
    assert.ok(entry, "hour 13 must be present");
    assert.strictEqual(typeof entry.hour, "number");
    assert.strictEqual(entry.orders, 1);
});

test("patterns.weekday entries expose a numeric weekday and an orders count", () => {
    // 2026-08-02 is a Sunday (weekday 0) — see the NOW comment at the top.
    const r = stats.computeSalesStats({
        orders: [deliveryOrder({ createdAt: at(2026, 7, 2), total: 300 })],
        timetables: [], indoorOrders: [], menu: {}, days: 7, now: NOW,
    });
    const entry = r.patterns.weekday.find(w => w.weekday === 0);
    assert.ok(entry, "Sunday (weekday 0) must be present");
    assert.strictEqual(typeof entry.weekday, "number");
    assert.strictEqual(entry.orders, 1);
});

test("bestHour is strictly a number, not a padded string", () => {
    const r = stats.computeSalesStats({
        orders: [deliveryOrder({ createdAt: at(2026, 7, 2, 13), total: 300 })],
        timetables: [], indoorOrders: [], menu: {}, days: 7, now: NOW,
    });
    assert.strictEqual(typeof r.patterns.bestHour, "number");
});

test("refund totals, rate and per-item co-occurrence", () => {
    const r = stats.computeSalesStats({
        orders: [
            deliveryOrder({ id: "ok", total: 300 }),
            deliveryOrder({ id: "r1", total: 100, paymentStatus: "refunded",
                            items: [{ name: "Guláš", qty: 1, price: 100 }],
                            refundReason: "late" }),
        ],
        timetables: [], indoorOrders: [], menu: {}, days: 7, now: NOW,
    });
    assert.strictEqual(r.refunds.total, 100);
    assert.strictEqual(r.refunds.count, 1);
    assert.strictEqual(r.refunds.rate, 25); // 100 of 400 gross
    assert.deepStrictEqual(r.refunds.topItems, [{ name: "Guláš", count: 1 }]);
    assert.deepStrictEqual(r.refunds.reasons, [{ id: "late", count: 1 }]);
});

test("unlabelled refunds are reported as 'none', not dropped", () => {
    const r = stats.computeSalesStats({
        orders: [deliveryOrder({ id: "r1", paymentStatus: "refunded" })],
        timetables: [], indoorOrders: [], menu: {}, days: 7, now: NOW,
    });
    assert.deepStrictEqual(r.refunds.reasons, [{ id: "none", count: 1 }]);
    assert.strictEqual(r.refunds.orders[0].reason, null);
});

test("refunds.orders carries what the UI needs to label them", () => {
    const r = stats.computeSalesStats({
        orders: [deliveryOrder({ id: "r1", paymentStatus: "refunded", total: 250 })],
        timetables: [], indoorOrders: [], menu: {}, days: 7, now: NOW,
    });
    const o = r.refunds.orders[0];
    assert.strictEqual(o.id, "r1");
    assert.strictEqual(o.total, 250);
    assert.deepStrictEqual(o.itemNames, ["Guláš"]);
});

test("no refunds yields zeroes and empty lists, and rate 0 not NaN", () => {
    const r = stats.computeSalesStats({
        orders: [deliveryOrder()], timetables: [], indoorOrders: [],
        menu: {}, days: 7, now: NOW,
    });
    assert.strictEqual(r.refunds.total, 0);
    assert.strictEqual(r.refunds.rate, 0);
    assert.deepStrictEqual(r.refunds.topItems, []);
});
