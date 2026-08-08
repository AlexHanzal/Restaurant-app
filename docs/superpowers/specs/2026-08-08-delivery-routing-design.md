# Delivery routing & batching — design

Date: 2026-08-08
Status: approved (design), pending implementation plan

## 1. Problem

`/driver` shows one flat list of delivery orders sorted newest-first
(`GET /api/orders`, server.js:3924). A driver picks whatever catches their
eye. Nothing tells them that three of those orders are on the same street,
and nothing tells the kitchen that those three should be cooked together so
they can leave in one trip.

Orders carry a free-text `address` (≤300 chars) and a `psc`. There are no
coordinates anywhere in the system, and no map/geocoding provider is
configured in the repo.

## 2. Goal

1. Rank a driver's claimable work by how far it is from them, not by age.
2. Detect orders that are close to each other and make them one unit — a
   **batch** — that the kitchen prepares together and a driver claims and
   delivers in one optimally-ordered trip.
3. Never let a far-away order starve.
4. Never let any of this cost the restaurant a sale.

## 3. Key decision: batching is geometry, ranking is the driver

"Are these two orders near each other" is a property of the two customers.
It has nothing to do with any driver. So:

- **Batch membership is computed once, server-side, and persisted** on the
  order (`batchId`) and in a `delivery_batches` record. Kitchen, driver, and
  admin all see the same batches.
- **The driver's GPS never changes membership.** It only decides which batch
  ranks first, and what sequence the stops inside it go in.

This is what makes the kitchen requirement work: a batch a cook is told to
prepare together cannot silently re-form because a driver moved.

## 4. Architecture

Two new self-contained modules, same black-box convention as
`validation.js` / `settings.js` / `reorder.js`.

### 4.1 `src/server/routing.js` — pure, zero I/O

No DB, no network, no `Date.now()`. `now` is always a parameter. This is
where the algorithm lives and where the test weight goes.

```
haversineKm(a, b)                              -> km
ageBonusKm(waitMinutes, cfg)                   -> km
canJoin(memberOrders, candidate, cfg)          -> bool
isBatchOpen(memberOrders, now, cfg)            -> bool
planBatch(memberOrders, origin)                -> { stopIds: [...], routeKm }
scorePlanItem(item, origin, now, cfg)          -> km (lower = better)
planRoute({ orders, batches, origin, now, cfg })
    -> { items: [...], unlocated: [...] }
```

### 4.2 `src/server/geocode.js` — address → coordinates, cached

- Provider: OpenStreetMap Nominatim, `format=jsonv2&limit=1&countrycodes=cz`,
  query built as `` `${address}, ${psc}, Czechia` ``. Native `fetch`, no SDK
  — same convention as `gopay.js`.
- **Nominatim usage policy is binding**: a descriptive `User-Agent` carrying
  the restaurant name and contact e-mail (from `settings.business`), and a
  hard limit of **one request per second**, enforced by an in-process serial
  queue with ≥1100 ms spacing. Not per-caller — one global queue.
- Cache: new `geocache` collection, id = SHA-1 of the normalized query.
  Record `{ id, query, lat, lon, quality, provider, at, failCount }`.
  Normalization: lowercase, strip diacritics, collapse whitespace.
- **Negative caching.** A miss is cached too. Retry no sooner than 1 hour
  later, and give up permanently after 5 attempts. Without this, a
  mistyped address is re-queried on every order event forever.
- **Kill switch**: `GEOCODE_DISABLED=1`, or
  `settings.delivery.routing.enabled === false`. The test harness force-sets
  the env var alongside `TWILIO_*` / `SMTP_*` / `GOPAY_*` so no test run can
  ever reach the network.

## 5. The scoring model

Every term is in **kilometers**. That is deliberate — it makes each term
independently unit-testable and explainable to a restaurant owner.

```
score = distToFirstStopKm
      + intraBatchRouteKm                 // cost of the extra stops
      - batchBonusKm × (stops − 1)        // value of a saved return trip
      - ageBonusKm(oldest member)

ageBonusKm(waitMin) = max(0, waitMin − ageGraceMinutes) × agePriorityKmPerMinute
```

