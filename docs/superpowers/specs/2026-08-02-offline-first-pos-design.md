# Offline-first POS (pokladna bez sítě) — design

Date: 2026-08-02
Status: approved, ready to implement

The bar's till must keep taking orders and money when the Wi-Fi dies, and
catch up by itself once it comes back. Today every table order is a live
round trip to the server: `POST /indoor-orders` prices it, `POST
/indoor-orders/:id/mark-paid` mints the receipt and hands it to the EET
queue. With no network, the barman can do neither.

## 1. Scope

| In scope | Out of scope |
|---|---|
| Creating a table order offline | Floorplan editing |
| Closing/paying a table order offline (cash, card terminal) | Kitchen status changes |
| Cached read-only menu | Menu admin, stats, exports |
| Automatic background sync on reconnect | GoPay online payment |
| The app loading at all with no network | Stock / sklad tracking |

Everything out of scope stays online-only and shows an explicit disabled
state rather than failing silently.

### 1.1 Decisions taken

| Question | Decision |
|---|---|
| Devices | Android tablets, Chrome. Background Sync and durable IndexedDB both available. |
| Architecture | Local-first: the device's own DB is written first, always, online or not. |
| Receipt at payment time | **Not issued** unless the guest asks. This is what removes offline receipt numbering entirely. |
| Sync transport | Replay of the **existing** two routes with an idempotency key — no second path to money. |
| Dexie.js | **Not vendored.** `pos-db.js` is a zero-dependency IndexedDB wrapper with a Dexie-shaped API, matching the `eet.js`/`gopay.js` convention. Swappable later. |
| Price drift | Client snapshot wins, server flags it. See §4.3. |

### 1.2 Why local-first rather than queue-on-failure

The cheaper option is to leave today's UI untouched and only divert a sale
into an outbox when a request actually fails. It was rejected on one
argument: that code path would then run *only* during an outage, so its
first real execution and its first business-critical execution are the same
event. Writing every sale through the local DB means the offline path is
exercised on every sale of every shift, and an outage changes nothing about
which code runs.

The cost is honest — `inner.js` currently reads indoor orders straight from
the server, and that read path has to change.

## 2. What is NOT being built

**No client-side EET.** `eet-queue.js` already has retry with backoff,
deadline escalation and a health endpoint, and the EET 2.0 design (§2.1 of
`2026-07-31-eet2-integration-design.md`) already decided what happens when a
sale cannot be reported in time: issue without POK and queue. The tablet's
only job is getting the sale to the server. Everything downstream of that
already survives outages.

**No offline receipt numbering.** `nextReceiptNumber()` stays a single
server-side sequence, and `porad_cis` is untouched. This is only possible
because receipts are issued on request (§1.1) — nothing is handed to a guest
while offline, so no number needs to exist before sync.

**No offline anything for shared mutable state.** Two devices diverging on
table occupancy, kitchen status or stock levels has no correct merge. The
till is an append-only stream of sales, which is the one part that can be
made safe.

## 3. Client

### 3.1 Storage — `src/js/pos-db.js`

One IndexedDB database, `pos`, version 1, four object stores:

| Store | Key | Holds |
|---|---|---|
| `sales` | `clientId` | The outbox. The only durable money on the device. |
| `menuCache` | `key` | Menu snapshot for offline pricing. |
| `serverOrders` | `id` | Read-only cache of the server's indoor-order list. |
| `meta` | `key` | `deviceId`, last successful sync, drain state. |

A sale is **one row with a state machine**, not two independent queue
entries. Two entries would need an ordering guarantee between them, and a
payment that synced before its own order is a bug with no clean recovery.

States are `queued` → `created` / `paid` → `synced`, plus terminal `failed`.

