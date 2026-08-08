# Delivery Routing & Batching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rank a driver's deliveries by distance from them, and persist "batches" of nearby orders that the kitchen prepares together and a driver claims and delivers in one optimally-ordered trip.

**Architecture:** Two new self-contained server modules. `routing.js` is pure (no DB, no network, no clock — `now` is always a parameter) and holds the entire algorithm. `geocode.js` turns a free-text address into coordinates via OpenStreetMap Nominatim with an aggressive DB cache. Batch membership is computed once and persisted on the order, so kitchen, driver, and admin all see the same batches; the driver's GPS only ranks batches and sequences stops within one.

**Tech Stack:** Node (CommonJS), Express 5, better-sqlite3 via `src/server/db.js`, zod via `src/server/validation.js`, `node:test`, vanilla browser JS (no build step).

Spec: `docs/superpowers/specs/2026-08-08-delivery-routing-design.md`

## Global Constraints

- **No new npm dependencies.** Native `fetch` only, same convention as `gopay.js`.
- **`routing.js` must stay pure.** No `require("./db")`, no `fetch`, no `Date.now()` / `new Date()` without an argument. `now` is a parameter on every function that needs it.
- **`settings.js` and `validation.js` change in the SAME commit.** `settingsSchema.delivery` (validation.js:809) is `.strict()`, and `inner.js` PUTs back the whole settings object it fetched (inner.js:3835). Adding a default without its schema 400s every settings save.
- **No `await` between a read-check and its writes** in any route that claims orders. better-sqlite3 is synchronous and Node is single-threaded, so such a block is atomic against concurrent requests *only* while it contains no `await`. See `tests/unit/db-patch.test.js`'s header for the bug this prevents.
- **UI text is Czech.** Comments and identifiers in English, matching the codebase.
- **`requireFeature("delivery")` mounts FIRST** in every new route's middleware chain, before CSRF and before auth (server.js:241 explains why).
- **Tests must never reach the network.** `GEOCODE_DISABLED=1` is force-set by the harness; unit tests stub `globalThis.fetch`.
- **Node's `node --test <directory>` is broken here** (MODULE_NOT_FOUND). Always use the glob form: `npm run test:unit`, `npm run test:smoke`.
- **Vocabulary trap:** a batch's `status: "open"` means *not yet claimed or dissolved*. Whether it still accepts new members is a **separate, stricter, derived** condition — `routing.isBatchAcceptingJoins()`. A batch that has stopped accepting joins is still perfectly deliverable. Never conflate them.

## File Ownership by Wave

Tasks within a wave touch disjoint files and may run in parallel. Waves are strictly ordered.

| Wave | Task | Owns |
|---|---|---|
| 1 | 1 | `src/server/routing.js`, `tests/unit/routing.test.js` |
| 1 | 2 | `src/server/geocode.js`, `tests/unit/geocode.test.js` |
| 1 | 3 | `src/server/settings.js`, `src/server/validation.js` |
| 2 | 4 | `src/server/server.js`, `tests/helpers/harness.js`, `tests/smoke/driver-route.test.js` |
| 3 | 5 | `src/js/driver.js`, `src/css/driver-page.css`, `src/html/driver.html` |
| 3 | 6 | `src/js/kitchen.js`, `src/css/kitchen-page.css` |
| 3 | 7 | `src/js/inner.js`, `src/html/inner.html` |

---

## Shared Data Shapes

Every task refers to these. They are the contract between tasks.

```js
// A delivery order, as stored in collection "orders". Only the fields
// routing/batching care about are listed; the record has many more.
{
  id: "…", createdAt: "2026-08-08T17:00:00.000Z",
  status: "pending" | "claimed",
  kitchenStatus: "pending" | "completed",
  address: "Školní 50", psc: "43001",
  geo: { lat: 50.46, lon: 13.41, quality: "building", provider: "nominatim", at: "…" } | null,
  geoStatus: "pending" | "ok" | "failed",   // absent on pre-feature rows
  batchId: "b_…" | null,
}

// collection "delivery_batches"
{
  id: "b_…", createdAt: "…",
  orderIds: ["…", "…"],                     // always 2..maxStops, never 1
  status: "open" | "claimed" | "dissolved",
  claimedBy: null, claimedAt: null,
}

// cfg — always settings.delivery.routing
{ enabled, maxStops, groupRadiusM, batchWindowMinutes,
  ageGraceMinutes, agePriorityKmPerMinute, batchBonusKm, originLat, originLon }

// origin
{ lat: 50.46, lon: 13.41 }
```

---

## Task 1: `routing.js` — the algorithm (pure)

**Files:**
- Create: `src/server/routing.js`
- Test: `tests/unit/routing.test.js`

**Interfaces:**
- Consumes: nothing. This task has zero dependencies on any other task.
- Produces:
  ```js
  haversineKm(a, b) -> number                       // {lat,lon} pair, km
  centroid(orders) -> {lat,lon} | null
  waitMinutes(order, now) -> number
  ageBonusKm(waitMin, cfg) -> number
  canJoin(memberOrders, candidate, cfg) -> boolean
  isBatchAcceptingJoins(memberOrders, now, cfg) -> boolean
  planBatch(memberOrders, origin) -> { stopIds: string[], routeKm, distToFirstKm }
  planItem(memberOrders, origin, now, cfg)
      -> { stopIds, routeKm, distToFirstKm, score, readyCount,
           totalCount, claimable, oldestWaitMinutes }
  planRoute({ orders, batches, origin, now, cfg })
      -> { items: PlanItem[], unlocated: string[] }
  ```
  `PlanItem` = the `planItem` result plus `kind: "batch" | "single"` and `batchId: string | null`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/routing.test.js`:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm run test:unit
```

Expected: FAIL — `Cannot find module '../../src/server/routing'`.

- [ ] **Step 3: Write `src/server/routing.js`**

```js
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
            || (Math.abs(total - best.total) <= 1e-9 && stopIds.join(" ") < best.stopIds.join(" "));
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
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npm run test:unit
```

Expected: PASS, all routing tests green, no regressions in the existing unit suite.

- [ ] **Step 5: Commit**

```bash
git add src/server/routing.js tests/unit/routing.test.js
git commit -m "feat(routing): pure batching + ranking algorithm"
```

---

## Task 2: `geocode.js` — address to coordinates, cached

**Files:**
- Create: `src/server/geocode.js`
- Test: `tests/unit/geocode.test.js`

**Interfaces:**
- Consumes: `src/server/db.js` (`get`, `set`). Nothing from Task 1 or 3.
- Produces:
  ```js
  isEnabled() -> boolean
  normalizeQuery(address, psc) -> string
  cacheKey(query) -> string                        // sha1 hex
  geocode(address, psc, opts?) -> Promise<{lat, lon, quality, provider, at} | null>
  GEOCACHE_COLLECTION -> "geocache"
  ```
  `opts` is `{ userAgent }`. `geocode` never throws — a failure is `null`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/geocode.test.js`:

```js
// ============================================================================
// geocode.test.js — the Nominatim client's cache, negative cache, and rate
// limiter. `globalThis.fetch` is stubbed throughout: this file must never
// touch the network, and a test run must never appear in OSM's logs.
// ============================================================================

const test = require("node:test");
const assert = require("node:assert");
const os = require("os");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

// db.js resolves DB_PATH at require time, so this has to be set first —
// same pattern as tests/unit/db-patch.test.js.
const TMP_DB = path.join(os.tmpdir(), `geocode-${process.pid}-${crypto.randomBytes(6).toString("hex")}.db`);
process.env.SQLITE_PATH = TMP_DB;
// Keep the serial queue's spacing testable without 1.1s real waits.
process.env.GEOCODE_MIN_SPACING_MS = "20";
delete process.env.GEOCODE_DISABLED;

const db = require("../../src/server/db");
const geocode = require("../../src/server/geocode");

