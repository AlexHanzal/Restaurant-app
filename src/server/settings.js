// ============================================================================
// settings.js — the single "restaurant settings" record (collection
// "settings", id "restaurant") + enforcement helpers used by server.js.
//
// See docs/superpowers/specs/2026-07-19-go-live-operations-design.md §2-§3
// for the design this implements. Self-contained (only depends on db.js),
// same "black box" module pattern as validation.js/csrf.js/security.js.
//
// Design:
//   - DEFAULT_SETTINGS is the canonical shape. getSettings() deep-merges
//     whatever is stored (which may be an old, smaller shape — or nothing at
//     all on a fresh DB) OVER these defaults, key by key, so a field added
//     to this shape in a later release is transparently backfilled for every
//     existing installation without a migration script.
//   - saveSettings() runs incoming data through the same merge before
//     persisting, so what's actually stored is always the full canonical
//     shape too (defense in depth — even if a future caller bypassed the
//     zod schema in validation.js, the record on disk never regresses to a
//     partial/malformed shape).
//   - Arrays (closedDays, pscWhitelist) are REPLACED wholesale by whatever
//     was stored/submitted, never merged element-by-element — that's the
//     only sane semantics for "the list of closed days" etc.
//   - isReservationSlotOpen / isDeliveryOpenNow / quoteDelivery are pure
//     functions of (settings, ...) — no DB access — so routes fetch
//     getSettings() once per request and pass it in, and so these are easy
//     to unit-test in isolation.
// ============================================================================

const db = require("./db");
// Pure date/occupancy helpers, no db access — see timetable.js's header for
// why the weekday is DERIVED from the date here rather than trusted from the
// request body.
const timetable = require("./timetable");

const SETTINGS_COLLECTION = "settings";
const SETTINGS_ID = "restaurant";

