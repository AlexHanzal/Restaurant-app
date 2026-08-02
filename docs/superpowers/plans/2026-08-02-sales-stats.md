# Sales Statistics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the admin "Prodeje" view's two flat tables with a real sales dashboard — total revenue with a chart, period comparison, best/worst/never-sold items, time and channel patterns, and refund tracking with reasons.

**Architecture:** All aggregation math moves into one new pure, zero-dependency server module (`src/server/sales-stats.js`) that takes plain arrays and a clock and returns a single stats object — making it fully unit-testable with `node --test` in place. `GET /stats/sales` becomes a thin wrapper. The whole view moves out of the 275 KB `inner.js` into its own frontend file loaded like `pos-db.js`.

**Tech Stack:** Node 22, Express 5, zod 4, better-sqlite3, `node:test`. Zero frontend dependencies, no bundler, CSP `script-src 'self'` — plain global functions and hand-drawn DOM/SVG only.

**Spec:** `docs/superpowers/specs/2026-08-02-sales-stats-design.md`

## Global Constraints

- **Zero new dependencies**, server or frontend. No chart library — CSP is `script-src 'self'`.
- `src/server/sales-stats.js` must be **pure**: no `require` of db/fs/network, no `Date.now()` — the clock arrives as the `now` parameter. This is what keeps it testable without the copy-out-to-local-disk workaround.
- **All UI text in Czech.** The server returns neutral ids and numbers; every Czech label is applied client-side.
- **Swiss visual language only** (spec §4): white ground, single `#e30613` accent used sparingly, 1px rules never shadows, Inter only, flush-left on a strict grid, existing `--radius` tokens. No gradients, pastels, pill shapes, tinted badges, decorative icons, or emoji.
- Design tokens only in CSS — no new literal color values.
- Numeric columns get `font-variant-numeric: tabular-nums`.
- Every new `:hover` guarded by `@media (hover: hover)` and paired with an `:active` twin — the admin is a touch surface at tablet size.
- Admin targets **1024px and wider**. Do not spend effort below 900px.
- Mutating routes need `csrf.requireCsrf` **and** an auth guard, matching every other mutating route in `server.js`.
- Run tests with `npm run test:unit`. `node --test tests/unit/` with a trailing directory throws `MODULE_NOT_FOUND` — always use the glob form.

## File Structure

| File | Responsibility |
|---|---|
| `src/server/sales-stats.js` | **Create.** All aggregation math. Pure function `computeSalesStats()`. |
| `tests/unit/sales-stats.test.js` | **Create.** Unit tests for the above. |
| `src/server/server.js` | **Modify.** Thin `/stats/sales` route (~line 4393), new refund-reason route, delete `collectTableOrderEvents` (~line 2213). |
| `src/server/validation.js` | **Modify.** Add `refundReasonSchema` + export. |
| `src/js/sales-stats-view.js` | **Create.** The entire Prodeje view. |
| `src/js/inner.js` | **Modify.** Delete lines ~3407–3496 (the old sales view). Keep `renderReceiptsPanel` and the `switchView` call site. |
| `src/html/inner.html` | **Modify.** One `<script>` tag after `inner.js` (line ~399). |
| `src/css/inner.css` | **Modify.** Append `.inn-stat-*` block. |

## The Data Contract

Every task depends on this shape. `computeSalesStats()` returns exactly:

```js
{
  days, since, until,                       // ISO strings for since/until
  totals:   { revenue, orders, items, avgOrder },   // avgOrder null when orders === 0
  previous: { revenue, orders, items, avgOrder },
  deltas:   { revenue, orders, items, avgOrder },   // percent numbers; null when the
                                                    // matching previous value is 0
  chart: {
    unit: "day" | "hour",
    buckets: [ { key, revenue, orders } ]   // key = "YYYY-MM-DD" (day) or 0-23 (hour)
  },
  rankings: {
    topByCount:    [ { name, count, revenue } ],   // max 5
    bottomByCount: [ { name, count, revenue } ],   // max 5, only items with count > 0
    topByRevenue:  [ { name, count, revenue } ]    // max 5
  },
  neverSold: [ { category, items: [name] } ],      // category = menu key, e.g. "main"
  patterns: {
    weekday:  [ { weekday, revenue, orders, occurrences } ],  // weekday 0=Sun..6=Sat
    bestWeekday,                                              // weekday number or null
    hour:     [ { hour, revenue, orders } ],                  // only hours with data
    bestHour,                                                 // hour number or null
    channels: [ { id, revenue, share } ],   // id: "delivery" | "table" | "indoor"
    payments: [ { id, revenue, share } ]    // id: "cash" | "card_on_delivery" |
                                            //     "online_card" | "onsite"
  },
  refunds: {
    total, count, rate,                     // rate = refunded / (revenue + refunded)
    topItems: [ { name, count } ],          // max 5
    reasons:  [ { id, count } ],            // id includes "none" for unlabelled
    orders:   [ { id, createdAt, total, itemNames, reason, note } ]
  },
  items: [ { name, count, revenue } ]       // back-compat, sorted by count desc
}
```

