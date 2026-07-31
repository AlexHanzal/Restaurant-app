# Room shape editing — implementation plan

Design: `docs/superpowers/specs/2026-07-28-room-shape-editing-design.md`

## Parallelisation

Three tracks, split on the same exclusive-file boundaries that worked for the
floorplan feature. Three rather than four because `inner.js` is a single
4,700-line file that one owner must hold — splitting the editor across two
concurrent agents would guarantee conflicts, and the server work here is too
small to justify its own split.

| Track | Owns (exclusive write access) | Depends on |
|---|---|---|
| E — Geometry & rendering | `src/js/floorplan.js`, `src/css/floorplan.css`, `tests/unit/floorplan.test.js` | — |
| F — Server | `src/server/validation.js`, `src/server/settings.js` | — |
| G — Editor | `src/js/inner.js`, `src/html/inner.html` | E's helper contract |

G codes against E's contract as specified in design §4 rather than waiting;
integration verifies the contract holds.

## Track E — Geometry & rendering

1. Replace `.fp-canvas`'s CSS border with an SVG polygon wall layer per design
   §3. **One code path for every room** — the implicit rectangle from
   `roomCorners()` when a room has no corners, never a rectangle-vs-polygon
   branch.
2. Add the five pure helpers from design §4 with exactly those signatures.
3. Add `.fp-walls`, corner-handle and `.fp-table--outside` styles. Corner
   handles are styled here but produced by Track G — same courtesy precedent
   as the existing `.fp-tray` classes.
4. Extend the unit tests per design §8, including a concave L-shape for
   `pointInPolygon` (a convex-only implementation passes rectangle tests and
   then fails on the exact shapes this feature exists to support).

## Track F — Server

1. `validation.js` — `corners` in `floorplanRoomSchema`, bounded 3–24, each
   point `.strict()` with finite bounded numbers. Reuse the existing local
   helpers rather than inlining new zod chains.
2. `settings.js` — explicit four-corner arrays on both seeded rooms, matching
   their current `width`/`height`.
3. Confirm (and report) that the deep merge still replaces `rooms` wholesale
   so an owner-edited shape is never merged against the seeded one.

## Track G — Editor

1. The empty-room gate per design §5.1, including the **Odebrat stoly z
   místnosti** button. The gate is the owner's explicit requirement — corner
   editing must be impossible while a room holds tables.
2. Corner drag, insert via edge `+`, delete with a 3-corner floor, and numeric
   x/y inputs for the selected corner (design §5.2). Pointer events with
   `setPointerCapture`, snapping to the 10-unit grid, clamped to the box.
3. The `.fp-table--outside` flag and its warning line (design §5.3),
   editor-only.
4. Corner edits flow through the existing dirty-tracking and the existing
   **Uložit rozložení** button. No new save path, no autosave.

## Integration (me)

1. Verify E's exports match G's call sites.
2. Unit tests.
3. Browser: drag a corner in an empty room, save, reload, confirm persistence;
   confirm the gate blocks and names the tables; confirm unplace-all clears
   it; confirm an L-shaped room renders on the customer page.
4. Regression: the floorplan feature's own behaviour (occupied/too-small
   states, party filter, waiter click, overview additivity) still works.

## Notes

- Not a git repository — edits land directly in the working tree.
- Test against a scratchpad copy, never the real `data/app.db`. A working
  environment with dependencies already exists under the session scratchpad
  (`integ2`); `src/` is re-synced there after implementation.
- The sandbox blocks `cmd.exe`, so npm/node must run through the PowerShell
  tool, and node's global `fetch` fails on loopback with "bad port" — use
  `node:http` for API checks.