test.after(() => {
    try { db.getDb().close(); } catch { /* already closed */ }
    for (const suffix of ["", "-wal", "-shm"]) {
        try { fs.unlinkSync(TMP_DB + suffix); } catch { /* never existed */ }
    }
});

const realFetch = globalThis.fetch;
function stubFetch(handler) {
    const calls = [];
    globalThis.fetch = async (url, opts) => {
        calls.push({ url: String(url), opts, at: Date.now() });
        return handler(String(url), opts, calls.length);
    };
    return calls;
}
function restoreFetch() { globalThis.fetch = realFetch; }

function hit(lat, lon) {
    return { ok: true, json: async () => ([{ lat: String(lat), lon: String(lon), addresstype: "building" }]) };
}
function miss() {
    return { ok: true, json: async () => ([]) };
}

function clearCache() {
    for (const rec of db.list(geocode.GEOCACHE_COLLECTION)) {
        db.remove(geocode.GEOCACHE_COLLECTION, rec.id);
    }
}

test("normalizeQuery folds case, diacritics and whitespace", () => {
    const a = geocode.normalizeQuery("  Školní   50 ", "430 01");
    const b = geocode.normalizeQuery("skolni 50", "43001");
    assert.strictEqual(a, b);
    assert.ok(a.includes("43001"));
});

test("cacheKey is stable and differs for different queries", () => {
    assert.strictEqual(geocode.cacheKey("a b"), geocode.cacheKey("a b"));
    assert.notStrictEqual(geocode.cacheKey("a b"), geocode.cacheKey("a c"));
});

test("a successful lookup is cached — the second call makes no request", async () => {
    clearCache();
    const calls = stubFetch(() => hit(50.46, 13.41));
    try {
        const first = await geocode.geocode("Školní 50", "43001");
        assert.ok(Math.abs(first.lat - 50.46) < 1e-9);
        assert.ok(Math.abs(first.lon - 13.41) < 1e-9);
        assert.strictEqual(first.provider, "nominatim");
        assert.strictEqual(calls.length, 1);

        const second = await geocode.geocode("  ŠKOLNÍ  50 ", "430 01");
        assert.ok(Math.abs(second.lat - 50.46) < 1e-9);
        assert.strictEqual(calls.length, 1, "normalized-equal query must hit the cache");
    } finally { restoreFetch(); }
});

test("a miss is negatively cached and not retried inside the retry floor", async () => {
    clearCache();
    const calls = stubFetch(() => miss());
    try {
        assert.strictEqual(await geocode.geocode("Nikde 999", "43001"), null);
        assert.strictEqual(calls.length, 1);
        assert.strictEqual(await geocode.geocode("Nikde 999", "43001"), null);
        assert.strictEqual(calls.length, 1, "must not re-query inside the 1h retry floor");
    } finally { restoreFetch(); }
});

test("a miss IS retried once the retry floor has elapsed", async () => {
    clearCache();
    const calls = stubFetch(() => miss());
    try {
        await geocode.geocode("Nikde 998", "43001");
        assert.strictEqual(calls.length, 1);
        // Age the cache record past the 1h floor.
        const key = geocode.cacheKey(geocode.normalizeQuery("Nikde 998", "43001"));
        const rec = db.get(geocode.GEOCACHE_COLLECTION, key);
        rec.at = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
        db.set(geocode.GEOCACHE_COLLECTION, key, rec);

        await geocode.geocode("Nikde 998", "43001");
        assert.strictEqual(calls.length, 2);
    } finally { restoreFetch(); }
});

test("a permanently bad address stops being retried after 5 attempts", async () => {
    clearCache();
    const calls = stubFetch(() => miss());
    try {
        const key = geocode.cacheKey(geocode.normalizeQuery("Nikde 997", "43001"));
        for (let i = 0; i < 6; i++) {
            await geocode.geocode("Nikde 997", "43001");
            const rec = db.get(geocode.GEOCACHE_COLLECTION, key);
            if (rec) { rec.at = new Date(Date.now() - 2 * 3600 * 1000).toISOString(); db.set(geocode.GEOCACHE_COLLECTION, key, rec); }
        }
        assert.strictEqual(calls.length, 5, `expected the 5-attempt ceiling, got ${calls.length}`);
    } finally { restoreFetch(); }
});

test("a non-ok HTTP response is a failure, not a crash", async () => {
    clearCache();
    stubFetch(() => ({ ok: false, status: 429, json: async () => ({}) }));
    try {
        assert.strictEqual(await geocode.geocode("Cokoliv 1", "43001"), null);
    } finally { restoreFetch(); }
});

test("a thrown fetch is a failure, not a crash", async () => {
    clearCache();
    stubFetch(() => { throw new Error("ENOTFOUND"); });
    try {
        assert.strictEqual(await geocode.geocode("Cokoliv 2", "43001"), null);
    } finally { restoreFetch(); }
});

test("requests are serialized with at least the configured spacing", async () => {
    clearCache();
    const calls = stubFetch(() => hit(50, 14));
    try {
        await Promise.all([
            geocode.geocode("Ulice 1", "43001"),
            geocode.geocode("Ulice 2", "43001"),
            geocode.geocode("Ulice 3", "43001"),
        ]);
        assert.strictEqual(calls.length, 3);
        for (let i = 1; i < calls.length; i++) {
            const gap = calls[i].at - calls[i - 1].at;
            assert.ok(gap >= 15, `calls ${i - 1}->${i} only ${gap}ms apart`);
        }
    } finally { restoreFetch(); }
});

test("the request carries a descriptive User-Agent and restricts to CZ", async () => {
    clearCache();
    const calls = stubFetch(() => hit(50, 14));
    try {
        await geocode.geocode("Ulice 9", "43001", { userAgent: "Testovaci restaurace (test@example.com)" });
        assert.match(calls[0].url, /countrycodes=cz/);
        assert.strictEqual(calls[0].opts.headers["User-Agent"], "Testovaci restaurace (test@example.com)");
    } finally { restoreFetch(); }
});

test("GEOCODE_DISABLED short-circuits without touching fetch or the cache", async () => {
    clearCache();
    process.env.GEOCODE_DISABLED = "1";
    const calls = stubFetch(() => hit(50, 14));
    try {
        assert.strictEqual(geocode.isEnabled(), false);
        assert.strictEqual(await geocode.geocode("Školní 50", "43001"), null);
        assert.strictEqual(calls.length, 0);
    } finally {
        restoreFetch();
        delete process.env.GEOCODE_DISABLED;
    }
});

