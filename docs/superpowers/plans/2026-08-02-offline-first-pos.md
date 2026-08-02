# Offline-first POS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The bar's till keeps taking orders and money with no network, and catches up by itself once the network returns — without ever double-reporting a sale to the tax authority or reporting one on the wrong day.

**Architecture:** Local-first. Every table order and payment is written to IndexedDB on the device first, always. A drain worker replays the **existing** `POST /indoor-orders` and `POST /indoor-orders/:id/mark-paid` routes carrying an `Idempotency-Key`. No second server path to money, and no client-side EET — `eet-queue.js` already handles everything downstream of the server.

**Tech Stack:** Vanilla ES2020, no bundler, plain `<script src>`. Node 22+, Express 5, better-sqlite3. **No new npm dependencies** — `pos-db.js` is a hand-written IndexedDB wrapper, not Dexie (see spec §1.1).

**Spec:** `docs/superpowers/specs/2026-08-02-offline-first-pos-design.md`

## Global Constraints

- **Zero new npm dependencies**, frontend and backend. CSP is `script-src 'self'` — a CDN would be blocked anyway, and nothing can be `npm install`ed in the OneDrive workspace.
- **Never let a paid sale become permanently unsyncable.** Availability gates (`soldOut`, daily-menu windows) must not reject a sale that already took money. See spec §4.3.
- **Never let the queue be cleared by session state.** `setSession(null)` must not touch the `sales` store.
- **Non-GET `/api/*` never passes through the service worker.** Only the outbox retries mutations, because only it holds idempotency keys.
- Comment density and style: match the surrounding codebase — heavily commented with *why*, not *what*.
- Service workers require a secure context. Production is Caddy + HTTPS and `localhost` is exempt, but a tablet pointed at `http://192.168.x.x:3000` will **silently** never register one. Task 6 adds the diagnostic for that.

---

### Task 1: Idempotency module

**Files:** Create `src/server/idempotency.js`; change `src/server/server.js` (collections)

- [ ] **Step 1: Write the failing tests** — `tests/unit/idempotency.test.js`
  - first call with a key executes and stores
  - replay with the same key returns the stored status + body and does **not** execute
  - different keys stay independent
  - a handler that throws stores nothing (the next attempt must be able to succeed)
  - a request with no key always executes
  - `prune()` drops entries past the age cutoff and keeps the rest

- [ ] **Step 2: Implement `idempotency.js`**
  - Zero dependencies, takes `db` + collection name as arguments like `eet-queue.js` does — no hidden import of `server.js`.
  - `middleware({ db, col })` → Express middleware reading `Idempotency-Key`.
  - Key format guard: 8–128 chars, `[A-Za-z0-9_-]` only. Reject anything else with 400 rather than storing arbitrary client strings as record ids.
  - Capture the response by wrapping `res.json` — store `{ status, body, at }` **only** for 2xx. A stored 500 would pin a transient failure forever.

- [ ] **Step 3: Register `idempotency` in `SERVER_CONFIG.collections`**

- [ ] **Step 4: Run tests** — `node --test "tests/unit/idempotency.test.js"`

---

### Task 2: Honest timestamps

**Files:** `src/server/server.js`, `src/server/validation.js`

- [ ] **Step 1: Write the failing tests** — `tests/unit/paid-at.test.js`
  - a `paidAt` in the future is rejected
  - a `paidAt` more than 72 h old is rejected
  - a valid `paidAt` from last December draws its receipt number from **last year's** counter
  - omitting `paidAt` behaves exactly as today

- [ ] **Step 2: Add `issuedAt` to `createReceiptForOrder`**
  - New optional parameter, defaulting to `new Date().toISOString()`. Every existing call site keeps working untouched.
  - It must flow to **both** `nextReceiptNumber(issuedAt)` and `receipt.issuedAt`, because the latter becomes `dat_trzby` in `eet-queue.js`.
  - Keep producing a full ISO string with milliseconds — `eet-queue.js` strips them itself with a deliberate regex, and hand-rolling a different format there would bypass that.

- [ ] **Step 3: Accept `paidAt` on `POST /indoor-orders/:id/mark-paid`**
  - Validate and clamp per Step 1, then pass through as `issuedAt`.

- [ ] **Step 4: Run tests**

---

### Task 3: Offline pricing

**Files:** `src/server/server.js`, `src/server/validation.js`

- [ ] **Step 1: Write the failing tests** — `tests/unit/offline-pricing.test.js`
  - snapshot agrees with live menu → order priced normally, no `pricedOffline` flag
  - snapshot disagrees → **client prices kept**, `pricedOffline: true`, both totals recorded
  - `priceOrderItems` errors (item now `soldOut`) → **client prices still kept**, order created
  - `total` ≠ sum of lines → rejected
  - a negative or non-finite line price → rejected
  - a non-integer or out-of-range `qty` → rejected
  - **without** `offlineSale`, all of the above still reprice and reject exactly as today

