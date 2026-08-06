// Configure API URL - will be set by config.js
const API_BASE_URL = window.API_BASE_URL || `http://${window.location.hostname}:3000`;
// window.APP_BASE_PATH comes from config.js (server.basePath — see brand.js),
// which loads before this file on every page. Falls back to "/reservation"
// so a stale cached config.js degrades rather than breaking (finding C2).
const API_URL = `${API_BASE_URL}${window.APP_BASE_PATH || '/reservation'}/api`;

// How many days ahead the day strip offers — easy to grow (spec §3).
const RESERVATION_DAYS_AHEAD = 14;

let timetables = {};

// ─── RESTAURANT SETTINGS (hours, closed days, pause) ────────────────────────
// Fetched once on load from the public GET /settings (src/server/settings.js
// is the canonical shape/authority). The server enforces every rule for
// real on /reservations/send-code and /verify-and-book — this client-side
// copy is advisory only, used to keep the day strip/time grid honest about
// what's actually bookable so customers don't pick a slot the server will
// then reject.
let restaurantSettings = null;

async function fetchRestaurantSettings() {
    try {
        const res = await fetch(`${API_URL}/settings`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        restaurantSettings = await res.json();
    } catch (e) {
        console.error('Failed to load restaurant settings:', e);
        restaurantSettings = null; // fail-open on the client (server still enforces) so the page stays usable
    }
    return restaurantSettings;
}

// go-live Task 5 (spec §7): fills in the footer's business-identity line
// from settings.business once fetched — replaces the static "[doplnit]"
// placeholder text that used to be hardcoded in index.html. Fails silently
// (leaves the line blank) if settings didn't load — same fail-open spirit
// as the rest of this section.
function renderFooterBusinessLine() {
    const el = document.getElementById('footerBusinessLine');
    if (!el || !restaurantSettings) return;
    const b = restaurantSettings.business || {};
    const contact = [b.email, b.phone].filter(Boolean).join(' / ');
    el.textContent = [b.name, b.ico ? `IČO: ${b.ico}` : '', b.address, contact]
        .filter(Boolean)
        .join(' · ');
}

function reservationsArePaused() {
    return !!(restaurantSettings && restaurantSettings.reservations && restaurantSettings.reservations.paused);
}

function isDateClosed(dateStr) {
    const list = restaurantSettings && Array.isArray(restaurantSettings.closedDays) ? restaurantSettings.closedDays : [];
    return list.some(cd => cd && cd.date === dateStr);
}

function reservationDayConfig(dayIndex) {
    const days = restaurantSettings && restaurantSettings.reservations && restaurantSettings.reservations.days;
    return (days && days[String(dayIndex)]) || null;
}

function isWeekdayOpenForReservations(dayIndex) {
    if (!restaurantSettings) return true; // settings failed to load — don't block the whole page on that
    // go-live Task 6 (spec §11): all 7 days are potentially bookable now —
    // the only day-level gate is settings.reservations.days[k].open, same as
    // every other weekday. This bound just rejects a malformed index.
    if (dayIndex < 0 || dayIndex > 6) return false;
    const day = reservationDayConfig(dayIndex);
    return !!(day && day.open);
}

// Returns the bookable hourIndex range (1-12) for a weekday, falling back to
// the full 8:00-20:00 grid when settings haven't loaded or the day has no
// explicit config (keeps the page usable before/without a settings record).
function getReservationHourRange(dayIndex) {
    const day = reservationDayConfig(dayIndex);
    if (day && day.open) return { from: day.fromHour, to: day.toHour };
    return { from: 1, to: 12 };
}

// Shows the full-page "paused" notice instead of the day strip/time grid/
// tables sections, or hides it and shows those sections again.
function applyReservationPausedUi() {
    const paused = reservationsArePaused();
    const pausedSection = document.getElementById('rsvPausedSection');
    const partySizeSection = document.getElementById('rsvPartySizeSection');
    const dayStripSection = document.getElementById('rsvDayStripSection');
    const timeGridSection = document.getElementById('rsvTimeGridSection');
    const tablesSection = document.getElementById('rsvTablesSection');
    if (pausedSection) pausedSection.style.display = paused ? 'block' : 'none';
    if (partySizeSection) partySizeSection.style.display = paused ? 'none' : 'block';
    if (dayStripSection) dayStripSection.style.display = paused ? 'none' : 'block';
    if (timeGridSection) timeGridSection.style.display = paused ? 'none' : 'block';
    if (tablesSection) tablesSection.style.display = paused ? 'none' : 'block';
}

// Hour slots (index 1-12, matching hourObj keys) — the restaurant's full
// opening-hours grid; a table's specific bookings are layered on top of
// this fixed set in the time grid below.
const RESERVATION_HOURS = [
    '8:00-9:00', '9:00-10:00', '10:00-11:00', '11:00-12:00',
    '12:00-13:00', '13:00-14:00', '14:00-15:00', '15:00-16:00',
    '16:00-17:00', '17:00-18:00', '18:00-19:00', '19:00-20:00'
];

const DOW_LABELS = ['Ne', 'Po', 'Út', 'St', 'Čt', 'Pá', 'So']; // Date.getDay() index
const MONTH_LABELS = ['Leden', 'Únor', 'Březen', 'Duben', 'Květen', 'Červen',
    'Červenec', 'Srpen', 'Září', 'Říjen', 'Listopad', 'Prosinec'];

// Reservation flow state
let reservationSelectedDate = null;    // 'YYYY-MM-DD'
let reservationSelectedHour = null;    // 1-12
let reservationSelectedDuration = 1;   // hours
let reservationTargetTable = null;     // table name currently being booked in the sheet
// floorplan-table-picking design §6.1: party size, independent of date/time
// (own .rsv-section above the day strip), defaults to 2. Drives which tables
// render "too-small" in renderTablesList() below and is sent as `guests` on
// booking.
let reservationSelectedPartySize = 2;
// Which room's tab is showing in the floorplan canvas (design §5.1's
// activeRoomId) — kept across re-renders (date/hour/party-size changes)
// rather than always resetting to the first room.
let rsvActiveRoomId = null;

// ─── ORDER (menu, shared with inner.js via server API) ────────────────────

const MENU_CATEGORIES = [
    { id: 'main',  label: 'Hlavní jídla' },
    { id: 'side',  label: 'Přílohy' },
    { id: 'drinks',label: 'Nápoje' },
    { id: 'desserts', label: 'Dezerty' },
];

let currentMenu = {};
// currentOrder is keyed two different ways depending on line type:
//   regular dish line: key = dishId,                          value = { item, price, qty }
//   combo line:         key = "combo:<comboId>:<n>" (unique),  value = { id: "combo:<comboId>", item, price, qty, comboConfig }
// The combo key's trailing ":<n>" (see comboLineCounter below) is what lets
// the same combo be added multiple times with different customizations
// without colliding — per spec, identical configs are NOT merged either.
let currentOrder = {};

async function fetchMenuForOrder() {
    try {
        const res = await fetch(`${API_URL}/menu`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        currentMenu = await res.json();
    } catch (e) {
        console.error('Failed to load menu:', e);
        currentMenu = {};
    }
    return currentMenu;
}

// ─── COMBO MENUS ("Zvýhodněná menu") ────────────────────────────────────────
// go-live combo-menus feature (docs/superpowers/specs/2026-07-22-combo-menus-
// design.md is the binding contract — read it before touching this section).
// Combos are restaurant-configured set menus (admin CRUD lives in inner.js)
// that customers can customize here: swap a slot's dish for an allowed
// alternative, remove a removable slot, add paid extras, and attach a note.
// Fetched read-only via GET /combos, in parallel with the regular menu (see
// openReservationSheet below). Everything in this section is DISPLAY ONLY —
// priceOrderItems()'s `combo:` branch in server.js is the actual authority on
// price/availability and re-validates every line from scratch when the order
// is submitted, so a stale/tampered client can't get a wrong price through.
const COMBO_ITEM_ID_PREFIX = 'combo:'; // mirrors DAILY_ITEM_ID_PREFIX's server-side namespacing convention

let currentCombos = []; // raw array from GET /combos, admin-authored order preserved
let comboLineCounter = 0; // see currentOrder key-shape comment above

// The combo sheet's in-progress state while the customer is customizing one
// (null when the sheet is closed / nothing is being configured). Committed
// into currentOrder as ONE line only when "Přidat" is pressed — cancelling
// or dismissing the sheet just discards this.
let comboSheetState = null; // { combo, slotSelections: {slotId: 'default'|'remove'|'swap:<dishId>'}, extras: Set<extraId> }

async function fetchCombosForOrder() {
    try {
        const res = await fetch(`${API_URL}/combos`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        currentCombos = Array.isArray(data) ? data : [];
    } catch (e) {
        console.error('Failed to load combos:', e);
        currentCombos = []; // fail-open: the food preorder still works, it just won't offer combos
    }
    return currentCombos;
}

// Finds a menu dish by id across every category of currentMenu (mirrors
// flattenMenuDishes()+findMenuDish() server-side, minus the name-fallback —
// combos always reference dishes by id). Used for default/swap dish lookups;
// does NOT filter by soldOut — callers decide what soldOut means for them
// (defaults are always shown per spec; swap alternatives are filtered below).
function findOrderDishById(dishId) {
    if (dishId == null) return null;
    for (const categoryId of Object.keys(currentMenu)) {
        const list = currentMenu[categoryId];
        if (!Array.isArray(list)) continue;
        const found = list.find(d => d.id === dishId);
        if (found) return found;
    }
    return null;
}

// Combos actually orderable right now: not soldOut, and every slot's default
// dish still exists on the live menu. Mirrors this page's existing "hide
// sold-out entirely" rule for dishes in a preorder context (see the comment
// in renderOrderPicker) — a combo referencing a vanished dish is equally
// unorderable, so it's hidden rather than shown broken.
function getAvailableCombos() {
    if (!Array.isArray(currentCombos)) return [];
    return currentCombos.filter(combo => {
        if (!combo || combo.soldOut) return false;
        if (!Array.isArray(combo.items) || combo.items.length === 0) return false;
        return combo.items.every(slot => !!findOrderDishById(slot.dishId));
    });
}

// "Polévka + Hlavní jídlo + Nápoj" — the default contents, for the browsable
// combo row (before any customization).
function comboContentsSummary(combo) {
    return (combo.items || [])
        .map(slot => {
            const dish = findOrderDishById(slot.dishId);
            return dish ? dish.name : null;
        })
        .filter(Boolean)
        .join(' + ');
}

// `n === 0` renders as "0 Kč" (no sign) — used for a swap that happens to
// cost the same as the default. Unicode minus '−' matches buildStepper's
// minus button elsewhere on this page, not a plain hyphen.
function formatSignedKc(n) {
    const v = Math.round(n);
    if (v === 0) return '0 Kč';
    return `${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(0)} Kč`;
}

// Reads the sheet's live radio/checkbox state into the { removed, swaps,
// extras, note } shape used both for pricing/display-name and for the
// eventual comboConfig sent to the server.
function comboConfigFromSheetState() {
    const st = comboSheetState;
    const removed = [];
    const swaps = {};
    Object.entries(st.slotSelections).forEach(([slotId, selection]) => {
        if (selection === 'remove') removed.push(slotId);
        else if (selection && selection.startsWith('swap:')) swaps[slotId] = selection.slice('swap:'.length);
    });
    return {
        removed,
        swaps,
        extras: Array.from(st.extras),
        note: (document.getElementById('rsvComboNoteInput')?.value || '').trim(),
    };
}

// Client-side mirror of the server's unit-price formula (spec's "Cart line &
// server-side pricing" section) — display only, server recomputes for real:
//   combo.price − Σ removeValue(removed) + Σ (swapDish.price − defaultDish.price) + Σ extra.price, clamped ≥ 0
function computeComboUnitPrice(combo, config) {
    let price = Number(combo.price) || 0;
    const removedSet = new Set(config.removed || []);

    (combo.items || []).forEach(slot => {
        if (removedSet.has(slot.slotId)) {
            price -= Number(slot.removeValue) || 0;
            return;
        }
        const swapDishId = config.swaps && config.swaps[slot.slotId];
        if (swapDishId) {
            const swapDish = findOrderDishById(swapDishId);
            const defaultDish = findOrderDishById(slot.dishId);
            if (swapDish && defaultDish) {
                price += (Number(swapDish.price) || 0) - (Number(defaultDish.price) || 0);
            }
        }
    });

    (config.extras || []).forEach(extraId => {
        const extra = (combo.extras || []).find(e => e.id === extraId);
        if (extra) price += Number(extra.price) || 0;
    });

    return Math.max(0, price);
}

// Builds the human-readable breakdown name shown in the order list — mirrors
// the server's stored-name format exactly (spec example: "Menu 1 (bez
// polévky, Fanta místo Coca-Cola, + Extra sýr, pozn.: bez cibule)") so what
// the customer sees here matches what ends up on the kitchen ticket/receipt.
// No changes → just the combo name, no parentheses.
function buildComboDisplayName(combo, config) {
    const parts = [];
    const removedSet = new Set(config.removed || []);

    (combo.items || []).forEach(slot => {
        const defaultDish = findOrderDishById(slot.dishId);
        const defaultName = defaultDish ? defaultDish.name : '?';
        if (removedSet.has(slot.slotId)) {
            parts.push(`bez ${defaultName}`);
            return;
        }
        const swapDishId = config.swaps && config.swaps[slot.slotId];
        if (swapDishId) {
            const swapDish = findOrderDishById(swapDishId);
            if (swapDish) parts.push(`${swapDish.name} místo ${defaultName}`);
        }
    });

    (config.extras || []).forEach(extraId => {
        const extra = (combo.extras || []).find(e => e.id === extraId);
        if (extra) parts.push(`+ ${extra.name}`);
    });

    if (config.note) parts.push(`pozn.: ${config.note}`);

    return parts.length > 0 ? `${combo.name} (${parts.join(', ')})` : combo.name;
}

// Commits the sheet's current selections into currentOrder as ONE new line
// (never merged with an existing identical one — see currentOrder key-shape
// comment up top) and re-renders the picker so the new line's stepper shows
// up immediately.
function addComboLineToOrder(combo, config) {
    const price = computeComboUnitPrice(combo, config);
    const item = buildComboDisplayName(combo, config);
    const key = `${COMBO_ITEM_ID_PREFIX}${combo.id}:${comboLineCounter++}`;

    // Only stamp the fields that actually differ from the combo's defaults —
    // an all-default customization still gets comboConfig: {} (every field
    // is optional per the contract), which is exactly what "no changes" means.
    const comboConfig = {};
    if (config.removed.length > 0) comboConfig.removed = config.removed;
    if (Object.keys(config.swaps).length > 0) comboConfig.swaps = config.swaps;
    if (config.extras.length > 0) comboConfig.extras = config.extras;
    if (config.note) comboConfig.note = config.note;

    currentOrder[key] = {
        id: `${COMBO_ITEM_ID_PREFIX}${combo.id}`,
        item,
        price,
        qty: 1,
        comboConfig,
    };
    renderOrderPicker();
}

function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, ch => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));
}

