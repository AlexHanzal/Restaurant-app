// ============================================================================
// sales-stats.js — pure aggregation math behind the admin "Prodeje" screen.
//
// Zero dependencies and completely pure, same convention as settings.js /
// csrf.js / reorder.js / offline-sale.js: every input arrives as an
// argument (including the clock — `now` — never Date.now()/new Date() with
// no argument), nothing is read from server.js, nothing touches the
// database or the filesystem. That is what keeps a screen built from three
// very different sale sources (delivery orders, reservation-table orders,
// walk-in indoor orders) testable with `node --test` in a workspace where
// the full server frequently cannot boot at all (OneDrive-hosted
// node_modules gaps — see MEMORY.md).
//
// `collectSales` is the seam: it normalises all three channels into one
// flat shape, and every later task (rankings, never-sold items, time-of-day
// patterns, refund analytics) reads from that same array rather than
// re-deriving it. `computeSalesStats` is the only exported entry point
// that walks that seam today; the `chart`/`rankings`/`neverSold`/`patterns`/
// `refunds` keys on its return value are empty stubs here — their shape
// (which keys exist, and their type) is fixed by the contract now, so later
// tasks only need to fill the stub contents in, not change what a caller
// destructures.
// ============================================================================

function round2(value) {
    return Math.round(Number(value) * 100) / 100;
}

function round1(value) {
    return Math.round(Number(value) * 10) / 10;
}

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

// Normalises one item line to { name, qty, price }. `key` is "name" for
// delivery orders and "item" for reservation slots / indoor orders — see
// the module header. Returns null for a blank/whitespace-only name so the
// caller can drop it.
function normaliseItem(raw, key) {
    if (!raw || typeof raw !== "object") return null;
    const name = String(raw[key] == null ? "" : raw[key]).trim();
    if (!name) return null;
    const qty = Number(raw.qty);
    const price = Number(raw.price);
    return {
        name,
        qty: Number.isFinite(qty) ? qty : 0,
        price: Number.isFinite(price) ? price : 0,
    };
}

function normaliseItems(rawItems, key) {
    if (!Array.isArray(rawItems)) return [];
    const out = [];
    for (const raw of rawItems) {
        const item = normaliseItem(raw, key);
        if (item) out.push(item);
    }
    return out;
}

// Flat, normalised sale records from all three channels:
//   { channel, at: Date, total, refunded, paymentMethod, orderId,
//     items: [{ name, qty, price }] }
// This is the single seam every later task reads from.
function collectSales({ orders, timetables, indoorOrders }, fromDate, toDate) {
    const sales = [];

    // ── delivery (`orders`) ────────────────────────────────────────────
    for (const order of orders || []) {
        if (!order) continue;
        const parsed = Date.parse(order.createdAt);
        if (!Number.isFinite(parsed)) continue;
        const at = new Date(parsed);
        if (at < fromDate || at > toDate) continue;

        sales.push({
            channel: "delivery",
            at,
            total: Number(order.total) || 0,
            refunded: order.paymentStatus === "refunded",
            paymentMethod: order.paymentMethod || "onsite",
            orderId: order.id,
            items: normaliseItems(order.items, "name"),
            // Refund analytics (Task 4) reads these. Only delivery orders
            // carry them today — the route that writes them targets that
            // channel — so table/indoor sales simply don't have the keys,
            // which downstream code treats the same as unset.
            refundReason: order.refundReason || null,
            refundNote: order.refundNote || null,
        });
    }

    // ── table (`timetables`) ───────────────────────────────────────────
    // Ports the de-duplication trick from collectTableOrderEvents
    // (server.js ~line 2213): walk data[dateStr][dayIndex][hour] in hour
    // order, skip slots with no order, and emit only when the
    // JSON.stringify(order)+"|"+orderTotal signature differs from the
    // previous hour's — a slot's order is unchanged from the previous hour
    // for as long as nothing new was ordered, and re-emitting it every hour
    // would double count the same food. Unlike the original, this also
    // keeps the slot's hour, which collectTableOrderEvents discards.
    for (const timetableData of timetables || []) {
        const dataObj = (timetableData && timetableData.data) || {};
        for (const dateStr of Object.keys(dataObj)) {
            const dayArray = dataObj[dateStr] || [];
            for (let dayIndex = 0; dayIndex < dayArray.length; dayIndex++) {
                const hoursObj = dayArray[dayIndex];
                if (!hoursObj) continue;

                const hourKeys = Object.keys(hoursObj)
                    .map(Number)
                    .filter(h => !isNaN(h))
                    .sort((a, b) => a - b);

                let prevSignature = null;
                for (const h of hourKeys) {
                    const slot = hoursObj[h];
                    if (!slot || !Array.isArray(slot.order) || slot.order.length === 0) {
                        prevSignature = null;
                        continue;
                    }
                    const signature = JSON.stringify(slot.order) + "|" + slot.orderTotal;
                    if (signature !== prevSignature) {
                        const at = new Date(`${dateStr}T00:00:00`);
                        if (!isNaN(at.getTime())) {
                            at.setHours(h, 0, 0, 0);
                            if (at >= fromDate && at <= toDate) {
                                sales.push({
                                    channel: "table",
                                    at,
                                    total: Number(slot.orderTotal) || 0,
                                    refunded: !!slot.refundReceiptId,
                                    paymentMethod: slot.isPaid ? "online_card" : "onsite",
                                    orderId: null,
                                    items: normaliseItems(slot.order, "item"),
                                });
                            }
                        }
                    }
                    prevSignature = signature;
                }
            }
        }
    }

    // ── indoor (`indoorOrders`) ────────────────────────────────────────
    for (const order of indoorOrders || []) {
        if (!order) continue;
        const parsed = Date.parse(order.createdAt);
        if (!Number.isFinite(parsed)) continue;
        const at = new Date(parsed);
        if (at < fromDate || at > toDate) continue;

        sales.push({
            channel: "indoor",
            at,
            total: Number(order.total) || 0,
            refunded: false,
            paymentMethod: order.gatewayTransactionId ? "online_card" : "onsite",
            orderId: order.id,
            items: normaliseItems(order.items, "item"),
        });
    }

    return sales;
}

