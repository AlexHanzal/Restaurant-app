# Sales stats — handoff

**Branch:** `feat/sales-stats` (16 commits, branched off `feat/offline-first-pos`, not off `master`)
**Status:** feature complete and verified working. Nothing below is required to make it run.

Spec: `docs/superpowers/specs/2026-08-02-sales-stats-design.md`
Plan: `docs/superpowers/plans/2026-08-02-sales-stats.md`

## What works (verified live, 2026-08-02)

Against a real server with seeded data across all three channels: 189/189 unit
tests, 48/48 API assertions, and the screen renders correctly at 1680 and 1024
with no horizontal overflow.

Period switcher (Dnes / 7 / 30 / 90) · revenue chart with the total as the
headline · KPI row with period-over-period deltas · most-sold / least-sold /
top-earning · never-sold menu items · busiest weekday and hour · channel and
payment splits · refund totals, rate, item co-occurrence and staff-assigned
reasons · the original item table.

## Left to do

### 1. Merge the branch
Not merged and not pushed — deliberately, since you were leaving. `feat/sales-stats`
sits on top of `feat/offline-first-pos`, which is itself unmerged (1 commit ahead
of `master`). Decide whether both land together or the POS branch merges first.

### 2. Re-style against your design references
You asked for the layout and hierarchy from your saved dashboards, and that is
what was built — Ledger Coral's structure (one dominant money figure, a row of
equal tiles, a dense grid below) and Barnwise's bars-in-rails, rendered in the
app's existing Swiss language. You said you would redo the styling yourself.
Everything visual is confined to two places: the `.inn-stat-*` block appended to
`src/css/inner.css`, and the DOM builders in `src/js/sales-stats-view.js`. No
other file needs touching to restyle it.

### 3. Known minor items (none block use)
- **90-day chart at 1024px** — bars get very thin and only every 5th day is
  labelled. Verified no overflow, but not eyeballed for legibility. May want
  weekly buckets at 90 days instead of daily.
- **Period switcher has no request sequencing** — clicking through periods fast
  fires overlapping fetches, so a slow older response could in theory land after
  a newer one. Not observed; add an abort/generation guard if you ever see flicker.
- **`POST /orders/:orderId/refund-reason` echoes the whole order** (including
  customer name, address, phone) in its response. Consistent with how
  `mark-paid`, `claim` and `kitchen-status` already behave, so it is not a new
  exposure — but this route only needs to return `{success, refundReason,
  refundNote}`. Worth narrowing, ideally across all four together.
- **`role="tab"` + `aria-pressed`** on the period switcher — `aria-selected` is
  the idiomatic pairing for a tablist. Cosmetic a11y nit.

### 4. Refunds: two real limitations, by design
- **Table-reservation refunds cannot be given a reason.** The route resolves
  orders from the `orders` collection, and reservation food orders do not live
  there. Those rows render with disabled controls and a visible caption saying
  so. Closing this means a second lookup path into `timetables`.
- **"Most refunded items" is co-occurrence, not attribution.** A GoPay refund is
  always whole-order, so this counts how often a dish appeared in a refunded
  order. The UI says this in as many words — please keep that wording if you
  restyle, it is a correctness claim rather than decoration.

### 5. One thing worth knowing for future frontend work
`src/js/sales-stats-view.js` and `src/js/inner.js` are plain `<script>` files
sharing **one global lexical scope**. A duplicate top-level `const` in either
kills the entire other file with a `SyntaxError` and no visible error beyond a
blank screen — this actually happened here (`WEEKDAYS` was declared in both) and
neither the unit tests nor `node --check` could catch it, because each file is
individually valid. Before adding a top-level name to any frontend file, run:

```bash
for f in src/js/inner.js src/js/sales-stats-view.js src/js/qr.js src/js/floorplan.js src/js/pos-db.js src/js/pos-sync.js src/config.js; do grep -hE "^(const|let|var|async function|function) [A-Za-z_$]+" "$f" | sed -E 's/^(const|let|var|async function|function) ([A-Za-z_$]+).*/\2/'; done | sort | uniq -d
```

Anything it prints is a collision. It currently prints nothing.

## How to run it again

The workspace cannot run in place (OneDrive placeholder `node_modules`). Copy
`src/` + `package.json` to a short local path — **skip `data/`**, it holds real
customer names, addresses, phones and password hashes — then `npm install`,
approve the `better-sqlite3` and `esbuild` install scripts, and boot with
`PORT=… JWT_SECRET=x CSRF_SECRET=y node src/server/server.js`.

The throwaway harness from this session is at `C:\Users\alexh\AppData\Local\Temp\zt-stats`
(`seed.js` seeds hand-checkable data, `verify.js` asserts 48 API facts). Delete
it whenever; it is outside your synced folder.

**Cache gotcha:** JS is served with `Cache-Control: max-age=3600` and Chrome
serves it stale through Ctrl+Shift+R. After editing frontend JS, re-test on a
**different port** — that is the only reliable way to get fresh bytes.