Lowest score ranks first.

Worked examples against the defaults (grace 30 min, 0.5 km/min, bonus
1.5 km):

| Case | Score | Outcome |
|---|---|---|
| 6 km away, waiting 45 min | `6 − 7.5 = −1.5` | beats everything nearby |
| 1 km away, waiting 5 min | `1.0` | normal |
| 5 km away, waiting 20 min | `5.0` | correctly stays buried — no bonus yet |
| 2 stops @ 1 km, 0.4 km apart | `1 + 0.4 − 1.5 = −0.1` | batch beats an equidistant single |

Because intra-batch route length is bounded by `(stops−1) × groupRadiusM`
(≤1.6 km at defaults) while the batch bonus is 1.5 km per extra stop,
batching essentially always wins by a small margin. That is intended.

## 6. Clustering — complete linkage

There is no bulk clustering pass. Orders arrive one at a time, so batches
form **incrementally** (§8.3) and the whole of the clustering logic is a
single admission rule, `canJoin`:

> A candidate may join iff the batch has fewer than `maxStops` members and
> the candidate is within `groupRadiusM` of **every** existing member.

Single-link (chaining) is explicitly rejected: three 800 m hops would build
a group spanning 2.4 km. Complete linkage guarantees the literal promise —
**no two stops in a batch are ever more than `groupRadiusM` apart** — which
is the only version of the setting a restaurant owner can reason about.

Cost is O(n²) with n in the tens and a 3-stop cap. Irrelevant.

## 7. Stop ordering — exact, not heuristic

`maxStops` is capped at **6** in the settings schema. That makes
brute-forcing all permutations (≤720) instant, so `planBatch` returns the
**provably optimal** stop sequence minimising
`dist(origin, s₁) + dist(s₁, s₂) + …`.

This replaces the usual nearest-neighbour + 2-opt: one code path, no local
minima, and the unit test can assert true optimality rather than "good
enough". The schema cap is what keeps this safe — it must not be raised
without replacing the algorithm.

## 8. Batch lifecycle

### 8.1 Records

New collection `delivery_batches` (`COL.deliveryBatches`):

```js
{
  id, createdAt,
  orderIds: [...],          // 2..maxStops — batches of 1 never exist
  status: "open" | "claimed" | "dissolved",
  claimedBy, claimedAt,
}
```

Delivery orders gain:

```js
geo: { lat, lon, quality, provider, at } | null,
geoStatus: "pending" | "ok" | "failed",
batchId: string | null,
```

A lone order has `batchId: null` and is a `kind: "single"` plan item. Batches
of one are never created — the second nearby order is what brings a batch
into existence, lazily.

### 8.2 Sealing is derived, never written

`isBatchOpen(memberOrders, now, cfg)` returns false when **any** holds:

- any member has `kitchenStatus === "completed"`, or
- `now − oldestMember.createdAt ≥ batchWindowMinutes`, or
- `status !== "open"`.

The window is measured from the **oldest member's `createdAt`**, not the
batch's. A batch created at 18:09 around an 18:00 order seals at 18:10, not
18:19 — that is precisely what protects the order that has already been
waiting.

Sealing is a pure function of state, so there is no cron, no `sealedAt`
column to go stale, and no write to race.

### 8.3 Formation

Runs after a successful geocode, never before:

1. `POST /orders` saves the order (`geoStatus: "pending"`) and returns.
2. Background: geocode → `db.patch` sets `geo` + `geoStatus`.
3. On `"ok"`: find an **open** batch this order `canJoin`. Failing that,
   find an unbatched, still-open lone order nearby and create a batch of two.
   Failing that, do nothing.
4. `broadcastBoardEvent()`.

When **more than one** open batch would accept the order, it joins the one
whose members' centroid is nearest. Ties break on batch `id` ascending, so
formation is deterministic and testable.

A lone order counts as "still open" under the same `isBatchOpen` predicate
applied to `[order]` — one rule, not two.

**Backfill.** Orders written before this feature have no `geo`. Rather than
a migration, any pending order still inside the kitchen-board window
(`kitchenBoard.filterForBoard`) with `geoStatus` absent is enqueued for
geocoding on demand. The window bounds the work; history is never
backfilled and never needs to be.

