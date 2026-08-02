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

test("the returned object has every contract key, with the correct stub shapes", () => {
    const r = stats.computeSalesStats({
        orders: [], timetables: [], indoorOrders: [], menu: {}, days: 7, now: NOW,
    });
    assert.deepStrictEqual(r.chart, { unit: "day", buckets: [] });
    assert.deepStrictEqual(r.rankings, { topByCount: [], bottomByCount: [], topByRevenue: [] });
    assert.deepStrictEqual(r.neverSold, []);
    assert.deepStrictEqual(r.patterns, {
        weekday: [], bestWeekday: null, hour: [], bestHour: null,
        channels: [], payments: [],
    });
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
