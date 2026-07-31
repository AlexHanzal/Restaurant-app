// ════════════════════════════════════════════════════════════════════════
// FLOORPLAN.JS — shared, dependency-free floorplan renderer. Plain global
// script (no build step, no ES modules), loaded via <script> by both
// index.html (customer table picker) and inner.html (waiter view, admin
// Přehled, admin Rozložení editor). See
// docs/superpowers/specs/2026-07-27-floorplan-table-picking-design.md
// §4-§5 for the data model and rendering rules this file implements.
//
// PUBLIC API (this is a fixed contract other tracks code against — do not
// rename or reshape without updating every caller):
//
//   FloorPlan.render(container, {
//     rooms,          // settings.floorplan.rooms — see design §4.2
//     tables,         // [{ name, seats, layout, state, sublabel }]
//     activeRoomId,   // id of the room to draw; falls back to rooms[0]
//     onRoomChange,   // (roomId) => void; omit to hide the room switcher
//     onTableClick    // (tableName) => void; omit for a read-only plan
//   })
//
//   Each entry in `tables` is expected to already carry a resolved `state`
//   ('free' | 'occupied' | 'too-small' | 'selected') and, optionally, a
//   `sublabel` string override — callers compute these per-table (using
//   resolveTableState below, plus whatever availability/selection logic is
//   local to their page) before calling render(). If `state` is missing or
//   not one of the four known values, render() falls back to
//   resolveTableState(table, {}) so a caller can also pass raw tables.
//
// PURE HELPERS (exported for unit tests and reused by the Rozložení editor):
//
//   resolveTableState(table, opts) -> 'free'|'occupied'|'too-small'|'selected'
//     table: { seats?: number }
//     opts:  { occupied?: boolean,   // has an active booking right now
//              partySize?: number,   // guest count to check against seats
//              selected?: boolean }  // is the caller's current selection
//     Priority: occupied > too-small (only when both `seats` and
//     `partySize` are given and partySize exceeds seats) > selected > free.
//     A table with no `seats` set is never `too-small` — see design §9.
//
//   partitionTables(tables, rooms) -> { placed: [...], unplaced: [...] }
//     A table is "placed" only if its `layout` is a well-formed object
//     ({ room, x, y, w, h } with finite x/y/w/h) whose `room` matches the
//     id of one of the given `rooms`. Everything else — layout null/absent,
//     malformed, or pointing at an unknown room id — is "unplaced". Robust
//     to `tables`/`rooms` being missing, empty, or containing garbage.
//
//   snapToGrid(value, step) -> number
//     Rounds `value` to the nearest multiple of `step` (editor drag
//     snapping). Works for negative values. step <= 0 or non-finite input
//     is a no-op (returns the numeric value unsnapped).
//
//   autoArrange(tables, room) -> tables (new array, not mutated in place)
//     Grid-fills `tables` inside `room` (an object with numeric
//     `id`/`width`/`height`... `id` is a string) as a left-to-right,
//     top-to-bottom grid of default-sized cells, snapped to a 10-unit
//     grid, returning each table with a freshly assigned `layout`. Existing
//     `layout.w`/`layout.h` on a table are kept as its footprint if present
//     (falls back to a 120x120 default), everything else about the table is
//     passed through unchanged.
//
//   seatSides(seats) -> { top, bottom, left, right }
//     Distributes `seats` chair bars around the four sides in top, bottom,
//     left, right rotation — one seat per side per lap. 4 seats => exactly
//     one bar per side; 2 seats => top and bottom only; 6 seats => two top,
//     two bottom, one left, one right. Deterministic and pure.
//
// ── Room shape editing (2026-07-28) ─────────────────────────────────────
// See docs/superpowers/specs/2026-07-28-room-shape-editing-design.md §3-§4.
// A room may now carry an optional `corners` array (>=3 points, in the
// room's own width/height coordinate space — see design §2). render() draws
// every room's walls through ONE path: an SVG <polygon> as .fp-canvas's
// first child, built from roomCorners(room) — the implicit rectangle when a
// room has no (valid) corners. There is never a separate rectangle-drawing
// branch, so the two can't drift apart.
//
//   roomCorners(room) -> [{x,y}, ...]
//     Explicit room.corners when it is an array of >=3 points that are all
//     finite ({x,y} both Number.isFinite), returned as plain {x,y} copies.
//     Otherwise the implicit rectangle [(0,0),(w,0),(w,h),(0,h)] from
//     room.width/room.height, when those are finite and positive. Returns
//     [] when neither a usable corners array nor a usable width/height is
//     available (e.g. `room` missing or malformed). Never throws.
//
//   pointInPolygon(point, corners) -> boolean
//     Ray-casting point-in-polygon test against `corners` (>=3 points,
//     e.g. from roomCorners()). A point exactly on an edge or on a vertex
//     counts as inside (checked explicitly before ray-casting, so it isn't
//     left to float-comparison luck). Works for concave polygons, not just
//     convex ones — an L-shaped room is the reason this helper exists.
//     Returns false for a degenerate polygon (<3 corners) or a non-finite
//     point.
//
//   tableOutsideRoom(table, room) -> boolean
//     True when table.layout's rectangle is not FULLY inside the room's
//     polygon — i.e. any one of its four corners fails pointInPolygon().
//     False (never "outside") for an unplaced/malformed table.layout, or
//     when the room has no usable polygon (roomCorners() returns <3
//     points) — there is nothing to be outside of.
//
//   insertCornerAt(corners, edgeIndex) -> [{x,y}, ...] (new array)
//     Inserts the midpoint of edge `edgeIndex` — the edge running from
//     vertex `edgeIndex` to vertex `edgeIndex + 1`, WRAPPING (so the last
//     edge, index corners.length - 1, runs from the last vertex back to
//     vertex 0). Does not mutate `corners`. Returns `corners` unchanged
//     (same reference) when it has fewer than 3 points or `edgeIndex` is
//     not an in-range integer.
//
//   removeCornerAt(corners, index) -> [{x,y}, ...] (new array)
//     Removes the corner at `index`. Does not mutate `corners`. Returns
//     `corners` unchanged (same reference) when removal would drop the
//     count below 3 (a polygon floor — design §5.2), or when `index` is
//     not an in-range integer.
// ════════════════════════════════════════════════════════════════════════