### 8.3.1 Member removal

`DELETE /orders/:id` (server.js:3981) must drop the id from its batch. If
that leaves the batch with fewer than 2 members, the batch is dissolved and
the survivor's `batchId` is cleared. Without this the batch holds a dangling
id and `planRoute` sees a member it cannot resolve.

### 8.4 Claiming

`POST /api/orders/claim-batch`, body `{ batchId, driverId, driverName }`.

Takes a **`batchId`, not a list of order ids** — the server owns membership,
so a client cannot ask to claim an arbitrary set of orders as a "batch".
Lone orders keep using the existing `POST /orders/:id/claim`.

All-or-nothing. Rejects with 409 and `conflictingIds` if any member is
already claimed; rejects if any member is not `kitchenStatus: "completed"`.
Nothing is written on any rejection path.

> **Hard implementation constraint.** better-sqlite3 is synchronous and Node
> is single-threaded, so the read-check-then-write block is atomic against
> concurrent drivers **only while it contains no `await`**. Every
> notification, SMS, and broadcast fires *after* the last write. Introducing
> an `await` mid-block silently reintroduces the double-claim race that the
> single-order claim route was built to avoid.

### 8.5 Split

`POST /api/delivery-batches/:id/split` — `requireAuth`, `csrf.requireCsrf`,
refused unless `status === "open"`. Sets `status: "dissolved"`, clears
`batchId` on every member, broadcasts. Orders return to the pool as singles.

Manual **merge** is deliberately out of scope: it would let staff build a
batch spanning the whole town, and the driver-facing promise in §6 would
stop holding.

## 9. Endpoints

| Route | Auth | Notes |
|---|---|---|
| `POST /api/driver/route` | `requireDriver`, CSRF | body `{ lat, lon }` |
| `POST /api/orders/claim-batch` | `requireDriver`, CSRF | §8.4 |
| `POST /api/delivery-batches/:id/split` | `requireAuth`, CSRF | §8.5 |

All three carry `requireFeature("delivery")` first, per the mount-order rule
at server.js:241.

**`POST`, not `GET`, for the route endpoint.** Driver GPS is location data;
query strings land in access logs and proxy caches. Body instead, and CSRF
protection comes along for free.

**The route endpoint filters other drivers' orders server-side.** Today
`driver.js:280` does that filter in the browser, so another driver's
customer PII is already on the wire. The new endpoint does not repeat that
mistake.

## 10. Origin

`navigator.geolocation` on `/driver`, behind an explicit "Použít polohu"
button rather than an unprompted permission dialog on page load.

Fallback chain: live GPS → `routing.originLat/originLon` manual override →
geocoded `settings.business.address`.

`navigator.geolocation` is refused on plain HTTP outside localhost. On an
HTTP-only deployment every driver silently falls back to the restaurant
origin; the feature still works, it just loses live re-sorting.

## 11. Kitchen board

`GET /api/kitchen/orders` passes delivery orders through **whole**
(server.js:4063), unlike the indoor rows above it which are mapped
field-by-field. So `batchId` reaches `kitchen.js` with **no route change**.

Presentation: each order keeps its own card and its own kitchen-status
button — nothing about the existing kitchen workflow changes. Batched cards
sort adjacent and share a colored band with `Skupina · 2 ze 3 hotovo`, plus
the split button from §8.5.

A merged single-ticket-per-batch rendering was rejected: it collides with
per-order kitchen status and lets a cook lose track of which dish belongs to
which customer.

## 12. Driver UI

- Batch card: numbered stops (1 → 2 → 3), per-stop address and phone.
- `2/3 hotovo` counter; claim button disabled until every member is ready.
- One **"Navigovat celou trasu"** link using Google Maps' multi-stop form
  (`dir/?api=1&origin=…&destination=…&waypoints=…`) in the computed stop
  order, alongside the existing per-stop links.
- **Unlocated tail**: `geoStatus: "failed"` orders, oldest-first, badged
  `poloha neznámá`, individually claimable exactly as today. Never batched.
- Existing SSE refetch (`driver.js:232`) is retained unchanged.