test("an empty address never becomes a request", async () => {
    clearCache();
    const calls = stubFetch(() => hit(50, 14));
    try {
        assert.strictEqual(await geocode.geocode("", ""), null);
        assert.strictEqual(calls.length, 0);
    } finally { restoreFetch(); }
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm run test:unit
```

Expected: FAIL — `Cannot find module '../../src/server/geocode'`.

- [ ] **Step 3: Write `src/server/geocode.js`**

```js
// ════════════════════════════════════════════════════════════════════════
// geocode.js — free-text address -> {lat, lon}, via OpenStreetMap
// Nominatim, cached hard in SQLite.
//
// Self-contained black box, same convention as validation.js/settings.js:
// depends only on db.js, and native fetch (no SDK — same choice gopay.js
// made). Never throws; a failure is `null`.
//
// THREE THINGS HERE ARE LOAD-BEARING, not defensive padding:
//
//  1. NOMINATIM'S USAGE POLICY IS BINDING. It requires a descriptive
//     User-Agent identifying the application and a hard maximum of ONE
//     request per second. Both are implemented below and neither is
//     optional — ignoring them gets the restaurant's IP blocked, and the
//     symptom would be "batching quietly stopped working".
//
//  2. NEGATIVE CACHING. Without it a mistyped address is re-queried on
//     every single board event, forever. Misses are cached, retried no
//     sooner than an hour later, and abandoned after 5 attempts.
//
//  3. THIS IS NEVER ON THE CHECKOUT PATH. POST /orders saves the order and
//     returns; geocoding happens afterwards, in the background. A geocoder
//     outage must never cost the restaurant a sale (spec §14).
//
// Privacy: only the street address and PSČ are ever sent — never a name,
// phone, or e-mail. See spec §17; a street address is still personal data
// under GDPR and the privacy page may need a disclosure line.
// ════════════════════════════════════════════════════════════════════════

const crypto = require("crypto");
const db = require("./db");

const GEOCACHE_COLLECTION = "geocache";
const ENDPOINT = "https://nominatim.openstreetmap.org/search";

// Nominatim's policy floor is 1 req/s. 1100 ms leaves headroom for clock
// jitter. Overridable ONLY so the unit test can run in milliseconds.
const MIN_SPACING_MS = Number(process.env.GEOCODE_MIN_SPACING_MS || 1100);
const REQUEST_TIMEOUT_MS = 8000;
const RETRY_FLOOR_MS = 60 * 60 * 1000; // 1 hour
const MAX_ATTEMPTS = 5;

const DEFAULT_USER_AGENT = "restaurace-app/1.0 (delivery routing)";

function isEnabled() {
    return process.env.GEOCODE_DISABLED !== "1";
}

// Case-folded, diacritic-stripped, whitespace-collapsed. Two addresses that
// differ only in how the customer typed them must produce ONE cache entry —
// otherwise the cache barely hits and the rate limiter becomes the
// bottleneck on a busy night.
function normalizeQuery(address, psc) {
    return `${address || ""} ${psc || ""}`
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

function cacheKey(query) {
    return crypto.createHash("sha1").update(query).digest("hex");
}

// ── Rate limiter ─────────────────────────────────────────────────────────
// One global serial queue, not one per caller: the policy limit is per
// application, so parallel callers must still be spaced apart.
let queueTail = Promise.resolve();
let lastCallAt = 0;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function enqueue(fn) {
    const run = queueTail.then(async () => {
        const wait = MIN_SPACING_MS - (Date.now() - lastCallAt);
        if (wait > 0) await sleep(wait);
        lastCallAt = Date.now();
        return fn();
    });
    // Swallow rejections on the CHAIN only — the returned promise still
    // rejects for the caller. Without this one failure poisons the queue
    // and every later lookup rejects forever.
    queueTail = run.then(() => {}, () => {});
    return run;
}

// ── Provider ─────────────────────────────────────────────────────────────

async function queryNominatim(query, userAgent) {
    const url = `${ENDPOINT}?q=${encodeURIComponent(query)}&format=jsonv2&limit=1&countrycodes=cz`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            headers: { "User-Agent": userAgent, "Accept-Language": "cs" },
            signal: controller.signal,
        });
        if (!res.ok) return null;
        const data = await res.json();
        if (!Array.isArray(data) || !data.length) return null;
        const lat = parseFloat(data[0].lat);
        const lon = parseFloat(data[0].lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
        return { lat, lon, quality: data[0].addresstype || data[0].type || "" };
    } catch {
        // Timeout, DNS failure, malformed JSON — all the same to the caller.
        return null;
    } finally {
        clearTimeout(timer);
    }
}

// ── Public entry point ───────────────────────────────────────────────────

async function geocode(address, psc, opts = {}) {
    if (!isEnabled()) return null;

    const query = normalizeQuery(address, psc);
    if (!query) return null;

    const key = cacheKey(query);
    const cached = db.get(GEOCACHE_COLLECTION, key);

    if (cached && Number.isFinite(cached.lat) && Number.isFinite(cached.lon)) {
        return { lat: cached.lat, lon: cached.lon, quality: cached.quality || "", provider: cached.provider || "nominatim", at: cached.at };
    }

    if (cached) {
        const failCount = cached.failCount || 0;
        if (failCount >= MAX_ATTEMPTS) return null;
        const age = Date.now() - new Date(cached.at).getTime();
        if (Number.isFinite(age) && age < RETRY_FLOOR_MS) return null;
    }

    const userAgent = opts.userAgent || DEFAULT_USER_AGENT;
    // Nominatim wants a country hint in the query text too, not just the
    // countrycodes filter — CZ street names are not globally unique.
    const found = await enqueue(() => queryNominatim(`${address || ""}, ${psc || ""}, Czechia`, userAgent));
    const at = new Date().toISOString();

    if (!found) {
        db.set(GEOCACHE_COLLECTION, key, {
            id: key, query, lat: null, lon: null, quality: "", provider: "nominatim",
            at, failCount: (cached && cached.failCount ? cached.failCount : 0) + 1,
        });
        return null;
    }

    const record = { id: key, query, lat: found.lat, lon: found.lon, quality: found.quality, provider: "nominatim", at, failCount: 0 };
    db.set(GEOCACHE_COLLECTION, key, record);
    return { lat: found.lat, lon: found.lon, quality: found.quality, provider: "nominatim", at };
}

module.exports = { isEnabled, normalizeQuery, cacheKey, geocode, GEOCACHE_COLLECTION };
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npm run test:unit
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/geocode.js tests/unit/geocode.test.js
git commit -m "feat(geocode): cached Nominatim client with negative caching and rate limit"
```

---

## Task 3: settings defaults + all zod schemas

**Files:**
- Modify: `src/server/settings.js` (the `delivery` block inside `buildDefaultSettings()`, ~line 80-92)
- Modify: `src/server/validation.js` (near `pscWhitelistSchema` ~line 726, and the `delivery` object at ~line 809)

**Interfaces:**
- Consumes: nothing.
- Produces: `settings.delivery.routing` (shape in "Shared Data Shapes" above), plus two request schemas exported from validation.js: `driverRouteSchema`, `claimBatchSchema`.

> **This task owns ALL of validation.js.** Task 4 needs `V.driverRouteSchema`
> and `V.claimBatchSchema` but must not edit validation.js itself — they are
> defined here so the two tasks never collide on the file.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/settings.test.js` (the existing file — find the settings-shape describe/test block and add alongside it):

```js
test("delivery.routing has the documented defaults", () => {
    const s = settings.getSettings();
    assert.deepStrictEqual(s.delivery.routing, {
        enabled: true,
        maxStops: 3,
        groupRadiusM: 800,
        batchWindowMinutes: 10,
        ageGraceMinutes: 30,
        agePriorityKmPerMinute: 0.5,
        batchBonusKm: 1.5,
        originLat: null,
        originLon: null,
    });
});

test("maxStops is capped at 6 — planBatch brute-forces permutations", () => {
    const V = require("../../src/server/validation");
    const base = settings.getSettings();
    const withStops = n => ({ ...base, delivery: { ...base.delivery, routing: { ...base.delivery.routing, maxStops: n } } });
    assert.strictEqual(V.settingsSchema.safeParse(withStops(6)).success, true);
    assert.strictEqual(V.settingsSchema.safeParse(withStops(7)).success, false);
    assert.strictEqual(V.settingsSchema.safeParse(withStops(1)).success, false);
});

test("a full settings round-trip survives the strict schema", () => {
    // The regression this guards: inner.js PUTs back the WHOLE settings
    // object it fetched. A default added without a matching schema entry
    // makes every settings save 400 the moment an admin opens the panel.
    const V = require("../../src/server/validation");
    const result = V.settingsSchema.safeParse(settings.getSettings());
    assert.strictEqual(result.success, true,
        result.success ? "" : JSON.stringify(result.error.issues, null, 2));
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm run test:unit
```

Expected: FAIL — `delivery.routing` is `undefined`.

- [ ] **Step 3: Add the defaults in `src/server/settings.js`**

Inside `buildDefaultSettings()`, in the `delivery` object, after `etaMinutes: 60,`:

```js
            etaMinutes: 60,
            // Distance-ranked driver list + batching of nearby orders —
            // docs/superpowers/specs/2026-08-08-delivery-routing-design.md.
            //
            // Every weight below is in KILOMETRES so they can be added and
            // subtracted in one score (spec §5). `enabled: false` turns off
            // geocoding entirely and leaves the driver list as it was
            // before this feature — that is also the opt-out for an owner
            // who does not want addresses sent to OpenStreetMap (§17).
            routing: {
                enabled: true,
                // Capped at 6 by routingSchema: planBatch() brute-forces
                // every permutation to get a provably optimal stop order.
                maxStops: 3,
                // No two stops in a batch are ever further apart than this.
                groupRadiusM: 800,
                // How long a batch keeps accepting new members, measured
                // from its OLDEST order.
                batchWindowMinutes: 10,
                // Waiting time below this earns no priority at all.
                ageGraceMinutes: 30,
                // ...and above it, each minute is worth this many km of
                // head start. 0.5 => a 45-min-old order behaves as if it
                // were 7.5 km closer than it is.
                agePriorityKmPerMinute: 0.5,
                // What one saved return trip is worth, per extra stop.
                batchBonusKm: 1.5,
                // Manual override for the restaurant's own coordinates.
                // null => geocoded from business.address on demand.
                originLat: null,
                originLon: null,
            },
```

- [ ] **Step 4: Add the schemas in `src/server/validation.js`**

Immediately after `pscWhitelistSchema` (~line 726), add:

```js
// Delivery routing/batching (spec 2026-08-08 §13). MUST stay in lockstep
// with settings.js's DEFAULT_SETTINGS.delivery.routing — `delivery` below is
// .strict(), so a default without a schema entry here makes PUT /settings
// 400 the moment the admin panel round-trips the object it just fetched.
const routingSchema = z.object({
    enabled: z.coerce.boolean(),
    // Hard ceiling of 6, NOT a taste call: routing.js's planBatch() brute-
    // forces all permutations for a provably optimal stop order. 6 stops is
    // 720 permutations (microseconds); 10 would be 3.6 million.
    maxStops: boundedInt(2, 6, "Max. zastávek ve skupině"),
    groupRadiusM: boundedInt(100, 5000, "Poloměr skupiny (m)"),
    batchWindowMinutes: boundedInt(1, 60, "Okno pro slučování (min)"),
    ageGraceMinutes: boundedInt(0, 240, "Tolerance čekání (min)"),
    agePriorityKmPerMinute: nonNegNumber(5, "Váha čekání"),
    batchBonusKm: nonNegNumber(20, "Bonus za sloučení"),
    originLat: z.number().min(-90).max(90).nullable(),
    originLon: z.number().min(-180).max(180).nullable(),
}).strict();

// POST /api/driver/route — the driver's live position. Sent in the BODY, not
// a query string: it is location data, and query strings end up in access
// logs and proxy caches.
const driverRouteSchema = z.object({
    lat: z.number().min(-90).max(90).nullish(),
    lon: z.number().min(-180).max(180).nullish(),
}).strict();

// POST /api/orders/claim-batch — a batch id, deliberately NOT a list of
// order ids. The server owns batch membership, so a client cannot ask to
// claim an arbitrary set of orders by calling it a "batch".
const claimBatchSchema = z.object({
    batchId: reqStr(80, "ID skupiny"),
}).strict();
```

Then add `routing: routingSchema,` to the `delivery` object (~line 809), after `etaMinutes`:

```js
        etaMinutes: boundedInt(1, 600, "Doba doručení (min)"),
        routing: routingSchema,
    }).strict(),
```

Finally add all three to `module.exports` alongside the other exported schemas:

```js
    driverRouteSchema,
    claimBatchSchema,
```

(`routingSchema` is used only inside `settingsSchema` and does not need exporting.)

- [ ] **Step 5: Run the tests to verify they pass**

```bash
npm run test:unit
```

Expected: PASS — including the pre-existing 48 settings cases, unchanged.

- [ ] **Step 6: Commit — both files together, this is not optional**

```bash
git add src/server/settings.js src/server/validation.js tests/unit/settings.test.js
git commit -m "feat(routing): settings defaults and strict schemas for delivery routing"
```

---

## Task 4: server.js wiring

**Files:**
- Modify: `src/server/server.js`
- Modify: `tests/helpers/harness.js` (env blanking, ~line 169-181)
- Test: `tests/smoke/driver-route.test.js`

**Interfaces:**
- Consumes: everything from Tasks 1, 2, 3 — `routing.planRoute/canJoin/isBatchAcceptingJoins/centroid/haversineKm`, `geocode.geocode/isEnabled`, `settings.delivery.routing`, `V.driverRouteSchema`, `V.claimBatchSchema`.
- Produces: `POST /api/driver/route`, `POST /api/orders/claim-batch`, `POST /api/delivery-batches/:id/split`; `order.geo` / `order.geoStatus` / `order.batchId`; collection `delivery_batches`.

- [ ] **Step 1: Add the collection and the requires**

In the `collections` block (~line 43-70), after `orders: "orders",`:

```js
        orders: "orders",
        // Persisted groups of nearby delivery orders (spec 2026-08-08 §8.1).
        // Membership is computed ONCE and stored, not recomputed per driver
        // request — the kitchen has to be able to prepare a batch together,
        // which a per-driver recomputation could never support.
        deliveryBatches: "delivery_batches",
```

With the other module requires (~line 193-212):

```js
const routing = require("./routing"); // pure batching/ranking algorithm — see its header
const geocode = require("./geocode"); // address -> coordinates, cached; never on the checkout path
```

- [ ] **Step 2: Add the helper block**

Place these near the other delivery helpers, above the `POST ${api}/orders` route (~line 3679):

```js
// ── DELIVERY ROUTING / BATCHING ──────────────────────────────────────────
// See docs/superpowers/specs/2026-08-08-delivery-routing-design.md.
// The algorithm itself is in routing.js (pure); everything here is the
// persistence and I/O around it.

function routingCfg() {
    return settingsStore.getSettings().delivery.routing;
}

// User-Agent for Nominatim, built from the restaurant's own identity so a
// blocked instance is traceable to a real business, as the usage policy
// requires.
function geocoderUserAgent() {
    const biz = settingsStore.getSettings().business || {};
    const contact = biz.email || biz.phone || "";
    return `${biz.name || "restaurace"} restaurace-app/1.0${contact ? ` (${contact})` : ""}`;
}

// The restaurant's own coordinates: manual override, else geocoded from
// business.address. Cached in module scope for the process lifetime — the
// restaurant does not move.
let cachedRestaurantOrigin = null;

async function restaurantOrigin() {
    const cfg = routingCfg();
    if (Number.isFinite(cfg.originLat) && Number.isFinite(cfg.originLon)) {
        return { lat: cfg.originLat, lon: cfg.originLon };
    }
    if (cachedRestaurantOrigin) return cachedRestaurantOrigin;
    const biz = settingsStore.getSettings().business || {};
    const found = await geocode.geocode(biz.address, "", { userAgent: geocoderUserAgent() });
    if (found) cachedRestaurantOrigin = { lat: found.lat, lon: found.lon };
    return cachedRestaurantOrigin;
}

// Attach a freshly-geocoded order to a batch. SYNCHRONOUS AND await-FREE by
// design: better-sqlite3 is synchronous and Node is single-threaded, so this
// whole read-decide-write block cannot interleave with another request.
// Adding an `await` here would reintroduce exactly the race that
// tests/unit/db-patch.test.js documents.
function attachToBatch(orderId) {
    const cfg = routingCfg();
    if (!cfg.enabled) return;

    const order = db.get(COL.orders, orderId);
    if (!order || order.batchId || order.geoStatus !== "ok" || order.status !== "pending") return;

    const now = new Date();
    const allOrders = db.list(COL.orders);
    const byId = new Map(allOrders.map(o => [o.id, o]));

    // 1) An existing open batch that would accept it. When more than one
    //    would, the nearest centroid wins; ties break on batch id so
    //    formation is deterministic and testable (spec §8.3).
    const candidates = [];
    for (const batch of db.list(COL.deliveryBatches)) {
        if (batch.status !== "open") continue;
        const members = batch.orderIds.map(id => byId.get(id)).filter(Boolean);
        if (members.length !== batch.orderIds.length) continue;
        if (!routing.isBatchAcceptingJoins(members, now, cfg)) continue;
        if (!routing.canJoin(members, order, cfg)) continue;
        const c = routing.centroid(members);
        candidates.push({ batch, dist: routing.haversineKm(c, order.geo) });
    }
    if (candidates.length) {
        candidates.sort((a, b) => (a.dist - b.dist) || a.batch.id.localeCompare(b.batch.id));
        const target = candidates[0].batch;
        target.orderIds = [...target.orderIds, orderId];
        db.set(COL.deliveryBatches, target.id, target);
        db.patch(COL.orders, orderId, { batchId: target.id });
        return;
    }

    // 2) Otherwise a lone order nearby, which brings a new batch into
    //    existence. Batches of one are never created — a lone order is just
    //    a lone order (spec §8.1).
    const partners = allOrders
        .filter(o => o.id !== orderId
            && o.status === "pending"
            && !o.batchId
            && o.geoStatus === "ok"
            && routing.isBatchAcceptingJoins([o], now, cfg)
            && routing.canJoin([o], order, cfg))
        .map(o => ({ order: o, dist: routing.haversineKm(o.geo, order.geo) }));
    if (!partners.length) return;
    partners.sort((a, b) => (a.dist - b.dist) || a.order.id.localeCompare(b.order.id));

    const partner = partners[0].order;
    const batchId = `b_${crypto.randomBytes(9).toString("hex")}`;
    db.set(COL.deliveryBatches, batchId, {
        id: batchId,
        createdAt: now.toISOString(),
        orderIds: [partner.id, orderId],
        status: "open",
        claimedBy: null,
        claimedAt: null,
    });
    db.patch(COL.orders, partner.id, { batchId });
    db.patch(COL.orders, orderId, { batchId });
}

// Remove an order from its batch, dissolving the batch if that would leave
// it with fewer than two members (spec §8.3.1). Without this, DELETE
// /orders/:id leaves a dangling member id behind.
function detachFromBatch(orderId) {
    const order = db.get(COL.orders, orderId);
    const batchId = order && order.batchId;
    if (!batchId) return;
    const batch = db.get(COL.deliveryBatches, batchId);
    db.patch(COL.orders, orderId, { batchId: null });
    if (!batch) return;
    const remaining = batch.orderIds.filter(id => id !== orderId);
    if (remaining.length < 2) {
        batch.orderIds = remaining;
        batch.status = "dissolved";
        db.set(COL.deliveryBatches, batchId, batch);
        for (const id of remaining) db.patch(COL.orders, id, { batchId: null });
        return;
    }
    batch.orderIds = remaining;
    db.set(COL.deliveryBatches, batchId, batch);
}

// Geocode in the BACKGROUND, after the order is already saved and the
// customer already has their confirmation. A geocoder outage, rate-limit, or
// unparseable address can never block or slow a sale (spec §14) — the worst
// case is one order sitting in the driver's "poloha neznámá" tail.
function scheduleGeocode(orderId) {
    const cfg = routingCfg();
    if (!cfg.enabled || !geocode.isEnabled()) return;
    setImmediate(async () => {
        try {
            const order = db.get(COL.orders, orderId);
            if (!order || order.geoStatus === "ok") return;
            const found = await geocode.geocode(order.address, order.psc, { userAgent: geocoderUserAgent() });
            if (!found) {
                db.patch(COL.orders, orderId, { geo: null, geoStatus: "failed" });
            } else {
                db.patch(COL.orders, orderId, { geo: found, geoStatus: "ok" });
                attachToBatch(orderId);
            }
            broadcastBoardEvent();
        } catch (e) {
            console.error("Background geocode failed:", e);
        }
    });
}
```

- [ ] **Step 3: Hook order creation, deletion, and backfill**

In `POST ${api}/orders`, in the order record literal (~line 3720-3745), add three fields next to `claimedAt: null,`:

```js
            claimedAt: null,
            // Delivery routing (spec 2026-08-08). Filled in by
            // scheduleGeocode() after this response is already sent.
            geo: null,
            geoStatus: "pending",
            batchId: null,
```

Immediately after the existing `db.set(COL.orders, id, order);` + `broadcastBoardEvent();` in that route:

```js
        scheduleGeocode(id);
```

In `DELETE ${api}/orders/:id` (~line 3981), before the record is removed:

```js
        detachFromBatch(req.params.id);
```

- [ ] **Step 4: Add the three routes**

Place after the existing `POST ${api}/orders/:id/claim` route (~line 3963):

```js
    // POST — the driver's ranked work list. See spec §9 for why this is a
    // POST: the body carries the driver's live GPS, which is location data
    // and has no business in a query string, an access log, or a proxy cache.
    app.post(`${api}/driver/route`, requireFeature("delivery"), csrf.requireCsrf, requireDriver, V.validate(V.driverRouteSchema), async (req, res) => {
        try {
            const cfg = routingCfg();
            const now = new Date();
            const driverId = req.user.id;

            // PRIVACY: filter server-side. The old flat list shipped every
            // pending order to every driver and let driver.js hide other
            // drivers' orders in the browser (driver.js:280) — which means
            // another driver's customer PII was already on the wire. This
            // endpoint does not repeat that.
            const visible = db.list(COL.orders).filter(o =>
                o.status === "pending" || o.claimedBy === driverId);

            let origin = null;
            if (Number.isFinite(req.body.lat) && Number.isFinite(req.body.lon)) {
                origin = { lat: req.body.lat, lon: req.body.lon };
            } else {
                origin = await restaurantOrigin();
            }

            if (!cfg.enabled || !origin) {
                // Feature off, or we have no idea where the restaurant is.
                // Degrade to exactly the old behaviour rather than an error.
                return res.json({
                    enabled: false, origin: null, items: [],
                    unlocated: visible.filter(o => o.status === "pending").map(o => o.id),
                    orders: visible,
                });
            }

            const batches = db.list(COL.deliveryBatches);
            const plan = routing.planRoute({ orders: visible, batches, origin, now, cfg });

            res.json({ enabled: true, origin, items: plan.items, unlocated: plan.unlocated, orders: visible });
        } catch (e) {
            console.error("Driver route planning failed:", e);
            res.status(500).json({ error: "Nepodařilo se naplánovat trasu" });
        }
    });

    // POST — claim every order in a batch, all or nothing.
    //
    // ⚠ THERE IS DELIBERATELY NO `await` BETWEEN THE CHECKS AND THE WRITES.
    // better-sqlite3 is synchronous and Node is single-threaded, so this
    // block cannot interleave with a competing driver's request — that is
    // the ONLY thing making the all-or-nothing guarantee real. Adding an
    // await (an SMS, a gateway call, anything) silently reintroduces the
    // double-claim race. Notifications fire after the last write, below.
    app.post(`${api}/orders/claim-batch`, requireFeature("delivery"), csrf.requireCsrf, requireDriver, V.validate(V.claimBatchSchema), (req, res) => {
        const driverId = req.user.id;
        const driverName = req.user.name;

        const batch = db.get(COL.deliveryBatches, req.body.batchId);
        if (!batch) return res.status(404).json({ error: "Skupina nenalezena" });
        if (batch.status !== "open") {
            return res.status(409).json({ error: "Tuto skupinu už převzal jiný řidič" });
        }

        const members = batch.orderIds.map(id => db.get(COL.orders, id));
        const missing = batch.orderIds.filter((id, i) => !members[i]);
        if (missing.length) return res.status(404).json({ error: "Objednávka ze skupiny nenalezena" });

        const conflictingIds = members.filter(o => o.status !== "pending").map(o => o.id);
        if (conflictingIds.length) {
            return res.status(409).json({ error: "Objednávku ze skupiny už převzal jiný řidič", conflictingIds });
        }

        const notReady = members.filter(o => o.kitchenStatus !== "completed").map(o => o.id);
        if (notReady.length) {
            return res.status(409).json({ error: "Kuchyně ještě nedokončila všechny objednávky ve skupině", notReadyIds: notReady });
        }

        const claimedAt = new Date().toISOString();
        for (const order of members) {
            order.status = "claimed";
            order.claimedBy = driverId;
            order.claimedByName = driverName;
            order.claimedAt = claimedAt;
            db.set(COL.orders, order.id, order);
        }
        batch.status = "claimed";
        batch.claimedBy = driverId;
        batch.claimedAt = claimedAt;
        db.set(COL.deliveryBatches, batch.id, batch);
        // ── every write is done; awaits are safe from here ──

        broadcastBoardEvent();

        const notifSettings = settingsStore.getSettings().notifications;
        if (notifSettings.smsOrderOnTheWay) {
            for (const order of members) {
                if (!order.phone) continue;
                notify.sendSms(order.phone, `Objednávka č. ${order.id} je na cestě.`)
                    .catch(e => console.error("On-the-way SMS crashed unexpectedly:", e));
            }
        }

        res.json({ success: true, orders: members });
    });

    // POST — break a batch apart. The safety valve for when the algorithm
    // makes a bad call on a busy night; members return to the pool as
    // singles. requireAuth (not requireStaff) so a driver can also do it —
    // but only while the batch is still unclaimed.
    app.post(`${api}/delivery-batches/:id/split`, requireFeature("delivery"), csrf.requireCsrf, requireAuth, V.validateParams(V.paramsId), (req, res) => {
        const batch = db.get(COL.deliveryBatches, req.params.id);
        if (!batch) return res.status(404).json({ error: "Skupina nenalezena" });
        if (batch.status !== "open") {
            return res.status(409).json({ error: "Skupinu už nelze rozdělit" });
        }
        for (const id of batch.orderIds) db.patch(COL.orders, id, { batchId: null });
        batch.status = "dissolved";
        db.set(COL.deliveryBatches, batch.id, batch);
        broadcastBoardEvent();
        res.json({ success: true });
    });
```

(`crypto` is already required at server.js:179 — do not add a second require.)

- [ ] **Step 5: Backfill orders written before this feature**

Orders already in the DB have no `geo`. Rather than a migration, geocode
them on demand — bounded by the kitchen-board window, so history is never
touched and never needs to be (spec §8.3).

Add to the helper block from Step 2:

```js
// Orders written before this feature have no geoStatus at all. Enqueue any
// that a driver could still act on. Bounded by the same board window the
// kitchen uses, so this can never walk the whole order history.
function backfillGeocoding() {
    const cfg = routingCfg();
    if (!cfg.enabled || !geocode.isEnabled()) return;
    const recent = kitchenBoard.filterForBoard(db.list(COL.orders), { now: new Date() });
    for (const order of recent) {
        if (order.status !== "pending") continue;
        if (order.geoStatus) continue; // already ok/failed/pending
        db.patch(COL.orders, order.id, { geoStatus: "pending" });
        scheduleGeocode(order.id);
    }
}
```

Call it once from inside the `POST ${api}/driver/route` handler, before
planning — a driver opening their page is exactly when stale rows matter,
and the `geoStatus` guard makes repeat calls free:

```js
            backfillGeocoding();
```

- [ ] **Step 6: Blank the geocoder in the test harness**

In `tests/helpers/harness.js`, in the env object (~line 169-181), alongside the Twilio/SMTP/GoPay blanking:

```js
        // Delivery routing: no test run may ever reach OpenStreetMap.
        GEOCODE_DISABLED: "1",
```

- [ ] **Step 7: Write the smoke test**

Create `tests/smoke/driver-route.test.js`. Follow the existing setup in
`tests/smoke/table-orders.test.js` for booting the harness, creating a driver
user, logging in, and carrying the CSRF token. Cover exactly these cases:

```js
// 1. Two orders 300 m apart, both kitchen-completed, pre-batched via a
//    seeded delivery_batches record -> POST /driver/route returns ONE item
//    with kind "batch" and both stop ids, in optimal order.
// 2. A third order 5 km away -> a separate kind "single" item, ranked after
//    the batch.
// 3. An order with geoStatus "failed" -> appears in `unlocated`, never in
//    `items`.
// 4. PRIVACY: an order already claimed by ANOTHER driver is absent from
//    both `items` and `orders` in the response body. Assert on the raw JSON
//    text, not just the parsed items — the point is that the PII is not on
//    the wire at all.
// 5. claim-batch happy path: 200, both orders become status "claimed" with
//    claimedBy set to the caller, and the batch becomes status "claimed".
// 6. claim-batch on an already-claimed batch: 409, and NOTHING is written
//    (re-read both orders and assert they are untouched).
// 7. claim-batch where one member is still kitchenStatus "pending": 409
//    with notReadyIds, and neither order is claimed.
// 8. split: 200, both orders get batchId null, batch becomes "dissolved",
//    and a second split attempt is 409.
// 9. DELETE one member of a 2-order batch -> the batch is dissolved and the
//    survivor's batchId is null (spec §8.3.1).
```

- [ ] **Step 8: Run the full suite**

```bash
npm run test:unit
npm run test:smoke
```

Expected: PASS, both suites, no regressions.

- [ ] **Step 9: Commit**

```bash
git add src/server/server.js tests/helpers/harness.js tests/smoke/driver-route.test.js
git commit -m "feat(routing): batch formation, driver route endpoint, batch claim and split"
```

---

## Task 5: driver page

**Files:**
- Modify: `src/js/driver.js`
- Modify: `src/css/driver-page.css`

**Interfaces:**
- Consumes: `POST ${API_URL}/driver/route` (body `{lat, lon}` or `{}`) returning `{ enabled, origin, items, unlocated, orders }`; `POST ${API_URL}/orders/claim-batch` body `{ batchId }`.
- Produces: nothing consumed by other tasks.

- [ ] **Step 1: Replace `fetchOrders` with route planning**

Keep `apiFetch`, `ensureCsrfToken`, the session block, and `startBoardStream`
exactly as they are. Replace the order-fetching and rendering with:

```js
let plan = { enabled: false, items: [], unlocated: [], orders: [] };
let driverPosition = null; // {lat, lon} once the driver opts in

async function fetchOrders() {
    try {
        const res = await apiFetch(`${API_URL}/driver/route`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(driverPosition || {}),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        plan = await res.json();
        orders = plan.orders || [];
        renderOrders();
    } catch (e) {
        console.error('Failed to load route:', e);
    }
}

// Geolocation is behind an explicit tap, not an unprompted permission
// dialog on page load — a prompt nobody asked for is a prompt that gets
// denied permanently. Also note navigator.geolocation is refused outright
// on plain HTTP outside localhost, in which case this silently keeps the
// restaurant as the origin and everything still works.
function requestPosition() {
    if (!navigator.geolocation) {
        showToast('Tento prohlížeč neumí zjistit polohu.', true);
        return;
    }
    navigator.geolocation.getCurrentPosition(
        pos => {
            driverPosition = { lat: pos.coords.latitude, lon: pos.coords.longitude };
            showToast('Trasa seřazena podle vaší polohy.');
            fetchOrders();
        },
        () => showToast('Polohu se nepodařilo zjistit — řadím od restaurace.', true),
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 }
    );
}
```

- [ ] **Step 2: Render batches and the unlocated tail**

Replace `renderOrders()`. Keep the existing `renderOrderCard()` for singles
and for the driver's own claimed orders — it is unchanged.

```js
function renderOrders() {
    const container = document.getElementById('ordersList');
    container.innerHTML = '';
    const byId = new Map(orders.map(o => [o.id, o]));

    // Orders this driver already claimed stay at the top, unchanged.
    const mine = orders.filter(o => o.claimedBy === currentDriver?.id);
    mine.forEach(o => container.appendChild(renderOrderCard(o)));

    for (const item of plan.items || []) {
        if (item.kind === 'batch') {
            container.appendChild(renderBatchCard(item, byId));
        } else {
            const order = byId.get(item.stopIds[0]);
            if (order && order.claimedBy !== currentDriver?.id) container.appendChild(renderOrderCard(order));
        }
    }

    for (const id of plan.unlocated || []) {
        const order = byId.get(id);
        if (!order || order.claimedBy === currentDriver?.id) continue;
        const card = renderOrderCard(order);
        // When routing is switched off entirely, EVERY order arrives here —
        // that is the deliberate degrade-to-old-behaviour path, and badging
        // all of them "poloha neznámá" would be a lie. Badge only when the
        // feature is on and this specific address genuinely failed.
        if (plan.enabled) {
            card.classList.add('drv-order--unlocated');
            card.insertAdjacentHTML('afterbegin',
                '<div class="drv-order__badge-unlocated">📍 poloha neznámá</div>');
        }
        container.appendChild(card);
    }

    if (!container.children.length) {
        container.innerHTML = '<div class="ds-empty drv-empty-wrap">Momentálně nemáte žádné rozvozy.</div>';
    }
}

function renderBatchCard(item, byId) {
    const stops = item.stopIds.map(id => byId.get(id)).filter(Boolean);
    const card = document.createElement('div');
    card.className = 'ds-card drv-batch' + (item.claimable ? '' : ' drv-batch--waiting');

    const stopsHtml = stops.map((o, i) => `
        <div class="drv-batch__stop">
            <span class="drv-batch__stop-num">${i + 1}</span>
            <div class="drv-batch__stop-body">
                <div class="drv-batch__stop-name">${escapeHtml(o.customerName)} · ${formatPrice(o.total)}</div>
                <div class="drv-batch__stop-addr">${escapeHtml(o.address)}${o.psc ? ` (PSČ ${escapeHtml(o.psc)})` : ''}</div>
                ${o.kitchenStatus === 'completed' ? '' : '<div class="drv-batch__stop-wait">⏳ čeká v kuchyni…</div>'}
            </div>
            ${o.phone ? `<a class="ds-btn ds-btn--ghost drv-batch__call" href="tel:${escapeHtmlAttr(o.phone)}">📞</a>` : ''}
        </div>`).join('');

    card.innerHTML = `
        <div class="drv-batch__head">
            <span class="drv-batch__title">Skupina · ${stops.length} objednávky</span>
            <span class="drv-batch__ready">${item.readyCount}/${item.totalCount} hotovo</span>
        </div>
        <div class="drv-batch__stops">${stopsHtml}</div>
        <div class="drv-order__actions-row">
            <a class="ds-btn ds-btn--ghost" href="${escapeHtmlAttr(multiStopMapsUrl(stops))}" target="_blank" rel="noopener noreferrer">🗺 Navigovat celou trasu</a>
            <button type="button" class="ds-btn ds-btn--ghost drv-batch__split">Rozdělit</button>
        </div>`;

    card.querySelector('.drv-batch__split')
        .addEventListener('click', () => splitBatch(item.batchId));

    const claimBtn = document.createElement('button');
    claimBtn.type = 'button';
    claimBtn.className = 'ds-btn ds-btn--primary ds-btn--block';
    claimBtn.textContent = item.claimable
        ? `Vyzvednout skupinu (${stops.length})`
        : `Čeká na kuchyni (${item.readyCount}/${item.totalCount})`;
    claimBtn.disabled = !item.claimable;
    claimBtn.addEventListener('click', () => claimBatch(item.batchId, claimBtn));
    card.appendChild(claimBtn);

    return card;
}

// Google Maps multi-stop form: everything between origin and destination
// rides as waypoints, in the order the server computed.
function multiStopMapsUrl(stops) {
    const addrs = stops.map(o => o.address || '');
    const destination = encodeURIComponent(addrs[addrs.length - 1]);
    const waypoints = addrs.slice(0, -1).map(encodeURIComponent).join('|');
    let url = `https://www.google.com/maps/dir/?api=1&destination=${destination}`;
    if (waypoints) url += `&waypoints=${waypoints}`;
    return url;
}

