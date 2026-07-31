# Floorplan table picking — implementation plan

Design: `docs/superpowers/specs/2026-07-27-floorplan-table-picking-design.md`

## Parallelisation

Four tracks, split so that **no two tracks write the same file**. `inner.js`
is 3776 lines and is touched by the waiter view, the overview and the new
editor — all three go to a single owner rather than being split, because
splitting a file that large across concurrent agents guarantees conflicts.

| Track | Owns (exclusive write access) | Depends on |
|---|---|---|
| A — Server & data | `src/server/validation.js`, `src/server/settings.js`, `src/server/server.js`, `deploy/seed-floorplan.js` | — |
| B — Shared module | `src/js/floorplan.js`, `src/css/floorplan.css`, `tests/unit/floorplan.test.js` | — |
| C — Customer page | `src/js/renderer.js`, `src/html/index.html` | B's contract |
| D — Admin | `src/js/inner.js`, `src/html/inner.html` | B's contract |

C and D do **not** wait for B to finish. The module contract is fully
specified in design §5.1 and is treated as a fixed interface; all three write
against it simultaneously. Integration verifies the contract actually holds.

## Track A — Server & data layer

1. `validation.js`: add `seats` + `layout` to `timetablePutSchema` (which is
   `.strict()`), `seats` to `createTimetableSchema`, `floorplan` to
   `settingsSchema` (also `.strict()`), `guests` to `sendCodeSchema`.
   Bounds per design §7.1.
2. `settings.js`: add the `floorplan` block to `buildDefaultSettings()`,
   seeded with the two rooms and three fixtures from design §4.2. Verify the
   existing deep merge treats `rooms` as a wholesale-replaced array.
3. `server.js` `sanitizeTimetableForPublic()`: add `seats` and `layout` to
   the returned whitelist, and extend the header comment explaining why
   these two are public-safe while the slot-level redaction is unchanged.
4. `server.js` `POST /timetables`: default `seats: 4`, `layout: null` on
   create, next to the existing `attributes: []`.
5. `server.js` `applyBookingToTimetable()`: accept `guests`, reject when it
   exceeds the table's `seats`, store `guests` on each booked slot. Thread
   `guests` through `POST /reservations/send-code` into the pending payload.
6. `deploy/seed-floorplan.js`: idempotent placement of `stul`, `stul 2`,
   `stůl 3`, `stůl 4` per design §9. Skips any table that already has a
   `layout`.

Do not touch any file under `src/js/`, `src/css/` or `src/html/`.

## Track B — Shared floorplan module

1. `src/js/floorplan.js`: `FloorPlan.render()` plus the five pure helpers,
   exactly the signatures in design §5.1. Plain global, no build step, no
   dependencies. Must work when loaded by both `index.html` and `inner.html`.
   Export the helpers for `node --test` via a `typeof module !== 'undefined'`
   guard, following the pattern already used elsewhere in the codebase if one
   exists.
2. `src/css/floorplan.css`: the four table states, chair bars, `block` and
   `door` fixtures, room switcher, unplaced tray. `--ds-*` tokens only, no
   new colours, `border-radius: 0` throughout.
3. `tests/unit/floorplan.test.js`: per design §10.

Do not touch `renderer.js`, `inner.js` or any HTML file.

## Track C — Customer reservation page

1. `index.html`: add the **Počet osob** `.rsv-section` above the day strip;
   load `floorplan.css` and `floorplan.js`.
2. `renderer.js`: render the party-size chips; replace `renderTablesList()`
   with a floorplan render plus a **Nezařazené stoly** fallback list;
   compute each table's state from the existing `isHourFree()` (do not
   reimplement availability); pass `guests` into the booking request.
3. Occupied tables must stay **visible and in place**, greyed out — not
   filtered out as they are today.
4. Handle the empty-floorplan case: no rooms configured ⇒ the fallback list
   alone, i.e. current behaviour.

Do not touch `inner.js`, `floorplan.js` or any server file.

## Track D — Admin surfaces

1. `inner.html`: add the **Rozložení** admin-only nav tab and its view
   container; load `floorplan.css` and `floorplan.js`.
2. `renderWaiterView()`: floorplan instead of the 🍽️ grid; click opens the
   existing `waiterOrderModal` unchanged. Any table is clickable including
   occupied ones.
3. `renderOverview()`: insert a read-only floorplan **above** the existing
   `inn-overview-grid`, which stays exactly as-is. Clicking a table scrolls
   to and highlights that table's card.
4. New `renderLayoutView()`: the editor per design §6.4 — drag, resize,
   10-unit snapping, numeric inputs, room CRUD, fixture CRUD, unplaced tray,
   Auto-rozmístit, explicit **Uložit rozložení** with an unsaved-changes
   badge and a navigate-away warning.
5. **Persistence hazards 2 and 3** (design §8) — carry `seats` and `layout`
   through `persistTimetable()`'s payload and through `saveInfo()`'s rename
   POST-then-PUT rebuild. These fail silently if missed.
6. Wire `switchView('layout')` into the existing view-switching block.

Do not touch `renderer.js`, `floorplan.js` or any server file.

## Integration (me)

1. Verify B's actual exports match what C and D call.
2. `npm run test:unit`.
3. Boot the server against a seeded copy of the real database; exercise all
   four surfaces in a browser at desktop and mobile widths.
4. Regression-check the hazards: place a table, edit its description, confirm
   the placement survived; rename a table, confirm the same.
5. Confirm the unauthenticated `GET /timetables/:name` still withholds
   `phone`, `content` and `receiptId`.

## Notes

- This project is **not** a git repository, so there is no commit step and no
  branch isolation. Edits land directly in the working tree.
- The project lives on OneDrive with some files dehydrated. Testing runs
  against a local copy under the session scratchpad with its own
  `node_modules`; `src/` is re-synced there after implementation.
