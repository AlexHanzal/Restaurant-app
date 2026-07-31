# Floorplan table picking — design

Date: 2026-07-27
Status: approved

## 1. Problem

Guests and staff pick tables from flat text lists that carry no spatial
information:

- **Customer** (`/reservation/app`, `renderer.js` `renderTablesList()`) — a
  `.ds-list-row` per free table, name + attributes. Occupied tables are
  filtered out entirely, so the guest cannot tell whether "stůl 3" is the
  quiet corner or the one wedged beside the kitchen door.
- **Waiter** (`/reservation/admin` → *Objednat ke stolu*, `inner.js`
  `renderWaiterView()`) — a grid of identical 🍽️ cards. During a rush the
  waiter has to translate "the four by the stairs" into a name in an
  alphabetically-sorted grid.

Neither surface knows how many people a table seats, so a party of five can
book a two-top and nothing stops them.

The owner supplied two floorplan images as the target: a main room with a
**KUCHYŇ** block and an entrance door, and a second area with **SCHODY**
(stairs). Tables render as squares with chair bars on each occupied side,
labelled with a name and a seat count; occupied tables stay visible in place,
greyed out and marked *obsazeno*.

## 2. Goals

1. Replace both pickers with a to-scale floorplan matching the supplied
   images.
2. Make the floorplan **data-driven and admin-editable** — adding, moving or
   resizing a table never requires a code change.
3. Give tables a seat count, and let party size drive which tables a guest may
   book, enforced on the server.
4. Add the floorplan to the admin *Přehled* **without removing anything that
   is on that screen today**.

## 3. Non-goals

- Round or non-rectangular tables. The design system is square-cornered
  (`--ds-radius: 0`); every table in the supplied images is a rectangle.
- Table merging/splitting for large parties.
- Multi-floor navigation beyond the flat room list.
- Changing how availability itself is computed. `isHourFree()` stays the
  authority on free/occupied; the floorplan only draws its result.

## 4. Data model

### 4.1 Table record (`timetables` collection)

Two new optional fields per record. Everything else is untouched.

```js
{
  className: "stul",          // unchanged — still the table's identity
  fileId, data, info,
  attributes: [],
  seats: 4,                   // NEW: integer 1–20. Default 4.
  layout: {                   // NEW: null/absent = "not placed yet"
    room: "main",             // room id from settings.floorplan.rooms[].id
    x: 60, y: 170,            // top-left corner, in the room's own units
    w: 160, h: 165            // size, in the room's own units
  }
}
```

`layout` is a single nested object rather than four flat fields so that
"unplaced" is representable as one `null` instead of four sentinel numbers,
and so a whole placement moves atomically.

### 4.2 Rooms and fixtures (`settings.floorplan`)

Rooms are not tables, so they live in the existing single settings record
rather than in a new collection. This reuses `settings.js`'s deep-merge
backfill (a field added later is transparently filled in for existing
installs), the existing `GET /settings` that both frontends already fetch,
the `requireAdmin` + CSRF guard on `PUT /settings`, and the admin *Nastavení*
UI — none of which would exist for a new collection.

```js
settings.floorplan = {
  rooms: [
    {
      id: "main",
      name: "Hlavní místnost",
      width: 1000, height: 430,        // the room's own coordinate space
      fixtures: [
        { type: "block", label: "KUCHYŇ", x: 0, y: 0, w: 620, h: 105 },
        { type: "door", label: "", x: 900, y: 300, w: 100, h: 100,
          facing: "left" }
      ]
    },
    {
      id: "upstairs",
      name: "Patro",
      width: 300, height: 490,
      fixtures: [
        { type: "block", label: "SCHODY", x: 0, y: 0, w: 133, h: 245 }
      ]
    }
  ]
}
```

Exactly two fixture types, which is everything the supplied images contain:

- `block` — a grey filled rectangle with a centred letter-spaced label.
  Kitchen, stairs, bar, WC.
- `door` — a quarter-circle arc plus a straight leaf line, no fill.
  `facing` is one of `left|right|up|down` and rotates it.

`settings.js`'s deep merge replaces arrays wholesale, which is the correct
semantics for `rooms` — a saved room list replaces the old one entirely, and
the objects inside the array pass through untouched.

### 4.3 Coordinates

Each room declares its own `width`/`height` in abstract units. The rendered
canvas gets `aspect-ratio: width / height`, and every table and fixture is
positioned as a **percentage** of those dimensions:

```
left:  x / room.width  * 100%      width:  w / room.width  * 100%
top:   y / room.height * 100%      height: h / room.height * 100%
```

Because the canvas preserves the room's aspect ratio, a square in room units
renders as a square on screen at every viewport size, with no JavaScript
measuring and no resize listener. Units are otherwise arbitrary — treat them
as centimetres or as "roughly pixels in the reference drawing".

## 5. Rendering