**Two revenue definitions, deliberately different — do not "fix" this:**
`totals.revenue` sums **order totals** (real money taken, including delivery fees).
`items[].revenue` sums **price × qty** per dish. They will not match, because delivery fees belong to no dish. Task 7 labels the item table accordingly.

**Period windowing.** `since` = local midnight, `days - 1` days before `now`; `until` = `now`. So "Dnes" (`days: 1`) is today from midnight, and "7 dní" is exactly 7 calendar days including today. This is a deliberate change — today's code subtracts the full `days` and so covers 8 calendar days for `days=7`. The previous period is `[since - days, since)`.

**Refund rule** (spec §6): orders with `paymentStatus === "refunded"` (delivery) or a truthy `refundReceiptId` (reservation slots) are **excluded from all money** — `totals`, `previous`, `chart`, `channels`, `payments` — but **included in item counts**. Indoor orders have no refunded state and are never refunded.

---

### Task 1: Module skeleton — windowing, collection, totals

**Files:**
- Create: `src/server/sales-stats.js`
- Test: `tests/unit/sales-stats.test.js`

**Interfaces:**
- Produces: `computeSalesStats({ orders, timetables, indoorOrders, menu, days, now })` returning the contract above. Tasks 2–4 fill in `rankings`, `neverSold`, `patterns`, `refunds`; this task delivers `days`, `since`, `until`, `totals`, `previous`, `deltas`, `items`.
- Produces: `periodBounds(days, now)` → `{ since, until, prevSince }` (Date objects), used internally and directly unit-tested.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/sales-stats.test.js`:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm run test:unit
```

Expected: FAIL — `Cannot find module '../../src/server/sales-stats'`.

- [ ] **Step 3: Write the implementation**