## 13. Settings

New `settings.delivery.routing`:

| Key | Default | Range |
|---|---|---|
| `enabled` | `true` | — |
| `maxStops` | `3` | 2–6 (see §7; use `enabled` to switch batching off) |
| `groupRadiusM` | `800` | 100–5000 |
| `batchWindowMinutes` | `10` | 1–60 |
| `ageGraceMinutes` | `30` | 0–240 |
| `agePriorityKmPerMinute` | `0.5` | 0–5 |
| `batchBonusKm` | `1.5` | 0–20 |
| `originLat` / `originLon` | `null` | manual override |

> **Hard constraint.** `settingsSchema.delivery` (validation.js:809) is
> itself `.strict()`. Adding `routing` to `settings.js` defaults without
> adding a matching `routingSchema` in the same commit makes
> `PUT /api/settings` 400 the moment the admin panel round-trips the object
> it just fetched (inner.js saves the **whole** settings object —
> inner.js:3835). Both files, one commit.

Admin UI: a new block in the existing delivery-rules panel. The age weight
is exposed as a labelled select (mírná 0.2 / střední 0.5 / silná 1.0) rather
than a raw "km per minute" number, which means nothing to an owner.

## 14. Checkout is untouched

`/delivery` gets **no** geocoding round-trip. Geocoding happens after the
order is saved. A geocoder outage, a rate-limit, or an unparseable address
can never block or slow a customer's order — the worst case is one order
sitting in the unlocated tail.

## 15. Testing

| File | Covers |
|---|---|
| `tests/unit/routing.test.js` | haversine vs known distances; complete-linkage never exceeds `groupRadiusM`; `maxStops` respected; `planBatch` optimality verified against an independent exhaustive checker; `ageBonusKm` monotonicity; sealing rule at each of its three triggers; window measured from oldest member; determinism and stable tie-breaking |
| `tests/unit/geocode.test.js` | query normalization and cache-key stability; cache hit avoids a second call; negative caching honours the 1 h retry floor and the 5-attempt ceiling; the ≥1100 ms serial queue; `GEOCODE_DISABLED` short-circuit. `fetch` stubbed — **no network** |
| `tests/smoke/driver-route.test.js` | `POST /driver/route` grouping end-to-end; the other-driver PII boundary; batch-claim happy path; 409 on a contested member; 409 when a member is not kitchen-ready; split releases members; deleting a member dissolves a 2-order batch (§8.3.1) |

`tests/helpers/harness.js` gains `GEOCODE_DISABLED=1` to its force-blanked
env list.

Note: `node --test <directory>` fails with MODULE_NOT_FOUND on this Node —
the glob form in `npm run test:unit` is required.

## 16. Files

**New** — `src/server/routing.js`, `src/server/geocode.js`,
`tests/unit/routing.test.js`, `tests/unit/geocode.test.js`,
`tests/smoke/driver-route.test.js`.

**Changed** — `src/server/server.js` (collection, 3 routes, geocode hook),
`src/server/settings.js`, `src/server/validation.js`, `src/js/driver.js`,
`src/js/kitchen.js`, `src/js/inner.js`, `src/css/driver-page.css`,
`src/css/kitchen-page.css`, `tests/helpers/harness.js`.

## 17. Privacy — owner decision required

Nominatim means **customer street addresses leave this server for a third
party** (OpenStreetMap Foundation). Only the address and PSČ are sent —
never name, phone, or e-mail. A street address is nonetheless personal data
under GDPR.

This repo ships `src/html/ochrana-osobnich-udaju.html`. That page likely
needs a line disclosing the transfer. **Drafting that legal text is the
owner's call and is out of scope for the implementation.** The alternative,
if the owner prefers not to disclose, is to set `routing.enabled: false`,
which disables geocoding entirely and leaves the driver list exactly as it
is today.

## 18. Out of scope

- Road-distance routing (straight-line haversine only — adequate inside one
  town, and a routing API is a paid dependency).
- Dispatcher-assigned batches in admin; drivers keep self-claiming.
- Manual batch merge (§8.5).
- Multi-driver load balancing.
- Any change to `priceOrderItems()` or the checkout flow.
