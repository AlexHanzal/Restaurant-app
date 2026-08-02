# Sales statistics for the admin "Prodeje" view — design

Date: 2026-08-02
Status: approved, ready for implementation

## 1. Problem

The admin Prodeje view (`src/js/inner.js`, `renderSalesView()`) shows two flat
tables — every item sold in the last 7 days and in the last 30 days, count +
revenue, sorted by count. That is the entire feature. It answers "what sold"
and nothing else:

- no totals — the owner cannot see how much money the restaurant took,
- no comparison — no way to tell a good week from a bad one,
- no time or channel patterns — busiest day, busiest hour, rozvoz vs stůl,
- no "what is dying on the menu" — items that sold *zero* times never appear
  at all, because the tables are built from what sold,
- refunded orders silently count as revenue.

## 2. Goals

A single Prodeje screen that answers, in order of how often it is asked:

1. How much did we take? (total revenue, prominently, with a chart)
2. Is that better or worse than last period?
3. What sells, what does not, and what earns?
4. When are we busy, and through which channel?
5. What got refunded, and why?

Non-goals: CSV/Excel export, printing, per-waiter performance, cost/margin
tracking (the app stores no cost prices), forecasting.

## 3. Architecture

### 3.1 `src/server/sales-stats.js` — new, pure, zero-dependency

All aggregation math lives in one module, following the existing
`settings.js` / `reorder.js` / `validation.js` convention of dependency-free
server modules. `server.js` is already 264 KB; none of this belongs there.

```js
computeSalesStats({ orders, timetables, indoorOrders, menu, days, now })
  -> { days, since, totals, previous, chart, rankings, neverSold,
       patterns, refunds, items }
```

Pure function: takes plain arrays and a clock, touches no database, no
`Date.now()`, no I/O. This makes it fully unit-testable with `node --test`
**in place**, without the copy-out-to-local-disk workaround the rest of this
workspace needs (see `docs/` history and the OneDrive placeholder problem).

`collectTableOrderEvents()` in `server.js` (line ~2213) has exactly one
caller — the stats route — so its logic moves into this module and gains the
slot **hour**, which the current version discards but which the "busiest
hour" stat needs.

### 3.2 `GET /stats/sales?days=N` — rewritten thin

Becomes: read the four collections (`COL.orders`, `COL.timetables`,
`COL.indoorOrders`, `COL.menu`), call `computeSalesStats`, respond.
Keeps `requireAuth` and the security reasoning in the comment above it
(all staff, not admin-only).

`days` gains an allowlist: **1, 7, 30, 90**. Anything else → 400. Today's
`parseInt` is unbounded upward, so `?days=99999` walks the entire order
history on every call; the allowlist closes that and makes the response
cacheable in shape.

The response keeps the existing `items` array **unchanged** so nothing that
reads it breaks; the new blocks are added alongside.

### 3.3 `POST /orders/:orderId/refund-reason` — new

`csrf.requireCsrf, requireAuth, V.validateParams(V.paramsOrderId),
V.validate(V.refundReasonSchema)`.

Sets `refundReason` and `refundNote` on a delivery order. **Rejects with 400
unless `order.paymentStatus === "refunded"`** — this route labels refunds
that already happened; it can never create one, and no money moves. (Refunds
in this app arrive only as GoPay webhooks; `gopay.js`'s `refundPayment()` is
defined but never called.)

`refundReasonSchema` in `validation.js`:

```js
reason: z.enum(["badly_prepared", "late", "customer_cancelled",
                "wrong_order", "other"])
note:   z.string().max(200).optional()
```

### 3.4 `src/js/sales-stats-view.js` — new frontend file

The whole Prodeje view moves out of `inner.js` (275 KB) into its own file,
loaded by `inner.html` after `inner.js`, exactly like `pos-db.js` /
`pos-sync.js`. `inner.js` keeps only the `switchView('sales')` call site and
sheds ~90 lines. Plain global functions, no modules, no bundler — the
project has zero frontend dependencies and CSP is `script-src 'self'`.

The receipts panel (`renderReceiptsPanel`) stays where it is and is still
called at the bottom of the view.

