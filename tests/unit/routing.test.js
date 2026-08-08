// ============================================================================
// routing.test.js — the delivery batching + ranking algorithm.
//
// routing.js is pure by construction (no DB, no network, `now` is always a
// parameter), which is the entire reason this file can test the real
// algorithm rather than a mock of it.
// ============================================================================

const test = require("node:test");
const assert = require("node:assert");
const routing = require("../../src/server/routing");

const CFG = {
    enabled: true, maxStops: 3, groupRadiusM: 800, batchWindowMinutes: 10,
    ageGraceMinutes: 30, agePriorityKmPerMinute: 0.5, batchBonusKm: 1.5,
    originLat: null, originLon: null,
};

const NOW = new Date("2026-08-08T18:00:00.000Z");
const RESTAURANT = { lat: 50.4600, lon: 13.4100 };

// ~111.32 km per degree of latitude at the equator; longitude is scaled by
// cos(lat). These helpers build points a known number of metres apart so the
// distance assertions below are checkable by hand.
function north(base, metres) {
    return { lat: base.lat + metres / 111320, lon: base.lon };
}
function east(base, metres) {
    return { lat: base.lat, lon: base.lon + metres / (111320 * Math.cos(base.lat * Math.PI / 180)) };
}

function order(id, geo, extra = {}) {
    return {
        id, geo, createdAt: NOW.toISOString(), status: "pending",
        kitchenStatus: "pending", geoStatus: geo ? "ok" : "failed",
        batchId: null, ...extra,
    };
}

function minutesAgo(n) {
    return new Date(NOW.getTime() - n * 60000).toISOString();
}

// ── haversineKm ──────────────────────────────────────────────────────────

test("haversineKm measures a known north-south offset", () => {
    const d = routing.haversineKm(RESTAURANT, north(RESTAURANT, 1000));
    assert.ok(Math.abs(d - 1.0) < 0.01, `expected ~1 km, got ${d}`);
});

test("haversineKm is symmetric and zero for identical points", () => {
    const a = RESTAURANT, b = east(RESTAURANT, 500);
    assert.ok(Math.abs(routing.haversineKm(a, b) - routing.haversineKm(b, a)) < 1e-12);
    assert.strictEqual(routing.haversineKm(a, a), 0);
});

test("haversineKm matches a known long-distance pair (Prague-Brno ~184 km)", () => {
    const d = routing.haversineKm({ lat: 50.0755, lon: 14.4378 }, { lat: 49.1951, lon: 16.6068 });
    assert.ok(d > 180 && d < 188, `expected ~184 km, got ${d}`);
});

// ── canJoin: complete linkage ────────────────────────────────────────────

test("canJoin admits a candidate inside the radius of the only member", () => {
    const a = order("a", RESTAURANT);
    assert.strictEqual(routing.canJoin([a], order("b", east(RESTAURANT, 700)), CFG), true);
});

test("canJoin rejects a candidate outside the radius", () => {
    const a = order("a", RESTAURANT);
    assert.strictEqual(routing.canJoin([a], order("b", east(RESTAURANT, 900)), CFG), false);
});

test("canJoin is COMPLETE linkage, not single linkage — no chaining", () => {
    // a --700m--> b --700m--> c, but a to c is 1400m, over the 800m radius.
    // Single-link clustering would admit c. Complete linkage must not: the
    // promise is that NO TWO stops in a batch are further apart than the
    // configured radius.
    const a = order("a", RESTAURANT);
    const b = order("b", east(RESTAURANT, 700));
    const c = order("c", east(RESTAURANT, 1400));
    assert.strictEqual(routing.canJoin([a], b, CFG), true);
    assert.strictEqual(routing.canJoin([a, b], c, CFG), false);
});

test("canJoin refuses once the batch is full", () => {
    const full = [
        order("a", RESTAURANT),
        order("b", east(RESTAURANT, 100)),
        order("c", east(RESTAURANT, 200)),
    ];
    assert.strictEqual(full.length, CFG.maxStops);
    assert.strictEqual(routing.canJoin(full, order("d", east(RESTAURANT, 300)), CFG), false);
});

test("canJoin refuses an ungeocoded candidate, an empty batch, and a duplicate", () => {
    const a = order("a", RESTAURANT);
    assert.strictEqual(routing.canJoin([a], order("b", null), CFG), false);
    assert.strictEqual(routing.canJoin([], order("b", RESTAURANT), CFG), false);
    assert.strictEqual(routing.canJoin([a], a, CFG), false);
});

// ── isBatchAcceptingJoins: the sealing rule ──────────────────────────────

test("a fresh, unstarted batch accepts joins", () => {
    assert.strictEqual(routing.isBatchAcceptingJoins([order("a", RESTAURANT)], NOW, CFG), true);
});

test("a batch stops accepting joins once ANY member is cooked", () => {
    const members = [
        order("a", RESTAURANT, { kitchenStatus: "completed" }),
        order("b", east(RESTAURANT, 100)),
    ];
    assert.strictEqual(routing.isBatchAcceptingJoins(members, NOW, CFG), false);
});