function sumTotals(sales) {
    let revenue = 0;
    let ordersCount = 0;
    let itemCount = 0;
    const itemsByName = new Map();

    for (const sale of sales) {
        if (!sale.refunded) {
            revenue += sale.total;
            ordersCount += 1;
        }
        for (const item of sale.items) {
            itemCount += item.qty;
            const existing = itemsByName.get(item.name) || { name: item.name, count: 0, revenue: 0 };
            existing.count += item.qty;
            // items[] is the "what the kitchen sold" view: count and revenue both gross (including refunded orders).
            // totals.revenue is the net money view and excludes refunds. These two figures are on different bases by design.
            existing.revenue += item.qty * item.price;
            itemsByName.set(item.name, existing);
        }
    }

    return {
        revenue: round2(revenue),
        orders: ordersCount,
        items: itemCount,
        avgOrder: ordersCount ? round2(revenue / ordersCount) : null,
        itemsByName,
    };
}

// From the aggregated item map (already sorted by count desc — see `items`
// in computeSalesStats), split into the three ranking views the "Prodeje"
// screen shows. All three cap at 5 entries.
function buildRankings(items) {
    const topByCount = items.slice(0, 5);
    const bottomByCount = items
        .filter(item => item.count > 0)
        .sort((a, b) => a.count - b.count)
        .slice(0, 5);
    const topByRevenue = [...items].sort((a, b) => b.revenue - a.revenue).slice(0, 5);
    return { topByCount, bottomByCount, topByRevenue };
}

// Menu items whose (trimmed) name never appears in `soldNames`, grouped by
// their menu category. Skips non-array category values and blank names
// defensively, and drops categories that end up empty.
function buildNeverSold(menu, soldNames) {
    const groups = [];
    for (const category of Object.keys(menu || {})) {
        const rawList = menu[category];
        if (!Array.isArray(rawList)) continue;
        const names = [];
        for (const entry of rawList) {
            if (!entry) continue;
            const name = String(entry.name == null ? "" : entry.name).trim();
            if (!name) continue;
            if (!soldNames.has(name)) names.push(name);
        }
        if (names.length) groups.push({ category, items: names });
    }
    return groups;
}

// Local YYYY-MM-DD from a Date's *local* parts — never toISOString(), which
// shifts across midnight outside UTC and would file an evening sale under
// the wrong day.
function localDayKey(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
}

// One local-midnight Date per calendar day from `since` to `until`
// inclusive (both truncated to their local day). Used to zero-fill the day
// chart and to count how many times each weekday occurs in the window.
function eachLocalDay(since, until) {
    const days = [];
    const cursor = new Date(since.getFullYear(), since.getMonth(), since.getDate());
    const end = new Date(until.getFullYear(), until.getMonth(), until.getDate());
    while (cursor <= end) {
        days.push(new Date(cursor));
        cursor.setDate(cursor.getDate() + 1);
    }
    return days;
}