**Corrected during implementation.** This section originally described a
linear `open → paid → created → synced` machine, with the next sync step
switched on the current state. That was wrong, and the hole was big enough
to lose a shift's kitchen tickets through: an order submitted offline but
**not yet paid** had no pending step at all, so it sat on the tablet
forever and the kitchen never learned about it even after the network came
back. Tested by `pos-sale-machine.test.js`, "an order submitted offline and
NEVER paid still syncs".

What the sync worker needs next is therefore derived from two independent
facts — *does the server have this order* and *has the money been taken* —
never from a position in a queue:

```
pendingStep(sale):
  synced | failed        → nothing
  no serverOrderId       → "create"   (POST /indoor-orders)
  state === paid         → "settle"   (POST /:id/mark-paid)
  otherwise              → nothing    (on the server, tab still open)
```

For the same reason the `created` event must not stamp over `paid` — doing
so would lose the fact that money had been taken, and the sale would look
settled while its payment was still unreported.

```js
{
  clientId,        // UUID v4, minted on device — also the Idempotency-Key
  deviceId,
  tableName, guestName,
  items: [{ id, name, qty, price, vatRate }],  // price snapshot AT SALE TIME
  total,                                        // client-computed, Kč
  paymentMethod,   // "cash" | "card_terminal"
  createdAt,       // order opened
  paidAt,          // real payment instant — becomes dat_trzby
  state,           // open | paid | created | synced | failed
  serverOrderId, receiptId, receiptNumber,      // filled in by sync
  attempts, lastError, nextAttemptAt,
}
```

`synced` rows are kept 30 days for audit, then pruned. Nothing else is ever
deleted automatically.

**Durability.** `navigator.storage.persist()` is requested on first login.
Without it Chrome may evict the database under storage pressure, which here
means losing money that was taken but never reported. If the request is
denied, that is surfaced, not swallowed.

### 3.2 Service worker — `src/sw.js`

Precaches the `inner.html` shell only: the HTML, its three stylesheets,
`config.js`, `qr.js`, `floorplan.js`, `inner.js`, `pos-db.js`, `pos-sync.js`
and fonts.

| Request | Strategy |
|---|---|
| Shell assets | Cache-first. This is the point of the exercise. |
| `GET /api/*` | Network-first, short timeout, falling back to the local cache. |
| **Any non-GET `/api/*`** | **Network-only. Never touched by the service worker.** |

The last row is not an optimisation. Payments must not go anywhere near
cache-replay logic; the outbox in §3.1 is the only thing allowed to retry a
mutation, because it is the only thing that knows about idempotency keys.

**Cache versioning is server-stamped.** `sw.js` is served by a route that
substitutes a hash of the shell files' contents into the cache name, and
`activate` deletes every cache that does not match. A hand-maintained
version constant is how a bar ends up running last month's `inner.js` after
a deploy that appeared to succeed — and it interacts badly with the existing
`express.static` `immutable, max-age=2592000` headers and `minify.js`'s own
content-hash ETags. The service worker script itself is served `no-store` so
the browser always re-checks it.

Scope is the app's `basePath` (default `/reservation`), not `/`.
`manifest.json` with `display: standalone` makes it installable, which on
Android is also what earns durable storage and a stable launch surface.

### 3.3 Sync worker — `src/js/pos-sync.js`

Four triggers, because none of them alone is reliable:

1. Immediately after a sale reaches `paid`.
2. The `online` event.
3. A 30-second timer while the app is open.
4. Background Sync (tag `pos-drain`), so the queue drains with the app closed.

Rules:

- **Serial, oldest first.** One sale at a time. Parallel drains multiply
  failure modes for no gain — the server is a single SQLite writer anyway.
- Per-sale exponential backoff, 1 s doubling to a 5 min cap, stored as
  `nextAttemptAt` so it survives a page reload.
- `navigator.onLine === false` skips an attempt. `true` is **never** treated
  as proof of anything: a bar's Wi-Fi with a dead uplink reports `true`, and
  the only real evidence of connectivity is a request that succeeded.