// Builds a .ds-stepper (− n +) element; calls onChange(newQty) on every click.
function buildStepper(initialQty, onChange) {
    const wrap = document.createElement('div');
    wrap.className = 'ds-stepper';

    const minus = document.createElement('button');
    minus.type = 'button';
    minus.className = 'ds-stepper__btn';
    minus.textContent = '−';
    minus.setAttribute('aria-label', 'Ubrat');

    const val = document.createElement('span');
    val.className = 'ds-stepper__value';

    const plus = document.createElement('button');
    plus.type = 'button';
    plus.className = 'ds-stepper__btn';
    plus.textContent = '+';
    plus.setAttribute('aria-label', 'Přidat');

    let current = initialQty;
    const render = () => {
        val.textContent = String(current);
        minus.disabled = current <= 0;
    };
    render();

    minus.addEventListener('click', () => {
        current = Math.max(0, current - 1);
        render();
        onChange(current);
    });
    plus.addEventListener('click', () => {
        current += 1;
        render();
        onChange(current);
    });

    wrap.appendChild(minus);
    wrap.appendChild(val);
    wrap.appendChild(plus);
    return wrap;
}

// ─── COMBO CUSTOMIZE SHEET (rsvComboSheet) ──────────────────────────────────
// A second .ds-sheet, stacked on top of the booking sheet (see the z-index
// comment on .rsv-combo-sheet in reservation.css) — opened by "Přizpůsobit"
// on a combo row, closed by "Zrušit"/backdrop click/successful "Přidat".

function openComboCustomizeSheet(combo) {
    const slotSelections = {};
    (combo.items || []).forEach(slot => { slotSelections[slot.slotId] = 'default'; });
    comboSheetState = { combo, slotSelections, extras: new Set() };
    renderComboSheetContents();
    openSheet('rsvComboSheetBackdrop', 'rsvComboSheet');
}

function closeComboCustomizeSheet() {
    comboSheetState = null;
    closeSheet('rsvComboSheetBackdrop', 'rsvComboSheet');
}

