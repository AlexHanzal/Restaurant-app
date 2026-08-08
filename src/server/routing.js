// ════════════════════════════════════════════════════════════════════════
// routing.js — delivery batching + route ranking.
//
// PURE FUNCTIONS ONLY. No DB, no network, no clock: `now` is always a
// parameter. That is not stylistic — it is what lets tests/unit/
// routing.test.js exercise the real algorithm instead of a mock of it, and
// what lets the same code answer "what would this batch look like at 18:05"
// without any test scaffolding.
//
// Design notes live in docs/superpowers/specs/2026-08-08-delivery-routing-
// design.md. Two things worth repeating here because getting them wrong
// produces plausible-looking but wrong behaviour:
//
//  1. CLUSTERING IS COMPLETE LINKAGE (canJoin). A candidate must be within
//     the radius of EVERY existing member, not just one. Single linkage
//     would let three 800 m hops build a batch spanning 2.4 km, and the
//     setting would stop meaning what it says.
//
//  2. "OPEN" IS TWO DIFFERENT THINGS. A batch record's status "open" means
//     it has not been claimed or dissolved. Whether it still ACCEPTS NEW
//     MEMBERS is a stricter, derived condition — isBatchAcceptingJoins().
//     A batch that stopped accepting members is still perfectly
//     deliverable; it is in fact exactly what a driver should be taking.
// ════════════════════════════════════════════════════════════════════════

const EARTH_RADIUS_KM = 6371.0088; // IUGG mean radius

function toRad(deg) {
    return (deg * Math.PI) / 180;
}

