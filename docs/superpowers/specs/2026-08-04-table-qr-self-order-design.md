# Customer QR self-order for tables — design

**Date:** 2026-08-04
**Status:** approved, ready for implementation plan
**Repo:** `restaurace-github-ready`

---

## 1. Problem

Table ordering exists today but is **staff-initiated only**. A waiter opens
*Objednat ke stolu* (`renderWaiterView()` / `openWaiterOrderModal()`,
`src/js/inner.js:3108`), picks a table, builds the order and POSTs it to
`${api}/indoor-orders`. The guest never touches it, so every table is gated on
a waiter being free.

The admin table-detail view already renders an *Objednávka* / *Platba* column
pair with a note (`src/js/inner.js:1739`) saying the columns are *"připraveny
pro budoucí funkci objednávek u stolu"*. **This spec is that feature**, arriving
from the customer's side. That note is deleted as part of the work.

## 2. What already exists (and must be reused, not rebuilt)

Discovery findings that shape the whole design:

| Asset | Where | Consequence |
|---|---|---|
| Dependency-free client-side QR encoder, `window.QR.renderSVG()` | `src/js/qr.js` (475 lines, byte mode, versions 1–10) | **No `qrcode` npm dependency.** Admin renders table QR codes client-side, exactly as it already does for GoPay redirect URLs (`src/js/inner.js:1517`). |
| `priceOrderItems()` — single server-side pricing funnel for every order route, incl. `daily:` and `combo:` prefixed lines | `src/server/server.js` (~line 880) | The new route calls it unchanged. Pricing correctness is inherited, not re-implemented. |
| `POST ${api}/orders` (delivery checkout) is **public and CSRF-free** | `src/server/server.js:3423` | Precedent for a public, session-less, zod-validated, rate-limited order route. CSRF protects *cookie-authenticated* routes; a guest phone has no session. |
| `auth.deriveSecret(purpose)` — per-audience key derivation, JWT_SECRET never exported | `src/server/auth.js:212` | The table token derives its own key. Documented in that function's header as the intended pattern for exactly this case. |
| `broadcastBoardEvent()` + SSE `GET /api/events/board` | `src/server/server.js` | A QR order appears on the kitchen board live with one call, no polling changes. |
| `COL.indoorOrders` rows are consumed by `kitchen.js`, the admin overview, `sales-stats.js`, receipts and EET | throughout | Writing an identically-shaped row means **zero kitchen-side, stats-side or receipt-side code**. |
| `POST ${api}/indoor-orders/:id/pay-online` is already public for guests | `src/server/server.js:4030` | Online payment is out of scope now (§3 decision), but the hook already exists. |

## 3. Decisions (settled with the owner, not assumptions)

| # | Decision | Chosen |
|---|---|---|
| D1 | Order model | **One new indoor order per submit.** Each guest submit creates its own `indoor_orders` row, exactly like a waiter-placed order. A second round is a second card. |
| D2 | Anti-abuse gate | **Static (non-rotating) per-table signed token** in the QR URL, plus rate limits, plus a settings gate, plus staff-visible table name. Print once, never reprint. |
| D3 | Payment | **At the table only** (cash / card terminal), settled by staff exactly as today. No payment code in this feature. |
| D4 | QR output | **Admin panel: per-table QR in table detail + a "print all tables" sheet.** |
| D5 | Menu scope | **Full menu + daily menu (`Polední menu`) + combos (`Zvýhodněná menu`).** Delivery's 200 Kč minimum and PSČ whitelist do **not** apply. |
| D6 | After submit | **Live order status** — Přijato → Připravuje se → Hotovo, plus total and "Zaplatíte u obsluhy". |
| D7 | Staff toggle | **Global toggle + per-day hours** in `settings`, server-enforced. |
| D8 | Guest identity | **Table name is the identity.** Optional `guestName`, optional order note. No phone, no email, no address — nothing GDPR-relevant is collected. |
| D9 | Code sharing | **Extract a shared *data* module only** (`src/js/menu-catalog.js`). Rendering stays separate per page. |
| D10 | Combo UI | **Full customization**, same as delivery (slot swaps, paid extras, per-line note). |
| D11 | URL | **`/reservation/stul/<token>`** — Czech, matching the existing `/reservation/uctenka/:receiptId`. |