// (Re)builds the sheet's slot radios + extras checkboxes + note field from
// comboSheetState, and wires each control's change handler to update both
// comboSheetState and the live total. Called once when the sheet opens.
function renderComboSheetContents() {
    const { combo } = comboSheetState;

    document.getElementById('rsvComboSheetTitle').textContent = combo.name;
    const descEl = document.getElementById('rsvComboSheetDesc');
    if (descEl) {
        descEl.textContent = combo.description || '';
        descEl.style.display = combo.description ? '' : 'none';
    }

    const slotsContainer = document.getElementById('rsvComboSlots');
    slotsContainer.innerHTML = '';

    (combo.items || []).forEach(slot => {
        const defaultDish = findOrderDishById(slot.dishId);
        if (!defaultDish) return; // shouldn't happen — getAvailableCombos() already excludes these combos

        const slotEl = document.createElement('div');
        slotEl.className = 'rsv-combo-slot';

        // Build the choice list for this slot: the default (always, 0 Kč
        // diff), any swap alternatives that still exist and aren't sold out
        // ("only alternatives present & not soldOut in currentMenu" per the
        // implementation task — soldOut is NOT checked for the default
        // itself, only for swap targets), and a "bez <dish>" removal option
        // when the slot is removable.
        const options = [{ value: 'default', label: defaultDish.name, diff: 0 }];

        (slot.swaps || []).forEach(swapDishId => {
            const swapDish = findOrderDishById(swapDishId);
            if (!swapDish || swapDish.soldOut) return;
            options.push({
                value: `swap:${swapDishId}`,
                label: swapDish.name,
                diff: (Number(swapDish.price) || 0) - (Number(defaultDish.price) || 0),
            });
        });

        if (slot.removable) {
            options.push({
                value: 'remove',
                label: `Bez ${defaultDish.name}`,
                diff: -(Number(slot.removeValue) || 0),
            });
        }

        // A slot with no swaps and not removable is a fixed part of the
        // combo — show it plainly rather than a single disabled radio.
        if (options.length === 1) {
            const fixed = document.createElement('div');
            fixed.className = 'rsv-combo-slot__fixed';
            fixed.textContent = defaultDish.name;
            slotEl.appendChild(fixed);
        } else {
            const groupName = `comboSlot_${slot.slotId}`;
            options.forEach(opt => {
                const optId = `${groupName}_${opt.value.replace(/[^a-zA-Z0-9]/g, '_')}`;

                const optRow = document.createElement('label');
                optRow.className = 'rsv-combo-option';
                optRow.setAttribute('for', optId);

                const radio = document.createElement('input');
                radio.type = 'radio';
                radio.name = groupName;
                radio.id = optId;
                radio.value = opt.value;
                radio.checked = (comboSheetState.slotSelections[slot.slotId] || 'default') === opt.value;
                radio.addEventListener('change', () => {
                    if (!radio.checked) return;
                    comboSheetState.slotSelections[slot.slotId] = opt.value;
                    updateComboSheetTotal();
                });

                const labelEl = document.createElement('span');
                labelEl.className = 'rsv-combo-option__label';
                labelEl.textContent = opt.label;

                const diffEl = document.createElement('span');
                diffEl.className = 'rsv-combo-option__diff';
                diffEl.textContent = opt.diff !== 0 ? formatSignedKc(opt.diff) : '';

                optRow.appendChild(radio);
                optRow.appendChild(labelEl);
                optRow.appendChild(diffEl);
                slotEl.appendChild(optRow);
            });
        }

        slotsContainer.appendChild(slotEl);
    });

    const extrasContainer = document.getElementById('rsvComboExtras');
    extrasContainer.innerHTML = '';
    if (Array.isArray(combo.extras) && combo.extras.length > 0) {
        const label = document.createElement('div');
        label.className = 'rsv-combo-extras__label';
        label.textContent = 'Příplatky';
        extrasContainer.appendChild(label);

        combo.extras.forEach(extra => {
            const row = document.createElement('label');
            row.className = 'rsv-combo-option';

            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = comboSheetState.extras.has(extra.id);
            cb.addEventListener('change', () => {
                if (cb.checked) comboSheetState.extras.add(extra.id);
                else comboSheetState.extras.delete(extra.id);
                updateComboSheetTotal();
            });

            const labelEl = document.createElement('span');
            labelEl.className = 'rsv-combo-option__label';
            labelEl.textContent = extra.name;

            const priceEl = document.createElement('span');
            priceEl.className = 'rsv-combo-option__diff';
            priceEl.textContent = formatSignedKc(Number(extra.price) || 0);

            row.appendChild(cb);
            row.appendChild(labelEl);
            row.appendChild(priceEl);
            extrasContainer.appendChild(row);
        });
    }

    const noteInput = document.getElementById('rsvComboNoteInput');
    if (noteInput) noteInput.value = '';

    updateComboSheetTotal();
}

function updateComboSheetTotal() {
    if (!comboSheetState) return;
    const config = comboConfigFromSheetState();
    const price = computeComboUnitPrice(comboSheetState.combo, config);
    const el = document.getElementById('rsvComboTotalText');
    if (el) el.textContent = `${price.toFixed(0)} Kč`;
}

// "Přidat" — commits the sheet's current selections as one new order line.
function confirmComboCustomize() {
    if (!comboSheetState) return;
    const { combo } = comboSheetState;
    const config = comboConfigFromSheetState();
    if (config.note.length > 200) config.note = config.note.slice(0, 200); // belt-and-braces alongside the input's maxlength
    addComboLineToOrder(combo, config);
    closeComboCustomizeSheet();
}

// Renders the "Zvýhodněná menu" group into `container` (called from
// renderOrderPicker, ABOVE the regular category groups) — the browsable list
// of customizable combos, plus any combo lines already added to the order
// (each with its own qty stepper, exactly like a regular dish row). Returns
// whether it rendered anything, so renderOrderPicker knows whether the
// "Menu zatím není k dispozici." empty state still applies.
function renderComboGroup(container) {
    const availableCombos = getAvailableCombos();
    const selectedComboEntries = Object.entries(currentOrder)
        .filter(([, o]) => o.id && o.id.startsWith(COMBO_ITEM_ID_PREFIX));

    if (availableCombos.length === 0 && selectedComboEntries.length === 0) return false;

    const group = document.createElement('div');
    group.className = 'rsv-order-cat rsv-order-combo-group';

    const label = document.createElement('div');
    label.className = 'rsv-order-cat__label';
    label.textContent = 'Zvýhodněná menu';
    group.appendChild(label);

    availableCombos.forEach(combo => {
        const row = document.createElement('div');
        row.className = 'rsv-order-combo';

        const topEl = document.createElement('div');
        topEl.className = 'rsv-order-combo__top';

        const nameEl = document.createElement('span');
        nameEl.className = 'rsv-order-combo__name';
        nameEl.textContent = combo.name;

        const priceEl = document.createElement('span');
        priceEl.className = 'rsv-order-combo__price';
        priceEl.textContent = `${Number(combo.price).toFixed(0)} Kč`;

        const customizeBtn = document.createElement('button');
        customizeBtn.type = 'button';
        customizeBtn.className = 'ds-btn ds-btn--ghost rsv-order-combo__btn';
        customizeBtn.textContent = 'Přizpůsobit';
        customizeBtn.addEventListener('click', () => openComboCustomizeSheet(combo));

        topEl.appendChild(nameEl);
        topEl.appendChild(priceEl);
        topEl.appendChild(customizeBtn);
        row.appendChild(topEl);

        const summary = comboContentsSummary(combo);
        if (summary) {
            const summaryEl = document.createElement('span');
            summaryEl.className = 'rsv-order-combo__summary';
            summaryEl.textContent = summary;
            row.appendChild(summaryEl);
        }

        group.appendChild(row);
    });

    if (selectedComboEntries.length > 0) {
        const selectedLabel = document.createElement('div');
        selectedLabel.className = 'rsv-order-combo-selected__label';
        selectedLabel.textContent = 'Vybraná menu';
        group.appendChild(selectedLabel);

        selectedComboEntries.forEach(([key, o]) => {
            const row = document.createElement('div');
            row.className = 'rsv-order-dish rsv-order-combo-selected';

            const nameEl = document.createElement('span');
            nameEl.className = 'rsv-order-dish__name';
            nameEl.textContent = o.item;
            const priceEl = document.createElement('span');
            priceEl.className = 'rsv-order-dish__price';
            priceEl.textContent = `${Number(o.price).toFixed(0)} Kč`;
            nameEl.appendChild(priceEl);
            row.appendChild(nameEl);

            const stepper = buildStepper(o.qty, (newQty) => {
                if (newQty <= 0) delete currentOrder[key];
                else currentOrder[key].qty = newQty;
                updateOrderTotal();
            });
            row.appendChild(stepper);
            group.appendChild(row);
        });
    }

    container.appendChild(group);
    return true;
}