- **Corrected during implementation.** The rule above was stated for the
  drain but not for the *display*, and the status pill was written against
  `navigator.onLine`. With the server stopped and the tablet's Wi-Fi
  perfectly healthy, the till entered offline mode, the connection label
  read "Offline", and the pill next to it read "Online" — the pill lying
  about the single thing it exists to report. `POSSync.serverUnreachable()`
  now answers from whether the server actually responded (`noteContact()`),
  and the pill uses it. Verified in a browser against a genuinely dead
  server.
- The CSRF token is refetched at drain time, never reused from before an
  outage.
- On `401`, the drain does **not** clear the queue and does not drop the
  barman to the login gate mid-service; it raises a "sign in to sync"
  prompt. **`setSession(null)` must never touch the `sales` store.** Queued
  money is not session state.
- A `4xx` that is not `401`/`403`/`429` marks the sale `failed` and stops
  retrying it — a human has to look. It is never silently dropped.

### 3.4 UI

- A status pill in the staff header, impossible to miss:
  `● Online` / `● Offline — 3 účtenky k odeslání`.
- A failed-sales list showing the raw server error, because those need a
  person.
- A blocking confirmation if the barman ends a shift with unsynced sales.
- The order list renders **cached server orders ∪ local unsynced sales**,
  deduped by `clientId`. That is a small one-way merge, not bidirectional
  sync.
- Per the device split, every hover state gets an `:active` twin.

### 3.5 The operational consequence that must be stated out loud

**The kitchen board cannot see an offline order until it syncs.**
`broadcastBoardEvent()` is a server-side SSE push; an order that has not
reached the server does not exist to the kitchen. For a bar closing drinks
tabs this is usually irrelevant, but it is a real behaviour change and the
staff have to be told rather than discover it during service.

## 4. Server

This is the load-bearing part. The client work is worthless without it.

### 4.1 Idempotency — `src/server/idempotency.js`

New zero-dependency module plus a `idempotency` collection: `key → { status,
body, at }`. Middleware on `POST /indoor-orders` and `POST
/indoor-orders/:id/mark-paid`: a key already seen replays the stored
response verbatim and runs nothing. The record is written only after the
handler succeeds. Entries older than 30 days are pruned by the existing
maintenance pass.

The risk this closes is specific. `mark-paid` is *already* idempotent per
order — it reuses `order.receiptId`, and `eetQueue.enqueue` dedupes on
receipt id. But `POST /indoor-orders` mints a fresh id via
`generateFileId()` on every call, so a request that succeeds while its
response is lost — the single most common failure on flaky Wi-Fi — produces
a second order, a second receipt, a second `porad_cis` and **a second sale
reported to the tax authority**. Creation is where the key matters; the key
on `mark-paid` is belt-and-braces and a clean stored response.

### 4.2 Honest timestamps

`createReceiptForOrder` gains an `issuedAt` parameter instead of always
calling `new Date()`. `POST /:id/mark-paid` accepts `paidAt` and passes it
through. That one value flows to both:

- `nextReceiptNumber(issuedAt)` — a New Year's Eve sale synced on 2 January
  draws its number from the correct year's counter.
- `receipt.issuedAt` → `dat_trzby` in `eet-queue.js` — the sale is reported
  on the day it happened, not the day the Wi-Fi came back.

`paidAt` is rejected if it is in the future or more than 72 hours old. Past
that window it is a bug, not a late sync, and it deserves a human rather
than a confident wrong tax report.

### 4.3 Offline pricing — client snapshot wins, server flags

`POST /indoor-orders` accepts `offlineSale: true` plus the client's priced
line items. The server still runs `priceOrderItems`, but its result is used
as a *comparison*, not as the answer:

- Prices agree → normal path, nothing recorded.
- Prices differ → **the client's snapshot is kept**, the order is stamped
  `pricedOffline: true` with both totals, and it is logged for ops review.
- `priceOrderItems` errors outright → **the client's snapshot is still
  kept.**