## 4. Architecture

### 4.1 The QR link is a signed capability, not an id

New self-contained module **`src/server/table-token.js`**. Its only dependency
is `auth.deriveSecret` — the same "black box module" pattern as `reorder.js`,
`security.js`, `csrf.js` and `validation.js`.

```
token   = <fileId> "." <base64url( HMAC-SHA256(fileId, KEY)[0..15] )>
KEY     = auth.deriveSecret("table-qr-v1" + TABLE_QR_EPOCH)
```

**API:**

```js
mintTableToken(fileId)   // -> string
verifyTableToken(token)  // -> fileId | null
```

Rules:

- **Key separation is mandatory.** The key is derived via
  `auth.deriveSecret("table-qr-v1…")` and **never** `JWT_SECRET`. `requireAuth`
  accepts any signature-valid staff JWT, so a same-secret table token would be
  privilege escalation — the identical hazard documented at `src/server/auth.js:192`
  for reorder tokens. A payload-shape check is not an acceptable substitute: it
  is one line a later refactor can delete. A different key cannot be refactored
  away by accident.
- **The payload is the table's `fileId`, not its `className`.**
  `POST ${api}/timetables/:name/rename` (`src/server/server.js:2957`) changes
  `className` and leaves `fileId` untouched, so **renaming a table does not
  invalidate its printed QR code**. The server resolves `fileId → current
  className` at order time and stores that resolved name on the order.
- **No expiry** (D2). Compromise recovery is the optional `TABLE_QR_EPOCH` env
  var mixed into the purpose string: changing it invalidates every printed code
  at once. Documented in `.env.example`; deliberately not wired to admin UI —
  it is a break-glass control, not a routine one.
- Comparison uses `crypto.timingSafeEqual` on equal-length buffers, with an
  explicit length check first (`timingSafeEqual` throws on length mismatch).
- Truncating the HMAC to 16 bytes keeps the URL short enough for a low QR
  version (denser codes are harder to scan on a printed card) while leaving
  128 bits of forgery resistance.

### 4.2 A QR order *is* an indoor order

The new route writes to `COL.indoorOrders` in the **identical shape**
`POST ${api}/indoor-orders` writes (`src/server/server.js:3951`), with one added
field:

```js
source: "qr"   // absent on every pre-existing row; absent is read as "staff"
```

Existing rows are **not** migrated or rewritten. `POST ${api}/indoor-orders`
starts writing `source: "staff"` going forward. Every reader treats a missing
`source` as `"staff"`.

The `offlineSale` branch of `POST /indoor-orders` is deliberately **not**
reachable from the guest route: a guest phone is never an offline POS, so
client-supplied pricing is never accepted here. `priced.error` always returns
400 (the sold-out guard).

## 5. Server surface

Four public routes plus one authenticated one (§8.3). `${api}` = `${basePath}/api`,
`${base}` = `basePath` (`/reservation`).

### 5.1 `GET ${base}/stul/:token` — the guest page

Serves `src/html/table.html`. Registered alongside `deliveryHtmlRoute` /
`kitchenHtmlRoute` in the frontend-serving block (`src/server/server.js:2690`,
both the `base` and no-`base` branches). The page route does **not** validate
the token — it always serves the shell; the API tells the page whether the
token is real. This keeps the HTML cacheable and puts every rejection in one
place.

### 5.2 `GET ${api}/table-session/:token` — resolve scan → usable page

Public. Rate-limited by `tableOrderIpLimiter`.

```jsonc
// 200
{
  "tableName": "Stůl 5",
  "ordering": { "enabled": true, "open": true, "notice": null }
}
```

- `404` — signature invalid / malformed token.
- `410` — signature valid but the table record no longer exists (deleted table,
  stale printed code). A distinct status so the page can say *"Tento stůl už
  neexistuje — obraťte se na obsluhu"* rather than a generic error.
- `ordering.open === false` with a Czech `notice` when the toggle is off or the
  current time is outside today's hours. **The menu stays browsable; only submit
  is blocked** — mirroring `delivery.html`'s `deliveryNotice` behaviour.