test("a batch stops accepting joins after the window elapses", () => {
    const fresh = [order("a", RESTAURANT, { createdAt: minutesAgo(9) })];
    const stale = [order("a", RESTAURANT, { createdAt: minutesAgo(11) })];
    assert.strictEqual(routing.isBatchAcceptingJoins(fresh, NOW, CFG), true);
    assert.strictEqual(routing.isBatchAcceptingJoins(stale, NOW, CFG), false);
});

test("the window is measured from the OLDEST member, not the newest", () => {
    // This is what protects the order that has already been waiting: a batch
    // formed at 18:09 around an 18:00 order must seal at 18:10, not 18:19.
    const members = [
        order("old", RESTAURANT, { createdAt: minutesAgo(11) }),
        order("new", east(RESTAURANT, 100), { createdAt: minutesAgo(1) }),
    ];
    assert.strictEqual(routing.isBatchAcceptingJoins(members, NOW, CFG), false);
});

test("a claimed member stops the batch accepting joins", () => {
    const members = [order("a", RESTAURANT, { status: "claimed" })];
    assert.strictEqual(routing.isBatchAcceptingJoins(members, NOW, CFG), false);
});

// ── planBatch: exact stop ordering ───────────────────────────────────────

test("planBatch returns the provably optimal stop order", () => {
    // Independent exhaustive checker: try every permutation, confirm the one
    // planBatch picked is not beatable.
    const stops = [
        order("far", east(RESTAURANT, 3000)),
        order("near", east(RESTAURANT, 500)),
        order("mid", east(RESTAURANT, 1500)),
    ];
    const result = routing.planBatch(stops, RESTAURANT);

    function totalFor(ids) {
        const byId = new Map(stops.map(s => [s.id, s]));
        let total = routing.haversineKm(RESTAURANT, byId.get(ids[0]).geo);
        for (let i = 1; i < ids.length; i++) {
            total += routing.haversineKm(byId.get(ids[i - 1]).geo, byId.get(ids[i]).geo);
        }
        return total;
    }
    function permute(arr) {
        if (arr.length <= 1) return [arr];
        const out = [];
        for (let i = 0; i < arr.length; i++) {
            for (const p of permute(arr.slice(0, i).concat(arr.slice(i + 1)))) out.push([arr[i], ...p]);
        }
        return out;
    }

    const chosen = totalFor(result.stopIds);
    for (const perm of permute(stops.map(s => s.id))) {
        assert.ok(chosen <= totalFor(perm) + 1e-9,
            `planBatch chose ${result.stopIds} (${chosen}) but ${perm} (${totalFor(perm)}) is shorter`);
    }
    assert.deepStrictEqual(result.stopIds, ["near", "mid", "far"]);
});

test("planBatch splits distToFirstKm from routeKm", () => {
    const stops = [order("a", east(RESTAURANT, 500)), order("b", east(RESTAURANT, 900))];
    const r = routing.planBatch(stops, RESTAURANT);
    assert.ok(Math.abs(r.distToFirstKm - 0.5) < 0.01, `distToFirst ${r.distToFirstKm}`);
    assert.ok(Math.abs(r.routeKm - 0.4) < 0.01, `routeKm ${r.routeKm}`);
});

test("planBatch on a single stop has zero intra-batch route", () => {
    const r = routing.planBatch([order("a", east(RESTAURANT, 500))], RESTAURANT);
    assert.deepStrictEqual(r.stopIds, ["a"]);
    assert.strictEqual(r.routeKm, 0);
});

test("planBatch is deterministic when two orders sit at the same point", () => {
    const a = order("aaa", east(RESTAURANT, 500));
    const b = order("bbb", east(RESTAURANT, 500));
    assert.deepStrictEqual(
        routing.planBatch([a, b], RESTAURANT).stopIds,
        routing.planBatch([b, a], RESTAURANT).stopIds
    );
});

// ── ageBonusKm ───────────────────────────────────────────────────────────

test("ageBonusKm is zero inside the grace period and rises after it", () => {
    assert.strictEqual(routing.ageBonusKm(0, CFG), 0);
    assert.strictEqual(routing.ageBonusKm(30, CFG), 0);
    assert.strictEqual(routing.ageBonusKm(45, CFG), 7.5);
    assert.ok(routing.ageBonusKm(60, CFG) > routing.ageBonusKm(50, CFG));
});

// ── planItem: the score ──────────────────────────────────────────────────

test("a long-waiting far order outranks a fresh near one", () => {
    // The spec's worked example: 6 km / 45 min scores -1.5, beating 1 km / 5 min.
    const far = order("far", north(RESTAURANT, 6000), { createdAt: minutesAgo(45) });
    const near = order("near", north(RESTAURANT, 1000), { createdAt: minutesAgo(5) });
    const farScore = routing.planItem([far], RESTAURANT, NOW, CFG).score;
    const nearScore = routing.planItem([near], RESTAURANT, NOW, CFG).score;
    assert.ok(Math.abs(farScore - -1.5) < 0.05, `far scored ${farScore}`);
    assert.ok(farScore < nearScore);
});