That last case is the important one. `priceOrderItems` enforces
*availability*: `soldOut` dishes, sold-out combos, the daily-menu serving
window. Applied to a sale that was already paid for hours earlier, those
gates would reject the request permanently — a sale that took real money
and can never be reported, retrying forever. **Sync must never be able to
permanently reject a sale that has already been paid.** The money changed
hands; the receipt and the EET total must record what happened, not what
the menu says now.

Guards, since this path trusts client numbers:

- Every item must carry a positive integer `qty` within existing limits.
- Every line price must be a non-negative finite number.
- `total` must equal the sum of the line totals, or the request is rejected.
- The path requires `requireAuth` exactly as today.

The trust boundary is unchanged: an authenticated staff member can already
mark any order paid at any amount and delete orders. This adds no authority
that was not already there, and unlike the existing paths it leaves an
explicit `pricedOffline` audit flag behind.

Rejected alternative: a `menuVersion` stamp on each sale. Comparing computed
prices directly is both simpler (no version endpoint, no hash to keep in
step) and stricter — it detects actual price drift on the items sold rather
than any unrelated edit to the menu.

### 4.4 Receipt number on the response

`POST /:id/mark-paid` returns `receiptNumber` alongside `receiptId`. Added
during implementation: the drain stored a `receiptNumber` the route never
sent, so every synced sale's local audit trail held an opaque id nobody
could match against a paper receipt. Caught in the browser, not by the unit
tests — both halves were individually correct and only their composition
was wrong.

## 5. Testing

Unit, `node --test`, zero-dependency modules per the house convention:

- Idempotency: first call executes, replay returns the stored response,
  distinct keys stay independent, a failed handler stores nothing.
- `paidAt` clamping: future rejected, >72 h rejected, year boundary draws
  from the right counter.
- Offline pricing: agreement, drift, `priceOrderItems` failure, and each
  guard.
- Sale state machine and backoff schedule.

End-to-end, against a real server:

1. Go offline in DevTools, take three sales, reconnect.
2. Assert **exactly** three orders, three receipts, three EET records.
3. Repeat, killing the response mid-flight, and assert the same counts —
   this is the test that proves §4.1 actually holds.

Running these for real needs the copy-out-to-local-disk recipe; the
workspace copy cannot `npm install` in place.

## 6. Files

New:

- `src/js/pos-db.js` — IndexedDB wrapper and sale state machine
- `src/js/pos-sync.js` — drain worker
- `src/sw.js` — service worker
- `src/manifest.json`
- `src/server/idempotency.js`

Changed:

- `src/server/server.js` — idempotency middleware on two routes,
  `createReceiptForOrder(issuedAt)`, `paidAt` on mark-paid, offline pricing
  branch, `sw.js` stamping route
- `src/server/validation.js` — `offlineSale`, `paidAt`, priced item shape
- `src/js/inner.js` — write path through the outbox, merged read path,
  status pill
- `src/html/inner.html` — script tags, manifest link

## 6.1 One thing the spec did not anticipate

`tryConnect()` drops a "enter the server address" gate over the whole app
when the first request fails — which is exactly the wrong dialog to show
someone whose problem is that there is no network, and it would have hidden
this entire feature behind an overlay. `enterOfflineMode()` now takes over
when the queue is alive and the service worker has a cached shell; the
connect gate is reserved for a genuinely unconfigured device.

Verified with the server process stopped: the till loads, restores its
session, disables the online-only views, takes and settles a sale, and
drains it automatically when the server returns — reporting `dat_trzby` at
the offline payment instant.

## 7. Open question for the accountant

§4.3 decides that a sale offline at a price that has since changed is
recorded and reported **at the price the guest actually paid**. That is the
technically defensible reading — a receipt should record the transaction
that occurred. But like §2.1 of the EET 2.0 design, it is a tax question
wearing a technical costume, and it belongs in the same conversation with
the restaurant's accountant. The decision lives in exactly one place in the
code so it is a one-line change if the answer comes back different.