// ── DEFAULTS (spec §2, verbatim shape; extended by spec §11 follow-up) ──
// Reservation days keyed "0".."6" = Po..Ne (Monday..Sunday), Monday-first —
// same dayIndex convention used throughout renderer.js/server.js (see
// dayIndexMonFirst() below and renderer.js's getDayIndexFromDateString()).
// go-live Task 6 (spec §11, owner follow-up decision): reservations used to
// stop at "4" (Po-Pá only); they now cover every day like delivery already
// did. Saturday/Sunday are ordinary rows here — open by default, same
// fromHour/toHour range as every other day — and the ONLY way to close one
// is the same per-weekday `open` toggle every other day has (no special
// weekend gate anywhere in the enforcement helpers or the UI). hourIndex
// range 1-12 still matches RESERVATION_HOURS (8:00-20:00) in renderer.js —
// extending the intraday hour grid stays out of scope (see spec §9).
//
// Delivery days keyed "0".."6" = Po..Ne (Monday..Sunday) — delivery always
// ran every day; reservations' keys now use the exact same convention so
// admin UI weekday ordering is consistent across both sections.
function buildDefaultSettings() {
    return {
        business: {
            name: "Ukázková restaurace s.r.o.",
            ico: "12345678",
            dic: "CZ12345678",
            address: "Náměstí Svobody 1, 602 00 Brno",
            email: "",
            phone: "",
            // go-live Task 5 (spec §7): optional fixed "účinnost od" date for
            // the legal template pages' {{EFFECTIVE_DATE}} token. Empty by
            // default — the legal-page renderer (server.js) then falls back
            // to today's date so the page never shows a blank/placeholder,
            // but once the owner/lawyer settles on a real effective date for
            // the reviewed text, setting this field freezes it (otherwise it
            // would silently drift to "today" forever on every request).
            termsEffectiveDate: "",
        },
        reservations: {
            paused: false,
            // How far ahead a customer may book, in days (0 = today only).
            // Matches RESERVATION_DAYS_AHEAD in renderer.js, which is what
            // the day strip renders — before this existed the client's 14
            // days were the ONLY limit, and the server happily accepted a
            // booking for 2099. Must stay declared in validation.js's
            // (strict) settingsSchema alongside this default.
            maxDaysAhead: 14,
            days: {
                "0": { open: true, fromHour: 1, toHour: 12 },
                "1": { open: true, fromHour: 1, toHour: 12 },
                "2": { open: true, fromHour: 1, toHour: 12 },
                "3": { open: true, fromHour: 1, toHour: 12 },
                "4": { open: true, fromHour: 1, toHour: 12 },
                "5": { open: true, fromHour: 1, toHour: 12 },
                "6": { open: true, fromHour: 1, toHour: 12 },
            },
        },
        delivery: {
            paused: false,
            days: {
                "0": { open: true, from: "10:30", to: "21:00" },
                "1": { open: true, from: "10:30", to: "21:00" },
                "2": { open: true, from: "10:30", to: "21:00" },
                "3": { open: true, from: "10:30", to: "21:00" },
                "4": { open: true, from: "10:30", to: "21:00" },
                "5": { open: true, from: "10:30", to: "21:00" },
                "6": { open: true, from: "10:30", to: "21:00" },
            },
            fee: 49,
            minOrder: 200,
            freeAbove: 600,
            pscWhitelist: ["12000", "12800"],
            etaMinutes: 60,
            // Distance-ranked driver list + batching of nearby orders —
            // docs/superpowers/specs/2026-08-08-delivery-routing-design.md.
            //
            // Every weight below is in KILOMETRES so they can be added and
            // subtracted in one score (spec §5). `enabled: false` turns off
            // geocoding entirely and leaves the driver list as it was
            // before this feature — that is also the opt-out for an owner
            // who does not want addresses sent to OpenStreetMap (§17).
            routing: {
                enabled: true,
                // Capped at 6 by routingSchema: planBatch() brute-forces
                // every permutation to get a provably optimal stop order.
                maxStops: 3,
                // No two stops in a batch are ever further apart than this.
                groupRadiusM: 800,
                // How long a batch keeps accepting new members, measured
                // from its OLDEST order.
                batchWindowMinutes: 10,
                // Waiting time below this earns no priority at all.
                ageGraceMinutes: 30,
                // ...and above it, each minute is worth this many km of
                // head start. 0.5 => a 45-min-old order behaves as if it
                // were 7.5 km closer than it is.
                agePriorityKmPerMinute: 0.5,
                // What one saved return trip is worth, per extra stop.
                batchBonusKm: 1.5,
                // Manual override for the restaurant's own coordinates.
                // null => geocoded from business.address on demand.
                originLat: null,
                originLon: null,
            },
        },
        // Customer QR self-order at tables (spec: docs/superpowers/specs/
        // 2026-08-04-table-qr-self-order-design.md §7). Same day/hours shape
        // as `delivery` above, deliberately — the admin UI reuses the very
        // same hours table renderer.
        //
        // `enabled` defaults to FALSE, unlike delivery. Printing and placing
        // the QR codes IS the deployment step for this feature; an install
        // that has never printed one must not be silently accepting
        // anonymous orders from anyone who guesses the URL shape.
        tableOrdering: {
            enabled: false,
            days: {
                "0": { open: true, from: "11:00", to: "21:00" },
                "1": { open: true, from: "11:00", to: "21:00" },
                "2": { open: true, from: "11:00", to: "21:00" },
                "3": { open: true, from: "11:00", to: "21:00" },
                "4": { open: true, from: "11:00", to: "21:00" },
                "5": { open: true, from: "11:00", to: "21:00" },
                "6": { open: true, from: "11:00", to: "21:00" },
            },
        },
        closedDays: [], // [{ date: "YYYY-MM-DD", note: "Vánoce" }, ...]
        dailyMenu: { enabled: true, from: "11:00", to: "14:00" },
        notifications: {
            smsOrderConfirmed: true,
            smsOrderOnTheWay: true,
            smsReservationConfirmed: true,
            smsReservationReminder: false, // reminders cost money, default off
            emailEnabled: true,
        },
        // Floorplan (docs/superpowers/specs/2026-07-27-floorplan-table-
        // picking-design.md §4.2): rooms + fixtures for the customer/waiter/
        // overview floorplan and the admin *Rozložení* editor. Seeded here
        // (rather than left empty) so every install — including ones that
        // never touch the *Rozložení* tab — gets the real two-room layout
        // matching the owner's reference images out of the box; per §9, an
        // empty/missing `rooms` array is also handled (falls back to the
        // flat "Nezařazené stoly" list everywhere), so this default is a
        // convenience, not a requirement the rest of the system leans on.
        // Coordinates/dimensions are verbatim from the design doc, which in
        // turn matches the owner-supplied reference images pixel-for-pixel
        // in proportion (not literal pixels — see design §4.3, these are
        // abstract room units rendered as percentages of width/height).
        floorplan: {
            rooms: [
                {
                    id: "main",
                    name: "Hlavní místnost",
                    width: 1000,
                    height: 430,
                    fixtures: [
                        { type: "block", label: "KUCHYŇ", x: 0, y: 0, w: 620, h: 105 },
                        { type: "door", label: "", x: 900, y: 300, w: 100, h: 100, facing: "left" },
                    ],
                    // Room shape editing (docs/superpowers/specs/2026-07-28-
                    // room-shape-editing-design.md §2): explicit corners, in
                    // room units, clockwise from the top-left, matching this
                    // room's own width/height exactly — i.e. the same
                    // rectangle `roomCorners()` would fall back to anyway.
                    // Written out here (rather than left implicit) purely so
                    // the corner handles are visible and draggable the first
                    // time an owner opens the *Rozložení* editor, on both a
                    // fresh install and an existing one (picked up via the
                    // deep merge below).
                    corners: [
                        { x: 0, y: 0 }, { x: 1000, y: 0 },
                        { x: 1000, y: 430 }, { x: 0, y: 430 },
                    ],
                },
                {
                    id: "upstairs",
                    name: "Patro",
                    width: 300,
                    height: 490,
                    fixtures: [
                        { type: "block", label: "SCHODY", x: 0, y: 0, w: 133, h: 245 },
                    ],
                    // Same as "main" above: explicit corners matching this
                    // room's own 300x490 box.
                    corners: [
                        { x: 0, y: 0 }, { x: 300, y: 0 },
                        { x: 300, y: 490 }, { x: 0, y: 490 },
                    ],
                },
            ],
        },
    };
}