- [ ] **Step 2: Extend `createIndoorOrderSchema`**
  - `offlineSale`, `paidAt`, `clientSaleId`, and per-item `price`. The schema is already `.passthrough()`, so this is additive.

- [ ] **Step 3: Implement the offline branch in `POST /indoor-orders`**
  - Guarded snapshot path per spec §4.3. Keep it in one clearly-marked block so the accountant question in spec §7 is a one-line change.

- [ ] **Step 4: Run tests**

---

### Task 4: Client outbox — `pos-db.js`

**Files:** Create `src/js/pos-db.js`, `tests/unit/pos-sale-machine.test.js`

- [ ] **Step 1: Write the failing tests** for the pure parts — state transitions and the backoff schedule. Keep both in functions that take plain objects, so they test with `node --test` and no browser.

- [ ] **Step 2: Implement the store**
  - `open()` creating `sales`, `menuCache`, `serverOrders`, `meta` with the indexes from spec §3.1.
  - Promise-wrapped request helpers; a Dexie-shaped surface (`table.put/get/where`) so real Dexie is a drop-in later.
  - `requestPersistence()` calling `navigator.storage.persist()`, returning the result rather than swallowing it.
  - `pruneSynced(days = 30)`.

- [ ] **Step 3: Run tests**

---

### Task 5: Drain worker — `pos-sync.js`

**Files:** Create `src/js/pos-sync.js`

- [ ] **Step 1: Implement the drain**
  - Serial, oldest-first, one sale at a time.
  - Per-sale exponential backoff persisted as `nextAttemptAt`, so a reload does not reset it.
  - `POST /indoor-orders` with `Idempotency-Key: <clientId>`, then `POST /:id/mark-paid` with `Idempotency-Key: <clientId>:paid`.
  - Fresh CSRF token per drain; never reuse one from before an outage.
  - `401` → raise a sign-in prompt, keep the queue, do not log out mid-service.
  - `4xx` other than `401/403/429` → mark `failed`, stop retrying, surface it.

- [ ] **Step 2: Wire the four triggers** — on enqueue, `online`, a 30 s timer, and Background Sync (`pos-drain`).

- [ ] **Step 3: Verify `navigator.onLine` is only ever used to skip an attempt**, never as evidence of connectivity.

---

### Task 6: Service worker and manifest

**Files:** Create `src/sw.js`, `src/manifest.json`; change `src/server/server.js`, `src/html/inner.html`

- [ ] **Step 1: Write `sw.js`** with the three strategies from spec §3.2. Assert in review that no non-GET request can reach a cache path.

- [ ] **Step 2: Add the stamping route**
  - Serves `sw.js` with a hash of the shell files substituted into the cache name, `Content-Type: application/javascript`, `Cache-Control: no-store`, and `Service-Worker-Allowed` for the base path.
  - Must be registered **before** `minify.js` and `express.static`, both of which would otherwise serve it with the wrong headers.

- [ ] **Step 3: Register from `inner.html`**, plus a visible diagnostic when registration fails — including the insecure-context case, which is otherwise completely silent.

---

### Task 7: Integrate into `inner.js`

**Files:** `src/js/inner.js`, `src/html/inner.html`

- [ ] **Step 1: Route the write path through the outbox** — create and mark-paid enqueue locally and return immediately.

- [ ] **Step 2: Merged read path** — cached server orders ∪ local unsynced sales, deduped by `clientId`.

- [ ] **Step 3: Status pill** in the header with the unsent count, a failed-sales list with raw errors, and a blocking shift-end warning. Every hover state gets an `:active` twin.

- [ ] **Step 4: Disable online-only features when offline** with an explicit reason — floorplan editing, kitchen status, menu admin, stats, GoPay.

- [ ] **Step 5: Audit `setSession(null)`** and confirm no path from it reaches the `sales` store.

---

### Task 8: End-to-end verification

- [ ] **Step 1: Stand up a real server** using the copy-out-to-local-disk recipe (`src/` + `package.json` to a short local path, skip `data/`).

- [ ] **Step 2: Golden path** — offline, three sales, reconnect. Assert **exactly** three orders, three receipts, three EET records.

- [ ] **Step 3: The test that matters** — repeat, killing the response mid-flight after the server has committed. Assert the same three counts. This is the only direct proof that Task 1 holds.

- [ ] **Step 4: Timestamp check** — a sale taken offline and synced later reports `dat_trzby` at the payment instant, not the sync instant.

- [ ] **Step 5: Price-drift check** — sell offline, change the menu price, sync. Receipt and EET total must show the price the guest paid, and the order must carry `pricedOffline: true`.