function renderOrderPicker() {
    const container = document.getElementById('rsvOrderCategories');
    if (!container) return;
    container.innerHTML = '';

    // Combo-menus feature: "Zvýhodněná menu" renders ABOVE the regular
    // categories, only when there's at least one orderable combo or an
    // already-added combo line to show (see renderComboGroup/
    // getAvailableCombos above) — mirrors the plan's "combos section above
    // categories" ordering.
    const hasCombos = renderComboGroup(container);

    // go-live Task 3 (spec §5): sold-out dishes are hidden entirely from the
    // reservation food-preorder expander (unlike the delivery page, which
    // shows them faded with a badge) — a preorder is placed well ahead of
    // the meal, so offering a dish the kitchen has already marked
    // unavailable would just be confusing rather than merely "out of stock
    // for the next 5 minutes". The server (priceOrderItems in server.js)
    // rejects it too if one somehow still gets submitted (e.g. a stale
    // page), so this is UI-only, not the actual enforcement. Sold-out
    // combos follow the exact same reasoning (see getAvailableCombos).
    const hasDishes = MENU_CATEGORIES.some(cat => (currentMenu[cat.id] || []).some(d => !d.soldOut));
    if (!hasDishes && !hasCombos) {
        const p = document.createElement('p');
        p.className = 'rsv-hint';
        p.textContent = 'Menu zatím není k dispozici.';
        container.appendChild(p);
        updateOrderTotal();
        return;
    }

    MENU_CATEGORIES.forEach(cat => {
        const dishes = (currentMenu[cat.id] || []).filter(d => !d.soldOut);
        if (dishes.length === 0) return;

        const catEl = document.createElement('div');
        catEl.className = 'rsv-order-cat';

        const labelEl = document.createElement('div');
        labelEl.className = 'rsv-order-cat__label';
        labelEl.textContent = cat.label;
        catEl.appendChild(labelEl);

        dishes.forEach(dish => {
            const row = document.createElement('div');
            row.className = 'rsv-order-dish';

            const nameEl = document.createElement('span');
            nameEl.className = 'rsv-order-dish__name';
            nameEl.textContent = dish.name;
            const priceEl = document.createElement('span');
            priceEl.className = 'rsv-order-dish__price';
            priceEl.textContent = `${Number(dish.price).toFixed(0)} Kč`;
            nameEl.appendChild(priceEl);
            row.appendChild(nameEl);

            const qty = currentOrder[dish.id]?.qty || 0;
            const stepper = buildStepper(qty, (newQty) => {
                if (newQty <= 0) {
                    delete currentOrder[dish.id];
                } else {
                    currentOrder[dish.id] = { item: dish.name, price: Number(dish.price), qty: newQty };
                }
                updateOrderTotal();
            });
            row.appendChild(stepper);
            catEl.appendChild(row);
        });

        container.appendChild(catEl);
    });

    updateOrderTotal();
}

function updateOrderTotal() {
    const total = Object.values(currentOrder).reduce((sum, o) => sum + o.price * o.qty, 0);
    const el = document.getElementById('rsvOrderTotalText');
    if (el) el.textContent = `${total.toFixed(0)} Kč`;
}

function getOrderArray() {
    return Object.values(currentOrder).map(o => {
        const line = { item: o.item, qty: o.qty, price: o.price };
        // Combo lines carry two extra fields per the combo-menus contract:
        // `id` (always "combo:<comboId>", so the server's priceOrderItems()
        // recognizes + revalidates the line) and `comboConfig` (the removed/
        // swap/extras/note choices). Regular dish lines have neither of
        // these on `o`, so they're omitted here exactly as before this
        // feature — dish lines still match purely by `item` (dish name).
        if (o.id) line.id = o.id;
        if (o.comboConfig) line.comboConfig = o.comboConfig;
        return line;
    });
}

function getOrderTotal() {
    return Object.values(currentOrder).reduce((sum, o) => sum + o.price * o.qty, 0);
}

// ─── DATE HELPERS ────────────────────────────────────────────────────────────

function getCurrentDate() {
    return new Date();
}