Create `src/server/sales-stats.js`. Header comment must state the purity contract and why it exists (mirroring `offline-sale.js`'s house style). Implement:

```js
// Local midnight, days-1 back. See the plan's "Period windowing" note.
function periodBounds(days, now) {
    const n = now instanceof Date ? now : new Date(now);
    const since = new Date(n);
    since.setDate(since.getDate() - (days - 1));
    since.setHours(0, 0, 0, 0);
    const prevSince = new Date(since);
    prevSince.setDate(prevSince.getDate() - days);
    return { since, until: new Date(n), prevSince };
}
```

Then a private `collectSales({ orders, timetables, indoorOrders }, fromDate, toDate)`
returning a flat array of normalised sale records — this is the single seam every
later task reads from:

```js
// { channel, at: Date, total, refunded, paymentMethod, orderId,
//   items: [{ name, qty, price }] }
```

Rules for building it:
- **delivery** (`orders`): parse `createdAt`; skip unparseable. `refunded` is
  `paymentStatus === "refunded"`. `paymentMethod` is `order.paymentMethod` or
  `"onsite"` when absent. `total` is `order.total`. Items map from
  `{ name, qty, price }`.
- **table** (`timetables`): port the de-duplication from `collectTableOrderEvents`
  in `server.js:2213` — walk `data[dateStr][dayIndex][hour]`, skip slots with an
  empty `order`, and emit only when
  `JSON.stringify(slot.order) + "|" + slot.orderTotal` differs from the previous
  hour's signature. **Additionally capture the slot `hour`**, which the original
  discards. `at` = that date at that hour. `refunded` = `!!slot.refundReceiptId`.
  `paymentMethod` = `slot.isPaid ? "online_card" : "onsite"`. Items map from
  `{ item, qty, price }` — note the key is `item`, not `name`.
- **indoor** (`indoorOrders`): parse `createdAt`; `refunded` always `false`;
  `paymentMethod` = `order.gatewayTransactionId ? "online_card" : "onsite"`.
  Items map from `{ item, qty, price }`.

Filter to `at >= fromDate && at <= toDate` (inclusive lower bound — the test pins this).

Then `computeSalesStats` builds `totals`/`previous` by summing non-refunded sales
(`revenue`, `orders`), summing **all** sales for `items` counts, and computing
`avgOrder = orders ? round2(revenue / orders) : null`. `deltas` per key:
`prev === 0 ? null : round1(((cur - prev) / prev) * 100)`.

Round all money with `Math.round(x * 100) / 100`. Trim item names and skip empties.
Return `rankings`, `neverSold`, `patterns`, `refunds` as empty stubs matching the
contract's shape — Tasks 2–4 fill them.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm run test:unit
```

Expected: PASS, all 9 new tests green, existing suites unaffected.

- [ ] **Step 5: Commit**

```bash
git add src/server/sales-stats.js tests/unit/sales-stats.test.js
git commit -m "feat(stats): pure sales-stats module with totals and period comparison"
```

---

### Task 2: Rankings and never-sold items

**Files:**
- Modify: `src/server/sales-stats.js`
- Test: `tests/unit/sales-stats.test.js`

**Interfaces:**
- Consumes: `collectSales()` and the `items` aggregation from Task 1.
- Produces: `rankings.{topByCount,bottomByCount,topByRevenue}` and `neverSold`, per the contract.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/sales-stats.test.js`:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm run test:unit
```

Expected: FAIL — `rankings.topByCount` is an empty stub.

- [ ] **Step 3: Write the implementation**

In `sales-stats.js`, from the aggregated item map:

- `topByCount` — sort by `count` desc, take 5.
- `bottomByCount` — filter `count > 0`, sort by `count` asc, take 5.
- `topByRevenue` — sort by `revenue` desc, take 5.
- `neverSold` — for each key of `menu`, keep entries whose **trimmed** `name` is
  not present in the sold-name set (also trimmed). Skip categories that end up
  empty, and skip non-array menu values defensively. Return `[]` when nothing
  qualifies.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm run test:unit
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/sales-stats.js tests/unit/sales-stats.test.js
git commit -m "feat(stats): rankings and never-sold menu items"
```

---

### Task 3: Chart buckets and patterns

**Files:**
- Modify: `src/server/sales-stats.js`
- Test: `tests/unit/sales-stats.test.js`

**Interfaces:**
- Consumes: `collectSales()` from Task 1.
- Produces: `chart.{unit,buckets}` and `patterns.{weekday,bestWeekday,hour,bestHour,channels,payments}`.

- [ ] **Step 1: Write the failing test**

Append:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm run test:unit
```

Expected: FAIL — `chart.buckets` is empty.

- [ ] **Step 3: Write the implementation**

- `chart`: `unit` is `"hour"` when `days === 1`, else `"day"`. Pre-seed **every**
  bucket at zero (24 hours, or one per calendar day from `since` to today
  inclusive) so the chart never has holes, then add non-refunded sales.
  Day keys are local `YYYY-MM-DD` — build them from the Date's local parts, **not**
  `toISOString()`, which would shift across midnight in a non-UTC timezone.
- `patterns.weekday`: bucket non-refunded revenue by `at.getDay()`, and count how
  many times each weekday actually occurs in the window (`occurrences`).
  `bestWeekday` = the weekday with the highest `revenue / occurrences`, or `null`
  when there is no revenue.
- `patterns.hour`: bucket by `at.getHours()`, emit only hours with data, sorted
  ascending. `bestHour` = highest revenue, or `null`.
- `patterns.channels` / `patterns.payments`: sum non-refunded revenue by `channel`
  and by `paymentMethod`. `share` = percent of the period's non-refunded revenue,
  rounded to one decimal. Emit only ids with revenue; return `[]` when there is none.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm run test:unit
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/sales-stats.js tests/unit/sales-stats.test.js
git commit -m "feat(stats): revenue chart buckets, weekday/hour/channel/payment patterns"
```

---

### Task 4: Refund analytics

**Files:**
- Modify: `src/server/sales-stats.js`
- Test: `tests/unit/sales-stats.test.js`

**Interfaces:**
- Consumes: `collectSales()`; reads `refundReason` / `refundNote` written by Task 6.
- Produces: `refunds.{total,count,rate,topItems,reasons,orders}`.

- [ ] **Step 1: Write the failing test**

Append:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm run test:unit
```

Expected: FAIL — `refunds.total` is 0 from the stub.

- [ ] **Step 3: Write the implementation**

From the refunded slice of `collectSales()`:
- `total` = sum of refunded order totals; `count` = number of refunded sales.
- `rate` = `total / (totals.revenue + total) * 100`, rounded to one decimal,
  **0 when the denominator is 0** — guard the division.
- `topItems` = item names by how many refunded orders they appear in, top 5.
- `reasons` = counts by `refundReason`, with missing/blank mapped to `"none"`,
  sorted by count desc.
- `orders` = refunded sales as `{ id, createdAt, total, itemNames, reason, note }`,
  **unlabelled first** (so they are easy to clear), then newest first. `reason` is
  `null` when unset. Carry `refundReason`/`refundNote` through `collectSales()` for
  delivery orders only.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm run test:unit
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/sales-stats.js tests/unit/sales-stats.test.js
git commit -m "feat(stats): refund totals, rate, item co-occurrence and reason breakdown"
```

---

### Task 5: Wire the module into `GET /stats/sales`

**Files:**
- Modify: `src/server/server.js` — route at ~line 4393, delete `collectTableOrderEvents` at ~line 2213

**Interfaces:**
- Consumes: `computeSalesStats()` from Tasks 1–4.
- Produces: the JSON payload Tasks 7–8 render.

- [ ] **Step 1: Replace the route body**

Add `const salesStats = require("./sales-stats");` alongside the other server-module
requires at the top of `server.js`. Replace the whole handler body:

```js
const ALLOWED_STATS_DAYS = [1, 7, 30, 90];

app.get(`${api}/stats/sales`, requireAuth, (req, res) => {
    try {
        const days = parseInt(req.query.days, 10);
        if (!ALLOWED_STATS_DAYS.includes(days)) {
            return res.status(400).json({ error: "Neplatné období" });
        }
        res.json(salesStats.computeSalesStats({
            orders: db.list(COL.orders),
            timetables: db.list(COL.timetables),
            indoorOrders: db.list(COL.indoorOrders),
            menu: db.get(COL.menu, MENU_SINGLETON_ID) || {},
            days,
            now: new Date(),
        }));
    } catch (e) {
        console.error("Sales stats failed:", e);
        res.status(500).json({ error: "Failed to compute sales stats" });
    }
});
```

**Keep the existing security comment block above the route verbatim** — it records
why this is `requireAuth` and not `requireAdmin`, and why the guard exists at all
(audit 2026-07-29 finding F1). Extend it with one line explaining that `days` is
now allowlisted, replacing the unbounded `parseInt` the comment warns about.

- [ ] **Step 2: Delete the now-dead helper**

`collectTableOrderEvents` (`server.js:2213`) had exactly one caller — this route.
Its logic now lives in `sales-stats.js`. Delete the function. Do **not** touch
`collectIndoorOrderEvents` directly below it; that one is the kitchen board's and
is still used.

- [ ] **Step 3: Verify nothing else referenced it**

```bash
grep -rn "collectTableOrderEvents" src/
```

Expected: no output.

- [ ] **Step 4: Boot the server and hit the route**

Per the workspace recipe, copy `src/` + `package.json` to a short local path
(`C:\Users\alexh\AppData\Local\Temp\zt-stats`), **skipping `data/`** — it holds
real customer names, addresses, phones and password hashes. Then:

```bash
npm install --no-audit --no-fund && npm install-scripts approve better-sqlite3 && npm install-scripts approve esbuild
```

Boot with `PORT=3457 JWT_SECRET=x CSRF_SECRET=y node src/server/server.js`, seed an
admin (needs both `isAdmin: true` and a bcrypt hash) and a menu, log in via
`POST /api/users/login` with **`abbreviation`**, then `GET /stats/sales?days=7`.

Expected: 200 with the full contract shape; `?days=5` returns 400.

- [ ] **Step 5: Commit**

```bash
git add src/server/server.js
git commit -m "refactor(stats): thin /stats/sales route over sales-stats module, allowlist days"
```

---

### Task 6: Refund-reason route

**Files:**
- Modify: `src/server/validation.js`
- Modify: `src/server/server.js`

**Interfaces:**
- Produces: `POST /orders/:orderId/refund-reason`, consumed by Task 8's UI.

- [ ] **Step 1: Add the schema**

In `validation.js`, next to the other body schemas:

```js
const refundReasonSchema = z.object({
    reason: z.enum(["badly_prepared", "late", "customer_cancelled",
                    "wrong_order", "other"], { error: "Neplatný důvod" }),
    note: z.string().max(200, { error: "Poznámka je příliš dlouhá" }).optional(),
});
```

Export it in the `// bodies` group of `module.exports`.

- [ ] **Step 2: Add the route**

In `server.js`, directly after the delivery-order routes:

```js
// Labels a refund that ALREADY happened — it can never create one. Refunds
// arrive only as GoPay webhooks (gopay.js's refundPayment() is defined but
// never called), so this route moves no money and touches no gateway. The
// paymentStatus guard is what enforces that.
app.post(`${api}/orders/:orderId/refund-reason`,
    csrf.requireCsrf, requireAuth,
    V.validateParams(V.paramsOrderId), V.validate(V.refundReasonSchema),
    (req, res) => {
        const order = db.get(COL.orders, req.params.orderId);
        if (!order) return res.status(404).json({ error: "Objednávka nenalezena" });
        if (order.paymentStatus !== "refunded") {
            return res.status(400).json({ error: "Objednávka není vrácená" });
        }
        order.refundReason = req.body.reason;
        order.refundNote = (req.body.note || "").trim();
        db.set(COL.orders, order.id, order);
        res.json({ success: true, order });
    });
```

- [ ] **Step 3: Verify against the running server**

Using the Task 5 server, with both the session cookie and an `x-csrf-token` header
from `GET /api/csrf-token`:

- POST a reason to a non-refunded order → **400 "Objednávka není vrácená"**
- POST to an unknown id → **404**
- POST `{ reason: "banana" }` → **400** from the schema
- POST a valid reason to a refunded order → **200**, and `GET /stats/sales?days=7`
  now reports it under `refunds.reasons`

- [ ] **Step 4: Commit**

```bash
git add src/server/validation.js src/server/server.js
git commit -m "feat(stats): staff can label why a refund happened"
```

---

### Task 7: Frontend shell — extraction, period switcher, chart, KPIs

**Files:**
- Create: `src/js/sales-stats-view.js`
- Modify: `src/js/inner.js` (delete ~3407–3496), `src/html/inner.html` (~line 399)

**Interfaces:**
- Consumes: `GET /stats/sales?days=N`.
- Produces: global `renderSalesView()`, replacing `inner.js`'s. Reuses `inner.js`'s
  globals at call time: `apiFetch`, `escapeHtml`, `showToast`, `API_URL`,
  `renderReceiptsPanel`.

- [ ] **Step 1: Move the view out**

Delete `fetchSalesStats`, `renderSalesTable` and `renderSalesView` from `inner.js`
(the block between the `SALES STATS` banner comment at ~3407 and the
`── RECEIPTS ──` comment at ~3498). **Keep** everything from `todayISODate`
onward — `renderReceiptsPanel` and friends stay in `inner.js`.

Add to `inner.html` after the `inner.js` tag:

```html
<script src="/reservation/js/sales-stats-view.js"></script>
```

Loading it *after* `inner.js` is safe: `renderSalesView` is a hoisted function
declaration and is only ever called from a click handler, long after both scripts
have evaluated.

- [ ] **Step 2: Build the shell**

In `sales-stats-view.js`, module-level `let salesPeriod = 7;` and the Czech label
maps (the server sends ids only):

```js
const PERIODS = [
    { days: 1,  label: 'Dnes',    caption: 'Dnešek od půlnoci' },
    { days: 7,  label: '7 dní',   caption: 'Posledních 7 dní' },
    { days: 30, label: '30 dní',  caption: 'Posledních 30 dní' },
    { days: 90, label: '90 dní',  caption: 'Posledních 90 dní' },
];
const CHANNEL_LABELS = { delivery: 'Rozvoz', table: 'Stůl', indoor: 'Na místě' };
const PAYMENT_LABELS = {
    cash: 'Hotově', card_on_delivery: 'Kartou u řidiče',
    online_card: 'Online', onsite: 'Na místě',
};
const WEEKDAYS = ['Neděle','Pondělí','Úterý','Středa','Čtvrtek','Pátek','Sobota'];
const REFUND_REASONS = [
    { id: 'badly_prepared',    label: 'Špatně připravené' },
    { id: 'late',              label: 'Pozdě doručené' },
    { id: 'customer_cancelled',label: 'Zákazník zrušil' },
    { id: 'wrong_order',       label: 'Chyba objednávky' },
    { id: 'other',             label: 'Jiný' },
];
const czk = n => `${Math.round(Number(n) || 0).toLocaleString('cs-CZ')} Kč`;
```

`renderSalesView()` fetches `?days=${salesPeriod}`, clears the container, and
appends: header, period switcher, chart card, KPI row, then the Task 8 panels,
then `await renderReceiptsPanel(container)`.

On fetch failure, render one error line plus a "Zkusit znovu" button wired back to
`renderSalesView()`.

- [ ] **Step 3: Period switcher**

Flush-left tab strip (spec §5.1) — text labels on a shared baseline, active one
marked by weight plus a 2px accent underline. **Not** filled pills. Each is a
`<button>` with `aria-pressed`; clicking sets `salesPeriod` and re-runs
`renderSalesView()`.

- [ ] **Step 4: Chart card — the headline**

One wide card, the most prominent thing on screen:
- Total revenue **large, in the accent color** (`totals.revenue` via `czk()`), with
  the period caption beneath it.
- On the same baseline, the Δ% as plain `+x %` / `−x %` text in `--ok` / `--danger`.
  **Omit the element entirely when `deltas.revenue` is `null`.**
- Below, one bar per `chart.buckets` entry: each bar in a pale full-height rail
  (`--line` background) with an accent fill whose height is
  `revenue / max * 100%`, `max` being the largest bucket revenue — guard `max === 0`
  by rendering all bars empty rather than dividing by zero.
- Each bar gets a `title` with the bucket label, its revenue and its order count —
  keyboard-reachable via `tabindex="0"`, since hover alone can't be the only
  affordance on a touch surface.
- Day labels: `D.M.` from the bucket key for `unit: "day"`, `H:00` for `"hour"`.
  On 30/90-day ranges label every 5th bucket only, so the axis never collides.
- Empty period: `0 Kč` and a muted "Zatím žádné prodeje v tomto období." instead of
  bars.

- [ ] **Step 5: KPI row**

Four tiles — **Tržba · Objednávky · Průměrná objednávka · Prodáno položek**. Each:
small muted uppercase label, big number, Δ% caption. `avgOrder === null` renders
"—", never `NaN`. Δ omitted when null, exactly as in Step 4.

- [ ] **Step 6: Verify in the browser**

Against the Task 5 server at 1280 wide: switch all four periods and confirm the
totals change, the chart re-renders, and no console errors. Because `minify.js`
sends `Cache-Control: max-age=3600` and Chrome serves stale JS through
Ctrl+Shift+R, **re-test on a different port** to get a fresh cache partition.

- [ ] **Step 7: Commit**

```bash
git add src/js/sales-stats-view.js src/js/inner.js src/html/inner.html
git commit -m "feat(stats): revenue chart, period switcher and KPI row"
```

---

### Task 8: Frontend panels — rankings, never-sold, patterns, refunds

**Files:**
- Modify: `src/js/sales-stats-view.js`

**Interfaces:**
- Consumes: `rankings`, `neverSold`, `patterns`, `refunds`, `items` from the payload;
  `POST /orders/:orderId/refund-reason` from Task 6.

- [ ] **Step 1: Three ranking cards**

Side by side: **Nejprodávanější** (`topByCount`), **Nejméně prodávané**
(`bottomByCount`), **Největší tržba** (`topByRevenue`). Each row: rank, name, and
the metric, with a thin proportional bar behind the row scaled to that card's top
value. No emoji in the titles. Each card gets its own "Zatím žádné prodeje" empty
state.

- [ ] **Step 2: Neprodalo se vůbec**

`neverSold` grouped by category, mapping the menu keys to Czech via
`{ main: 'Hlavní jídla', side: 'Přílohy', drinks: 'Nápoje', desserts: 'Dezerty' }`
and falling back to the raw key for any other category. Empty array renders the
positive state: "Všechny položky menu se v tomto období prodaly."

- [ ] **Step 3: Vzorce**

One card, four blocks: **Nejsilnější den** (`WEEKDAYS[bestWeekday]`, or "—"),
**Nejsilnější hodina** (`${bestHour}:00`, or "—"), **Podle kanálu** and
**Podle platby** as labelled proportional bars using `share`, with revenue shown
alongside. Label the payment "Na místě" slice with a one-line note that these
orders were settled at the table and carry no recorded method — so nobody reads it
as missing data.

- [ ] **Step 4: Vrácené platby**

- Header figures: total refunded, `count`, and `rate` as a percentage.
- **Nejčastěji vrácené položky** — titled precisely *"položky ve vrácených
  objednávkách"*. Add a one-line note: a refund is always whole-order, so this is
  co-occurrence, not per-item attribution. The UI must not imply the item itself
  was refunded.
- **Důvody vrácení** — `reasons` mapped through `REFUND_REASONS`, with `none`
  rendered as "Bez důvodu".
- The `refunds.orders` list, each row showing date, total, item names, and a
  `<select>` of `REFUND_REASONS` plus a note input. Changing the select POSTs to
  `/orders/${id}/refund-reason`. `apiFetch` already attaches the CSRF header —
  confirm this by reading `apiFetch` at `inner.js:108` before writing the call, and
  add the `x-csrf-token` header explicitly if it does not.
- On failure: revert the select to its previous value and `showToast(msg, true)`.
  On success: toast, and update the reason breakdown without a full refetch.
- Whole panel hidden when `refunds.count === 0` — an empty refunds panel is noise.

- [ ] **Step 5: Item table**

The full `items` table for the selected period. Header stays
`# / Položka / Prodáno (ks) / Tržba`. Add a one-line caption: counts include
refunded orders, and the revenue column is per-dish (price × qty) so it will not
match the headline total, which includes delivery fees. Reuse the existing
`inn-bookings-table` classes.

- [ ] **Step 6: Verify in the browser**

Seed data covering all three channels, a refunded order, and a menu item nobody
ordered. Confirm: never-sold lists exactly that item; the refund select persists
across a reload; a failed POST reverts the select.

- [ ] **Step 7: Commit**

```bash
git add src/js/sales-stats-view.js
git commit -m "feat(stats): rankings, never-sold, patterns and refund panels"
```

---

### Task 9: Swiss styling

**Files:**
- Modify: `src/css/inner.css`

- [ ] **Step 1: Append the `.inn-stat-*` block**

Tokens only — no literal colors. Cards use `--rule` 1px edges and `--radius`;
internal dividers use `--line`. Accent (`--accent`) appears only on the total
revenue figure, the active tab underline, and the chart bars. Everything else is
`--ink` / `--muted`. All numerics get `font-variant-numeric: tabular-nums`.

Layout: CSS grid, flush-left, consistent gutters. KPI row is
`repeat(4, minmax(0, 1fr))`, ranking cards `repeat(3, minmax(0, 1fr))`, both
collapsing to two columns under 1100px. No shadows anywhere.

- [ ] **Step 2: Hover and focus**

Every `:hover` wrapped in `@media (hover: hover)` with a matching `:active` rule
outside it. Chart bars and tabs get a visible `:focus-visible` outline.

- [ ] **Step 3: Verify at both widths**

Screenshot or assert geometry at **1024×768** and **1680 wide**. Confirm no
horizontal overflow, no collision in the chart axis labels at 90 days, and that
the total revenue figure is unambiguously the largest text on the screen.

- [ ] **Step 4: Commit**

```bash
git add src/css/inner.css
git commit -m "style(stats): Swiss grid, rules and accent discipline for the sales view"
```

---

### Task 10: Full verification

- [ ] **Step 1: Unit suite**

```bash
npm run test:unit
```

Expected: PASS, including every pre-existing EET/POS suite.

- [ ] **Step 2: End-to-end against the copy-out server**

Seed all three channels, a refunded order with and without a reason, and a menu
item with no sales. Walk all four periods and confirm against hand-computed
figures: totals, deltas, chart bucket sums, channel and payment shares summing to
100%, never-sold contents, and refund rate.

- [ ] **Step 3: Confirm the refund guard**

Re-run the Task 6 negative cases — non-refunded order 400, unknown id 404, bad
enum 400. A regression here would let the UI invent refunds.

- [ ] **Step 4: Report**

State plainly what passed and what did not, with the actual command output. Do not
claim completion for anything not observed running.