const DEFAULT_SETTINGS = buildDefaultSettings();

// ── DEEP MERGE (defaults <- stored/submitted) ───────────────────────────

function isPlainObject(v) {
    return !!v && typeof v === "object" && !Array.isArray(v);
}

// Returns a value shaped exactly like `defaults`:
//   - plain objects are merged key-by-key, recursively (missing keys in
//     `value` fall back to the matching default; extra keys in `value` that
//     aren't in `defaults` are dropped — the canonical shape is always
//     `defaults`' shape).
//   - arrays are replaced wholesale by `value` when `value` is itself an
//     array, otherwise fall back to (a copy of) the default array.
//   - primitives fall back to the default when `value` is undefined; any
//     other value (including false/0/"") is taken as-is.
function mergeDefaults(defaults, value) {
    if (Array.isArray(defaults)) {
        return Array.isArray(value) ? value : defaults.slice();
    }
    if (isPlainObject(defaults)) {
        const src = isPlainObject(value) ? value : {};
        const out = {};
        for (const key of Object.keys(defaults)) {
            out[key] = mergeDefaults(defaults[key], src[key]);
        }
        return out;
    }
    return value !== undefined ? value : defaults;
}

// ── READ / WRITE ─────────────────────────────────────────────────────────

function getSettings() {
    const stored = db.get(SETTINGS_COLLECTION, SETTINGS_ID);
    return mergeDefaults(DEFAULT_SETTINGS, stored);
}

function saveSettings(obj) {
    const merged = mergeDefaults(DEFAULT_SETTINGS, obj);
    db.set(SETTINGS_COLLECTION, SETTINGS_ID, merged);
    return merged;
}

// ── DATE/TIME HELPERS ────────────────────────────────────────────────────
// Local-date/time based (not toISOString, which converts to UTC and can
// shift the date/hour depending on timezone offset) — same reasoning as
// getDateString() in renderer.js.

function formatDateStrLocal(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
}

function formatHHMM(date) {
    const h = String(date.getHours()).padStart(2, "0");
    const m = String(date.getMinutes()).padStart(2, "0");
    return `${h}:${m}`;
}

// Monday-first weekday index (0=Po..6=Ne) from a JS Date, whose own
// getDay() is Sunday-first (0=Ne..6=So). Used for settings.delivery.days,
// which — unlike reservations (weekdays-only) — covers all 7 days.
function dayIndexMonFirst(date) {
    return (date.getDay() + 6) % 7;
}

// ── CLOSED DAYS (shared by reservations AND delivery — spec §2) ─────────

function findClosedDay(settings, dateStr) {
    const list = Array.isArray(settings.closedDays) ? settings.closedDays : [];
    return list.find(d => d && d.date === dateStr) || null;
}

// ── ENFORCEMENT HELPERS (server is the authority — spec §2) ─────────────