function getDateString(date) {
    // Local-date-based (not toISOString, which converts to UTC and can shift
    // the date by a day depending on timezone offset and time-of-day).
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function getDayIndexFromDateString(dateString) {
    const d = new Date(dateString + 'T00:00:00');
    const jsDay = d.getDay(); // 0=Sun..6=Sat
    // go-live Task 6 (spec §11): Monday-first 0-6, matching dayIndexMonFirst()
    // in src/server/settings.js — reservations now cover every day, so this
    // never needs to produce an invalid index. For Mon-Fri this is numerically
    // identical to the old `jsDay - 1` mapping (Mon=1->0 ... Fri=5->4), so
    // existing bookings stored under the old convention keep reading/writing
    // at the same array index; only Sat (was 5, previously rejected as
    // "invalid") and Sun (was -1, previously rejected) now resolve to 5/6.
    return (jsDay + 6) % 7;
}

function formatDayShort(d) {
    return `${DOW_LABELS[d.getDay()]} ${d.getDate()}. ${d.getMonth() + 1}.`;
}

function hourStartLabel(hourIndex) {
    return RESERVATION_HOURS[hourIndex - 1].split('-')[0];
}

// Is the given hourIndex (1-12) free for this table on this date?
function isHourFree(timetableData, dateString, dayIndex, hourIndex) {
    if (dayIndex < 0 || dayIndex > 6) return false;

    const direct = timetableData.data?.[dateString]?.[dayIndex]?.[hourIndex];
    if (direct?.content) return false;

    const targetDate = new Date(dateString + 'T00:00:00');
    if (timetableData.data) {
        for (const weekDate in timetableData.data) {
            if (weekDate === dateString) continue;
            if (new Date(weekDate) > targetDate) continue;
            const entry = timetableData.data[weekDate]?.[dayIndex]?.[hourIndex];
            if (entry?.content && entry.isPermanent) return false;
        }
    }
    return true;
}

function isAnyTableFreeAtHour(dateString, dayIndex, hourIndex) {
    return Object.values(timetables).some(t => isHourFree(t, dateString, dayIndex, hourIndex));
}

// ─── LOAD TABLES ─────────────────────────────────────────────────────────────

async function loadTimetables() {
    timetables = {};

    try {
        const response = await fetch(`${API_URL}/timetables`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const names = [...new Set(await response.json())];

        for (const name of names) {
            try {
                const res = await fetch(`${API_URL}/timetables/${encodeURIComponent(name)}`);
                if (!res.ok) continue;
                const data = await res.json();
                timetables[name] = {
                    className: name,
                    fileId: data.fileId,
                    data: data.data || {},
                    info: data.info || '',
                    attributes: data.attributes || [],
                    // floorplan-table-picking design §7.2: the public endpoint
                    // whitelists `seats` (number|null) and `layout`
                    // (object|null). Until the server-side track lands, both
                    // are simply absent from `data` — normalize either case to
                    // `undefined` so every consumer below can use one check
                    // (`typeof seats === 'number'` / truthy `layout`) instead
                    // of juggling null vs. undefined.
                    seats: typeof data.seats === 'number' ? data.seats : undefined,
                    layout: data.layout || undefined,
                };
            } catch (e) {
                console.error(`Error loading timetable ${name}:`, e);
            }
        }
    } catch (error) {
        console.error('Failed to load timetables:', error);
        showToast('Nepodařilo se načíst stoly', true);
    }

    renderDayStrip();
    renderTimeGrid();
    renderTablesList();
    updateStepStates();
}

// ─── DAY STRIP ────────────────────────────────────────────────────────────────

function buildDayList() {
    const days = [];
    const today = getCurrentDate();
    for (let i = 0; i < RESERVATION_DAYS_AHEAD; i++) {
        const d = new Date(today);
        d.setDate(d.getDate() + i);
        days.push(d);
    }
    return days;
}

// Step 2's chosen value. Was the bare month ("Červenec 2026"), which said
// nothing about the choice actually made; it now names the selected day in
// full, so the month is still stated AND the decision stays legible after
// the day strip has scrolled out of view.
function updateMonthLabel() {
    const el = document.getElementById('rsvMonthLabel');
    if (!el) return;
    const d = new Date((reservationSelectedDate || getDateString(getCurrentDate())) + 'T00:00:00');
    el.textContent = `${DOW_LABELS[d.getDay()]} ${d.getDate()}. ${MONTH_LABELS[d.getMonth()].toLowerCase()}`;
}

// ─── STEP STATE ──────────────────────────────────────────────────────────────
// The four sections are a sequence (people → day → time → table) and each one
// gates the next. Marking which step is live and which is not yet reachable is
// what turns four identical stacked grids into a flow you can locate yourself
// in; reservation.css draws the three states. Called after every selection.
function updateStepStates() {
    const timeReady = Boolean(reservationSelectedDate);
    const tablesReady = timeReady && Boolean(reservationSelectedHour);

    const mark = (id, ready, active) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.classList.toggle('rsv-section--pending', !ready);
        el.classList.toggle('rsv-section--active', ready && active);
    };

    // "Active" is the earliest step still missing a choice — the one place
    // the red step marker is spent on this page.
    mark('rsvPartySizeSection', true, false);
    mark('rsvDayStripSection', true, !reservationSelectedDate);
    mark('rsvTimeGridSection', timeReady, timeReady && !reservationSelectedHour);
    mark('rsvTablesSection', tablesReady, tablesReady);
}

function renderDayStrip() {
    const strip = document.getElementById('rsvDayStrip');
    if (!strip) return;
    strip.innerHTML = '';

    buildDayList().forEach(d => {
        const dateStr = getDateString(d);
        const dayIndex = getDayIndexFromDateString(dateStr);
        // go-live Task 6 (spec §11): no more weekend special-case — a day
        // (any of the 7) renders disabled ONLY when this weekday is closed
        // per settings.reservations.days[k].open, or an explicit closedDays
        // entry covers this exact date. Saturday/Sunday are ordinary rows,
        // disabled the same way a weekday with open:false would be.
        const disabled = !isWeekdayOpenForReservations(dayIndex) || isDateClosed(dateStr);
        const isSelected = dateStr === reservationSelectedDate;

        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'ds-chip rsv-day-chip'
            + (isSelected ? ' ds-chip--selected' : '')
            + (disabled ? ' ds-chip--disabled' : '');
        chip.dataset.date = dateStr;

        const dow = document.createElement('span');
        dow.className = 'rsv-day-chip__dow';
        dow.textContent = DOW_LABELS[d.getDay()];
        const num = document.createElement('span');
        num.className = 'rsv-day-chip__num';
        num.textContent = String(d.getDate());

        chip.appendChild(dow);
        chip.appendChild(num);

        if (disabled) {
            // .ds-chip--disabled only styles and blocks pointer events — the
            // button stayed in the tab order and announced as actionable.
            chip.disabled = true;
        } else {
            chip.addEventListener('click', () => selectDate(dateStr));
        }
        strip.appendChild(chip);
    });

    updateMonthLabel();
    updateScrollHint();
}

function updateScrollHint() {
    const strip = document.getElementById('rsvDayStrip');
    const fill = document.getElementById('rsvScrollHintFill');
    if (!strip || !fill) return;

    const maxScroll = strip.scrollWidth - strip.clientWidth;
    const visibleRatio = strip.scrollWidth > 0
        ? Math.min(1, strip.clientWidth / strip.scrollWidth)
        : 1;
    const widthPct = Math.max(visibleRatio, 0.12) * 100;
    const scrollRatio = maxScroll > 0 ? strip.scrollLeft / maxScroll : 0;
    const leftPct = scrollRatio * (100 - widthPct);

    // The bar is full-width in CSS and placed purely by transform, so this
    // runs on the compositor instead of forcing layout on every scroll frame
    // (see .rsv-scroll-hint__fill). translateX first, then scaleX about the
    // left origin, so the percentage translate is in untransformed units.
    fill.style.transform = `translateX(${leftPct}%) scaleX(${widthPct / 100})`;
}

function selectDate(dateStr) {
    reservationSelectedDate = dateStr;
    reservationSelectedHour = null;
    renderDayStrip();
    renderTimeGrid();
    renderTablesList();
    updateStepStates();
}

// ─── TIME GRID ────────────────────────────────────────────────────────────────

function renderTimeGrid() {
    const grid = document.getElementById('rsvTimeGrid');
    if (!grid) return;
    grid.innerHTML = '';
    updateTimeValue(); // before the early returns below — a closed day has no hour

    const dateStr = reservationSelectedDate;
    const dayIndex = getDayIndexFromDateString(dateStr);

    if (isDateClosed(dateStr)) {
        const p = document.createElement('p');
        p.className = 'ds-empty';
        p.textContent = 'V tento den je zavřeno.';
        grid.appendChild(p);
        return;
    }

    if (!isWeekdayOpenForReservations(dayIndex)) {
        const p = document.createElement('p');
        p.className = 'ds-empty';
        p.textContent = 'V tento den rezervace nepřijímáme.';
        grid.appendChild(p);
        return;
    }

    // Only hours inside this weekday's configured range are rendered at all
    // (not just disabled) — settings.js/isReservationSlotOpen enforces the
    // same range server-side.
    const range = getReservationHourRange(dayIndex);

    RESERVATION_HOURS.forEach((label, i) => {
        const hourIndex = i + 1;
        if (hourIndex < range.from || hourIndex > range.to) return;
        const free = isAnyTableFreeAtHour(dateStr, dayIndex, hourIndex);
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'ds-chip'
            + (!free ? ' ds-chip--disabled' : (hourIndex === reservationSelectedHour ? ' ds-chip--selected' : ''));
        chip.textContent = label.split('-')[0];
        if (free) {
            chip.addEventListener('click', () => selectHour(hourIndex));
        } else {
            chip.disabled = true; // keep fully-booked hours out of the tab order
        }
        grid.appendChild(chip);
    });
}

// Step 3's chosen value, mirrored into the head so the hour survives scrolling.
function updateTimeValue() {
    const el = document.getElementById('rsvTimeValue');
    if (!el) return;
    el.textContent = reservationSelectedHour ? hourStartLabel(reservationSelectedHour) : '';
}

function selectHour(hourIndex) {
    reservationSelectedHour = hourIndex;
    renderTimeGrid();
    renderTablesList();
    updateStepStates();
}

// ─── PARTY SIZE ──────────────────────────────────────────────────────────────
// floorplan-table-picking design §6.1: a standalone 1-8 chip row, independent
// of date/time (see rsvPartySizeSection in index.html, above the day strip).
// Rendered once on load; only its selection changes afterwards, which just
// re-renders the tables section below (party size never affects which days/
// hours are open).

function renderPartySizeChips() {
    const row = document.getElementById('rsvPartySizeRow');
    if (!row) return;
    row.innerHTML = '';

    for (let n = 1; n <= 8; n++) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'ds-chip' + (n === reservationSelectedPartySize ? ' ds-chip--selected' : '');
        chip.textContent = String(n);
        chip.addEventListener('click', () => selectPartySize(n));
        row.appendChild(chip);
    }

    const value = document.getElementById('rsvPartySizeValue');
    if (value) value.textContent = czPeople(reservationSelectedPartySize || 2);
}

// Czech counts 1 / 2-4 / 5+ differently, and "2 osob" is the kind of small
// wrongness that makes a screen feel machine-written.
function czPeople(n) {
    if (n === 1) return '1 osoba';
    if (n >= 2 && n <= 4) return `${n} osoby`;
    return `${n} osob`;
}

function czFreeTables(n) {
    if (n === 1) return '1 volný';
    if (n >= 2 && n <= 4) return `${n} volné`;
    return `${n} volných`;
}

function selectPartySize(n) {
    reservationSelectedPartySize = n;
    renderPartySizeChips();
    renderTablesList();
}

// ─── TABLES LIST (floorplan + unplaced fallback) ────────────────────────────
// floorplan-table-picking design §6.1/§9. Every table's state is computed
// ONCE below, straight from the existing isHourFree() (the sole availability
// authority — design §3 non-goals: this feature never reimplements that) plus
// the party-size gate, then split into:
//   - placed tables  → drawn on FloorPlan.render()'s canvas, occupied/too-
//     small ones staying VISIBLE and IN PLACE, greyed out — this replaces the
//     old `available = names.filter(...)` behaviour that hid them entirely,
//     which is the whole point of this feature (design §1).
//   - unplaced tables (no `layout`, or a `layout.room` naming an unknown
//     room) → the "Nezařazené stoly" list below the plan, reusing the exact
//     .ds-list-row markup this function always used. Every table in the
//     database has no `layout` yet, so this is the default, fully-bookable
//     path on day one, not a degraded afterthought (design §9).
// If no rooms are configured at all, no canvas is drawn and every table
// falls back to that same flat list alone — i.e. today's behaviour exactly,
// so a flat list (with no "place" to grey a table into) keeps showing only
// bookable tables, exactly as it always has.

function buildTableListRow(table) {
    const full = timetables[table.name];
    const attrs = (full && full.attributes) || [];
    const subtitle = attrs.length ? attrs.join(' · ') : 'Bez vlastností';

    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'ds-list-row';
    row.innerHTML = `
        <span class="ds-list-row__body">
            <span class="ds-list-row__title">${escapeHtml(table.name)}</span>
            <span class="ds-list-row__subtitle">${escapeHtml(subtitle)}</span>
        </span>
        <span class="ds-list-row__chevron">→</span>
    `;
    row.addEventListener('click', () => openReservationSheet(table.name));
    return row;
}