test("an order still inside the grace period stays buried", () => {
    const far = order("far", north(RESTAURANT, 5000), { createdAt: minutesAgo(20) });
    const near = order("near", north(RESTAURANT, 1000), { createdAt: minutesAgo(1) });
    assert.ok(routing.planItem([far], RESTAURANT, NOW, CFG).score >
              routing.planItem([near], RESTAURANT, NOW, CFG).score);
});

test("a 2-stop batch beats an equidistant single via the batch bonus", () => {
    const single = [order("s", east(RESTAURANT, 1000))];
    const batch = [order("a", east(RESTAURANT, 1000)), order("b", east(RESTAURANT, 1400))];
    assert.ok(routing.planItem(batch, RESTAURANT, NOW, CFG).score <
              routing.planItem(single, RESTAURANT, NOW, CFG).score);
});

test("planItem reports readiness and claimability", () => {
    const members = [
        order("a", RESTAURANT, { kitchenStatus: "completed" }),
        order("b", east(RESTAURANT, 100)),
    ];
    const partial = routing.planItem(members, RESTAURANT, NOW, CFG);
    assert.strictEqual(partial.readyCount, 1);
    assert.strictEqual(partial.totalCount, 2);
    assert.strictEqual(partial.claimable, false);

    const all = routing.planItem(
        members.map(m => ({ ...m, kitchenStatus: "completed" })), RESTAURANT, NOW, CFG);
    assert.strictEqual(all.claimable, true);
});

// ── planRoute ────────────────────────────────────────────────────────────

test("planRoute ranks by score, keeps batches whole, and tails the unlocated", () => {
    const orders = [
        order("near1", east(RESTAURANT, 300), { batchId: "b1" }),
        order("near2", east(RESTAURANT, 500), { batchId: "b1" }),
        order("lone", north(RESTAURANT, 4000)),
        order("nogeo", null),
    ];
    const batches = [{ id: "b1", orderIds: ["near1", "near2"], status: "open" }];
    const plan = routing.planRoute({ orders, batches, origin: RESTAURANT, now: NOW, cfg: CFG });

    assert.strictEqual(plan.items.length, 2);
    assert.strictEqual(plan.items[0].kind, "batch");
    assert.strictEqual(plan.items[0].batchId, "b1");
    assert.deepStrictEqual(plan.items[0].stopIds.slice().sort(), ["near1", "near2"]);
    assert.strictEqual(plan.items[1].kind, "single");
    assert.deepStrictEqual(plan.unlocated, ["nogeo"]);
});

test("planRoute still returns a batch that has stopped accepting joins", () => {
    // Sealing only stops NEW members. A sealed batch is exactly what a driver
    // is supposed to take. Conflating batch.status with isBatchAcceptingJoins
    // would make finished batches vanish from the driver's list entirely.
    const orders = [
        order("a", east(RESTAURANT, 300), { batchId: "b1", createdAt: minutesAgo(45) }),
        order("b", east(RESTAURANT, 500), { batchId: "b1", createdAt: minutesAgo(44) }),
    ];
    const batches = [{ id: "b1", orderIds: ["a", "b"], status: "open" }];
    assert.strictEqual(routing.isBatchAcceptingJoins(orders, NOW, CFG), false);
    const plan = routing.planRoute({ orders, batches, origin: RESTAURANT, now: NOW, cfg: CFG });
    assert.strictEqual(plan.items.length, 1);
    assert.strictEqual(plan.items[0].kind, "batch");
});

test("planRoute omits claimed orders and dissolved batches", () => {
    const orders = [
        order("claimed", east(RESTAURANT, 300), { status: "claimed" }),
        order("d1", east(RESTAURANT, 400), { batchId: "bx" }),
        order("d2", east(RESTAURANT, 450), { batchId: "bx" }),
    ];
    const batches = [{ id: "bx", orderIds: ["d1", "d2"], status: "dissolved" }];
    const plan = routing.planRoute({ orders, batches, origin: RESTAURANT, now: NOW, cfg: CFG });
    // The dissolved batch's members fall back to singles; the claimed one is gone.
    assert.strictEqual(plan.items.length, 2);
    assert.ok(plan.items.every(i => i.kind === "single"));
    assert.ok(!plan.items.some(i => i.stopIds.includes("claimed")));
});

test("planRoute survives a batch with a dangling member id", () => {
    // Defence in depth for the DELETE /orders/:id path (spec 8.3.1).
    const orders = [order("a", east(RESTAURANT, 300), { batchId: "b1" })];
    const batches = [{ id: "b1", orderIds: ["a", "deleted"], status: "open" }];
    const plan = routing.planRoute({ orders, batches, origin: RESTAURANT, now: NOW, cfg: CFG });
    assert.strictEqual(plan.items.length, 1);
    assert.strictEqual(plan.items[0].kind, "single");
});

test("planRoute orders the unlocated tail oldest-first", () => {
    const orders = [
        order("newer", null, { createdAt: minutesAgo(5) }),
        order("older", null, { createdAt: minutesAgo(50) }),
    ];
    const plan = routing.planRoute({ orders, batches: [], origin: RESTAURANT, now: NOW, cfg: CFG });
    assert.deepStrictEqual(plan.unlocated, ["older", "newer"]);
});