### 5.3 `POST ${api}/table-orders` — place the order

Public, **no CSRF** (mirrors `POST ${api}/orders`). Validated by a new zod
schema. Rate-limited by `tableOrderIpLimiter` **and** `tableOrderTableLimiter`.

```jsonc
// request
{ "token": "<table token>", "guestName": "Petr", "note": "bez cibule", "items": [ … ] }
```

Handler order — each step is a hard gate:

1. `verifyTableToken(token)` → `fileId`, else `404`.
2. Resolve `fileId` → table record in `COL.timetables`, else `410`.
3. **Settings gate** (§7). Closed → `403` with a Czech message. The server is
   the authority; the page's own notice is only the front-of-house reflection.
4. `priceOrderItems(items)` — untouched. `priced.error` → `400`.
5. Build the order (§4.2), `db.set(COL.indoorOrders, id, order)`.
6. `broadcastBoardEvent()`.

```jsonc
// 200
{ "success": true, "orderId": "…", "tableName": "Stůl 5", "total": 348, "items": [ … ] }
```

### 5.4 `GET ${api}/table-orders/:id/status?token=<table token>` — live status

Public, rate-limited.

- Verifies the token, resolves it to a table, loads the order by id, and
  **returns 404 unless `order.tableName` matches the token's resolved table**.
  A token for table 5 can never read table 6's order.
- Returns only `{ kitchenStatus, paymentStatus, total, createdAt }`. No item
  list, no guest name, **no listing route** — one id at a time.
- Polled by the page every 15 s while the status screen is open, stopping once
  `kitchenStatus === "completed"`. Polling, not SSE: `GET /api/events/board`
  sits behind `requireAuth` and must stay there.

## 6. Anti-abuse — four layers, none sufficient alone

1. **Signed token.** `GET /reservation/stul/5` is meaningless — there is nothing
   to guess or enumerate.
2. **New limiters in `src/server/security.js`**, exported alongside the existing
   ones:
   - `tableOrderIpLimiter` — 30 requests / 15 min per IP, across all three API
     routes. Backstop.
   - `tableOrderTableLimiter` — **12 orders / 15 min keyed on the resolved
     `fileId`**, mounted on `POST /table-orders` only. This is the layer that
     matters: it caps the damage from a photographed or shared QR code, which
     the signature alone cannot prevent.
     *Implementation note:* the key must be the **resolved `fileId`**, so the
     limiter runs as a route-level middleware after token verification, or uses
     a `keyGenerator` that verifies the token itself. Keying on the raw token
     string is equivalent here (one token per table) but is fragile if the
     token format ever changes.
3. **Settings gate** (§7) — a closed kitchen rejects at the server.
4. **Staff visibility** — the kitchen ticket and the admin overview row show a
   `QR` badge next to the already-prominent table name, so a guest ordering
   from the wrong table (or off-premises) is visible to whoever carries the
   plate. This is the honest mitigation: the system cannot prove physical
   presence, so it makes mismatch *legible* instead of pretending to prevent it.

Existing protections that already apply and are not re-implemented:
`itemsArraySchema` bounds (`MAX_ITEM_QTY` 50, `MAX_ITEMS_PER_ORDER` 200,
`src/server/validation.js:240`), `apiLimiter`, helmet/CSP, and the body-size cap.

## 7. Settings

New block in `src/server/settings.js` DEFAULTS, deep-merged like every other
section:

```js
tableOrdering: {
    enabled: false,          // opt-in: an install that never prints QR codes stays closed
    days: {
        "0": { open: true, from: "11:00", to: "21:00" },
        // … "1".."6", same shape as settings.delivery.days
    },
},
```

`enabled` defaults to **`false`**: printed QR codes are the deployment step, so
an install that has not printed any must not be silently accepting anonymous
orders.

> ### ⚠️ Persistence hazard — both files, same commit
>
> `settingsSchema` in `src/server/validation.js:814` is `.strict()`. Adding
> `tableOrdering` to the defaults **without** adding it to `settingsSchema`
> makes `PUT ${api}/settings` return 400 the instant the admin panel round-trips
> the settings object (the panel always PUTs the whole object it GET-ed). This
> is the exact trap already documented for `floorplanSchema` at
> `src/server/validation.js:810`. Reuse `deliveryDaysSchema` for `days`.