### 3.5 CSS

New `.inn-stat-*` block appended to `inner.css`. Design tokens only
(`--accent`, `--ok`, `--danger`, `--muted`, `--line`, `--panel`,
`--radius`) — no new literal colors.

## 4. Visual direction

**Only the information hierarchy and layout are taken from the references.
None of their styling is.** The app is Swiss/warm-minimal and stays that way.

What the references (`code/design-refs`) contribute — structure only:

- *Ledger Coral* (`ref_mry41zhj_5owjn`): one dominant money figure owning the
  top of the page, secondary metrics as a row of equal tiles beneath it, and
  a dense supporting grid below that.
- *Barnwise* (`ref_mry49j25_mkqmb`): a period switcher as a top-level tab
  strip, and bars drawn inside full-height rails so low values still read.

What is **not** taken: gradients, pastel fills, rounded pill tiles, soft
shadows, tinted badges, decorative icons, coral/lavender palettes.

The rendering is this app's existing Swiss system, unchanged:

- white ground, single `#e30613` accent, black 1px rules (`--rule`) for card
  edges and `--line` hairlines for internal dividers — **rules, never
  shadows**, to separate anything,
- Inter only; hierarchy purely by size and weight,
- flush-left alignment on a strict modular grid, generous consistent gutters,
  no centered text,
- existing `--radius` tokens; no pill shapes, no new literal colors,
- accent used sparingly — the total revenue figure, the active tab, and the
  chart bars. Not on every tile,
- no emoji anywhere; section titles are plain words.

Numeric columns get `font-variant-numeric: tabular-nums` (the system has no
monospace face by design — see the `--mono` alias comment in `inner.css`).

## 5. The screen, top to bottom

### 5.1 Period switcher

A flush-left tab strip: **Dnes · 7 dní · 30 dní · 90 dní**. Text labels on a
shared baseline, the active one marked by weight plus a 2px accent underline
— not a filled pill. Default 7 dní. Changing it refetches and re-renders
everything below. The selection is held in a module-level variable only —
not persisted.

### 5.2 Revenue chart — the headline

One wide card, and the most prominent element on the screen:

- **Total revenue for the period, large, in the accent color**, with the
  period spelled out beneath it ("Posledních 7 dní").
- Next to it, on the same baseline, a **Δ% figure** versus the previous equal
  period (7 dní compares against the 7 days before it), set in `--ok` or
  `--danger` with a leading + or −. Plain text, no badge, no background.
- Below, a **bar per day** (per hour when "Dnes" is selected). Each bar sits
  in a pale full-height rail so low-value days still read as present rather
  than as missing data — the one structural trick taken from Barnwise.
- Bars are accent-colored, scaled to the period maximum. Hover/focus shows a
  tooltip with the date, that day's revenue, and its order count.
- Revenue only in the bars; **order count lives in the tooltip**, not as a
  second series. A dual-axis chart on a 90-day range in a 1px-rule design
  system reads as noise.

Empty period → the card shows the total as `0 Kč` and a muted "Zatím žádné
prodeje v tomto období." in place of the bars.

### 5.3 KPI row — four tiles

**Tržba · Objednávky · Průměrná objednávka · Prodáno položek.**
Each: small muted uppercase label, big number, and a Δ% caption against the
previous equal period.

Δ is **hidden entirely** when the previous period had no sales — showing
"+∞%" or "+100%" against a zero baseline is worse than showing nothing.

### 5.4 Three ranking cards

- **Nejprodávanější** — top 5 by units sold.
- **Nejméně prodávané** — bottom 5 among items that sold at least once.
- **Největší tržba** — top 5 by revenue.

The third earns its place: the most-sold item is rarely the top earner
(drinks vs mains). Each row: rank, name, and the metric with a thin
proportional bar behind it.

### 5.5 Neprodalo se vůbec

Live menu items with **zero** sales in the period, grouped by category
(Hlavní jídla / Přílohy / Nápoje / Dezerty). This is the actionable reading
of "least sold" — a dish nobody ordered never appears in a sales table.

