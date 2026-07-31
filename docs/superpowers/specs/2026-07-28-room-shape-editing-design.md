# Room shape editing — design

Date: 2026-07-28
Status: approved
Extends: `2026-07-27-floorplan-table-picking-design.md`

## 1. Problem

Rooms are rectangles. A room is `{ id, name, width, height, fixtures }` and
renders as a bordered `div` with that aspect ratio. Real dining rooms are
L-shaped, have angled corners, bay windows and cut-outs — none of which the
current model can express.

The owner wants each corner of a room to be draggable, with corners addable
and removable, and asked for the editing to be **gated on the room being
empty of tables**, so that changing a room's shape never requires
recalculating where its tables sit.

## 2. Data model

Rooms gain one optional field:

```js
{
  id: "main",
  name: "Hlavní místnost",
  width: 1000, height: 430,       // UNCHANGED — still the coordinate space
  corners: [                       // NEW: 3–24 points, in room units
    { x: 0, y: 0 }, { x: 1000, y: 0 },
    { x: 1000, y: 430 }, { x: 0, y: 430 }
  ],
  fixtures: [ ... ]
}
```

`width`/`height` keep their exact current meaning: they define the room's
coordinate space, drive the canvas `aspect-ratio`, and are the denominator for
every table and fixture percentage. **Corners are points inside that box and
clamp to it.** Nothing about existing table math changes — which is the whole
point of the owner's constraint. Editing a shape never rewrites a table's
stored `x`/`y`.

A room with no `corners`, or fewer than 3, renders as the implicit rectangle
`[(0,0), (w,0), (w,h), (0,h)]`. That keeps every pre-existing room valid
without a migration, and is the single fallback used everywhere via
`roomCorners()` below.

The two seeded rooms get their four corners written explicitly, so the handles
are visible and draggable the first time the owner opens the editor.

## 3. Rendering

`.fp-canvas` currently gets its outline from a CSS `border`, which can only
ever draw a rectangle. That border is removed and the walls become an SVG
polygon drawn as the canvas's first child:

```html
<svg class="fp-walls" viewBox="0 0 1000 430" preserveAspectRatio="none" aria-hidden="true">
  <polygon points="0,0 1000,0 1000,430 0,430" vector-effect="non-scaling-stroke" />
</svg>
```

- The `viewBox` is the room's own coordinate space, so corner coordinates are
  written into `points` verbatim — no conversion.
- `preserveAspectRatio="none"` is safe because the canvas already has
  `aspect-ratio: width / height`, so the SVG's box matches its container
  exactly.
- `vector-effect="non-scaling-stroke"` keeps the wall a crisp 2px regardless
  of how the room scales, which a scaled SVG stroke otherwise would not.
- Fill is `--ds-surface`, stroke is `--ds-rule`.

**This is not a special case for polygon rooms.** Every room renders through
the same polygon path, using the implicit rectangle when it has no corners, so
there is exactly one wall-drawing code path rather than a rectangle branch and
a polygon branch that can drift apart.

Tables and fixtures are unchanged: absolutely-positioned divs layered on top
of the SVG.

## 4. New pure helpers (`floorplan.js`)

Added to the same `FloorPlan` global, all pure and unit-tested:

| Helper | Contract |
|---|---|
| `roomCorners(room)` | `-> [{x,y}, ...]`. Explicit corners when valid (≥3, finite), otherwise the implicit rectangle. Never throws; returns `[]` for an invalid room. |
| `pointInPolygon(point, corners)` | `-> boolean`. Ray casting. Points exactly on an edge count as inside. |
| `tableOutsideRoom(table, room)` | `-> boolean`. True when the table's rectangle is not fully inside the room polygon (tests all four corners). |
| `insertCornerAt(corners, edgeIndex)` | `-> [{x,y}, ...]` (new array). Inserts the midpoint of edge `edgeIndex` (the edge from vertex `i` to `i+1`, wrapping). |
| `removeCornerAt(corners, index)` | `-> [{x,y}, ...]` (new array). Returns the input unchanged when it would drop below 3 corners. |

Existing helper signatures are unchanged. `render()` gains no new options —
the polygon is read off the room object it already receives.