function renderTablesList() {
    const container = document.getElementById('rsvTablesList');
    const planContainer = document.getElementById('rsvFloorplan');
    const unplacedHead = document.getElementById('rsvUnplacedHead');
    const label = document.getElementById('rsvTablesLabel');
    if (!container) return;
    container.innerHTML = '';
    if (planContainer) planContainer.innerHTML = '';
    if (unplacedHead) unplacedHead.classList.add('rsv-hidden');

    const dateStr = reservationSelectedDate;
    const dayIndex = getDayIndexFromDateString(dateStr);
    const hourIndex = reservationSelectedHour;

    if (label) label.textContent = '';

    if (dayIndex < 0 || dayIndex > 6) {
        container.innerHTML = '<p class="ds-empty">Neplatné datum.</p>';
        return;
    }
    if (!hourIndex) {
        container.innerHTML = '<p class="ds-empty">Nejprve vyberte čas.</p>';
        return;
    }

    const names = Object.keys(timetables);
    if (names.length === 0) {
        container.innerHTML = '<p class="ds-empty">Žádné stoly nejsou k dispozici.</p>';
        return;
    }

    const partySize = reservationSelectedPartySize || 2;

    // One state per table: not free => occupied; free but seats < party size
    // => too-small; otherwise free. A table with no `seats` (not yet set by
    // the owner, or the public endpoint not yet extended to expose it — see
    // the comment on loadTimetables() above) is never marked too-small
    // (design §9's "no seats ⇒ never filtered by party size" rule).
    const allTables = names.map(name => {
        const t = timetables[name];
        const free = isHourFree(t, dateStr, dayIndex, hourIndex);
        const tooSmall = free && typeof t.seats === 'number' && t.seats < partySize;
        const state = !free ? 'occupied' : (tooSmall ? 'too-small' : 'free');
        return {
            name,
            seats: typeof t.seats === 'number' ? t.seats : undefined,
            layout: t.layout || undefined,
            state,
            sublabel: state === 'occupied' ? 'obsazeno' : (state === 'too-small' ? 'málo míst' : undefined),
        };
    });

    // Step 4's value: how many tables this party can actually take at this
    // hour. The head used to repeat the selected hour, which step 3 states on
    // its own line one section above.
    if (label) label.textContent = czFreeTables(allTables.filter(t => t.state === 'free').length);

    const rooms = (restaurantSettings && restaurantSettings.floorplan && Array.isArray(restaurantSettings.floorplan.rooms))
        ? restaurantSettings.floorplan.rooms
        : [];

    if (rooms.length === 0) {
        // No floorplan configured — degrade to exactly today's behaviour: a
        // flat list of the tables actually bookable right now.
        const bookable = allTables.filter(t => t.state === 'free');
        if (bookable.length === 0) {
            container.innerHTML = '<p class="ds-empty">V danou dobu není volný žádný stůl.</p>';
            return;
        }
        bookable.forEach(t => container.appendChild(buildTableListRow(t)));
        return;
    }

    if (!window.FloorPlan || typeof FloorPlan.render !== 'function' || typeof FloorPlan.partitionTables !== 'function') {
        // Shared module not loaded (see the <script> order note in
        // index.html) — fail open the same way as the no-rooms case rather
        // than throwing, so the page stays usable.
        console.error('FloorPlan module not available; falling back to plain table list.');
        const bookable = allTables.filter(t => t.state === 'free');
        if (bookable.length === 0) {
            container.innerHTML = '<p class="ds-empty">V danou dobu není volný žádný stůl.</p>';
            return;
        }
        bookable.forEach(t => container.appendChild(buildTableListRow(t)));
        return;
    }

    // Split into placed (drawn on the canvas) vs. unplaced (fallback list),
    // via the shared module so "which room does this table belong to" lives
    // in one place, reused by the admin layout editor.
    const { placed: placedTables, unplaced: unplacedTables } = FloorPlan.partitionTables(allTables, rooms);

    if (planContainer) {
        if (!rsvActiveRoomId || !rooms.some(r => r.id === rsvActiveRoomId)) {
            rsvActiveRoomId = rooms[0].id;
        }
        FloorPlan.render(planContainer, {
            rooms,
            tables: placedTables,
            activeRoomId: rsvActiveRoomId,
            onRoomChange: (roomId) => { rsvActiveRoomId = roomId; renderTablesList(); },
            onTableClick: (tableName) => {
                const table = placedTables.find(pt => pt.name === tableName);
                if (table && table.state === 'free') openReservationSheet(tableName);
            },
        });
    }

    if (unplacedTables.length === 0) return; // every table sits on the plan

    const bookableUnplaced = unplacedTables.filter(t => t.state === 'free');
    if (unplacedHead) unplacedHead.classList.remove('rsv-hidden');
    if (bookableUnplaced.length === 0) {
        container.innerHTML = '<p class="ds-empty">V danou dobu není volný žádný nezařazený stůl.</p>';
        return;
    }
    bookableUnplaced.forEach(t => container.appendChild(buildTableListRow(t)));
}

// ─── SHEET HELPERS (generic open/close for both sheets on this page) ────────

function openSheet(backdropId, sheetId) {
    document.getElementById(backdropId)?.classList.add('open');
    const sheet = document.getElementById(sheetId);
    if (!sheet) return;
    sheet.classList.add('open');
    sheet.setAttribute('aria-hidden', 'false');
}

function closeSheet(backdropId, sheetId) {
    document.getElementById(backdropId)?.classList.remove('open');
    const sheet = document.getElementById(sheetId);
    if (!sheet) return;
    sheet.classList.remove('open');
    sheet.setAttribute('aria-hidden', 'true');
}

function showToast(message, isError) {
    const toast = document.getElementById('rsvToast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.toggle('error', !!isError);
    toast.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toast.classList.remove('show'), 2800);
}

// ─── BOOKING SHEET (duration + name/phone + optional food → SMS code → success) ──

const RSV_STEP_IDS = ['rsvStepDetails', 'rsvStepCode', 'rsvStepSuccess'];

function showStep(id) {
    RSV_STEP_IDS.forEach(s => {
        document.getElementById(s)?.classList.toggle('active', s === id);
    });
    const err = document.getElementById('rsvCodeError');
    if (err) { err.classList.remove('show'); err.textContent = ''; }
}

function collapseOrderExpander() {
    document.getElementById('rsvOrderExpander')?.classList.remove('open');
    document.getElementById('rsvOrderToggle')?.setAttribute('aria-expanded', 'false');
}

function renderDurationChips() {
    const row = document.getElementById('rsvDurationRow');
    if (!row) return;
    row.innerHTML = '';

    const dayIndex = getDayIndexFromDateString(reservationSelectedDate);
    const range = getReservationHourRange(dayIndex);
    const maxLen = Math.min(4, range.to - reservationSelectedHour + 1);
    reservationSelectedDuration = 1;

    for (let h = 1; h <= maxLen; h++) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'ds-chip' + (h === 1 ? ' ds-chip--selected' : '');
        chip.textContent = `${h} h`;
        chip.addEventListener('click', () => {
            row.querySelectorAll('.ds-chip').forEach(c => c.classList.remove('ds-chip--selected'));
            chip.classList.add('ds-chip--selected');
            reservationSelectedDuration = h;
        });
        row.appendChild(chip);
    }
}

function openReservationSheet(name) {
    reservationTargetTable = name;
    currentOrder = {};

    document.getElementById('rsvStepDetailsTitle').textContent = `Zarezervovat – ${name}`;
    const dateObj = new Date(reservationSelectedDate + 'T00:00:00');
    document.getElementById('rsvStepDetailsSummary').innerHTML =
        `<strong>${escapeHtml(name)}</strong> · ${formatDayShort(dateObj)} · ${hourStartLabel(reservationSelectedHour)}`;

    document.getElementById('rsvNameInput').value = '';
    document.getElementById('rsvPhoneInput').value = '';
    collapseOrderExpander();
    renderDurationChips();
    // Menu + combos are independent fetches (see fetchCombosForOrder's own
    // fail-open comment — a combos hiccup shouldn't block plain dish
    // ordering), run in parallel and both awaited before the first render.
    Promise.all([fetchMenuForOrder(), fetchCombosForOrder()]).then(renderOrderPicker);

    showStep('rsvStepDetails');
    openSheet('rsvSheetBackdrop', 'rsvSheet');
}

function closeReservationSheet() {
    closeComboCustomizeSheet(); // defensive: don't leave the customize sheet orphaned open on top
    closeSheet('rsvSheetBackdrop', 'rsvSheet');
    reservationTargetTable = null;
    currentOrder = {};
    pendingVerificationPhone = null;
    clearResendCooldown();
}

// Phone number currently awaiting a code (set once /send-code succeeds),
// used by verifyCodeAndBook / resendCode.
let pendingVerificationPhone = null;