`GET ${api}/settings` is fully public (`src/server/server.js:4335`), so the guest
page reads the toggle from it with no new route.

Admin UI: a *Objednávky u stolu* section in the Nastavení view, next to the
delivery hours table — reuse `renderDeliveryHoursTable()`'s markup
(`src/js/inner.js:3737`) as `renderTableOrderingHoursTable()`.

## 8. Frontend

### 8.1 `src/js/menu-catalog.js` — new shared data module (D9)

No DOM, no rendering. Exposes `window.MenuCatalog`:

```
MENU_CATEGORIES, DAILY_ITEM_ID_PREFIX, DAILY_CATEGORY_ID, COMBO_ITEM_ID_PREFIX,
COMBO_CATEGORY_ID, fetchMenu(apiUrl), fetchDailyMenu(apiUrl), fetchCombos(apiUrl),
isComboRenderable(combo, menu), comboPricePreview(...), categoryLabel(id)
```

`delivery.js` loses those definitions and consumes this module instead. This is
a **mechanical, behaviour-preserving** change to live checkout code:

- Same fail-open semantics preserved exactly — `fetchCombos` swallows errors to
  an empty array with no toast; `fetchMenu` surfaces a toast. These differ on
  purpose (`src/js/delivery.js:62`).
- Load order: `menu-catalog.js` must be included **before** `delivery.js` and
  before `table-order.js` in both HTML files.
- The combo price preview must keep matching `priceOrderItems()`'s `combo:`
  branch. The server stays the price authority; the preview is display-only,
  but a mismatch surprises the guest at the table.

### 8.2 `src/html/table.html` + `src/js/table-order.js` + `src/css/table-page.css`

New guest page. Screens, in order:

1. **Loading / invalid** — resolves the token via `GET /table-session/:token`.
   Distinct copy for 404 (neplatný kód) and 410 (stůl neexistuje).
2. **Menu** — header shows the resolved table name prominently ("Stůl 5"), so a
   guest at the wrong table notices. Sections in the same order as delivery:
   Zvýhodněná menu → Polední menu → MENU_CATEGORIES. Reuses `delivery-page.css`
   classes; `table-page.css` holds only what differs.
3. **Cart sheet** — items, quantities, total, optional `Jméno` field, optional
   note. Explicitly **no** address, phone, email, PSČ, delivery fee or minimum.
4. **Combo customize sheet** — full slot swaps, paid extras, per-line note (D10),
   ported from `delivery.js`'s sheet.
5. **Status** — Přijato / Připravuje se / Hotovo, the total, and
   *"Zaplatíte u obsluhy"* (D3). Order id + token kept in `sessionStorage` so a
   refresh returns to the live status rather than an empty cart.
   When the kitchen is closed, submit is disabled with the server's notice.

Not a PWA: this page is deliberately **excluded** from `SW_SHELL_FILES`
(`src/server/server.js:2620`) and the service worker. It is a one-off scan by a
stranger's phone, not an installed staff shell.

### 8.3 `src/js/inner.js` — admin

- **Delete** the `inn-future-note` block at `src/js/inner.js:1739`. This feature
  is what that note was waiting for.
- **`renderDetail(name)`** (`src/js/inner.js:1648`) gains a *QR kód pro
  objednávky u stolu* panel: the code rendered by `QR.renderSVG(url, { ecLevel:
  'M', scale: 5 })`, the full URL as selectable text beneath it, and a
  *Tisknout* button.