// Revenue chart: hourly (24 zero-filled slots) for a 1-day window, daily
// (one zero-filled bucket per calendar day, oldest first) otherwise.
// Refunded sales are excluded — this is a money view.
function buildChart(days, since, until, sales) {
    const unit = days === 1 ? "hour" : "day";
    let buckets;
    if (unit === "hour") {
        buckets = Array.from({ length: 24 }, (_, h) => ({ key: String(h).padStart(2, "0"), revenue: 0 }));
        for (const sale of sales) {
            if (sale.refunded) continue;
            buckets[sale.at.getHours()].revenue += sale.total;
        }
    } else {
        const map = new Map();
        for (const day of eachLocalDay(since, until)) {
            const key = localDayKey(day);
            map.set(key, { key, revenue: 0 });
        }
        for (const sale of sales) {
            if (sale.refunded) continue;
            const bucket = map.get(localDayKey(sale.at));
            if (bucket) bucket.revenue += sale.total;
        }
        buckets = [...map.values()];
    }
    for (const bucket of buckets) bucket.revenue = round2(bucket.revenue);
    return { unit, buckets };
}

// Non-refunded revenue by weekday (`at.getDay()`), alongside how many times
// that weekday actually occurred in [since, until] — needed to rank
// weekdays by *average* revenue, not raw total, so a 7-day window doesn't
// automatically favour whichever weekday shows up twice. Only weekdays that
// occur in the window are emitted; bestWeekday stays null with no revenue.
function buildWeekdayPattern(sales, since, until) {
    const occurrences = new Array(7).fill(0);
    for (const day of eachLocalDay(since, until)) occurrences[day.getDay()] += 1;

    const revenueByDay = new Array(7).fill(0);
    for (const sale of sales) {
        if (sale.refunded) continue;
        revenueByDay[sale.at.getDay()] += sale.total;
    }

    const weekday = [];
    let bestWeekday = null;
    let bestAvg = -Infinity;
    for (let d = 0; d < 7; d++) {
        if (occurrences[d] === 0) continue;
        const revenue = round2(revenueByDay[d]);
        weekday.push({ id: d, revenue, occurrences: occurrences[d] });
        if (revenue > 0) {
            const avg = revenue / occurrences[d];
            if (avg > bestAvg) {
                bestAvg = avg;
                bestWeekday = d;
            }
        }
    }
    return { weekday, bestWeekday };
}

// Non-refunded revenue by hour of day. Unlike weekday, only hours that
// actually received a sale are emitted — there is no "occurrences" concept
// to average over, an hour either sold something in the window or it did
// not.
function buildHourPattern(sales) {
    const map = new Map();
    for (const sale of sales) {
        if (sale.refunded) continue;
        const h = sale.at.getHours();
        map.set(h, (map.get(h) || 0) + sale.total);
    }
    const hour = [...map.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([id, revenue]) => ({ id, revenue: round2(revenue) }));

    let bestHour = null;
    let bestRevenue = -Infinity;
    for (const entry of hour) {
        if (entry.revenue > bestRevenue) {
            bestRevenue = entry.revenue;
            bestHour = entry.id;
        }
    }
    return { hour, bestHour };
}

// Non-refunded revenue split by an arbitrary key (channel or payment
// method), each with its percent share of the period's non-refunded
// revenue. Emits only ids that actually have revenue, sorted highest first;
// share is 0 (not NaN) when there is no revenue at all.
function buildSplit(sales, keyFn) {
    const map = new Map();
    let totalRevenue = 0;
    for (const sale of sales) {
        if (sale.refunded) continue;
        const id = keyFn(sale);
        map.set(id, (map.get(id) || 0) + sale.total);
        totalRevenue += sale.total;
    }
    return [...map.entries()]
        .map(([id, revenue]) => ({
            id,
            revenue: round2(revenue),
            share: totalRevenue > 0 ? round1((revenue / totalRevenue) * 100) : 0,
        }))
        .sort((a, b) => b.revenue - a.revenue);
}