(function (global) {
    'use strict';

    const VALID_STATES = new Set(['free', 'occupied', 'too-small', 'selected']);
    const CLICKABLE_STATES = new Set(['free', 'selected']);
    const SIDE_ORDER = ['top', 'bottom', 'left', 'right'];

    // ── resolveTableState ───────────────────────────────────────────────────

    function resolveTableState(table, opts) {
        table = table || {};
        opts = opts || {};

        if (opts.occupied) return 'occupied';

        const seats = typeof table.seats === 'number' && Number.isFinite(table.seats) ? table.seats : null;
        const partySize = typeof opts.partySize === 'number' && Number.isFinite(opts.partySize) ? opts.partySize : null;
        if (seats !== null && partySize !== null && partySize > seats) return 'too-small';

        if (opts.selected) return 'selected';

        return 'free';
    }

    // ── partitionTables ──────────────────────────────────────────────────────

    function isFiniteLayout(layout) {
        return !!layout
            && typeof layout === 'object'
            && Number.isFinite(layout.x)
            && Number.isFinite(layout.y)
            && Number.isFinite(layout.w)
            && Number.isFinite(layout.h);
    }

    function partitionTables(tables, rooms) {
        const tableList = Array.isArray(tables) ? tables : [];
        const roomIds = new Set(
            (Array.isArray(rooms) ? rooms : [])
                .filter(r => r && typeof r.id === 'string' && r.id.length > 0)
                .map(r => r.id)
        );

        const placed = [];
        const unplaced = [];
        for (const table of tableList) {
            const layout = table && table.layout;
            if (isFiniteLayout(layout) && typeof layout.room === 'string' && roomIds.has(layout.room)) {
                placed.push(table);
            } else {
                unplaced.push(table);
            }
        }
        return { placed, unplaced };
    }

    // ── snapToGrid ────────────────────────────────────────────────────────────

    function snapToGrid(value, step) {
        const n = Number(value);
        if (!Number.isFinite(n)) return 0;
        const s = Number(step);
        if (!Number.isFinite(s) || s === 0) return n;
        return Math.round(n / s) * s;
    }

    // ── autoArrange ───────────────────────────────────────────────────────────

    const AUTO_ARRANGE_DEFAULT_W = 120;
    const AUTO_ARRANGE_DEFAULT_H = 120;
    const AUTO_ARRANGE_CELL = 150; // must be >= the largest table footprint used below
    const AUTO_ARRANGE_GAP = 20;
    const AUTO_ARRANGE_MARGIN = 20;
    const AUTO_ARRANGE_GRID_STEP = 10;

    function autoArrange(tables, room) {
        const list = Array.isArray(tables) ? tables : [];
        if (!room || !Number.isFinite(room.width) || !Number.isFinite(room.height) || room.width <= 0 || room.height <= 0) {
            // No usable room to arrange into — hand tables back untouched
            // rather than throwing, matching the "degrade gracefully" rule
            // that governs every other helper in this module.
            return list.map(t => Object.assign({}, t));
        }

        const step = AUTO_ARRANGE_CELL + AUTO_ARRANGE_GAP;
        const cols = Math.max(1, Math.floor((room.width - AUTO_ARRANGE_MARGIN * 2 + AUTO_ARRANGE_GAP) / step));

        return list.map((table, i) => {
            const col = i % cols;
            const row = Math.floor(i / cols);
            const w = (table.layout && Number.isFinite(table.layout.w)) ? table.layout.w : AUTO_ARRANGE_DEFAULT_W;
            const h = (table.layout && Number.isFinite(table.layout.h)) ? table.layout.h : AUTO_ARRANGE_DEFAULT_H;
            const x = snapToGrid(AUTO_ARRANGE_MARGIN + col * step, AUTO_ARRANGE_GRID_STEP);
            const y = snapToGrid(AUTO_ARRANGE_MARGIN + row * step, AUTO_ARRANGE_GRID_STEP);
            return Object.assign({}, table, { layout: { room: room.id, x, y, w, h } });
        });
    }

    // ── seatSides ─────────────────────────────────────────────────────────────

    function seatSides(seats) {
        const n = Math.max(0, Math.floor(Number(seats) || 0));
        const sides = { top: 0, bottom: 0, left: 0, right: 0 };
        for (let i = 0; i < n; i++) {
            sides[SIDE_ORDER[i % SIDE_ORDER.length]]++;
        }
        return sides;
    }

    // ── roomCorners ───────────────────────────────────────────────────────────

    function isFiniteCorner(c) {
        return !!c && typeof c === 'object' && Number.isFinite(c.x) && Number.isFinite(c.y);
    }

    function implicitRectangle(width, height) {
        return [
            { x: 0, y: 0 },
            { x: width, y: 0 },
            { x: width, y: height },
            { x: 0, y: height },
        ];
    }

    function roomCorners(room) {
        if (!room || typeof room !== 'object') return [];

        const corners = room.corners;
        if (Array.isArray(corners) && corners.length >= 3 && corners.every(isFiniteCorner)) {
            return corners.map(c => ({ x: c.x, y: c.y }));
        }

        const width = room.width;
        const height = room.height;
        if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
            return implicitRectangle(width, height);
        }

        return [];
    }

    // ── pointInPolygon ───────────────────────────────────────────────────────

    // Is `p` on the closed segment [a, b]? Colinear (near-zero cross product)
    // and within the segment's bounding extent (dot product test). Checked
    // explicitly, ahead of the ray-cast loop below, so boundary points are
    // deterministically "inside" rather than depending on which way a
    // ray-cast's strict inequalities happen to fall at that exact point.
    function pointOnSegment(p, a, b) {
        const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
        if (Math.abs(cross) > 1e-9) return false;
        const dot = (p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y);
        if (dot < 0) return false;
        const lenSq = (b.x - a.x) * (b.x - a.x) + (b.y - a.y) * (b.y - a.y);
        if (dot > lenSq) return false;
        return true;
    }

    function pointInPolygon(point, corners) {
        if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;

        // Garbage entries (null/undefined/non-finite coordinates) are
        // dropped rather than left to throw partway through the loops
        // below — "never throws" (design §4) beats precise behaviour on
        // malformed input nobody should be passing in the first place.
        const list = (Array.isArray(corners) ? corners : []).filter(isFiniteCorner);
        const n = list.length;
        if (n < 3) return false;

        // Boundary first — edges and vertices always count as inside.
        for (let i = 0; i < n; i++) {
            const a = list[i];
            const b = list[(i + 1) % n];
            if (pointOnSegment(point, a, b)) return true;
        }

        // Standard ray-casting (even-odd rule). Works for concave polygons
        // (e.g. an L-shape) as well as convex ones.
        let inside = false;
        for (let i = 0, j = n - 1; i < n; j = i++) {
            const xi = list[i].x, yi = list[i].y;
            const xj = list[j].x, yj = list[j].y;
            const intersects = ((yi > point.y) !== (yj > point.y)) &&
                (point.x < (xj - xi) * (point.y - yi) / (yj - yi) + xi);
            if (intersects) inside = !inside;
        }
        return inside;
    }

    // ── tableOutsideRoom ─────────────────────────────────────────────────────

    function tableOutsideRoom(table, room) {
        const layout = table && table.layout;
        if (!isFiniteLayout(layout)) return false; // unplaced — nothing to flag

        const corners = roomCorners(room);
        if (corners.length < 3) return false; // no usable polygon to test against

        const rectCorners = [
            { x: layout.x, y: layout.y },
            { x: layout.x + layout.w, y: layout.y },
            { x: layout.x + layout.w, y: layout.y + layout.h },
            { x: layout.x, y: layout.y + layout.h },
        ];
        return !rectCorners.every(c => pointInPolygon(c, corners));
    }

    // ── insertCornerAt / removeCornerAt ──────────────────────────────────────

    function insertCornerAt(corners, edgeIndex) {
        const list = Array.isArray(corners) ? corners : [];
        const n = list.length;
        if (n < 3) return corners;
        if (!Number.isInteger(edgeIndex) || edgeIndex < 0 || edgeIndex >= n) return corners;

        const a = list[edgeIndex];
        const b = list[(edgeIndex + 1) % n]; // wraps: last edge closes back to vertex 0
        if (!isFiniteCorner(a) || !isFiniteCorner(b)) return corners;

        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        return list.slice(0, edgeIndex + 1).concat([mid], list.slice(edgeIndex + 1));
    }

    function removeCornerAt(corners, index) {
        const list = Array.isArray(corners) ? corners : [];
        const n = list.length;
        if (!Number.isInteger(index) || index < 0 || index >= n) return corners;
        if (n <= 3) return corners; // floor — fewer than 3 points isn't a polygon

        return list.slice(0, index).concat(list.slice(index + 1));
    }

    // ── Czech pluralisation for the default seat-count sublabel ────────────

    function seatsLabel(n) {
        if (n === 1) return '1 místo';
        if (n >= 2 && n <= 4) return n + ' místa';
        return n + ' míst';
    }

    function defaultSublabel(table, state) {
        if (state === 'occupied') return 'obsazeno';
        if (state === 'too-small') return 'málo míst';
        const seats = typeof table.seats === 'number' && Number.isFinite(table.seats) ? table.seats : null;
        return seats !== null ? seatsLabel(seats) : '';
    }

    // ── DOM rendering ─────────────────────────────────────────────────────────

    function pct(value, total) {
        if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return 0;
        return (value / total) * 100;
    }

    function isValidRoom(room) {
        return !!room
            && typeof room.id === 'string' && room.id.length > 0
            && Number.isFinite(room.width) && room.width > 0
            && Number.isFinite(room.height) && room.height > 0;
    }

    function buildRoomSwitcher(rooms, activeRoomId, onRoomChange) {
        const wrap = document.createElement('div');
        wrap.className = 'fp-rooms';
        wrap.setAttribute('role', 'tablist');
        for (const room of rooms) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'ds-chip fp-rooms__chip' + (room.id === activeRoomId ? ' ds-chip--selected' : '');
            btn.setAttribute('role', 'tab');
            btn.setAttribute('aria-selected', room.id === activeRoomId ? 'true' : 'false');
            btn.textContent = room.name || room.id;
            btn.addEventListener('click', function () { onRoomChange(room.id); });
            wrap.appendChild(btn);
        }
        return wrap;
    }

    function buildChairBar(side, count) {
        const bar = document.createElement('div');
        bar.className = 'fp-chairs fp-chairs--' + side;
        for (let i = 0; i < count; i++) {
            const chair = document.createElement('span');
            chair.className = 'fp-chair';
            bar.appendChild(chair);
        }
        return bar;
    }

    function buildTable(table, room, onTableClick) {
        const layout = table.layout;
        const state = VALID_STATES.has(table.state) ? table.state : resolveTableState(table, {});

        const el = document.createElement('div');
        el.className = 'fp-table fp-table--' + state;
        el.style.left = pct(layout.x, room.width) + '%';
        el.style.top = pct(layout.y, room.height) + '%';
        el.style.width = pct(layout.w, room.width) + '%';
        el.style.height = pct(layout.h, room.height) + '%';

        const clickable = CLICKABLE_STATES.has(state) && typeof onTableClick === 'function';
        if (clickable) {
            el.classList.add('fp-table--clickable');
            el.setAttribute('role', 'button');
            el.setAttribute('tabindex', '0');
            el.addEventListener('click', function () { onTableClick(table.name); });
            el.addEventListener('keydown', function (e) {
                if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
                    e.preventDefault();
                    onTableClick(table.name);
                }
            });
        } else {
            el.setAttribute('aria-disabled', 'true');
        }

        const sides = seatSides(table.seats);
        for (const side of SIDE_ORDER) {
            if (sides[side] > 0) el.appendChild(buildChairBar(side, sides[side]));
        }

        const name = document.createElement('div');
        name.className = 'fp-table__name';
        name.textContent = table.name != null ? String(table.name) : '';
        el.appendChild(name);

        const sub = document.createElement('div');
        sub.className = 'fp-table__sublabel';
        sub.textContent = (table.sublabel != null && table.sublabel !== '') ? String(table.sublabel) : defaultSublabel(table, state);
        el.appendChild(sub);

        return el;
    }

    // ── Walls — SVG polygon, always the canvas's first child (design §3) ────
    // One code path for every room: roomCorners() already resolves explicit
    // corners vs. the implicit rectangle, so this never branches on whether
    // the room has a shape. Built with createElementNS — createElement does
    // NOT work for SVG elements (they silently fail to render).
    const SVG_NS = 'http://www.w3.org/2000/svg';

    function buildWalls(room) {
        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('class', 'fp-walls');
        svg.setAttribute('viewBox', '0 0 ' + room.width + ' ' + room.height);
        svg.setAttribute('preserveAspectRatio', 'none');
        svg.setAttribute('aria-hidden', 'true');

        const corners = roomCorners(room);
        const polygon = document.createElementNS(SVG_NS, 'polygon');
        polygon.setAttribute('points', corners.map(c => c.x + ',' + c.y).join(' '));
        polygon.setAttribute('vector-effect', 'non-scaling-stroke');
        svg.appendChild(polygon);

        return svg;
    }

    const DOOR_FACINGS = new Set(['left', 'right', 'up', 'down']);

    function buildFixture(fixture, room) {
        const type = fixture && fixture.type === 'door' ? 'door' : 'block';
        const el = document.createElement('div');
        el.className = 'fp-fixture fp-fixture--' + type;
        el.style.left = pct(fixture.x, room.width) + '%';
        el.style.top = pct(fixture.y, room.height) + '%';
        el.style.width = pct(fixture.w, room.width) + '%';
        el.style.height = pct(fixture.h, room.height) + '%';

        if (type === 'block') {
            const label = document.createElement('span');
            label.className = 'fp-fixture__label';
            label.textContent = fixture.label != null ? String(fixture.label) : '';
            el.appendChild(label);
        } else {
            const facing = DOOR_FACINGS.has(fixture.facing) ? fixture.facing : 'down';
            el.classList.add('fp-fixture--door-' + facing);
            const arc = document.createElement('div');
            arc.className = 'fp-door__arc';
            el.appendChild(arc);
            const leaf = document.createElement('div');
            leaf.className = 'fp-door__leaf';
            el.appendChild(leaf);
            if (fixture.label) {
                const label = document.createElement('span');
                label.className = 'fp-fixture__label fp-fixture__label--door';
                label.textContent = String(fixture.label);
                el.appendChild(label);
            }
        }
        return el;
    }

    function render(container, opts) {
        opts = opts || {};
        if (!container) return;

        // Clear previous render. Never uses innerHTML with interpolated
        // content anywhere in this module — table names and fixture labels
        // are user/admin-supplied text and always go through textContent.
        container.innerHTML = '';

        const rooms = (Array.isArray(opts.rooms) ? opts.rooms : []).filter(isValidRoom);
        if (rooms.length === 0) return; // graceful empty state — design §9

        const tables = Array.isArray(opts.tables) ? opts.tables : [];
        const onRoomChange = typeof opts.onRoomChange === 'function' ? opts.onRoomChange : null;
        const onTableClick = typeof opts.onTableClick === 'function' ? opts.onTableClick : null;

        const activeRoom = rooms.find(r => r.id === opts.activeRoomId) || rooms[0];

        const root = document.createElement('div');
        root.className = 'fp-root';

        if (onRoomChange) {
            root.appendChild(buildRoomSwitcher(rooms, activeRoom.id, onRoomChange));
        }

        const viewport = document.createElement('div');
        viewport.className = 'fp-viewport';

        const canvas = document.createElement('div');
        canvas.className = 'fp-canvas';
        canvas.style.aspectRatio = activeRoom.width + ' / ' + activeRoom.height;
        // Cap the DRAWN HEIGHT by capping the width the ratio derives it from.
        // .fp-canvas is width:100%, so a room that is taller than it is wide
        // grew without limit: the stock "Patro" room (300x490) rendered 1748px
        // tall in a 1070px column — five screens of scrolling for one room, on
        // the customer picker and the admin plan alike. Clamping max-width
        // (rather than max-height) is what keeps tables and fixtures square,
        // which is the entire reason the ratio is set here in the first place.
        // Pages override the cap with --fp-canvas-max-h.
        canvas.style.maxWidth = 'calc(var(--fp-canvas-max-h, 440px) * '
            + activeRoom.width + ' / ' + activeRoom.height + ')';

        // Walls first — everything else (fixtures, tables) layers on top.
        canvas.appendChild(buildWalls(activeRoom));

        const fixtures = Array.isArray(activeRoom.fixtures) ? activeRoom.fixtures : [];
        for (const fixture of fixtures) {
            if (fixture) canvas.appendChild(buildFixture(fixture, activeRoom));
        }

        const { placed } = partitionTables(tables, rooms);
        const roomTables = placed.filter(t => t.layout.room === activeRoom.id);
        for (const table of roomTables) {
            canvas.appendChild(buildTable(table, activeRoom, onTableClick));
        }

        viewport.appendChild(canvas);
        root.appendChild(viewport);
        container.appendChild(root);
    }

    const FloorPlan = {
        render,
        resolveTableState,
        partitionTables,
        snapToGrid,
        autoArrange,
        seatSides,
        roomCorners,
        pointInPolygon,
        tableOutsideRoom,
        insertCornerAt,
        removeCornerAt,
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = FloorPlan;
    global.FloorPlan = FloorPlan;
})(typeof window !== 'undefined' ? window : globalThis);