// dateStr: "YYYY-MM-DD"; hourIndex: 1-12; duration: whole hours (>=1);
// now: a JS Date (defaults to "right now"), injected so this stays a pure
// function and its date rules are testable — same as isDeliveryOpenNow.
// Returns { ok, reason } — reason is a ready-to-show Czech message when ok
// is false, null otherwise.
//
// NOTE (2026-08-09 review, fix 1): there is deliberately NO dayIndex
// parameter. It used to be one, taken straight from the request body and
// validated only as "an integer 0-6", so a caller could pair a Saturday's
// dateStr with Monday's dayIndex and be checked against the wrong weekday's
// rules — booking a day the restaurant had closed. The weekday is now
// derived from dateStr, which makes that mismatch unrepresentable rather
// than merely rejected. Callers that need the index for storage get it from
// timetable.dayIndexFromDateStr() the same way this does.
function isReservationSlotOpen(settings, dateStr, hourIndex, duration, now = new Date()) {
    const resv = settings.reservations || {};

    if (resv.paused) {
        return { ok: false, reason: "Rezervace jsou dočasně pozastaveny." };
    }

    // fix 2: dateStr used to be validated only as "a non-empty string of at
    // most 20 characters" (reqStr in validation.js), so "aaaa" was a
    // bookable date — it just created a junk key in the timetable record.
    const date = timetable.parseDateStr(dateStr);
    if (!date) {
        return { ok: false, reason: "Neplatné datum." };
    }

    if (findClosedDay(settings, dateStr)) {
        return { ok: false, reason: "V tento den je zavřeno, rezervace není možná." };
    }

    // fix 2, the past: date-granular first, then the hour within today.
    // hourIndex 1-12 maps to 8:00-20:00 (RESERVATION_HOURS in renderer.js),
    // so the slot's real start hour is hourIndex + 7 — a booking made at
    // 19:00 for today at 8:00 was previously accepted by the server AND
    // offered by the client's time grid.
    const todayStr = formatDateStrLocal(now);
    if (dateStr < todayStr) {
        return { ok: false, reason: "Tento termín už je v minulosti." };
    }
    if (dateStr === todayStr && Number(hourIndex) + 7 <= now.getHours()) {
        return { ok: false, reason: "Tento termín už je v minulosti." };
    }

    // fix 2, the future: bound the booking horizon server-side.
    const maxDaysAhead = Number.isInteger(resv.maxDaysAhead) ? resv.maxDaysAhead : 14;
    const horizon = new Date(now.getFullYear(), now.getMonth(), now.getDate() + maxDaysAhead);
    if (date > horizon) {
        return { ok: false, reason: `Rezervovat lze nejvýše ${maxDaysAhead} dní dopředu.` };
    }

    // go-live Task 6: no weekday-vs-weekend distinction here — per-day
    // closing (including weekends) is entirely driven by resv.days[k].open
    // below. The index itself can no longer be out of range: it comes from
    // the calendar, not the caller.
    const dayIndex = timetable.dayIndexFromDateStr(dateStr);

    const day = resv.days && resv.days[String(dayIndex)];
    if (!day || !day.open) {
        return { ok: false, reason: "V tento den rezervace nepřijímáme." };
    }

    const dur = Number.isInteger(duration) && duration > 0 ? duration : 1;
    const h = Number(hourIndex);
    const endHour = h + dur - 1;

    if (!Number.isInteger(h) || h < day.fromHour || endHour > day.toHour) {
        return { ok: false, reason: "Vybraný čas je mimo otevírací dobu rezervací." };
    }

    return { ok: true, reason: null };
}

// now: a JS Date (defaults to "right now"). Returns { ok, reason, today } —
// `today` is this weekday's delivery.days entry ({open, from, to}) when one
// exists, so callers (e.g. a client-side banner) can show today's hours
// without a second lookup; null when the day itself is fully closed/absent.
function isDeliveryOpenNow(settings, now = new Date()) {
    const delivery = settings.delivery || {};

    if (delivery.paused) {
        return { ok: false, reason: "Rozvoz je dočasně pozastaven.", today: null };
    }

    const dateStr = formatDateStrLocal(now);
    if (findClosedDay(settings, dateStr)) {
        return { ok: false, reason: "Rozvoz je momentálně uzavřen.", today: null };
    }

    const dayKey = String(dayIndexMonFirst(now));
    const day = delivery.days && delivery.days[dayKey];
    if (!day || !day.open) {
        return { ok: false, reason: "Rozvoz je momentálně uzavřen.", today: day || null };
    }

    const hhmm = formatHHMM(now);
    if (hhmm < day.from || hhmm > day.to) {
        return { ok: false, reason: "Rozvoz je momentálně uzavřen.", today: day };
    }

    return { ok: true, reason: null, today: day };
}