// Refund analytics from the refunded slice of `collectSales()`. `netRevenue`
// is the period's totals.revenue (already refund-excluded) and is only used
// to build the rate denominator.
function buildRefunds(sales, netRevenue) {
    const refundedSales = sales.filter(sale => sale.refunded);

    let total = 0;
    const itemCounts = new Map();
    const reasonCounts = new Map();
    const orders = [];

    for (const sale of refundedSales) {
        total += sale.total;

        // Co-occurrence is per refunded order, not per line: an item that
        // appears twice on the same refunded order still only counts once
        // toward "how many refunded orders included this item".
        const namesOnOrder = new Set(sale.items.map(item => item.name));
        for (const name of namesOnOrder) {
            itemCounts.set(name, (itemCounts.get(name) || 0) + 1);
        }

        const reasonRaw = sale.refundReason == null ? "" : String(sale.refundReason).trim();
        const reasonId = reasonRaw || "none";
        reasonCounts.set(reasonId, (reasonCounts.get(reasonId) || 0) + 1);

        orders.push({
            id: sale.orderId,
            createdAt: sale.at.toISOString(),
            total: round2(sale.total),
            itemNames: sale.items.map(item => item.name),
            reason: reasonRaw || null,
            note: sale.refundNote || null,
        });
    }

    total = round2(total);
    const count = refundedSales.length;
    const denominator = netRevenue + total;
    const rate = denominator > 0 ? round1((total / denominator) * 100) : 0;

    const topItems = [...itemCounts.entries()]
        .map(([name, itemCount]) => ({ name, count: itemCount }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5);

    const reasons = [...reasonCounts.entries()]
        .map(([id, reasonCount]) => ({ id, count: reasonCount }))
        .sort((a, b) => b.count - a.count);

    // Unlabelled first (so they're easy to triage/clear), then newest first.
    orders.sort((a, b) => {
        const aUnlabelled = a.reason === null ? 0 : 1;
        const bUnlabelled = b.reason === null ? 0 : 1;
        if (aUnlabelled !== bUnlabelled) return aUnlabelled - bUnlabelled;
        return Date.parse(b.createdAt) - Date.parse(a.createdAt);
    });

    return { total, count, rate, topItems, reasons, orders };
}

function computeSalesStats({ orders, timetables, indoorOrders, menu, days, now }) {
    const { since, until, prevSince } = periodBounds(days, now);

    const currentSales = collectSales({ orders, timetables, indoorOrders }, since, until);
    // The previous period ends the instant the current one begins.
    const prevUntil = new Date(since.getTime() - 1);
    const previousSales = collectSales({ orders, timetables, indoorOrders }, prevSince, prevUntil);

    const current = sumTotals(currentSales);
    const previous = sumTotals(previousSales);

    const items = [...current.itemsByName.values()]
        .map(entry => ({ name: entry.name, count: entry.count, revenue: round2(entry.revenue) }))
        .sort((a, b) => b.count - a.count);

    const rankings = buildRankings(items);
    const soldNames = new Set(current.itemsByName.keys());
    const neverSold = buildNeverSold(menu, soldNames);

    const chart = buildChart(days, since, until, currentSales);
    const { weekday, bestWeekday } = buildWeekdayPattern(currentSales, since, until);
    const { hour, bestHour } = buildHourPattern(currentSales);
    const channels = buildSplit(currentSales, sale => sale.channel);
    const payments = buildSplit(currentSales, sale => sale.paymentMethod);
    const refunds = buildRefunds(currentSales, current.revenue);

    const deltaOf = (cur, prev) => (prev === 0 || prev === null ? null : round1(((cur - prev) / prev) * 100));

    return {
        days,
        since: since.toISOString(),
        until: until.toISOString(),
        totals: {
            revenue: current.revenue,
            orders: current.orders,
            items: current.items,
            avgOrder: current.avgOrder,
        },
        previous: {
            revenue: previous.revenue,
            orders: previous.orders,
            items: previous.items,
            avgOrder: previous.avgOrder,
        },
        deltas: {
            revenue: deltaOf(current.revenue, previous.revenue),
            orders: deltaOf(current.orders, previous.orders),
            items: deltaOf(current.items, previous.items),
            avgOrder: deltaOf(current.avgOrder, previous.avgOrder),
        },
        items,
        // Filled in by later tasks — kept here now so the contract shape is
        // stable from the start.
        chart,
        rankings,
        neverSold,
        patterns: {
            weekday, bestWeekday, hour, bestHour,
            channels, payments,
        },
        refunds,
    };
}

module.exports = {
    periodBounds,
    computeSalesStats,
};