### 5.1 Shared module

New `src/js/floorplan.js` — dependency-free, no build step, matching the
existing plain-`<script>` convention. It exposes one global:

```js
FloorPlan.render(container, {
  rooms,            // settings.floorplan.rooms
  tables,           // [{ name, seats, layout, state, sublabel }]
  activeRoomId,
  onRoomChange,     // (roomId) => void; omit to hide the room switcher
  onTableClick      // (tableName) => void; omit for a read-only plan
});
```

Plus pure helpers, exported for unit testing and reused by the editor:

| Helper | Purpose |
|---|---|
| `resolveTableState(table, opts)` | → `free` \| `occupied` \| `too-small` \| `selected` |
| `partitionTables(tables, rooms)` | splits placed vs. unplaced |
| `snapToGrid(value, step)` | editor drag snapping |
| `autoArrange(tables, room)` | grid-fills unplaced tables |
| `seatSides(seats)` | seat count → chair bars per side |

`seatSides` distributes seats around the perimeter in `top, bottom, left,
right` rotation: 4 seats → one bar per side, matching `stul` in the reference
image exactly; 2 seats → top and bottom; 6 → two top, two bottom, one each
side. Deterministic, so it never needs storing.

### 5.2 Visual states

Drawn from the reference images, using existing `design.css` tokens only.

| State | Appearance |
|---|---|
| `free` | 2px `--ds-rule` border, white fill, black name, grey seat count, black chair bars. Clickable. |
| `occupied` | `--ds-border` fill, `--ds-faint` border, grey name, sublabel *obsazeno*, grey chair bars. Not clickable. |
| `too-small` | As `free` but 40% opacity, sublabel *málo míst*. Not clickable. |
| `selected` | As `free` plus a `--ds-accent` border. |

### 5.3 Styles

New `src/css/floorplan.css`, loaded by both `index.html` and `inner.html`.
All colours come from the `--ds-*` custom properties; no new palette.

## 6. Surfaces

### 6.1 Customer reservation page

- A **Počet osob** chip row (1–8) is added above the day strip, in its own
  `.rsv-section`. It is independent of date and time, and defaults to 2.
- The *Dostupné stoly* section renders the floorplan instead of the list.
  **Occupied tables stay visible, greyed out and in place** — this is the
  main experiential change, and it is what makes the plan legible: a guest
  sees the room, not a filtered subset of it.
- Tables seating fewer than the chosen party size render `too-small`.
- Clicking a `free` table opens the existing booking sheet unchanged.
- Selected party size is passed into the booking as `guests`.

### 6.2 Admin → Objednat ke stolu

The 🍽️ card grid is replaced by the same floorplan, read-only with respect to
availability (a waiter may order to any table, including an occupied one —
occupied means *seated*, which is precisely when an order is placed). Clicking
a table opens the existing `waiterOrderModal` unchanged.

### 6.3 Admin → Přehled

**Additive only.** The existing `inn-overview-grid` of per-table cards stays
exactly as it is. A read-only floorplan is inserted above it, with each table
showing today's booking count. Clicking a table scrolls to and highlights that
table's existing card.

### 6.4 Admin → Rozložení (new tab)

Admin-only, placed after *Nastavení* in the sidebar nav, following the
existing `admin-only` + `style="display:none;"` pattern.

- Room switcher, plus add / rename / resize / delete room.
- Canvas rendering the active room. Tables are dragged with pointer events
  and resized by a bottom-right handle. Both snap to a 10-unit grid.
- A side panel for the selected table: seat count, room dropdown, and numeric
  x/y/w/h inputs — so the editor is fully usable by keyboard and does not
  depend on drag precision.
- Fixtures: add block or door, drag, edit label, delete.
- Unplaced tables sit in a tray beside the canvas; dragging one onto the
  canvas places it. **Auto-rozmístit** grid-fills every unplaced table.
- An explicit **Uložit rozložení** button. Nothing persists until it is
  clicked; an unsaved-changes badge appears as soon as anything moves, and
  navigating away with unsaved changes warns. Saving issues one
  `PUT /timetables/:name` per *changed* table plus one `PUT /settings`.

## 7. Server changes

### 7.1 Validation (`validation.js`)

`timetablePutSchema` is `.strict()`, so the two new fields must be declared or
every save fails with 400:

```js
seats: boundedInt(1, 20, "Počet míst").optional(),
layout: z.object({
    room: reqStr(80, "Místnost"),
    x: z.coerce.number().finite().min(-10_000).max(10_000),
    y: z.coerce.number().finite().min(-10_000).max(10_000),
    w: z.coerce.number().finite().min(1).max(10_000),
    h: z.coerce.number().finite().min(1).max(10_000),
}).strict().nullable().optional(),
```