const RESEND_COOLDOWN_S = 30; // matches SERVER_CONFIG.sms.resendCooldownMs
let resendCooldownInterval = null;

function startResendCooldown(seconds) {
    clearResendCooldown();
    const btn = document.getElementById('rsvResendBtn');
    if (!btn) return;
    let remaining = seconds;
    btn.disabled = true;
    btn.textContent = `Poslat znovu (${remaining} s)`;
    resendCooldownInterval = setInterval(() => {
        remaining -= 1;
        if (remaining <= 0) { clearResendCooldown(); return; }
        btn.textContent = `Poslat znovu (${remaining} s)`;
    }, 1000);
}

function clearResendCooldown() {
    if (resendCooldownInterval) clearInterval(resendCooldownInterval);
    resendCooldownInterval = null;
    const btn = document.getElementById('rsvResendBtn');
    if (btn) { btn.disabled = false; btn.textContent = 'Poslat znovu'; }
}

// Step 1 → asks the server to text a verification code. The reservation
// itself is NOT saved yet — the server only saves it once the code from
// step 2 is confirmed, so this can't be bypassed by skipping the sheet.
async function requestVerificationCode() {
    const name = reservationTargetTable;
    const t = timetables[name];
    const guestName = (document.getElementById('rsvNameInput')?.value || '').trim();
    const phone = (document.getElementById('rsvPhoneInput')?.value || '').trim();

    if (!t || !reservationSelectedDate || !reservationSelectedHour) {
        showToast('Vyberte prosím stůl, datum a čas.', true);
        return;
    }
    if (!guestName) {
        showToast('Zadejte prosím své jméno.', true);
        return;
    }
    if (!phone) {
        showToast('Zadejte prosím telefonní číslo.', true);
        return;
    }

    const duration = reservationSelectedDuration || 1;
    const dayIndex = getDayIndexFromDateString(reservationSelectedDate);
    const startHour = reservationSelectedHour;

    // Re-validate every slot in the requested duration is still free before
    // even sending an SMS, so we don't text people for nothing. Also keep
    // the request inside this weekday's configured hour range (the server
    // is the real authority — see isReservationSlotOpen in settings.js —
    // this is just a courtesy pre-check so a stale client doesn't burn an
    // SMS on a request the server would reject anyway).
    const range = getReservationHourRange(dayIndex);
    if (reservationsArePaused() || isDateClosed(reservationSelectedDate) || !isWeekdayOpenForReservations(dayIndex)) {
        showToast('Rezervace v tento den bohužel nejsou možné.', true);
        return;
    }
    for (let h = startHour; h < startHour + duration; h++) {
        if (h > range.to || !isHourFree(t, reservationSelectedDate, dayIndex, h)) {
            showToast('Vybraná délka rezervace už není volná, zkuste kratší dobu nebo jiný stůl.', true);
            return;
        }
    }

    const order = getOrderArray();
    const orderTotal = getOrderTotal();

    const confirmBtn = document.getElementById('rsvConfirmBtn');
    if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = 'Odesílám…'; }

    try {
        const res = await fetch(`${API_URL}/reservations/send-code`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                phone, tableName: name, dateStr: reservationSelectedDate, dayIndex,
                startHour, duration, guestName, order, orderTotal,
                // floorplan-table-picking design §6.1/§7.3: the party size
                // chosen above the day strip, enforced server-side against
                // the table's `seats` in applyBookingToTimetable().
                guests: reservationSelectedPartySize
            })
        });
        const result = await res.json();
        if (!res.ok) throw new Error(result.error || 'Chyba při odesílání SMS');

        pendingVerificationPhone = phone;
        document.getElementById('rsvCodeSentTo').textContent = phone;
        document.getElementById('rsvCodeInput').value = '';
        showStep('rsvStepCode');
        startResendCooldown(RESEND_COOLDOWN_S);
        showToast(result.simulated
            ? 'Kód vygenerován (SMS server zatím není nakonfigurován, kód najdete v konzoli serveru).'
            : `SMS kód odeslán na ${phone}.`);
    } catch (err) {
        console.error(err);
        showToast(err.message || 'Nepodařilo se odeslat ověřovací kód', true);
    } finally {
        if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = 'Odeslat ověřovací kód'; }
    }
}

async function resendCode() {
    // Re-runs the same send-code request using the details already on the
    // details step's inputs (still populated, just hidden).
    await requestVerificationCode();
}

// Captured right before showing the success step so the "Hotovo" button
// knows whether to hand off into the payment sheet.
let rsvLastBookingResult = null; // { ctx, orderTotal } | null

// Step 2 → sends the code back to the server; the server checks it and, if
// correct, performs the actual booking using the details it captured at
// send-code time.
async function verifyCodeAndBook() {
    const code = (document.getElementById('rsvCodeInput')?.value || '').trim();
    const errEl = document.getElementById('rsvCodeError');

    if (!pendingVerificationPhone) {
        showToast('Nejprve si vyžádejte ověřovací kód.', true);
        showStep('rsvStepDetails');
        return;
    }
    if (!code) {
        if (errEl) { errEl.textContent = 'Zadejte kód z SMS.'; errEl.classList.add('show'); }
        return;
    }

    const verifyBtn = document.getElementById('rsvVerifyBtn');
    if (verifyBtn) { verifyBtn.disabled = true; verifyBtn.textContent = 'Ověřuji…'; }

    try {
        const res = await fetch(`${API_URL}/reservations/verify-and-book`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone: pendingVerificationPhone, code })
        });
        const result = await res.json();

        if (!res.ok) {
            if (errEl) { errEl.textContent = result.error || 'Nesprávný kód'; errEl.classList.add('show'); }
            return;
        }

        // Capture everything needed to offer online payment BEFORE
        // closeReservationSheet() resets currentOrder/reservationTargetTable.
        const bookedTableName = reservationTargetTable;
        const bookedTable = timetables[bookedTableName];
        const duration = reservationSelectedDuration || 1;
        const dayIndex = getDayIndexFromDateString(reservationSelectedDate);
        const startHour = reservationSelectedHour;
        const order = getOrderArray();
        const orderTotal = getOrderTotal();
        const dateObj = new Date(reservationSelectedDate + 'T00:00:00');

        let summary = `Stůl „${bookedTableName}“ je rezervován na ${formatDayShort(dateObj)}, ${hourStartLabel(startHour)} (${duration} h).`;
        if (order.length > 0) summary += ` Objednávka k rezervaci: ${orderTotal.toFixed(0)} Kč.`;
        document.getElementById('rsvSuccessSummary').textContent = summary;

        rsvLastBookingResult = (order.length > 0 && bookedTable && bookedTable.fileId) ? {
            ctx: {
                fileId: bookedTable.fileId,
                dateStr: reservationSelectedDate,
                dayIndex,
                startHour,
                endHour: startHour + duration - 1,
                tableName: bookedTableName,
            },
            orderTotal,
        } : null;

        showStep('rsvStepSuccess');
        loadTimetables();
    } catch (err) {
        console.error(err);
        if (errEl) { errEl.textContent = 'Nepodařilo se ověřit kód, zkuste to znovu.'; errEl.classList.add('show'); }
    } finally {
        if (verifyBtn) { verifyBtn.disabled = false; verifyBtn.textContent = 'Potvrdit kód'; }
    }
}

// ─── RESERVATION FOOD-ORDER ONLINE PAYMENT ──────────────────────────────────
// Offered right after a successful booking, only when a food order was
// attached. The guest is on their own device here (unlike the waiter-held
// inner.html flow, which shows a QR code instead), so a plain redirect to
// GoPay makes more sense than a QR code. GoPay's return trip lands back on
// this same page (see the explicit returnUrl below) — pendingResvTx below is
// how we recognize that on load and resume polling instead of showing
// nothing.

const RESV_PENDING_TX_KEY = 'reservation_pending_payment_tx';
const RESV_POLL_INTERVAL_MS = 3000;
const RESV_POLL_MAX_ATTEMPTS = 60; // ~3 minutes

let resvPaymentContext = null; // { fileId, dateStr, dayIndex, startHour, endHour, tableName }
let resvPollHandle = null;
let resvPollAttempts = 0;

function stopResvPolling() {
    if (resvPollHandle) clearInterval(resvPollHandle);
    resvPollHandle = null;
}

function setPendingResvTx(txId, ctx) {
    try { localStorage.setItem(RESV_PENDING_TX_KEY, JSON.stringify({ txId, ctx })); } catch (e) { /* ignore */ }
}
function getPendingResvTx() {
    try { return JSON.parse(localStorage.getItem(RESV_PENDING_TX_KEY) || 'null'); } catch (e) { return null; }
}
function clearPendingResvTx() {
    try { localStorage.removeItem(RESV_PENDING_TX_KEY); } catch (e) { /* ignore */ }
}