// Great-circle distance. Straight-line, not road distance — inside a single
// town the two are close enough to rank by, and a routing API would be a
// paid dependency (spec §18).
function haversineKm(a, b) {
    if (!a || !b) return Infinity;
    const dLat = toRad(b.lat - a.lat);
    const dLon = toRad(b.lon - a.lon);
    const h = Math.sin(dLat / 2) ** 2
        + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

function centroid(orders) {
    const pts = (orders || []).map(o => o && o.geo).filter(Boolean);
    if (!pts.length) return null;
    return {
        lat: pts.reduce((s, p) => s + p.lat, 0) / pts.length,
        lon: pts.reduce((s, p) => s + p.lon, 0) / pts.length,
    };
}

function waitMinutes(order, now) {
    const t = new Date(order.createdAt).getTime();
    if (!Number.isFinite(t)) return 0;
    return Math.max(0, (now.getTime() - t) / 60000);
}

// Waiting time expressed as a head start in kilometres, so it can be
// subtracted from a distance and every term of the score shares one unit.
function ageBonusKm(waitMin, cfg) {
    return Math.max(0, waitMin - cfg.ageGraceMinutes) * cfg.agePriorityKmPerMinute;
}

// Complete linkage — see note 1 in the header.
function canJoin(memberOrders, candidate, cfg) {
    if (!candidate || !candidate.geo) return false;
    if (!memberOrders || memberOrders.length === 0) return false;
    if (memberOrders.length >= cfg.maxStops) return false;
    if (memberOrders.some(m => m.id === candidate.id)) return false;
    return memberOrders.every(m =>
        m.geo && haversineKm(m.geo, candidate.geo) * 1000 <= cfg.groupRadiusM);
}

// Whether a batch (or a lone order, passed as a one-element array — one rule,
// not two) will still take on a new member. Derived, never stored, so it can
// never go stale and there is no cron to run.
function isBatchAcceptingJoins(memberOrders, now, cfg) {
    if (!memberOrders || !memberOrders.length) return false;
    // Already-cooked food must not be made to wait for something not started.
    if (memberOrders.some(o => o.kitchenStatus === "completed")) return false;
    if (memberOrders.some(o => o.status !== "pending")) return false;
    const oldest = Math.min(...memberOrders.map(o => new Date(o.createdAt).getTime()));
    if (!Number.isFinite(oldest)) return false;
    // Measured from the OLDEST member: a batch formed at 18:09 around an
    // 18:00 order seals at 18:10, not 18:19. That is what bounds the extra
    // wait the already-waiting order can be made to suffer.
    return now.getTime() - oldest < cfg.batchWindowMinutes * 60000;
}

function permutations(arr) {
    if (arr.length <= 1) return [arr];
    const out = [];
    for (let i = 0; i < arr.length; i++) {
        const rest = arr.slice(0, i).concat(arr.slice(i + 1));
        for (const p of permutations(rest)) out.push([arr[i], ...p]);
    }
    return out;
}

// Exact optimal stop sequence, by brute force over all permutations.
//
// This is only safe because settings caps maxStops at 6 (=> at most 720
// permutations, microseconds). RAISING THAT CAP WITHOUT REPLACING THIS
// FUNCTION IS A PERFORMANCE BUG — 10 stops is 3.6M permutations. The cap is
// enforced in validation.js's routingSchema.
function planBatch(memberOrders, origin) {
    const stops = (memberOrders || []).filter(o => o && o.geo);
    if (!stops.length) return { stopIds: [], routeKm: 0, distToFirstKm: Infinity };

    let best = null;
    for (const perm of permutations(stops)) {
        const distToFirstKm = haversineKm(origin, perm[0].geo);
        let routeKm = 0;
        for (let i = 1; i < perm.length; i++) {
            routeKm += haversineKm(perm[i - 1].geo, perm[i].geo);
        }
        const total = distToFirstKm + routeKm;
        const stopIds = perm.map(o => o.id);
        // Tie-break on the id sequence so two orders at the same address
        // can never make the rendered stop order flap between refreshes.
        const better = !best
            || total < best.total - 1e-9
            || (Math.abs(total - best.total) <= 1e-9 && stopIds.join(" ") < best.stopIds.join(" "));
        if (better) best = { total, distToFirstKm, routeKm, stopIds };
    }
    return { stopIds: best.stopIds, routeKm: best.routeKm, distToFirstKm: best.distToFirstKm };
}

// One entry in the driver's ranked list — a batch or a lone order.
//
// score = distToFirst + intraBatchRoute - batchBonus*(stops-1) - ageBonus
//
// Every term is in kilometres. Lower ranks first. See spec §5 for the
// worked examples these constants were chosen against.
function planItem(memberOrders, origin, now, cfg) {
    const { stopIds, routeKm, distToFirstKm } = planBatch(memberOrders, origin);
    const totalCount = memberOrders.length;
    const oldestWaitMinutes = totalCount
        ? Math.max(...memberOrders.map(o => waitMinutes(o, now)))
        : 0;
    const readyCount = memberOrders.filter(o => o.kitchenStatus === "completed").length;
    const score = distToFirstKm
        + routeKm
        - cfg.batchBonusKm * Math.max(0, totalCount - 1)
        - ageBonusKm(oldestWaitMinutes, cfg);
    return {
        stopIds, routeKm, distToFirstKm, score,
        readyCount, totalCount,
        claimable: totalCount > 0 && readyCount === totalCount,
        oldestWaitMinutes,
    };
}

// The whole driver-facing plan. Returns ids only — hydrating them into full
// order records is server.js's job, which keeps this module free of any
// opinion about what a driver is allowed to see.
function planRoute({ orders, batches, origin, now, cfg }) {
    const byId = new Map(orders.map(o => [o.id, o]));
    const items = [];
    const batched = new Set();

    for (const b of batches || []) {
        if (b.status !== "open") continue;      // claimed or dissolved
        const members = b.orderIds.map(id => byId.get(id)).filter(Boolean);
        // A dangling member id (order deleted) or a member already claimed
        // demotes the whole batch to singles rather than rendering a batch
        // that cannot be claimed as one.
        if (members.length !== b.orderIds.length) continue;
        if (members.length < 2) continue;
        if (!members.every(o => o.geo && o.status === "pending")) continue;
        members.forEach(o => batched.add(o.id));
        items.push({ kind: "batch", batchId: b.id, ...planItem(members, origin, now, cfg) });
    }

    for (const o of orders) {
        if (batched.has(o.id)) continue;
        if (o.status !== "pending") continue;
        if (!o.geo) continue;
        items.push({ kind: "single", batchId: null, ...planItem([o], origin, now, cfg) });
    }

    items.sort((a, b) =>
        (a.score - b.score) || a.stopIds[0].localeCompare(b.stopIds[0]));

    const unlocated = orders
        .filter(o => o.status === "pending" && !o.geo)
        .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
        .map(o => o.id);

    return { items, unlocated };
}

module.exports = {
    haversineKm, centroid, waitMinutes, ageBonusKm,
    canJoin, isBatchAcceptingJoins,
    planBatch, planItem, planRoute,
};