`createTimetableSchema` gains an optional `seats`. `settingsSchema` (also
`.strict()`) gains a `floorplan` object with a bounded `rooms` array (max 20
rooms, max 50 fixtures each). `sendCodeSchema` gains
`guests: boundedInt(1, 20, "Počet osob").optional()`.

### 7.2 Public exposure (`server.js` `sanitizeTimetableForPublic`)

This function is a **whitelist** — its header comment states that any field
added to a record is private by default. `seats` and `layout` must therefore
be added explicitly:

```js
return {
    className, fileId, info, attributes,
    seats: typeof record.seats === "number" ? record.seats : null,
    layout: record.layout || null,
    data: publicData
};
```

This is safe to publish: a seat count and a piece of furniture's position are
not personal data, and they are exactly what the customer page must draw. The
existing redaction of `phone`, `content`, `abbreviation`, `order`,
`orderTotal`, `isPaid`, `paymentFailed` and `receiptId` is untouched, and the
per-slot whitelist is not widened.

### 7.3 Capacity enforcement

`applyBookingToTimetable()` gains a `guests` parameter and rejects the booking
when `guests > (data.seats ?? Infinity)`:

```
{ ok: false, error: "Tento stůl má jen X míst" }
```

Tables with no `seats` set accept any party, so existing data keeps working.
`guests` is stored on each booked slot next to `content`/`phone` and is
**not** exposed by `sanitizeTimetableForPublic` (party size is customer data).

### 7.4 Defaults (`settings.js`)

`buildDefaultSettings()` gains the `floorplan` block from §4.2, seeded with
the two rooms and three fixtures from the reference images. Existing installs
pick this up automatically via the existing deep merge — no migration.

## 8. Persistence hazards

These are the failure modes that make a change like this silently lose data.
Each must be handled:

| # | Location | Failure if missed |
|---|---|---|
| 1 | `validation.js` `timetablePutSchema` (`.strict()`) | every table save returns 400 |
| 2 | `inner.js:1195` `persistTimetable()` | payload is rebuilt field-by-field; editing a *description* silently wipes `seats` and `layout` |
| 3 | `inner.js:1238` `saveInfo()` rename flow | POST-then-PUT rebuild drops placement, so renaming a table unplaces it |
| 4 | `server.js:853` `sanitizeTimetableForPublic()` | customer floorplan renders every table as unplaced |
| 5 | `validation.js` `settingsSchema` (`.strict()`) | saving settings with `floorplan` returns 400 |
| 6 | `server.js` `POST /timetables` | new tables have no `seats`, so capacity checks skip them |

Hazards 2 and 3 are the dangerous pair: both fail *silently* and only under a
sequence (place a table, then later edit its description), so both need
regression tests, not just a careful edit.

## 9. Backwards compatibility

Every existing table has neither `seats` nor `layout`. The system must be
fully usable in that state and degrade in one direction only:

- A table with `layout == null` renders in a **Nezařazené stoly** list below
  the plan, using the existing `.ds-list-row` / `.inn-dish-add-card` markup.
  It stays bookable and orderable.
- If `settings.floorplan.rooms` is empty or missing, no canvas is drawn and
  every table falls back to that list — i.e. today's behaviour exactly.
- A table with no `seats` is never filtered by party size and never rejected
  by the capacity check.

`deploy/seed-floorplan.js` is an idempotent helper that places tables named
`stul`, `stul 2`, `stůl 3`, `stůl 4` at the coordinates from the reference
images and sets their seat counts (4, 4, 4, 2). It skips any table that
already has a `layout`, so it is safe to re-run and never overwrites owner
edits.

## 10. Testing

**Unit** (`tests/unit/floorplan.test.js`, `node --test`) — the pure helpers:
`resolveTableState` across all four states, `seatSides` for 1–8,
`partitionTables` with missing/unknown room ids, `snapToGrid` including
negatives, `autoArrange` producing non-overlapping in-bounds placements.

**Server** (`tests/smoke/`) — `PUT /timetables/:name` round-trips `seats` and
`layout`; unauthenticated `GET /timetables/:name` returns them while still
withholding `phone`/`content`/`receiptId`; a booking with `guests` greater
than `seats` is rejected; hazards 2 and 3 as explicit regressions (save a
description, then assert `layout` survived; rename a table, then assert
`layout` survived).

**Manual** — all four surfaces in a browser against a seeded database.

## 11. Files

New:

- `src/js/floorplan.js`
- `src/css/floorplan.css`
- `tests/unit/floorplan.test.js`
- `deploy/seed-floorplan.js`

Modified:

- `src/server/validation.js` — 4 schemas
- `src/server/settings.js` — defaults
- `src/server/server.js` — public whitelist, create defaults, capacity check
- `src/js/renderer.js` — party size, floorplan table picker
- `src/js/inner.js` — waiter view, overview, layout editor, persistence fixes
- `src/html/index.html` — party size section, floorplan script/style
- `src/html/inner.html` — Rozložení nav tab and view container