async function claimBatch(batchId, buttonEl) {
    buttonEl.disabled = true;
    buttonEl.textContent = 'Přebírám…';
    try {
        const res = await apiFetch(`${API_URL}/orders/claim-batch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ batchId }),
        });
        if (res.status === 409) {
            const data = await res.json().catch(() => ({}));
            showToast(data.error || 'Skupinu už převzal jiný řidič.', true);
            await fetchOrders();
            return;
        }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        showToast('Skupina převzata!');
        await fetchOrders();
    } catch (e) {
        console.error(e);
        showToast('Nepodařilo se převzít skupinu', true);
        await fetchOrders();
    }
}

async function splitBatch(batchId) {
    try {
        const res = await apiFetch(`${API_URL}/delivery-batches/${batchId}/split`, { method: 'POST' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        showToast('Skupina rozdělena.');
    } catch (e) {
        showToast('Nepodařilo se rozdělit skupinu', true);
    }
    await fetchOrders();
}
```

- [ ] **Step 3: Add the location button**

In `src/html/driver.html`, next to the logout button in the header:

```html
<button type="button" id="useLocationBtn" class="ds-btn ds-btn--ghost">📍 Použít polohu</button>
```

And wire it in driver.js beside the other listeners:

```js
document.getElementById('useLocationBtn').addEventListener('click', requestPosition);
```

- [ ] **Step 4: Add the styles**

Append to `src/css/driver-page.css` — follow the existing `.drv-order*`
conventions for spacing, radius, and colour variables:

```css
/* Batched orders — one card, numbered stops. The colored left border is
   the same signal the kitchen board uses, so a batch looks like the same
   object in both places. */
.drv-batch { border-left: 4px solid var(--ds-accent, #1a5c3a); }
.drv-batch--waiting { opacity: .72; }
.drv-batch__head { display: flex; justify-content: space-between; align-items: center; margin-bottom: .5rem; }
.drv-batch__title { font-weight: 600; }
.drv-batch__ready { font-size: .85rem; opacity: .75; }
.drv-batch__stops { display: flex; flex-direction: column; gap: .5rem; margin-bottom: .6rem; }
.drv-batch__stop { display: flex; align-items: flex-start; gap: .55rem; }
.drv-batch__stop-num {
    flex: 0 0 1.5rem; height: 1.5rem; border-radius: 50%;
    background: var(--ds-accent, #1a5c3a); color: #fff;
    display: flex; align-items: center; justify-content: center;
    font-size: .8rem; font-weight: 700;
}
.drv-batch__stop-body { flex: 1 1 auto; min-width: 0; }
.drv-batch__stop-name { font-weight: 600; }
.drv-batch__stop-addr { font-size: .9rem; opacity: .8; }
.drv-batch__stop-wait { font-size: .82rem; opacity: .7; }
.drv-batch__call { flex: 0 0 auto; padding: .2rem .5rem; }
.drv-order--unlocated { border-left: 4px solid #b58900; }
.drv-order__badge-unlocated { font-size: .82rem; color: #b58900; margin-bottom: .3rem; }
```

- [ ] **Step 5: Verify by hand**

```bash
npm run test:smoke
```

Expected: PASS (no driver.js coverage there, but nothing may regress).

- [ ] **Step 6: Commit**

```bash
git add src/js/driver.js src/css/driver-page.css src/html/driver.html
git commit -m "feat(driver): batch cards with ordered stops and multi-stop navigation"
```

---

## Task 6: kitchen board grouping

**Files:**
- Modify: `src/js/kitchen.js`
- Modify: `src/css/kitchen-page.css`

**Interfaces:**
- Consumes: `order.batchId` on delivery orders, which already reaches the board — `GET /api/kitchen/orders` passes delivery orders through **whole** (server.js:4063), unlike the indoor rows above it. **No route change is needed and none may be made.**
- Produces: nothing.

- [ ] **Step 1: Sort batched cards adjacent**

In `renderDeliveryRow()` (~line 290), after the existing sort, group by
`batchId` so batch members end up next to each other while unbatched orders
keep their existing order:

```js
    // Pull batch members adjacent to each other without disturbing the
    // relative order of everything else: order by the position of each
    // batch's FIRST member in the existing sort.
    const firstSeen = new Map();
    orders.forEach((o, i) => {
        const key = o.batchId || `solo:${o.id}`;
        if (!firstSeen.has(key)) firstSeen.set(key, i);
    });
    orders.sort((a, b) => {
        const ka = a.batchId || `solo:${a.id}`;
        const kb = b.batchId || `solo:${b.id}`;
        return firstSeen.get(ka) - firstSeen.get(kb);
    });
```

- [ ] **Step 2: Add the shared band and counter**

In `renderDeliveryCard(order)` (~line 306), compute the batch context and add
a header band. Each order keeps its own card and its own Complete/Remove
buttons — nothing about the existing kitchen workflow changes.

```js
    if (order.batchId) {
        const siblings = (board.delivery || []).filter(o => o.batchId === order.batchId);
        const ready = siblings.filter(o => o.kitchenStatus === 'completed').length;
        card.classList.add('kit-batched');
        card.insertAdjacentHTML('afterbegin', `
            <div class="kit-batch-band">
                <span>🔗 Skupina · připravit společně</span>
                <span class="kit-batch-band__count">${ready} ze ${siblings.length} hotovo</span>
            </div>`);
    }
```

- [ ] **Step 3: Add the styles**

Append to `src/css/kitchen-page.css`:

```css
/* Batched delivery orders: separate cards, visually tied. Same accent as
   the driver page's batch card so it reads as one object in both places. */
.kit-batched { border-left: 4px solid var(--ds-accent, #1a5c3a); }
.kit-batch-band {
    display: flex; justify-content: space-between; align-items: center;
    gap: .5rem; margin: -.25rem -.25rem .5rem; padding: .3rem .55rem;
    background: var(--ds-accent-soft, #e8f1ec);
    border-radius: .35rem; font-size: .82rem; font-weight: 600;
}
.kit-batch-band__count { font-weight: 500; opacity: .8; }
```

- [ ] **Step 4: Verify**

```bash
npm run test:smoke
```

Expected: PASS — in particular `tests/smoke/kitchen-board.test.js`.

- [ ] **Step 5: Commit**

```bash
git add src/js/kitchen.js src/css/kitchen-page.css
git commit -m "feat(kitchen): show batched delivery orders together on the board"
```

---

## Task 7: admin settings UI

**Files:**
- Modify: `src/js/inner.js`

**Interfaces:**
- Consumes: `settings.delivery.routing` (Task 3).
- Produces: nothing.

> `inner.js` fetches and PUTs the **whole** settings object (inner.js:3835),
> so any field this panel does not read still round-trips unchanged. The new
> inputs must be both **read** in the settings-populate function (~line 4257,
> alongside `setDeliveryFreeAbove` / `setDeliveryEta`) and **written** in the
> save handler (~line 4542) or the values silently reset on every save.

- [ ] **Step 1: Add the markup**

In the delivery-rules panel markup in `src/html/inner.html`, after the
existing delivery inputs:

```html
<h4>Řazení a slučování rozvozů</h4>
<label><input type="checkbox" id="setRoutingEnabled"> Řadit rozvozy podle vzdálenosti a slučovat blízké objednávky</label>
<label>Max. objednávek ve skupině <input type="number" id="setRoutingMaxStops" min="2" max="6" step="1"></label>
<label>Maximální vzdálenost ve skupině (m) <input type="number" id="setRoutingRadius" min="100" max="5000" step="50"></label>
<label>Jak dlouho lze do skupiny přidávat (min) <input type="number" id="setRoutingWindow" min="1" max="60" step="1"></label>
<label>Po kolika minutách čekání dostane objednávka přednost <input type="number" id="setRoutingGrace" min="0" max="240" step="5"></label>
<label>Jak silně čekání zvyšuje prioritu
    <select id="setRoutingAgeWeight">
        <option value="0.2">mírně</option>
        <option value="0.5">středně</option>
        <option value="1">silně</option>
    </select>
</label>
```

The age weight is a labelled select, not a raw number: "kilometres per
minute of waiting" is meaningful to the algorithm and meaningless to a
restaurant owner.

- [ ] **Step 2: Populate on load**

Beside the existing `setDeliveryEta` line (~line 4258):

```js
    const routing = settings.delivery.routing;
    deliveryRulesPanel.querySelector('#setRoutingEnabled').checked = !!routing.enabled;
    deliveryRulesPanel.querySelector('#setRoutingMaxStops').value = routing.maxStops;
    deliveryRulesPanel.querySelector('#setRoutingRadius').value = routing.groupRadiusM;
    deliveryRulesPanel.querySelector('#setRoutingWindow').value = routing.batchWindowMinutes;
    deliveryRulesPanel.querySelector('#setRoutingGrace').value = routing.ageGraceMinutes;
    // Snap to the nearest offered strength — a value set by hand in the DB
    // must not silently become "mírně" just because it is not in the list.
    const weights = [0.2, 0.5, 1];
    const nearest = weights.reduce((best, w) =>
        Math.abs(w - routing.agePriorityKmPerMinute) < Math.abs(best - routing.agePriorityKmPerMinute) ? w : best, weights[0]);
    deliveryRulesPanel.querySelector('#setRoutingAgeWeight').value = String(nearest);
```

- [ ] **Step 3: Include in the save payload**

In the save handler (~line 4542), inside the `delivery` object:

```js
            routing: {
                ...settingsCache.delivery.routing,
                enabled: deliveryRulesPanel.querySelector('#setRoutingEnabled').checked,
                maxStops: Number(deliveryRulesPanel.querySelector('#setRoutingMaxStops').value),
                groupRadiusM: Number(deliveryRulesPanel.querySelector('#setRoutingRadius').value),
                batchWindowMinutes: Number(deliveryRulesPanel.querySelector('#setRoutingWindow').value),
                ageGraceMinutes: Number(deliveryRulesPanel.querySelector('#setRoutingGrace').value),
                agePriorityKmPerMinute: Number(deliveryRulesPanel.querySelector('#setRoutingAgeWeight').value),
            },
```

Spreading `settingsCache.delivery.routing` first preserves `batchBonusKm`,
`originLat`, and `originLon`, which this panel does not expose. Without the
spread they arrive as `undefined` and the strict schema rejects the save.

- [ ] **Step 4: Verify**

```bash
npm run test:smoke
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/js/inner.js src/html/inner.html
git commit -m "feat(admin): expose delivery routing settings"
```

---

## Final verification (Opus, after all waves)

- [ ] `npm run test:unit` and `npm run test:smoke` both green
- [ ] Boot the server, seed geocoded orders directly in SQLite, and drive
      `/driver` and `/kitchen` in a browser: batch card renders with numbered
      stops, claim is blocked until all members are ready, claim-batch moves
      all members, split releases them, kitchen shows the band
- [ ] Two concurrent claim-batch calls: exactly one 200, one 409, and no
      partially-claimed batch left behind
- [ ] `routing.enabled: false` leaves the driver page working as it did
      before this feature