Cross-referenced by trimmed name against the current menu
(`COL.menu` singleton). Items sold under names no longer on the menu simply
do not appear here; the menu is the source of truth for "exists".

Empty state — everything sold at least once — is a genuine positive:
"Všechny položky menu se v tomto období prodaly."

### 5.6 Vzorce (patterns)

Four blocks in one card:

- **Nejsilnější den** — weekday with the highest average revenue.
- **Nejsilnější hodina** — hour bucket with the highest revenue. Sources:
  delivery `createdAt`, indoor `createdAt`, and the reservation **slot hour**
  (the hour the food was booked for, which is the meaningful one).
- **Podle kanálu** — revenue split Rozvoz / Stůl / Na místě, as labelled
  proportional bars.
- **Podle platby** — Hotově / Kartou u řidiče / Online. Reservation and
  walk-in orders settled physically at the table genuinely have no recorded
  method; they get their own **"Na místě"** slice rather than being dropped,
  so the percentages always sum to the real total.

### 5.7 Vrácené platby

- Total refunded amount, refund rate as % of gross, and count.
- **Nejčastěji vrácené položky** — top 5 items appearing in refunded orders.
  Labelled precisely as *"položky ve vrácených objednávkách"*: a GoPay refund
  is whole-order, never per-item, so this is co-occurrence, not attribution.
  The UI must not imply the item itself was the refunded thing.
- **Důvody vrácení** — breakdown by stored reason, with unlabelled refunds
  counted as "Bez důvodu".
- A list of the period's refunded orders, each with a reason `<select>` and
  an optional note field, saved via §3.3. Unlabelled refunds sort to the top
  so they are easy to clear. A failed save reverts the select and toasts.

### 5.8 Full item table

The existing table, now driven by the selected period instead of being fixed
at 7/30. Then the receipts panel, unchanged.

## 6. What counts as a sale

Period runs from local midnight, N days back, to now.

Three channels, as today: delivery orders (`COL.orders`), reservation food
orders (`COL.timetables` slots), walk-in/POS orders (`COL.indoorOrders`).

**Refund rule — refunded orders are excluded from money, kept in counts.**
Revenue, average order value, the chart and the channel/payment splits skip
orders with `paymentStatus === "refunded"`. Item *counts* still include them,
because the kitchen did make the dish. The refund panel explains the gap
between the two, and the item table's count column is documented on screen as
"prodáno včetně vrácených".

Only delivery orders and reservation slots can be refunded. Walk-in POS
orders have no refunded state at all and therefore never appear in §5.7.

## 7. Error handling and edge cases

- Any panel with no data renders its own empty state; one empty block never
  blanks the screen.
- A failed fetch replaces the view with a single error line and a retry
  button, as today.
- Δ% hidden when the previous period is empty (§5.3).
- Items with blank/whitespace names are skipped, as the current code does.
- Orders with an unparseable `createdAt` are skipped rather than bucketed
  into epoch zero.
- `days` outside the allowlist → 400 from the server, and the client only
  ever sends allowlisted values.
- Division guards: average order value with zero orders renders "—", not
  `NaN`.

## 8. Testing

**Unit — `node --test` against `sales-stats.js`, runs in place:**

- each channel contributes counts and revenue correctly, and the three
  combine without double-counting,
- refunded orders excluded from revenue, included in counts,
- reservation slot de-duplication (the `signature` logic) still holds,
- zero-sellers derived from the menu, including a menu item whose name
  differs only by surrounding whitespace,
- weekday and hour bucketing, including the reservation slot hour,
- previous-period delta, including the previous-period-empty case,
- boundary: an order exactly at the period start is included; one a second
  before it is not,
- empty input returns a well-formed zeroed object, never throws.

**Integration — copy-out server per the workspace recipe:**

seed orders across all three channels including one refunded, then assert the
`/stats/sales` payload and the `refund-reason` route's 400 on a non-refunded
order.

**Browser — DOM assertions at 1024 and 1680 wide** (the admin is a tablet or
monitor surface, never a phone). Every new `:hover` guarded by
`@media (hover: hover)` and paired with an `:active` twin, since the admin is
still a touch surface at tablet size.