- **New "print all" sheet** — a button in the tables/Rozložení view opens a
  print-friendly window with one card per table (table name + QR + short "Naskenujte
  a objednejte" caption), sized for cutting out and standing on tables.
- The token is **minted server-side** — the client must never hold the signing
  key. A fifth route, **`GET ${api}/table-qr-tokens`** behind `requireAuth`,
  returns `[{ fileId, className, token, url }]` for every table in one call,
  serving both the detail panel and the print-all sheet.

  > It must be a **new authenticated route**, not an extra field on the existing
  > tables read: `GET ${api}/timetables` (`src/server/server.js:2809`) is
  > **public and unauthenticated** — renderer.js depends on that. Attaching QR
  > tokens there would publish every table's ordering capability to the internet
  > and defeat §6 layer 1 entirely.
- `renderWalkinOrderRow()` (`src/js/inner.js:1294`) shows a `QR` badge when
  `order.source === "qr"`.

### 8.4 `src/js/kitchen.js`

`renderIndoorCard()` (`src/js/kitchen.js:232`) adds a `QR` badge next to
`kit-ticket__source` when `order.source === "qr"`. Nothing else changes — the
card already leads with `order.tableName`.

## 9. Testing

### 9.1 Unit — `tests/unit/table-token.test.js`

Pure, no server. Round-trip mint/verify; tampered signature rejected; tampered
fileId rejected; malformed input (`""`, `"."`, no dot, absurd length) returns
`null` rather than throwing; a token minted under a different `TABLE_QR_EPOCH`
is rejected; **a real staff JWT is rejected by `verifyTableToken`, and a table
token is rejected by `auth.verifyToken`** — the key-separation guarantee gets an
explicit test, not just a comment.

### 9.2 Smoke — `tests/smoke/table-orders.test.js` + `tests/helpers/harness.js`

This repo has **no test harness yet** (`tests/` holds only unit tests plus one
EET integration test), so a minimal one is built as part of this work:

- Spawns `src/server/server.js` as a child process on a probed free port with
  `SQLITE_PATH` pointing at a temp DB.
- Force-blanks `TWILIO_*` / `SMTP_*` / `GOPAY_*` so a test run can never send a
  real SMS or reach a payment gateway.
- Seeds fixtures **after** boot — `initializeData` owns the schema.
- `package.json` gains `"test:smoke": "node --test \"tests/smoke/**/*.test.js\""`.
  Note: a bare directory argument to `node --test` fails with MODULE_NOT_FOUND
  on recent Node — the glob form is required.

Cases: invalid token → 404; deleted table → 410; `tableOrdering.enabled: false`
→ 403; outside hours → 403; happy path creates a row visible in
`GET /indoor-orders` with `source: "qr"` and a server-derived total; a
client-supplied `total` or `offlineSale: true` in the body is **ignored** (the
price comes from the menu); the status route refuses a foreign table's token;
the per-table limiter trips after its threshold.

### 9.3 Live

Real server on a spare port, admin login, enable the toggle, generate a table
QR, open the URL, order across all three menu sections including a customized
combo, confirm the order lands on the kitchen board with the QR badge, confirm
status transitions reach the guest page, confirm the waiter can mark it paid and
a receipt is issued.

## 10. Out of scope

- Online payment from the guest page (D3) — the public
  `POST ${api}/indoor-orders/:id/pay-online` hook already exists for a later pass.
- Merging a table's several QR orders into one bill (D1).
- Rotating tokens (D2) — `TABLE_QR_EPOCH` is the break-glass, not a schedule.
- Any change to `priceOrderItems()`, the receipt/EET path, or the offline POS.

## 11. File inventory

**New**

```
src/server/table-token.js
src/js/menu-catalog.js
src/js/table-order.js
src/html/table.html
src/css/table-page.css
tests/unit/table-token.test.js
tests/smoke/table-orders.test.js
tests/helpers/harness.js
```

**Modified**

```
src/server/server.js        4 routes + page route + source:"staff" on the existing indoor route
src/server/validation.js    tableOrderSchema, tableTokenParam, tableOrdering in settingsSchema
src/server/settings.js      tableOrdering defaults
src/server/security.js      tableOrderIpLimiter, tableOrderTableLimiter
src/js/delivery.js          consume menu-catalog.js
src/html/delivery.html      load menu-catalog.js before delivery.js
src/js/inner.js             delete future-note, QR panel, print sheet, settings UI, QR badge
src/js/kitchen.js           QR badge on indoor tickets
src/css/inner.css           QR panel + print sheet styles
package.json                test:smoke script
.env.example                TABLE_QR_EPOCH
```