## 5. Editor (`inner.js`, Rozložení tab)

### 5.1 The empty-room gate

Corner editing is available only when the active room has **no placed
tables**. When it does have tables:

- Corner handles render greyed and non-interactive.
- A message names them: `Tvar místnosti lze upravit jen u prázdné místnosti.
  Nejdříve odeberte stoly: stul, stul 2`.
- A button, **Odebrat stoly z místnosti**, unplaces every table in that room
  in one click (sets `layout = null`, moving them to the unplaced tray and
  marking the editor dirty). This is what makes the restriction workable
  rather than a dead end — without it the owner has to hunt each table down
  and unplace it individually.

Because unplacing goes through the normal dirty/save flow, it is undone by
leaving the tab without saving, exactly like a mis-drag.

### 5.2 Editing corners

For an empty room:

- Each corner renders as a square handle, dragged with pointer events
  (`setPointerCapture`, so touch works), snapped to the 10-unit grid and
  clamped to the `width`×`height` box.
- Each edge renders a small `+` at its midpoint; clicking it inserts a corner
  there via `insertCornerAt`.
- A selected corner can be deleted with a **Odebrat roh** button or the
  Delete/Backspace key. Blocked at 3 corners, with a toast explaining why —
  fewer than 3 is not a polygon.
- Numeric `x`/`y` inputs for the selected corner, mirroring the existing
  table-coordinate inputs, so shaping is possible without dragging and by
  keyboard.

### 5.3 Tables outside the walls

Because tables clamp to the bounding box rather than the polygon, an angled
wall can leave a table outside the room. The editor flags this rather than
preventing it: any table where `tableOutsideRoom()` is true gets a
`.fp-table--outside` red outline plus a warning line listing the offenders.
Non-blocking by design — rectangle-vs-polygon containment near an angled wall
makes a hard block feel like the drag is fighting the user, and the flag
conveys the same information without that.

The flag is editor-only. Customer and waiter views never render it.

## 6. Server

- `validation.js` — `floorplanRoomSchema` gains
  `corners: z.array(z.object({ x, y }).strict()).min(3).max(24).optional()`,
  with the same finite/bounded number rules as the existing fixture
  coordinates. The schema is `.strict()`, so this is required for any save
  carrying corners to succeed.
- `settings.js` — the two seeded rooms gain explicit four-corner arrays
  matching their existing `width`/`height`. Existing installs pick these up
  through the deep merge already in place; because `rooms` is an array it is
  replaced wholesale, so a room the owner has already edited keeps its own
  shape.

No route, no sanitizer and no capacity logic changes. `corners` travels inside
`settings.floorplan`, which is already public via `GET /settings`, and a wall
outline is not personal data.

## 7. Backwards compatibility

- A room with no `corners` renders exactly as it does today.
- Fewer than 3 corners, or any non-finite coordinate, falls back to the
  implicit rectangle rather than rendering a broken shape.
- Tables, fixtures, seat counts, party-size filtering and the capacity check
  are all untouched.

## 8. Testing

**Unit** (extending `tests/unit/floorplan.test.js`): `roomCorners` with valid,
missing, too-short and malformed input; `pointInPolygon` for inside, outside,
on-edge and on-vertex cases against both a rectangle and a concave L-shape;
`tableOutsideRoom` for fully inside, fully outside and partially overlapping;
`insertCornerAt` midpoint correctness including the wrapping last edge;
`removeCornerAt` including the 3-corner floor and out-of-range indices.

**Browser**: drag a corner in an empty room and save; confirm the shape
persists across reload; confirm the gate blocks and explains in a room with
tables; confirm the unplace-all button clears the gate; confirm an L-shaped
room renders on the customer page.

## 9. Files

Modified only — no new files:

- `src/js/floorplan.js` — polygon rendering, five new helpers
- `src/css/floorplan.css` — `.fp-walls`, corner handles, `--outside` state
- `tests/unit/floorplan.test.js` — new suites
- `src/server/validation.js` — `corners` in the room schema
- `src/server/settings.js` — seeded corners
- `src/js/inner.js` — shape editing, the gate, the outside-table flag
- `src/html/inner.html` — shape controls in the editor panel