// Table QR self-ordering gate. Same contract as isDeliveryOpenNow above —
// { ok, reason, today } — so the guest page can render today's hours without
// a second lookup. POST /table-orders re-checks this for real; the page's
// own banner is only the front-of-house reflection of it.
//
// Note the inverted flag: delivery has `paused` (opt-out), this has
// `enabled` (opt-in). See the DEFAULT_SETTINGS comment for why.
function isTableOrderingOpenNow(settings, now = new Date()) {
    const cfg = settings.tableOrdering || {};

    if (!cfg.enabled) {
        return { ok: false, reason: "Objednávky u stolu nejsou momentálně dostupné.", today: null };
    }

    const dateStr = formatDateStrLocal(now);
    if (findClosedDay(settings, dateStr)) {
        return { ok: false, reason: "Dnes máme zavřeno.", today: null };
    }

    const dayKey = String(dayIndexMonFirst(now));
    const day = cfg.days && cfg.days[dayKey];
    if (!day || !day.open) {
        return { ok: false, reason: "Objednávky u stolu jsou momentálně uzavřeny.", today: day || null };
    }

    const hhmm = formatHHMM(now);
    if (hhmm < day.from || hhmm > day.to) {
        return { ok: false, reason: `Objednávky u stolu přijímáme ${day.from}–${day.to}.`, today: day };
    }

    return { ok: true, reason: null, today: day };
}

// itemsTotalCzk: cart subtotal (Kč, before delivery fee); psc: customer's
// postal code (string, digits only expected but not enforced here — the
// caller/zod schema is the shape gate). Returns { ok, fee, reason }.
// NOTE: does not check opening hours/pause — that's isDeliveryOpenNow's
// job; this is purely the pricing/eligibility quote (min order, PSČ
// whitelist, free-above threshold), per spec §2/§4. Task 2 wires this into
// POST /orders; implemented fully now per the Task 1 brief so Task 2 has
// nothing left to design here.
function quoteDelivery(settings, itemsTotalCzk, psc) {
    const delivery = settings.delivery || {};
    const total = Number(itemsTotalCzk) || 0;

    if (delivery.paused) {
        return { ok: false, fee: 0, reason: "Rozvoz je dočasně pozastaven." };
    }

    const minOrder = Number(delivery.minOrder) || 0;
    if (total < minOrder) {
        return { ok: false, fee: 0, reason: `Minimální hodnota objednávky pro rozvoz je ${minOrder} Kč.` };
    }

    const whitelist = Array.isArray(delivery.pscWhitelist) ? delivery.pscWhitelist : [];
    if (whitelist.length > 0) {
        const cleanPsc = String(psc || "").trim();
        if (!whitelist.includes(cleanPsc)) {
            return { ok: false, fee: 0, reason: "Do zadaného PSČ bohužel nerozvážíme." };
        }
    }

    const freeAbove = Number(delivery.freeAbove) || 0;
    const fee = (freeAbove > 0 && total >= freeAbove) ? 0 : (Number(delivery.fee) || 0);

    return { ok: true, fee, reason: null };
}

// now: a JS Date (defaults to "right now"). Returns { ok, reason } — used by
// BOTH GET /api/daily-menu (public path, no ?date= override) and
// priceOrderItems() in server.js (go-live Task 3, spec §5) so an order
// containing a daily-menu item is only ever accepted while the same window
// a customer could actually see the item in is open. Mirrors
// isDeliveryOpenNow()'s shape but for the simpler dailyMenu.{enabled,from,to}
// rule (no per-weekday days map, no pause/closedDays — daily specials are a
// same-day-only concept, spec §5 explicitly says sold-out logic doesn't
// apply to them either).
function isDailyMenuWindowOpen(settings, now = new Date()) {
    const daily = settings.dailyMenu || {};

    if (!daily.enabled) {
        return { ok: false, reason: "Polední menu dnes není k dispozici." };
    }

    const hhmm = formatHHMM(now);
    if (hhmm < daily.from || hhmm > daily.to) {
        return { ok: false, reason: `Polední menu je k dispozici pouze ${daily.from}–${daily.to}.` };
    }

    return { ok: true, reason: null };
}

module.exports = {
    DEFAULT_SETTINGS,
    getSettings,
    saveSettings,
    isReservationSlotOpen,
    isDeliveryOpenNow,
    isTableOrderingOpenNow,
    quoteDelivery,
    isDailyMenuWindowOpen,
    // exported for tests / reuse, not part of the "public API" surface used
    // by server.js routes:
    mergeDefaults,
    dayIndexMonFirst,
    // Re-exported from timetable.js so routes that already hold
    // `settingsStore` can derive a booking's weekday without a second
    // require — see isReservationSlotOpen's note about fix 1.
    dayIndexFromDateStr: timetable.dayIndexFromDateStr,
    formatDateStrLocal,
    formatHHMM,
};