function openPaymentSheet(ctx, orderTotal) {
    resvPaymentContext = ctx;
    document.getElementById('rsvPaySummary').textContent =
        `Stůl „${ctx.tableName}“ byl úspěšně rezervován. Objednávka k rezervaci: ${orderTotal.toFixed(0)} Kč.`;
    document.getElementById('rsvPayStatus').innerHTML = '';

    const payBtn = document.getElementById('rsvPayOnlineBtn');
    if (payBtn) { payBtn.classList.remove('rsv-hidden'); payBtn.disabled = false; payBtn.textContent = 'Zaplatit online'; }
    document.getElementById('rsvPayActions')?.classList.remove('rsv-hidden');

    openSheet('rsvPaySheetBackdrop', 'rsvPaySheet');
}

function closePaymentSheet() {
    stopResvPolling();
    closeSheet('rsvPaySheetBackdrop', 'rsvPaySheet');
}

document.getElementById('rsvPayLaterBtn')?.addEventListener('click', closePaymentSheet);
document.getElementById('rsvPaySheetBackdrop')?.addEventListener('click', closePaymentSheet);

document.getElementById('rsvPayOnlineBtn')?.addEventListener('click', async () => {
    if (!resvPaymentContext) return;
    const btn = document.getElementById('rsvPayOnlineBtn');
    btn.disabled = true;
    btn.textContent = 'Zahajuji…';

    try {
        const res = await fetch(`${API_URL}/kitchen/reservation/pay-online`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                fileId: resvPaymentContext.fileId,
                dateStr: resvPaymentContext.dateStr,
                dayIndex: resvPaymentContext.dayIndex,
                startHour: resvPaymentContext.startHour,
                endHour: resvPaymentContext.endHour,
                returnUrl: window.location.origin + window.location.pathname
            })
        });
        const result = await res.json();
        if (!res.ok) throw new Error(result.error || 'Nepodařilo se zahájit platbu');

        if (result.redirectUrl) {
            setPendingResvTx(result.gatewayTransactionId, resvPaymentContext);
            window.location.href = result.redirectUrl;
            return;
        }

        // No real gateway configured — simulated payment, still pollable.
        document.getElementById('rsvPayActions')?.classList.add('rsv-hidden');
        const status = document.getElementById('rsvPayStatus');
        if (status) status.innerHTML = `
            <p class="rsv-payment-note"><strong>🧪 Testovací režim</strong> — platební brána zatím není nastavena, platba se simuluje.</p>
            <p class="rsv-payment-status rsv-payment-status--waiting">Čekám na potvrzení platby…</p>
        `;
        setPendingResvTx(result.gatewayTransactionId, resvPaymentContext);
        startResvPolling(result.gatewayTransactionId);
    } catch (e) {
        console.error(e);
        const status = document.getElementById('rsvPayStatus');
        if (status) status.innerHTML = `<p class="rsv-payment-status rsv-payment-status--failed">${escapeHtml(e.message || 'Nepodařilo se zahájit platbu')}</p>`;
        btn.disabled = false;
        btn.textContent = 'Zaplatit online';
    }
});

function startResvPolling(txId) {
    stopResvPolling();
    resvPollAttempts = 0;
    resvPollHandle = setInterval(() => checkResvPaymentStatus(txId), RESV_POLL_INTERVAL_MS);
}

async function checkResvPaymentStatus(txId) {
    resvPollAttempts++;
    const status = document.getElementById('rsvPayStatus');
    try {
        const res = await fetch(`${API_URL}/payments/tx/${encodeURIComponent(txId)}/status`);
        if (!res.ok) {
            if (res.status === 404) { stopResvPolling(); clearPendingResvTx(); }
            return;
        }
        const st = await res.json();

        if (st.status === 'paid') {
            stopResvPolling();
            clearPendingResvTx();
            if (status) status.innerHTML = '<p class="rsv-payment-status rsv-payment-status--paid">Zaplaceno</p>';
            loadTimetables();
            return;
        }
        if (st.status === 'failed') {
            stopResvPolling();
            clearPendingResvTx();
            if (status) status.innerHTML = '<p class="rsv-payment-status rsv-payment-status--failed">Platba se nezdařila nebo vypršela.</p>';
            return;
        }
        if (resvPollAttempts >= RESV_POLL_MAX_ATTEMPTS) {
            stopResvPolling();
            if (status) {
                status.innerHTML = `
                    <p class="rsv-payment-note">Potvrzení platby zatím nedorazilo.</p>
                    <button type="button" class="ds-btn ds-btn--ghost ds-btn--block" id="resvRetryCheckBtn">Zkontrolovat znovu</button>
                `;
                document.getElementById('resvRetryCheckBtn')?.addEventListener('click', () => {
                    status.innerHTML = '<p class="rsv-payment-status rsv-payment-status--waiting">Kontroluji…</p>';
                    startResvPolling(txId);
                });
            }
        }
    } catch (e) {
        console.error('Reservation payment status poll failed:', e);
    }
}

// On load, if we're returning from GoPay (or reloading a simulated-payment
// tab), pendingResvTx is still set — resume polling and show the same
// payment sheet, keyed only by the opaque gateway transaction id.
function resumePendingResvPaymentIfAny() {
    const pending = getPendingResvTx();
    if (!pending || !pending.txId) return;

    resvPaymentContext = pending.ctx || null;
    const summary = document.getElementById('rsvPaySummary');
    if (summary) {
        summary.textContent = (pending.ctx && pending.ctx.tableName)
            ? `Kontroluji platbu za rezervaci stolu „${pending.ctx.tableName}“.`
            : 'Kontroluji stav platby…';
    }
    const status = document.getElementById('rsvPayStatus');
    if (status) status.innerHTML = '<p class="rsv-payment-status rsv-payment-status--waiting">Kontroluji stav platby…</p>';
    document.getElementById('rsvPayActions')?.classList.add('rsv-hidden');

    openSheet('rsvPaySheetBackdrop', 'rsvPaySheet');
    startResvPolling(pending.txId);
}

// ─── INIT ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
    reservationSelectedDate = getDateString(getCurrentDate());

    // Party size is independent of date/time/settings, so it renders
    // immediately rather than waiting on fetchRestaurantSettings()/
    // loadTimetables() below.
    renderPartySizeChips();
    // Paint the step states before the network settles, so the first frame
    // already shows steps 3 and 4 as not-yet-reachable rather than lighting
    // the whole flow up and dimming it a moment later.
    updateStepStates();

    // This page is used on a phone. Every control sets
    // -webkit-tap-highlight-color: transparent, which removes iOS's own tap
    // flash, and Safari only applies :active to a tapped element once the
    // document carries a touch listener — without this line the CSS press
    // state never fires there and a tap gives no feedback at all.
    document.addEventListener('touchstart', () => {}, { passive: true });

    document.getElementById('rsvDayStrip')?.addEventListener('scroll', updateScrollHint);

    document.getElementById('rsvOrderToggle')?.addEventListener('click', () => {
        const exp = document.getElementById('rsvOrderExpander');
        const open = exp?.classList.toggle('open');
        document.getElementById('rsvOrderToggle')?.setAttribute('aria-expanded', String(!!open));
    });

    document.getElementById('rsvCancelBtn')?.addEventListener('click', closeReservationSheet);
    document.getElementById('rsvSheetBackdrop')?.addEventListener('click', closeReservationSheet);
    document.getElementById('rsvConfirmBtn')?.addEventListener('click', requestVerificationCode);

    // Combo customize sheet (see openComboCustomizeSheet) — its own
    // cancel/backdrop/confirm, independent of the booking sheet's.
    document.getElementById('rsvComboCancelBtn')?.addEventListener('click', closeComboCustomizeSheet);
    document.getElementById('rsvComboSheetBackdrop')?.addEventListener('click', closeComboCustomizeSheet);
    document.getElementById('rsvComboAddBtn')?.addEventListener('click', confirmComboCustomize);
    document.getElementById('rsvVerifyBtn')?.addEventListener('click', verifyCodeAndBook);
    document.getElementById('rsvBackBtn')?.addEventListener('click', () => showStep('rsvStepDetails'));
    document.getElementById('rsvResendBtn')?.addEventListener('click', resendCode);
    document.getElementById('rsvCodeInput')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') verifyCodeAndBook();
    });

    document.getElementById('rsvSuccessCloseBtn')?.addEventListener('click', () => {
        closeReservationSheet();
        if (rsvLastBookingResult) {
            openPaymentSheet(rsvLastBookingResult.ctx, rsvLastBookingResult.orderTotal);
            rsvLastBookingResult = null;
        }
    });

    await fetchRestaurantSettings();
    renderFooterBusinessLine();
    applyReservationPausedUi();

    if (!reservationsArePaused()) {
        loadTimetables();
        resumePendingResvPaymentIfAny();
    }
});
