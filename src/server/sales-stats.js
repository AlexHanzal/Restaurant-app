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
// that walks that seam today; the `rankings`/`neverSold`/`patterns`/
// `refunds` keys on its return value are empty stubs here, filled in by
// later tasks, so the contract shape never changes underneath a caller.
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

function computeSalesStats({ orders, timetables, indoorOrders, menu, days, now }) {
    const { since, until, prevSince } = periodBounds(days, now);

    const currentSales = collectSales({ orders, timetables, indoorOrders }, since, until);
    // The previous period ends the instant the current one begins.
    const prevUntil = new Date(since.getTime() - 1);
    const previousSales = collectSales({ orders, timetables, indoorOrders }, prevSince, prevUntil);

    const current = sumTotals(currentSales);
    const previous = sumTotals(previousSales);

    const items = [...current.itemsByName.values()]
        .map(entry => ({ name: entry.name, count: entry.count, revenue: round2(entry.revenue) }));

    const deltaOf = (cur, prev) => (prev === 0 ? null : round1(((cur - prev) / prev) * 100));

    return {
        days,
        since,
        until,
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
        },
        items,
        // Filled in by later tasks — kept here now so the contract shape is
        // stable from the start.
        rankings: { topByRevenue: [], topByCount: [], bottom: [] },
        neverSold: [],
        patterns: { bestHour: null, bestDay: null, byHour: [], byDay: [] },
        refunds: { count: 0, amount: 0, rate: 0 },
    };
}

module.exports = {
    periodBounds,
    computeSalesStats,
};
