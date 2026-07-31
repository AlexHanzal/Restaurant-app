// ════════════════════════════════════════════════════════════════════════
// DELIVERY / MENU BROWSING — read-only menu view + local cart + checkout
// Mirrors the menu data shape used by inner.js / renderer.js:
//   menu = { main: [dish...], side: [...], drinks: [...], desserts: [...] }
//   dish = { id, name, price, info, imageUrl, createdAt }
// The cart is local to this page; checkout POSTs to /api/orders (unchanged).
// ════════════════════════════════════════════════════════════════════════

const API_BASE_URL = window.API_BASE_URL || `http://${window.location.hostname}:3000`;
const API_URL = `${API_BASE_URL}/reservation/api`;

const MENU_CATEGORIES = [
    { id: 'main',     label: 'Hlavní jídla' },
    { id: 'side',     label: 'Přílohy' },
    { id: 'drinks',   label: 'Nápoje' },
    { id: 'desserts', label: 'Dezerty' },
];

let currentMenu = {};
let activeCategory = null; // category id currently highlighted by scroll-spy
let cart = {}; // dishId -> { id, name, price, categoryId, qty }
let dishIndex = {}; // dishId -> { dish, categoryId } — for in-place row updates
let sectionObserver = null;

// go-live Task 3 (spec §5): today's specials ("Polední menu"), fetched from
// the PUBLIC GET /daily-menu (no ?date=) — only ever returns items while
// settings.dailyMenu.enabled and the current time is within from/to (empty
// list otherwise, e.g. outside the window or nothing entered today). Each
// item's cart/dish id is namespaced "daily:<id>" (see DAILY_ITEM_ID_PREFIX
// in server.js) so priceOrderItems() there can tell a daily-menu line apart
// from a regular menu dish id/name and price it from the dailyMenu record
// instead — the server never trusts this client-side price for these items
// either, same as regular dishes.
const DAILY_ITEM_ID_PREFIX = 'daily:';
const DAILY_CATEGORY_ID = 'daily-menu';
let dailyMenuItems = []; // [{id, name, price, vatRate}] as returned by the server

// ── COMBO MENUS ("Zvýhodněná menu") ─────────────────────────────────────
// Spec: docs/superpowers/specs/2026-07-22-combo-menus-design.md. Fetched
// from the PUBLIC GET /combos alongside the regular menu. Each combo bundles
// a few regular-menu dishes (by id, "slots") for one price, and the
// customer may customize it before adding it to the cart: remove a slot
// (subtracts that slot's admin-set removeValue), swap a slot's dish for one
// of the admin-allowed alternatives (price difference applies both ways),
// tick paid extras, and attach a short note. A customized combo becomes ONE
// cart line, namespaced "combo:<comboId>" (mirrors the "daily:" pattern
// above) — see COMBO_ITEM_ID_PREFIX further down for how the cart/checkout
// side tells these apart from regular dish lines. The server is always the
// price/name authority (see priceOrderItems()'s combo: branch, server.js);
// everything computed here is display-only, but must match that formula so
// the customer isn't surprised at checkout.
let combos = []; // raw array as returned by GET /combos, unfiltered
const COMBO_CATEGORY_ID = 'combo-menu'; // pseudo-category, mirrors DAILY_CATEGORY_ID

async function fetchCombos() {
    try {
        const res = await fetch(`${API_URL}/combos`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        combos = Array.isArray(data) ? data : [];
    } catch (e) {
        // Fails open to "no combos" — the section simply doesn't render
        // (see isComboRenderable()/renderMenuSections()). Combos are a
        // bonus on top of the regular menu, so a failure here must never
        // block the rest of the page (no toast, unlike fetchMenu()).
        console.error('Failed to load combos:', e);
        combos = [];
    }
    return combos;
}

// ── RESTAURANT SETTINGS (delivery hours / pause) ────────────────────────
// Fetched once on load from the public GET /settings (src/server/settings.js
// is the canonical shape/authority — POST /orders re-checks this for real).
// Menu stays browsable regardless; only checkout submission is gated.
let restaurantSettings = null;
let deliveryClosedInfo = { closed: false, reason: null };

async function fetchRestaurantSettings() {
    try {
        const res = await fetch(`${API_URL}/settings`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        restaurantSettings = await res.json();
    } catch (e) {
        console.error('Failed to load restaurant settings:', e);
        restaurantSettings = null; // fail-open on the client — server still enforces on POST /orders
    }
    return restaurantSettings;
}

// go-live Task 5 (spec §7): fills in the footer's business-identity line
// from settings.business once fetched — replaces the static "[doplnit]"
// placeholder text that used to be hardcoded in delivery.html. Fails
// silently (leaves the line blank) if settings didn't load — same
// fail-open spirit as the rest of this section.
function renderFooterBusinessLine() {
    const el = document.getElementById('footerBusinessLine');
    if (!el || !restaurantSettings) return;
    const b = restaurantSettings.business || {};
    const contact = [b.email, b.phone].filter(Boolean).join(' / ');
    el.textContent = [b.name, b.ico ? `IČO: ${b.ico}` : '', b.address, contact]
        .filter(Boolean)
        .join(' · ');
}

function todayDateStrLocal(now) {
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function todayHHMM(now) {
    return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

// Monday-first weekday index (0=Po..6=Ne) — matches settings.js's
// dayIndexMonFirst() / the admin Nastavení delivery-hours table ordering.
function dayIndexMonFirst(now) {
    return (now.getDay() + 6) % 7;
}

// Mirrors settings.js's isDeliveryOpenNow() logic client-side (read-only,
// advisory) so the banner can explain *why* delivery is closed and show
// today's hours. The server is the actual authority.
function computeDeliveryClosedInfo() {
    if (!restaurantSettings) return { closed: false, reason: null };
    const delivery = restaurantSettings.delivery || {};

    if (delivery.paused) {
        return { closed: true, reason: 'Rozvoz je dočasně pozastaven.' };
    }

    const now = new Date();
    const dateStr = todayDateStrLocal(now);
    const closedDay = (restaurantSettings.closedDays || []).find(cd => cd && cd.date === dateStr);
    if (closedDay) {
        return { closed: true, reason: 'Rozvoz je momentálně uzavřen.' };
    }

    const dayKey = String(dayIndexMonFirst(now));
    const today = delivery.days && delivery.days[dayKey];
    if (!today || !today.open) {
        return { closed: true, reason: 'Rozvoz je momentálně uzavřen. Dnes nerozvážíme.' };
    }

    const hhmm = todayHHMM(now);
    if (hhmm < today.from || hhmm > today.to) {
        return { closed: true, reason: `Rozvoz je momentálně uzavřen. Dnes rozvážíme ${today.from}–${today.to}.` };
    }

    return { closed: false, reason: null };
}

function applyDeliveryClosedUi() {
    deliveryClosedInfo = computeDeliveryClosedInfo();

    const notice = document.getElementById('deliveryNotice');
    if (notice) {
        if (deliveryClosedInfo.closed) {
            notice.textContent = deliveryClosedInfo.reason;
            notice.hidden = false;
        } else {
            notice.hidden = true;
        }
    }

    const hint = document.getElementById('checkoutClosedHint');
    if (hint) {
        if (deliveryClosedInfo.closed) {
            hint.textContent = deliveryClosedInfo.reason;
            hint.hidden = false;
        } else {
            hint.hidden = true;
        }
    }

    updateSubmitButtonState();
}

// ── DELIVERY PRICING PREVIEW (fee / free-above / min-order / ETA) ──────────
// go-live Task 2 (spec §4). settings.delivery.fee/minOrder/freeAbove/
// etaMinutes drive a live client-side preview of what POST /orders will
// actually charge — the server re-derives all of this for real via
// settingsStore.quoteDelivery(), so this is advisory only, same spirit as
// computeDeliveryClosedInfo() above. Unlike the PSČ whitelist (which gates
// *whether* an order is accepted), the fee amount itself never depends on
// PSČ — only on the cart subtotal — so this can run before the customer has
// even opened the checkout sheet.
function computeDeliveryQuoteDisplay(subtotal) {
    const delivery = (restaurantSettings && restaurantSettings.delivery) || {};
    const fee = Number(delivery.fee) || 0;
    const minOrder = Number(delivery.minOrder) || 0;
    const freeAbove = Number(delivery.freeAbove) || 0;
    const etaMinutes = Number(delivery.etaMinutes) || 0;

    const reachedFreeAbove = freeAbove > 0 && subtotal >= freeAbove;
    const effectiveFee = reachedFreeAbove ? 0 : fee;
    const remainingToFree = (freeAbove > 0 && !reachedFreeAbove) ? Math.max(0, freeAbove - subtotal) : 0;
    const belowMin = minOrder > 0 && subtotal < minOrder;

    return { fee: effectiveFee, minOrder, freeAbove, etaMinutes, remainingToFree, belowMin, reachedFreeAbove };
}

let minOrderBlockInfo = { blocked: false, reason: null };

function updateSubmitButtonState() {
    const submitBtn = document.getElementById('submitOrderBtn');
    if (submitBtn) submitBtn.disabled = deliveryClosedInfo.closed || minOrderBlockInfo.blocked;
}

// Updates the min-order gate (hint text + submit-button disabled state) from
// an already-computed quote. Called from renderCartDrawer() whenever the
// cart changes, so it always reflects the current subtotal.
function updateMinOrderGate(quote, hasItems) {
    minOrderBlockInfo = (quote.belowMin && hasItems)
        ? { blocked: true, reason: `Minimální objednávka je ${formatPrice(quote.minOrder)}.` }
        : { blocked: false, reason: null };

    const hint = document.getElementById('minOrderHint');
    if (hint) {
        if (minOrderBlockInfo.blocked) {
            hint.textContent = minOrderBlockInfo.reason;
            hint.hidden = false;
        } else {
            hint.hidden = true;
        }
    }

    updateSubmitButtonState();
}

// ── UTIL ─────────────────────────────────────────────────────────────────

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str ?? '';
    return div.innerHTML;
}

function showToast(msg, isError = false) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className = 'ds-toast show' + (isError ? ' error' : '');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => t.classList.remove('show'), 2400);
}

function formatPrice(n) {
    return `${Number(n || 0).toFixed(0)} Kč`;
}

// ── SHEET HELPERS (generic open/close, matches design.css .ds-sheet contract) ──

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

// ── DATA LOADING ─────────────────────────────────────────────────────────

async function fetchMenu() {
    try {
        const res = await fetch(`${API_URL}/menu`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        currentMenu = await res.json();
    } catch (e) {
        console.error('Failed to load menu:', e);
        currentMenu = {};
        showToast('Nepodařilo se načíst menu', true);
    }
    return currentMenu;
}

// go-live Task 3 (spec §5): public, no ?date= — server only ever returns
// today's items, and only inside the configured window. Fails open to an
// empty list (never blocks the rest of the page from loading) on any error.
async function fetchDailyMenu() {
    try {
        const res = await fetch(`${API_URL}/daily-menu`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        dailyMenuItems = Array.isArray(data.items) ? data.items : [];
    } catch (e) {
        console.error('Failed to load daily menu:', e);
        dailyMenuItems = [];
    }
    return dailyMenuItems;
}

// Category-label lookup that also understands the daily-menu pseudo-category
// (which isn't in MENU_CATEGORIES — it's rendered separately, see
// renderMenuSections) — used by the cart drawer to show a category label.
function categoryLabel(categoryId) {
    if (categoryId === DAILY_CATEGORY_ID) return 'Polední menu';
    if (categoryId === COMBO_CATEGORY_ID) return 'Zvýhodněná menu';
    return (MENU_CATEGORIES.find(c => c.id === categoryId) || {}).label || '';
}

// ── CATEGORY NAV (sticky chips, scroll-spy highlight) ───────────────────

function renderCatTabs() {
    const container = document.getElementById('catTabs');
    container.innerHTML = '';

    const cats = MENU_CATEGORIES.filter(cat => (currentMenu[cat.id] || []).length > 0);
    const hasDaily = dailyMenuItems.length > 0;
    const hasCombos = combos.filter(isComboRenderable).length > 0;
    container.hidden = cats.length === 0 && !hasDaily && !hasCombos;
    if (cats.length === 0 && !hasDaily && !hasCombos) return;

    // COMBO MENUS (spec: 2026-07-22-combo-menus-design.md): "Zvýhodněná
    // menu" chip, same accent treatment as the daily-menu chip below, and
    // rendered first since renderMenuSections() also puts the combos
    // section first (above even the daily menu) — chip order mirrors
    // scroll order.
    if (hasCombos) {
        const tab = document.createElement('button');
        tab.type = 'button';
        tab.className = 'ds-chip ds-chip--accent';
        tab.textContent = '🍱 Zvýhodněná menu';
        tab.dataset.categoryId = COMBO_CATEGORY_ID;
        tab.addEventListener('click', () => {
            document.getElementById('cat-combo-menu')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
        container.appendChild(tab);
    }

    // go-live Task 3 (spec §5): "Polední menu" chip, accent-styled (ds-chip
    // --accent, red fill) so it stands out from the regular category chips —
    // rendered first since the section it jumps to is also rendered first
    // (see renderMenuSections), matching visual order to scroll order.
    if (hasDaily) {
        const tab = document.createElement('button');
        tab.type = 'button';
        tab.className = 'ds-chip ds-chip--accent';
        tab.textContent = '🍽 Polední menu';
        tab.dataset.categoryId = DAILY_CATEGORY_ID;
        tab.addEventListener('click', () => {
            document.getElementById('cat-daily-menu')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
        container.appendChild(tab);
    }

    cats.forEach((cat, i) => {
        const tab = document.createElement('button');
        tab.type = 'button';
        tab.className = 'ds-chip' + (i === 0 && !hasDaily ? ' ds-chip--selected' : '');
        tab.textContent = cat.label;
        tab.dataset.categoryId = cat.id;
        tab.addEventListener('click', () => {
            document.getElementById(`cat-${cat.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
        container.appendChild(tab);
    });
    activeCategory = hasCombos ? COMBO_CATEGORY_ID : (hasDaily ? DAILY_CATEGORY_ID : (cats[0] ? cats[0].id : null));
}

function setActiveCategoryChip(categoryId) {
    if (!categoryId || activeCategory === categoryId) return;
    activeCategory = categoryId;
    document.querySelectorAll('#catTabs .ds-chip').forEach(chip => {
        chip.classList.toggle('ds-chip--selected', chip.dataset.categoryId === categoryId);
    });
}

function setupScrollSpy() {
    if (sectionObserver) sectionObserver.disconnect();
    const sections = document.querySelectorAll('.del-menu-section');
    if (sections.length === 0) return;
    sectionObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) setActiveCategoryChip(entry.target.dataset.categoryId);
        });
    }, { root: null, rootMargin: '-64px 0px -70% 0px', threshold: 0 });
    sections.forEach(s => sectionObserver.observe(s));
}

// ── MENU SECTIONS (full listing — every category with dishes, all at once) ──

// go-live Task 3 (spec §5): builds a dish-shaped object out of a daily-menu
// item so it can flow through the exact same renderDishRow/buildDishAction/
// changeCartQty machinery as a regular menu dish — the "daily:" id prefix is
// what tells the cart/server the two kinds of line apart (see the header
// comment on DAILY_ITEM_ID_PREFIX above). Sold-out logic never applies to
// these (spec §5), so soldOut is always false here.
function dailyItemAsDish(item) {
    return { id: `${DAILY_ITEM_ID_PREFIX}${item.id}`, name: item.name, price: item.price, info: '', imageUrl: '', soldOut: false };
}

function renderMenuSections() {
    const container = document.getElementById('menuSections');
    container.innerHTML = '';
    dishIndex = {};

    // ── Zvýhodněná menu (combos — rendered first, above even the daily
    // menu; spec: "ABOVE the regular category sections") ────────────────
    const renderableCombos = combos.filter(isComboRenderable);
    if (renderableCombos.length > 0) {
        container.appendChild(buildCombosSection(renderableCombos));
    }

    // ── Polední menu (highlighted, above the regular categories) ────────
    if (dailyMenuItems.length > 0) {
        const dailySection = document.createElement('section');
        dailySection.className = 'del-menu-section del-menu-section--daily';
        dailySection.id = 'cat-daily-menu';
        dailySection.dataset.categoryId = DAILY_CATEGORY_ID;

        const head = document.createElement('div');
        head.className = 'del-menu-section__head';
        head.innerHTML = `<span class="ds-microlabel">🍽 Polední menu</span><span class="del-menu-section__count">${dailyMenuItems.length} položek</span>`;
        dailySection.appendChild(head);

        const list = document.createElement('div');
        list.className = 'del-dish-list';
        dailyMenuItems.forEach(item => {
            const dish = dailyItemAsDish(item);
            dishIndex[dish.id] = { dish, categoryId: DAILY_CATEGORY_ID };
            list.appendChild(renderDishRow(dish, DAILY_CATEGORY_ID));
        });
        dailySection.appendChild(list);

        container.appendChild(dailySection);
    }

    const cats = MENU_CATEGORIES.filter(cat => (currentMenu[cat.id] || []).length > 0);
    if (cats.length === 0 && dailyMenuItems.length === 0 && renderableCombos.length === 0) {
        container.innerHTML = `<p class="ds-empty">Menu zatím není k dispozici.</p>`;
        return;
    }

    cats.forEach(cat => {
        const dishes = currentMenu[cat.id] || [];

        const section = document.createElement('section');
        section.className = 'del-menu-section';
        section.id = `cat-${cat.id}`;
        section.dataset.categoryId = cat.id;

        const head = document.createElement('div');
        head.className = 'del-menu-section__head';
        head.innerHTML = `<span class="ds-microlabel">${escapeHtml(cat.label)}</span><span class="del-menu-section__count">${dishes.length} položek</span>`;
        section.appendChild(head);

        const list = document.createElement('div');
        list.className = 'del-dish-list';
        dishes.forEach(dish => {
            dishIndex[dish.id] = { dish, categoryId: cat.id };
            list.appendChild(renderDishRow(dish, cat.id));
        });
        section.appendChild(list);

        container.appendChild(section);
    });

    setupScrollSpy();
}

function renderDishRow(dish, categoryId) {
    const row = document.createElement('div');
    row.className = 'del-dish' + (dish.soldOut ? ' del-dish--soldout' : '');

    if (dish.imageUrl) {
        const img = document.createElement('img');
        img.className = 'del-dish__thumb';
        img.src = dish.imageUrl;
        img.alt = dish.name;
        img.onerror = function () { this.replaceWith(makePlaceholder()); };
        row.appendChild(img);
    } else {
        row.appendChild(makePlaceholder());
    }

    const body = document.createElement('div');
    body.className = 'del-dish__body';
    body.innerHTML = `
        <div class="del-dish__name">${escapeHtml(dish.name)}${dish.soldOut ? ' <span class="ds-badge ds-badge--unpaid">Vyprodáno</span>' : ''}</div>
        ${dish.info ? `<div class="del-dish__info">${escapeHtml(dish.info)}</div>` : ''}
        <div class="del-dish__price">${formatPrice(dish.price)}</div>
    `;
    row.appendChild(body);

    const action = document.createElement('div');
    action.className = 'del-dish__action';
    action.id = `dish-action-${dish.id}`;
    action.appendChild(buildDishAction(dish, categoryId));
    row.appendChild(action);

    return row;
}

function buildDishAction(dish, categoryId) {
    // go-live Task 3 (spec §5): sold-out dishes render visibly disabled —
    // faded row (del-dish--soldout) + "Vyprodáno" badge next to the name
    // (above) — and get no add button/stepper at all, regardless of
    // whatever qty might already be sitting in the cart (a stale tab from
    // before the dish sold out). That existing cart line is left alone
    // here — it's surfaced instead as a clean server-error toast at
    // checkout (see submitOrder(), which already shows result.error as-is).
    if (dish.soldOut) return document.createDocumentFragment();

    const qty = cart[dish.id]?.qty || 0;
    if (qty > 0) return buildStepper(dish, categoryId);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'del-dish__add';
    btn.textContent = '+';
    btn.setAttribute('aria-label', `Přidat ${dish.name} do košíku`);
    btn.addEventListener('click', () => changeCartQty(dish, categoryId, 1));
    return btn;
}

function buildStepper(dish, categoryId) {
    const stepper = document.createElement('div');
    stepper.className = 'ds-stepper';

    const minusBtn = document.createElement('button');
    minusBtn.type = 'button';
    minusBtn.className = 'ds-stepper__btn';
    minusBtn.textContent = '−';
    minusBtn.setAttribute('aria-label', `Ubrat ${dish.name}`);
    minusBtn.addEventListener('click', () => changeCartQty(dish, categoryId, -1));

    const qtySpan = document.createElement('span');
    qtySpan.className = 'ds-stepper__value';
    qtySpan.textContent = cart[dish.id]?.qty || 0;

    const plusBtn = document.createElement('button');
    plusBtn.type = 'button';
    plusBtn.className = 'ds-stepper__btn';
    plusBtn.textContent = '+';
    plusBtn.setAttribute('aria-label', `Přidat ${dish.name}`);
    plusBtn.addEventListener('click', () => changeCartQty(dish, categoryId, 1));

    stepper.appendChild(minusBtn);
    stepper.appendChild(qtySpan);
    stepper.appendChild(plusBtn);
    return stepper;
}

function makePlaceholder() {
    const div = document.createElement('div');
    div.className = 'del-dish__thumb del-dish__thumb--placeholder';
    return div;
}

// ── COMBO MENUS ("Zvýhodněná menu") — cards + customize dialog ──────────
// Spec: docs/superpowers/specs/2026-07-22-combo-menus-design.md.

// Dish lookup restricted to the regular menu categories (MENU_CATEGORIES) —
// combo slots/swaps only ever reference regular menu dishes, never
// daily-menu items. Mirrors flattenMenuDishes()/findMenuDish() in
// server.js, just client-side and by exact id.
function findDishInMenu(dishId) {
    for (const cat of MENU_CATEGORIES) {
        const found = (currentMenu[cat.id] || []).find(d => d.id === dishId);
        if (found) return found;
    }
    return null;
}

// "A combo whose slot references a dish missing from the fetched menu is
// skipped (not rendered)" (plan, Task 3). Only the *default* dish of every
// slot is checked here — a default dish that still exists but is itself
// soldOut is left to render as-is; the server rejects the order at
// checkout time if the customer doesn't remove/swap that slot away (same
// "server is the source of truth" spirit as everywhere else on this page).
function isComboRenderable(combo) {
    if (!combo || !Array.isArray(combo.items) || combo.items.length === 0) return false;
    return combo.items.every(it => it && !!findDishInMenu(it.dishId));
}

// "dish1 + dish2 + dish3" — default dish names, in slot order.
function comboContentsSummary(combo) {
    return (combo.items || [])
        .map(it => findDishInMenu(it.dishId)?.name)
        .filter(Boolean)
        .join(' + ');
}

function buildCombosSection(renderableCombos) {
    const section = document.createElement('section');
    section.className = 'del-menu-section del-menu-section--combos';
    section.id = 'cat-combo-menu';
    section.dataset.categoryId = COMBO_CATEGORY_ID;

    const head = document.createElement('div');
    head.className = 'del-menu-section__head';
    head.innerHTML = `<span class="ds-microlabel">🍱 Zvýhodněná menu</span><span class="del-menu-section__count">${renderableCombos.length} položek</span>`;
    section.appendChild(head);

    const list = document.createElement('div');
    list.className = 'del-combo-list';
    renderableCombos.forEach(combo => list.appendChild(renderComboCard(combo)));
    section.appendChild(list);

    return section;
}

function renderComboCard(combo) {
    const row = document.createElement('div');
    row.className = 'del-combo' + (combo.soldOut ? ' del-combo--soldout' : '');

    if (combo.image) {
        const img = document.createElement('img');
        img.className = 'del-combo__thumb';
        img.src = combo.image;
        img.alt = combo.name;
        img.onerror = function () { this.replaceWith(makePlaceholder()); };
        row.appendChild(img);
    } else {
        row.appendChild(makePlaceholder());
    }

    const body = document.createElement('div');
    body.className = 'del-combo__body';
    body.innerHTML = `
        <div class="del-combo__name">${escapeHtml(combo.name)}${combo.soldOut ? ' <span class="ds-badge ds-badge--unpaid">Vyprodáno</span>' : ''}</div>
        ${combo.description ? `<div class="del-combo__desc">${escapeHtml(combo.description)}</div>` : ''}
        <div class="del-combo__contents">${escapeHtml(comboContentsSummary(combo))}</div>
        <div class="del-combo__price">${formatPrice(combo.price)}</div>
    `;
    row.appendChild(body);

    const action = document.createElement('div');
    action.className = 'del-combo__action';
    action.appendChild(buildComboAction(combo));
    row.appendChild(action);

    return row;
}

// Sold-out combos get no button at all (same treatment as buildDishAction()
// for sold-out dishes) — faded row + badge above is the only signal, and
// nothing here is clickable. A combo always opens the customize dialog
// (even one with no removable/swappable slots) so the note field and final
// price confirmation are always available before it lands in the cart.
function buildComboAction(combo) {
    if (combo.soldOut) return document.createDocumentFragment();

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'del-combo__customize-btn ds-btn ds-btn--primary';
    btn.textContent = 'Přizpůsobit a přidat';
    btn.addEventListener('click', () => openComboDialog(combo));
    return btn;
}

// ± / − / + Kč delta formatting per spec ("labels show ±X Kč price deltas").
function formatSignedDelta(delta) {
    const n = Math.round(Number(delta) || 0);
    if (n === 0) return '+0 Kč';
    return n > 0 ? `+${n} Kč` : `−${Math.abs(n)} Kč`;
}

// Same formula as the server's combo: branch in priceOrderItems() (spec
// "Cart line & server-side pricing"): base price − removed slots'
// removeValue + (swap dish price − default dish price) for swapped slots +
// checked extras, clamped at 0. Display-only — the server always
// recomputes for real.
function computeComboUnitPrice(combo, slotSelections, extrasSelected) {
    let price = Number(combo.price) || 0;

    (combo.items || []).forEach(it => {
        const sel = slotSelections[it.slotId] || 'default';
        if (sel === 'removed') {
            price -= Number(it.removeValue) || 0;
        } else if (sel.startsWith('swap:')) {
            const swapDish = findDishInMenu(sel.slice(5));
            const defaultDish = findDishInMenu(it.dishId);
            if (swapDish && defaultDish) {
                price += (Number(swapDish.price) || 0) - (Number(defaultDish.price) || 0);
            }
        }
    });

    (combo.extras || []).forEach(ex => {
        if (extrasSelected.has(ex.id)) price += Number(ex.price) || 0;
    });

    return Math.max(0, price);
}

// Rebuilds the exact human-readable breakdown the server stores as the
// order line's name (spec example: "Menu 1 (bez polévky, Fanta místo
// Coca-Cola, + Extra sýr, pozn.: bez cibule)") — so the customer sees in
// the cart precisely what they configured, in the same words the kitchen/
// receipt will eventually show. No changes at all → just the combo name.
function buildComboDisplayName(combo, removedSlotIds, swapsMap, extraIds, note) {
    const parts = [];

    (combo.items || []).forEach(it => {
        if (removedSlotIds.includes(it.slotId)) {
            const dish = findDishInMenu(it.dishId);
            parts.push(`bez ${dish ? dish.name : it.slotId}`);
        } else if (swapsMap[it.slotId]) {
            const defaultDish = findDishInMenu(it.dishId);
            const swapDish = findDishInMenu(swapsMap[it.slotId]);
            parts.push(`${swapDish ? swapDish.name : swapsMap[it.slotId]} místo ${defaultDish ? defaultDish.name : it.slotId}`);
        }
    });

    (combo.extras || []).forEach(ex => {
        if (extraIds.includes(ex.id)) parts.push(`+ ${ex.name}`);
    });

    if (note) parts.push(`pozn.: ${note}`);

    return parts.length > 0 ? `${combo.name} (${parts.join(', ')})` : combo.name;
}

// ── Customize dialog state ──────────────────────────────────────────────
// Only one combo dialog can be open at a time (single sheet, reused for
// every combo) — comboDialogState holds the combo being configured plus
// the customer's in-progress choices: slotSelections maps slotId -> one of
// 'default' | 'removed' | 'swap:<dishId>' (a single radio group per slot,
// so "removed" and "swapped" are mutually exclusive by construction — same
// rule the server enforces: "swap: slot must not also be in removed").
let comboDialogState = null;

function openComboDialog(combo) {
    const slotSelections = {};
    (combo.items || []).forEach(it => { slotSelections[it.slotId] = 'default'; });
    comboDialogState = { combo, slotSelections, extrasSelected: new Set() };

    renderComboDialogContent();
    openSheet('comboSheetBackdrop', 'comboSheet');
}

function closeComboDialog() {
    closeSheet('comboSheetBackdrop', 'comboSheet');
    comboDialogState = null;
}

function renderComboDialogContent() {
    const { combo } = comboDialogState;

    document.getElementById('comboSheetTitle').textContent = combo.name;
    const descEl = document.getElementById('comboDialogDesc');
    descEl.textContent = combo.description || '';
    descEl.hidden = !combo.description;

    const slotsContainer = document.getElementById('comboSlotsContainer');
    slotsContainer.innerHTML = '';

    (combo.items || []).forEach(it => {
        const defaultDish = findDishInMenu(it.dishId);
        if (!defaultDish) return; // defensive — combo would already have been skipped by isComboRenderable()

        const validSwaps = (it.swaps || [])
            .map(swapId => ({ swapId, dish: findDishInMenu(swapId) }))
            .filter(s => s.dish && !s.dish.soldOut); // "only offer alternatives present & not soldOut"

        const group = document.createElement('div');
        group.className = 'del-combo-slot';

        const label = document.createElement('div');
        label.className = 'del-combo-slot__label';
        label.textContent = defaultDish.name;
        group.appendChild(label);

        // A slot with no removable flag and no valid swaps has nothing to
        // customize — show just its (default) dish name above, no radios.
        if (it.removable || validSwaps.length > 0) {
            const optsWrap = document.createElement('div');
            optsWrap.className = 'del-combo-slot__options';
            const radioName = `combo-slot-${it.slotId}`;

            const addOption = (value, text, checked) => {
                const optLabel = document.createElement('label');
                optLabel.className = 'del-combo-option';
                const input = document.createElement('input');
                input.type = 'radio';
                input.name = radioName;
                input.value = value;
                input.checked = checked;
                input.addEventListener('change', () => {
                    comboDialogState.slotSelections[it.slotId] = value;
                    updateComboDialogTotal();
                });
                const span = document.createElement('span');
                span.textContent = text;
                optLabel.appendChild(input);
                optLabel.appendChild(span);
                optsWrap.appendChild(optLabel);
            };

            addOption('default', defaultDish.name, true);

            if (it.removable) {
                addOption('removed', `Bez ${defaultDish.name} (${formatSignedDelta(-(Number(it.removeValue) || 0))})`, false);
            }

            validSwaps.forEach(({ swapId, dish }) => {
                const delta = (Number(dish.price) || 0) - (Number(defaultDish.price) || 0);
                addOption(`swap:${swapId}`, `${dish.name} (${formatSignedDelta(delta)})`, false);
            });

            group.appendChild(optsWrap);
        }

        slotsContainer.appendChild(group);
    });

    const extrasContainer = document.getElementById('comboExtrasContainer');
    extrasContainer.innerHTML = '';
    if ((combo.extras || []).length > 0) {
        const head = document.createElement('div');
        head.className = 'del-combo-slot__label';
        head.textContent = 'Příplatky';
        extrasContainer.appendChild(head);

        const optsWrap = document.createElement('div');
        optsWrap.className = 'del-combo-slot__options';
        combo.extras.forEach(ex => {
            const optLabel = document.createElement('label');
            optLabel.className = 'del-combo-option';
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.addEventListener('change', () => {
                if (input.checked) comboDialogState.extrasSelected.add(ex.id);
                else comboDialogState.extrasSelected.delete(ex.id);
                updateComboDialogTotal();
            });
            const span = document.createElement('span');
            span.textContent = `${ex.name} (+${formatPrice(ex.price)})`;
            optLabel.appendChild(input);
            optLabel.appendChild(span);
            optsWrap.appendChild(optLabel);
        });
        extrasContainer.appendChild(optsWrap);
    }

    document.getElementById('comboNoteInput').value = '';
    updateComboDialogTotal();
}

function updateComboDialogTotal() {
    if (!comboDialogState) return;
    const { combo, slotSelections, extrasSelected } = comboDialogState;
    const price = computeComboUnitPrice(combo, slotSelections, extrasSelected);
    document.getElementById('comboDialogTotal').textContent = formatPrice(price);
}

// ── Combo cart lines ─────────────────────────────────────────────────────
// COMBO_ITEM_ID_PREFIX mirrors DAILY_ITEM_ID_PREFIX above and the server's
// COMBO_ITEM_ID_PREFIX constant (spec). Unlike regular dish lines, several
// cart lines can legitimately share the same server-facing id
// ("combo:<comboId>") — one per distinct customization, never merged (spec:
// "Each customized combo is its own line... identical configs are NOT
// merged"). The `cart` object used everywhere else on this page is keyed by
// dish.id for regular lines, which doubles as that line's identity; combo
// lines instead get a synthetic, always-unique local key
// (COMBO_LINE_KEY_PREFIX + running counter) so the *object key* stays
// unique per line while the *stored id* stays the shared "combo:<comboId>"
// the server needs. Nothing else in this file reads the outer cart object's
// own keys (only item.id inside each value), so this is safe.
const COMBO_ITEM_ID_PREFIX = 'combo:';
const COMBO_LINE_KEY_PREFIX = 'combo-line:';
let comboLineSeq = 0;

function addComboLineToCart(combo, comboConfig, price, name) {
    const localKey = `${COMBO_LINE_KEY_PREFIX}${combo.id}:${++comboLineSeq}`;
    cart[localKey] = {
        id: `${COMBO_ITEM_ID_PREFIX}${combo.id}`,
        name,
        price,
        qty: 1,
        categoryId: COMBO_CATEGORY_ID,
        comboConfig
    };
    renderCartCount();
    renderCartDrawer();
}

// Qty +/− for one specific combo cart line, addressed by its unique local
// cart key (NOT by item.id, which several lines may share) — the combo
// equivalent of changeCartQty()/buildStepper() for regular dishes.
function changeComboLineQty(localKey, delta) {
    const line = cart[localKey];
    if (!line) return;
    const newQty = Math.max(0, line.qty + delta);
    if (newQty === 0) delete cart[localKey];
    else line.qty = newQty;
    renderCartCount();
    renderCartDrawer();
}

function buildComboLineStepper(localKey, line) {
    const stepper = document.createElement('div');
    stepper.className = 'ds-stepper';

    const minusBtn = document.createElement('button');
    minusBtn.type = 'button';
    minusBtn.className = 'ds-stepper__btn';
    minusBtn.textContent = '−';
    minusBtn.setAttribute('aria-label', `Ubrat ${line.name}`);
    minusBtn.addEventListener('click', () => changeComboLineQty(localKey, -1));

    const qtySpan = document.createElement('span');
    qtySpan.className = 'ds-stepper__value';
    qtySpan.textContent = line.qty;

    const plusBtn = document.createElement('button');
    plusBtn.type = 'button';
    plusBtn.className = 'ds-stepper__btn';
    plusBtn.textContent = '+';
    plusBtn.setAttribute('aria-label', `Přidat ${line.name}`);
    plusBtn.addEventListener('click', () => changeComboLineQty(localKey, 1));

    stepper.appendChild(minusBtn);
    stepper.appendChild(qtySpan);
    stepper.appendChild(plusBtn);
    return stepper;
}

// ── CART ─────────────────────────────────────────────────────────────────

function changeCartQty(dish, categoryId, delta) {
    const existing = cart[dish.id];
    const newQty = Math.max(0, (existing?.qty || 0) + delta);

    if (newQty === 0) {
        delete cart[dish.id];
    } else {
        cart[dish.id] = {
            id: dish.id,
            name: dish.name,
            price: Number(dish.price) || 0,
            categoryId,
            qty: newQty
        };
    }

    updateDishActionInPlace(dish.id, categoryId);
    renderCartCount();
    renderCartDrawer();
}

// Swap just the one dish row's action element (add-button <-> stepper)
// instead of re-rendering the whole menu — keeps scroll position and the
// scroll-spy observer intact while the customer is browsing.
function updateDishActionInPlace(dishId, categoryId) {
    const holder = document.getElementById(`dish-action-${dishId}`);
    if (!holder) return;
    const dish = dishIndex[dishId]?.dish || cart[dishId] || { id: dishId, name: '' };
    holder.innerHTML = '';
    holder.appendChild(buildDishAction(dish, categoryId));
}

function getCartTotal() {
    return Object.values(cart).reduce((sum, item) => sum + item.price * item.qty, 0);
}

function getCartCount() {
    return Object.values(cart).reduce((sum, item) => sum + item.qty, 0);
}

// Sticky bar total is the honest payable amount (subtotal + delivery fee) —
// same figure the checkout sheet's "Celkem" row shows, just computed before
// the sheet is even open (go-live Task 2: "keep it consistent everywhere").
function renderCartCount() {
    const count = getCartCount();
    const subtotal = getCartTotal();
    const quote = computeDeliveryQuoteDisplay(subtotal);
    document.getElementById('cartCount').textContent = count;
    document.getElementById('cartBarTotal').textContent = formatPrice(subtotal + quote.fee);
    document.getElementById('openCartBtn').hidden = count === 0;
}

function renderCartDrawer() {
    const itemsEl = document.getElementById('cartItems');
    itemsEl.innerHTML = '';

    const entries = Object.entries(cart); // [localKey, item] — combo lines need the local key, not item.id (see COMBO_LINE_KEY_PREFIX above)
    if (entries.length === 0) {
        itemsEl.innerHTML = `<p class="ds-empty">Košík je zatím prázdný.<br>Přidejte si něco z menu.</p>`;
    } else {
        entries.forEach(([localKey, item]) => {
            const catLabel = categoryLabel(item.categoryId);
            const isCombo = typeof item.id === 'string' && item.id.startsWith(COMBO_ITEM_ID_PREFIX);

            const row = document.createElement('div');
            row.className = 'del-cart-row';

            const info = document.createElement('div');
            info.className = 'del-cart-row__info';
            info.innerHTML = `
                <div class="del-cart-row__name">${escapeHtml(item.name)}</div>
                <div class="del-cart-row__meta">${catLabel} · ${item.qty} × ${formatPrice(item.price)}</div>
            `;
            row.appendChild(info);

            // Combo lines: several may share the same item.id ("combo:<id>")
            // for different customizations, so the qty stepper must address
            // this exact line via its unique local cart key — regular dish
            // lines keep using the generic dish-keyed stepper unchanged.
            if (isCombo) {
                row.appendChild(buildComboLineStepper(localKey, item));
            } else {
                const dishStub = { id: item.id, name: item.name, price: item.price };
                row.appendChild(buildStepper(dishStub, item.categoryId));
            }

            const total = document.createElement('div');
            total.className = 'del-cart-row__total';
            total.textContent = formatPrice(item.price * item.qty);
            row.appendChild(total);

            itemsEl.appendChild(row);
        });
    }

    const hasItems = entries.length > 0;
    const subtotal = getCartTotal();
    const quote = computeDeliveryQuoteDisplay(subtotal);

    document.getElementById('cartSubtotalText').textContent = formatPrice(subtotal);
    document.getElementById('cartDeliveryFeeText').textContent = quote.fee > 0 ? formatPrice(quote.fee) : 'Zdarma';
    document.getElementById('cartTotalText').textContent = formatPrice(subtotal + quote.fee);

    const freeAboveHint = document.getElementById('freeAboveHint');
    if (freeAboveHint) {
        if (hasItems && quote.freeAbove > 0 && !quote.reachedFreeAbove) {
            freeAboveHint.textContent = `Do dopravy zdarma zbývá ${formatPrice(quote.remainingToFree)}`;
            freeAboveHint.hidden = false;
        } else {
            freeAboveHint.hidden = true;
        }
    }

    const etaLine = document.getElementById('etaLine');
    if (etaLine) {
        if (hasItems && quote.etaMinutes > 0) {
            etaLine.textContent = `Doručíme přibližně do ${quote.etaMinutes} minut`;
            etaLine.hidden = false;
        } else {
            etaLine.hidden = true;
        }
    }

    updateMinOrderGate(quote, hasItems);
}

// ── PAYMENT METHOD CARDS (selectable, border-accent + ✓ when checked) ────

function setupPaymentOptions() {
    const options = document.querySelectorAll('.del-pay-option');
    const sync = () => {
        options.forEach(opt => {
            const input = opt.querySelector('input[type="radio"]');
            opt.classList.toggle('del-pay-option--selected', !!input?.checked);
        });
    };
    options.forEach(opt => {
        opt.querySelector('input[type="radio"]')?.addEventListener('change', sync);
    });
    sync();
}

// ── CHECKOUT (create a delivery order — name + address + phone required, email optional) ──

function isValidEmail(email) {
    // Simple, permissive shape check — full RFC validation isn't worth it here.
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function submitOrder() {
    // Re-check right before submitting — closing/pausing could have kicked
    // in while the checkout sheet was open. The server re-enforces this on
    // POST /orders regardless (see settingsStore.isDeliveryOpenNow there).
    applyDeliveryClosedUi();
    if (deliveryClosedInfo.closed) {
        showToast(deliveryClosedInfo.reason || 'Rozvoz je momentálně uzavřen.', true);
        return;
    }

    const nameInput = document.getElementById('checkoutNameInput');
    const addressInput = document.getElementById('checkoutAddressInput');
    const pscInput = document.getElementById('checkoutPscInput');
    const phoneInput = document.getElementById('checkoutPhoneInput');
    const emailInput = document.getElementById('checkoutEmailInput');
    const noteInput = document.getElementById('checkoutNoteInput');
    const submitBtn = document.getElementById('submitOrderBtn');

    const customerName = nameInput.value.trim();
    const address = addressInput.value.trim();
    const psc = pscInput.value.trim();
    const phone = phoneInput.value.trim();
    const email = emailInput.value.trim();
    const note = noteInput.value.trim();

    const items = Object.values(cart);
    if (items.length === 0) {
        showToast('Košík je prázdný', true);
        return;
    }
    if (!customerName) {
        showToast('Zadejte prosím jméno', true);
        nameInput.focus();
        return;
    }
    if (!address) {
        showToast('Zadejte prosím adresu doručení', true);
        addressInput.focus();
        return;
    }
    if (!/^\d{5}$/.test(psc)) {
        showToast('Zadejte prosím platné PSČ (5 číslic)', true);
        pscInput.focus();
        return;
    }
    if (!phone) {
        showToast('Zadejte prosím telefonní číslo', true);
        phoneInput.focus();
        return;
    }
    // E-mail is optional (go-live Task 4, spec §6) — only validated when the
    // customer actually typed one; an empty field is fine (order confirmation
    // e-mail is simply skipped server-side when order.email is empty).
    if (email && !isValidEmail(email)) {
        showToast('Zadejte prosím platnou e-mailovou adresu, nebo pole nechte prázdné', true);
        emailInput.focus();
        return;
    }

    // Client-side mirrors of the two server-enforced delivery rules that
    // depend on values only known at this point (PSČ) or that the disabled
    // submit button already reflects (min order) — belt-and-braces UX, the
    // server (settingsStore.quoteDelivery) is still the actual authority.
    const subtotal = getCartTotal();
    const quote = computeDeliveryQuoteDisplay(subtotal);
    if (quote.belowMin) {
        showToast(`Minimální objednávka je ${formatPrice(quote.minOrder)}.`, true);
        return;
    }
    const pscWhitelist = (restaurantSettings && restaurantSettings.delivery && restaurantSettings.delivery.pscWhitelist) || [];
    if (pscWhitelist.length > 0 && !pscWhitelist.includes(psc)) {
        showToast('Do zadaného PSČ bohužel nerozvážíme.', true);
        pscInput.focus();
        return;
    }

    const paymentMethod = document.querySelector('input[name="paymentMethod"]:checked')?.value || 'online_card';

    submitBtn.disabled = true;
    submitBtn.textContent = 'Odesílám…';

    try {
        const res = await fetch(`${API_URL}/orders`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                customerName,
                address,
                psc,
                phone,
                email,
                note,
                items,
                total: subtotal,
                paymentMethod,
                // Only meaningful for online_card — lets GoPay send the
                // customer back to *this* page (not the generic default)
                // so pendingPaymentOrderId below can resume and poll.
                returnUrl: paymentMethod === 'online_card' ? (window.location.origin + window.location.pathname) : undefined
            })
        });
        const result = await res.json();
        if (!res.ok) throw new Error(result.error || 'Chyba při odesílání objednávky');

        cart = {};
        nameInput.value = '';
        addressInput.value = '';
        pscInput.value = '';
        phoneInput.value = '';
        emailInput.value = '';
        noteInput.value = '';
        renderCartCount();
        renderCartDrawer();
        renderMenuSections(); // full rebuild — resets every dish row back to "+"
        closeSheet('cartSheetBackdrop', 'cartSheet');

        if (paymentMethod === 'online_card' && result.redirectUrl) {
            // Real gateway: remember which order we're waiting on so that
            // when GoPay redirects back here, we know to resume polling
            // instead of showing a blank menu page.
            setPendingPaymentOrderId(result.order.id);
            window.location.href = result.redirectUrl;
            return;
        }

        showOrderConfirmation(result.order, paymentMethod, result.simulated);

        if (paymentMethod === 'online_card' && result.simulated) {
            // No real gateway configured — the order was still created with
            // a simulated payment record server-side. Poll the same way a
            // real gateway return would, so the flow is testable end-to-end.
            setPendingPaymentOrderId(result.order.id);
            startPaymentPolling(result.order.id);
        }
    } catch (e) {
        console.error(e);
        showToast(e.message || 'Nepodařilo se odeslat objednávku', true);
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Odeslat objednávku';
    }
}

function showOrderConfirmation(order, paymentMethod, wasSimulated) {
    document.getElementById('orderConfirmedHeading').textContent = 'Objednávka odeslána';
    document.getElementById('orderRefText').textContent = order.id;

    // order.total (server-computed, see POST /orders) already includes the
    // delivery fee — this is the same "honest total everywhere" figure the
    // cart bar/checkout summary showed. Missing deliveryFee (shouldn't
    // happen for a freshly created order, but defensive) reads as 0.
    const totalEl = document.getElementById('orderConfirmedTotal');
    if (totalEl) {
        const fee = Number(order.deliveryFee) || 0;
        totalEl.textContent = fee > 0
            ? `Celkem k úhradě: ${formatPrice(order.total)} (vč. dopravy ${formatPrice(fee)})`
            : `Celkem k úhradě: ${formatPrice(order.total)}`;
    }

    document.getElementById('orderPaymentStatus').innerHTML = '';
    const note = document.getElementById('orderConfirmedNote');
    if (paymentMethod === 'cash') {
        note.textContent = 'Platba: hotově při doručení.';
    } else if (paymentMethod === 'card_on_delivery') {
        note.textContent = 'Platba: kartou při doručení.';
    } else if (wasSimulated) {
        note.textContent = '';
        document.getElementById('orderPaymentStatus').innerHTML = `
            <p class="del-payonline-note"><strong>🧪 Testovací režim</strong> — platební brána zatím není nastavena, platba se simuluje.</p>
            <p class="del-payonline-waiting" id="paymentWaitingNote">⏳ Čekáme na potvrzení platby…</p>
        `;
    } else {
        note.textContent = 'Platba online byla zahájena.';
    }
    openSheet('orderConfirmedBackdrop', 'orderConfirmedModal');
}

// ── ONLINE PAYMENT STATUS (dev-mode polling + return-from-GoPay handling) ──
// GoPay redirects the customer back to this page after they pay. We can't
// tell "just paid" from "abandoned checkout" from the URL alone, so instead
// we remember the order id in localStorage right before sending the
// customer to the gateway, then on load check for it and resume polling
// GET /payments/:orderId/status until it settles (or we give up).

const PENDING_PAYMENT_KEY = 'delivery_pending_payment_order_id';
const PAYMENT_POLL_INTERVAL_MS = 3000;
const PAYMENT_POLL_MAX_ATTEMPTS = 60; // ~3 minutes

let paymentPollHandle = null;
let paymentPollAttempts = 0;

function setPendingPaymentOrderId(orderId) {
    try { localStorage.setItem(PENDING_PAYMENT_KEY, orderId); } catch (e) { /* localStorage unavailable — polling just won't survive a reload */ }
}
function getPendingPaymentOrderId() {
    try { return localStorage.getItem(PENDING_PAYMENT_KEY); } catch (e) { return null; }
}
function clearPendingPaymentOrderId() {
    try { localStorage.removeItem(PENDING_PAYMENT_KEY); } catch (e) { /* ignore */ }
}

function stopPaymentPolling() {
    if (paymentPollHandle) clearInterval(paymentPollHandle);
    paymentPollHandle = null;
}

function startPaymentPolling(orderId) {
    stopPaymentPolling();
    paymentPollAttempts = 0;
    paymentPollHandle = setInterval(() => checkPaymentStatus(orderId), PAYMENT_POLL_INTERVAL_MS);
}

async function checkPaymentStatus(orderId) {
    paymentPollAttempts++;
    try {
        const res = await fetch(`${API_URL}/payments/${orderId}/status`);
        if (!res.ok) {
            if (res.status === 404) { stopPaymentPolling(); clearPendingPaymentOrderId(); }
            return;
        }
        const status = await res.json();

        if (status.paymentStatus === 'paid') {
            stopPaymentPolling();
            clearPendingPaymentOrderId();
            renderPaymentResolved('paid', status.receiptId);
            return;
        }
        if (status.paymentStatus === 'refunded') {
            stopPaymentPolling();
            clearPendingPaymentOrderId();
            renderPaymentResolved('failed');
            return;
        }
        if (paymentPollAttempts >= PAYMENT_POLL_MAX_ATTEMPTS) {
            stopPaymentPolling();
            renderPaymentResolved('timeout', null, orderId);
        }
    } catch (e) {
        console.error('Payment status poll failed:', e);
    }
}

function renderPaymentResolved(state, receiptId, orderId) {
    const holder = document.getElementById('orderPaymentStatus');
    if (state === 'paid') {
        const link = receiptId
            ? `<a class="ds-btn ds-btn--primary" href="${API_URL.replace(/\/api\/?$/, '')}/uctenka/${encodeURIComponent(receiptId)}" target="_blank" rel="noopener">🧾 Zobrazit účtenku</a>`
            : '';
        holder.innerHTML = `<p class="del-payonline-paid">✅ Zaplaceno</p>${link}`;
        return;
    }
    if (state === 'failed') {
        holder.innerHTML = `<p class="del-payonline-failed">Platba se nezdařila nebo byla vrácena.</p>`;
        return;
    }
    // timeout — offer a manual retry (re-checks once more on click)
    holder.innerHTML = `
        <p class="del-payonline-note">Potvrzení platby zatím nedorazilo.</p>
        <button class="ds-btn ds-btn--ghost" id="retryPaymentCheckBtn">Zkontrolovat znovu</button>
    `;
    document.getElementById('retryPaymentCheckBtn').addEventListener('click', () => {
        holder.innerHTML = '<p class="del-payonline-waiting">⏳ Kontroluji…</p>';
        startPaymentPolling(orderId);
    });
}

// On load, if we're returning from GoPay (or reloading a simulated-payment
// tab), pendingPaymentOrderId is still set — resume polling and show the
// same confirmation sheet, keyed only by the opaque order id (no PII in
// the URL or localStorage).
function resumePendingPaymentIfAny() {
    const orderId = getPendingPaymentOrderId();
    if (!orderId) return;

    document.getElementById('orderConfirmedHeading').textContent = 'Platba online';
    document.getElementById('orderRefText').textContent = orderId;
    document.getElementById('orderConfirmedTotal').textContent = ''; // order details not available on this bare resume path
    document.getElementById('orderConfirmedNote').textContent = '';
    document.getElementById('orderPaymentStatus').innerHTML = '<p class="del-payonline-waiting">⏳ Kontroluji stav platby…</p>';
    openSheet('orderConfirmedBackdrop', 'orderConfirmedModal');

    startPaymentPolling(orderId);
}

document.getElementById('orderConfirmedCloseBtn').addEventListener('click', () => {
    closeSheet('orderConfirmedBackdrop', 'orderConfirmedModal');
    stopPaymentPolling();
});
document.getElementById('orderConfirmedBackdrop').addEventListener('click', () => {
    closeSheet('orderConfirmedBackdrop', 'orderConfirmedModal');
    stopPaymentPolling();
});

document.getElementById('submitOrderBtn').addEventListener('click', submitOrder);

// ── CART SHEET OPEN/CLOSE ────────────────────────────────────────────────

document.getElementById('openCartBtn').addEventListener('click', () => {
    renderCartDrawer();
    openSheet('cartSheetBackdrop', 'cartSheet');
});
document.getElementById('closeCartBtn').addEventListener('click', () => {
    closeSheet('cartSheetBackdrop', 'cartSheet');
});
document.getElementById('cartSheetBackdrop').addEventListener('click', () => {
    closeSheet('cartSheetBackdrop', 'cartSheet');
});

// ── COMBO CUSTOMIZE SHEET OPEN/CLOSE/CONFIRM ────────────────────────────

document.getElementById('comboSheetCancelBtn').addEventListener('click', closeComboDialog);
document.getElementById('comboSheetCloseBtn').addEventListener('click', closeComboDialog);
document.getElementById('comboSheetBackdrop').addEventListener('click', closeComboDialog);

document.getElementById('comboSheetConfirmBtn').addEventListener('click', () => {
    if (!comboDialogState) return;
    const { combo, slotSelections, extrasSelected } = comboDialogState;

    // ≤200 chars enforced both by the input's maxlength (UX) and here
    // (defense in depth) — the server re-validates this bound anyway.
    const note = document.getElementById('comboNoteInput').value.trim().slice(0, 200);

    const removed = [];
    const swaps = {};
    Object.keys(slotSelections).forEach(slotId => {
        const sel = slotSelections[slotId];
        if (sel === 'removed') removed.push(slotId);
        else if (sel && sel.startsWith('swap:')) swaps[slotId] = sel.slice(5);
    });
    const extras = Array.from(extrasSelected);

    // comboConfig fields are all optional (spec) — only include the ones
    // that actually differ from "everything default, no note".
    const comboConfig = {};
    if (removed.length > 0) comboConfig.removed = removed;
    if (Object.keys(swaps).length > 0) comboConfig.swaps = swaps;
    if (extras.length > 0) comboConfig.extras = extras;
    if (note) comboConfig.note = note;

    const price = computeComboUnitPrice(combo, slotSelections, extrasSelected);
    const name = buildComboDisplayName(combo, removed, swaps, extras, note);

    addComboLineToCart(combo, comboConfig, price, name);
    closeComboDialog();
    showToast(`${combo.name} přidáno do košíku`);
});

// ── REORDER ("Objednat znovu") ──────────────────────────────────────────
// Spec: docs/superpowers/specs/2026-07-25-reorder-design.md §8 (client);
// §7 there / the reorder plan document has the frozen HTTP contract this
// section calls against:
//   POST {API_URL}/reorder/send-code  {phone}       -> {success, simulated}
//   POST {API_URL}/reorder/verify     {phone, code}  -> {success} + Set-Cookie
//   GET  {API_URL}/reorder/recent                    -> {orders:[...]} | 401
//   POST {API_URL}/reorder/forget                    -> {success}
//
// SECURITY/CORRECTNESS: every one of the four requests below passes
// `credentials: 'same-origin'`. The whole feature rests on one httpOnly
// cookie (`reorder_token`); a plain `fetch()` can silently omit cookies
// depending on origin/protocol, which would make this look "randomly
// broken" in the worst possible way — verify() returns 200, then the very
// next /recent call 401s for no visible reason. Every other fetch on this
// page is same-origin already (relative to API_URL, same host as the page
// itself), so this isn't needed elsewhere, but it is load-bearing here.
//
// There is no "am I verified" probe endpoint by design (spec §8): the sheet
// simply calls GET /reorder/recent on first open and reacts to the status
// code (200 -> state 2/3, 401 -> state 1).

// The phone number the customer verified in this page session, used only to
// prefill the checkout phone field on restore (see prefillCheckoutFromOrder).
// Held in memory only — never persisted. It stays empty when the sheet opens
// straight into state 2 from an existing 90-day cookie (no phone was typed
// this session), which is exactly why the prefill treats it as optional.
let reorderVerifiedPhone = '';

// One shared sheet, content rebuilt per state — same pattern as the combo
// customize dialog above (comboDialogState / renderComboDialogContent()).
// The phone number awaiting a code is threaded through as a plain function
// argument (renderReorderCodeStep(phone, ...) -> its "Ověřit" handler
// closes over that same `phone`) rather than a module-level variable —
// there's exactly one place that needs it, so a hidden field of shared
// state would only add a second source of truth to keep in sync.

function reorderContentEl() {
    return document.getElementById('reorderSheetContent');
}

// ── State 1: unverified (phone entry -> code entry) ─────────────────────

function renderReorderPhoneStep(errorMsg) {
    const content = reorderContentEl();
    content.innerHTML = `
        <p class="del-reorder-intro">Zadejte telefonní číslo, na které jste u nás dříve objednávali, a pošleme vám na něj ověřovací SMS kód.</p>
        <div class="del-field-group">
            <label for="reorderPhoneInput">Telefon</label>
            <input type="tel" id="reorderPhoneInput" class="ds-input" placeholder="+420 601 234 567" autocomplete="tel">
        </div>
        <p class="del-reorder-error" id="reorderPhoneError"${errorMsg ? '' : ' hidden'}>${escapeHtml(errorMsg || '')}</p>
        <button type="button" class="ds-btn ds-btn--primary ds-btn--block" id="reorderSendCodeBtn">Poslat kód</button>
        <p class="del-reorder-note">Po ověření si toto zařízení zapamatuje Vaše číslo na 90 dní, abyste ho nemuseli zadávat znovu. Kdykoli to zrušíte tlačítkem „Nejsem to já“. Více v <a href="/reservation/ochrana-osobnich-udaju" target="_blank" rel="noopener">Ochraně osobních údajů</a>.</p>
    `;
    document.getElementById('reorderSendCodeBtn').addEventListener('click', () => {
        const phone = document.getElementById('reorderPhoneInput').value.trim();
        sendReorderCode(phone);
    });
}

function renderReorderCodeStep(phone, errorMsg, attemptsLeft) {
    const content = reorderContentEl();
    // The server's own message already explains *what* went wrong (spec
    // §7: "message wording mirrors verify-and-book exactly"); attemptsLeft
    // is only ever sent alongside "wrong code", so it's appended here as a
    // parenthetical rather than baked into the server string itself.
    const errorText = errorMsg
        ? errorMsg + (typeof attemptsLeft === 'number' ? ` (zbývá pokusů: ${attemptsLeft})` : '')
        : '';
    content.innerHTML = `
        <p class="del-reorder-intro">Zadejte kód, který jsme poslali na ${escapeHtml(phone)}.</p>
        <div class="del-field-group">
            <label for="reorderCodeInput">Ověřovací kód</label>
            <input type="text" inputmode="numeric" autocomplete="one-time-code" id="reorderCodeInput" class="ds-input" placeholder="123456" maxlength="10">
        </div>
        <p class="del-reorder-error" id="reorderCodeError"${errorText ? '' : ' hidden'}>${escapeHtml(errorText)}</p>
        <button type="button" class="ds-btn ds-btn--primary ds-btn--block" id="reorderVerifyBtn">Ověřit</button>
        <button type="button" class="ds-btn ds-btn--ghost ds-btn--block del-reorder-back-btn" id="reorderBackToPhoneBtn">Zpět na zadání telefonu</button>
    `;
    document.getElementById('reorderVerifyBtn').addEventListener('click', () => {
        const code = document.getElementById('reorderCodeInput').value.trim();
        verifyReorderCode(phone, code);
    });
    document.getElementById('reorderBackToPhoneBtn').addEventListener('click', () => renderReorderPhoneStep());
}

async function sendReorderCode(phone) {
    if (!phone) { renderReorderPhoneStep('Zadejte prosím telefonní číslo'); return; }

    const btn = document.getElementById('reorderSendCodeBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Odesílám…'; }

    try {
        const res = await fetch(`${API_URL}/reorder/send-code`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone })
        });
        const result = await res.json();
        if (!res.ok) throw new Error(result.error || 'Nepodařilo se odeslat kód');

        renderReorderCodeStep(phone);
        // Same "simulated" convention as the reservation phone-verify flow
        // (renderer.js/requestVerificationCode) — Twilio unconfigured means
        // the code is only ever logged server-side, never actually texted.
        showToast(result.simulated
            ? 'Kód vygenerován (SMS server zatím není nakonfigurován, kód najdete v konzoli serveru).'
            : `SMS kód odeslán na ${phone}.`);
    } catch (e) {
        console.error('Reorder send-code failed:', e);
        // renderReorderPhoneStep() below replaces this button's markup on
        // both the try and catch path, so there is no separate
        // stale-disabled-button state to restore here (unlike submitOrder(),
        // whose sheet stays open either way).
        renderReorderPhoneStep(e.message || 'Nepodařilo se odeslat kód, zkuste to prosím znovu');
    }
}

async function verifyReorderCode(phone, code) {
    if (!code) { renderReorderCodeStep(phone, 'Zadejte kód z SMS'); return; }

    const btn = document.getElementById('reorderVerifyBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Ověřuji…'; }

    try {
        const res = await fetch(`${API_URL}/reorder/verify`, {
            method: 'POST',
            credentials: 'same-origin', // the whole point of this call is to receive+store the reorder_token cookie
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone, code })
        });
        const result = await res.json();
        if (!res.ok) {
            renderReorderCodeStep(phone, result.error || 'Nesprávný kód', result.attemptsLeft);
            return;
        }
        // Verified — the cookie is now set. Remember the number purely to
        // prefill the checkout phone field later (the server deliberately
        // never echoes the phone back in /reorder/recent).
        reorderVerifiedPhone = phone;
        // Load state 2/3 the same way the sheet does on first open
        // (spec: "no separate am-I-logged-in call").
        await loadReorderRecent();
    } catch (e) {
        console.error('Reorder verify failed:', e);
        renderReorderCodeStep(phone, e.message || 'Nepodařilo se ověřit kód, zkuste to prosím znovu');
    }
}

// ── States 2/3: verified (orders list, or the empty explanation) ────────

function buildReorderForgetLink() {
    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'del-reorder-forget';
    link.textContent = 'Nejsem to já';
    link.addEventListener('click', forgetReorderSession);
    return link;
}

function reorderOrderDateLabel(createdAt) {
    const d = new Date(createdAt);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString('cs-CZ', { day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function buildReorderOrderCard(order) {
    const card = document.createElement('div');
    card.className = 'del-reorder-order';

    const head = document.createElement('div');
    head.className = 'del-reorder-order__head';
    head.innerHTML = `<span class="del-reorder-order__date">${escapeHtml(reorderOrderDateLabel(order.createdAt))}</span>`;
    card.appendChild(head);

    const linesEl = document.createElement('div');
    linesEl.className = 'del-reorder-order__lines';
    (order.lines || []).forEach(line => {
        const lineEl = document.createElement('div');
        const unavailable = line.available === false;
        lineEl.className = 'del-reorder-line' + (unavailable ? ' del-reorder-line--unavailable' : '');
        // Both branches escape server-provided text (line.name / line.reason)
        // before it hits the DOM — dish names and unavailability reasons
        // both come straight from the server (previewOrder), same as every
        // other server string rendered on this page.
        if (unavailable) {
            lineEl.innerHTML = `
                <span class="del-reorder-line__name">${escapeHtml(line.qty)}× ${escapeHtml(line.name)}</span>
                <span class="del-reorder-line__reason">${escapeHtml(line.reason || 'Již není k dispozici')}</span>
            `;
        } else {
            lineEl.innerHTML = `
                <span class="del-reorder-line__name">${escapeHtml(line.qty)}× ${escapeHtml(line.name)}</span>
                <span class="del-reorder-line__total">${formatPrice(line.lineTotal)}</span>
            `;
        }
        linesEl.appendChild(lineEl);
    });
    card.appendChild(linesEl);

    const footer = document.createElement('div');
    footer.className = 'del-reorder-order__footer';
    footer.innerHTML = `<span class="del-reorder-order__total">Celkem: ${formatPrice(order.availableTotal)}</span>`;
    if (order.unavailableCount > 0) {
        footer.innerHTML += `<span class="del-reorder-order__warn">${order.unavailableCount}× už není v nabídce</span>`;
    }
    card.appendChild(footer);

    const reorderBtn = document.createElement('button');
    reorderBtn.type = 'button';
    reorderBtn.className = 'ds-btn ds-btn--primary ds-btn--block';
    reorderBtn.textContent = 'Objednat znovu';
    const hasAnyAvailableLine = (order.lines || []).some(l => l.available !== false);
    if (!hasAnyAvailableLine) {
        // Nothing left to restore — disable rather than let the customer
        // tap into a toast-only no-op.
        reorderBtn.disabled = true;
    } else {
        reorderBtn.addEventListener('click', () => restoreOrderToCart(order));
    }
    card.appendChild(reorderBtn);

    return card;
}

function renderReorderOrdersList(orders) {
    const content = reorderContentEl();
    content.innerHTML = '';
    orders.forEach(order => content.appendChild(buildReorderOrderCard(order)));
    content.appendChild(buildReorderForgetLink());
}

function renderReorderEmpty() {
    const content = reorderContentEl();
    content.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'ds-empty';
    p.textContent = 'Zatím tu pro vás nemáme žádné předchozí objednávky k zopakování.';
    content.appendChild(p);
    content.appendChild(buildReorderForgetLink());
}

async function loadReorderRecent() {
    reorderContentEl().innerHTML = `<p class="ds-empty">Načítám…</p>`;
    try {
        const res = await fetch(`${API_URL}/reorder/recent`, { credentials: 'same-origin' });
        if (res.status === 401) {
            renderReorderPhoneStep();
            return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const orders = Array.isArray(data.orders) ? data.orders : [];
        if (orders.length === 0) renderReorderEmpty();
        else renderReorderOrdersList(orders);
    } catch (e) {
        console.error('Failed to load recent orders:', e);
        // Fails back to the phone step rather than leaving "Načítám…"
        // stuck forever — worst case the customer just re-verifies.
        renderReorderPhoneStep('Nepodařilo se načíst vaše objednávky, zkuste to prosím znovu');
    }
}

async function forgetReorderSession() {
    try {
        const res = await fetch(`${API_URL}/reorder/forget`, { method: 'POST', credentials: 'same-origin' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (e) {
        console.error('Failed to forget reorder session:', e);
        showToast('Nepodařilo se odhlásit, zkuste to prosím znovu.', true);
        return;
    }
    // "Nejsem to já" means this browser is being handed back / disowned, so
    // drop the in-memory phone too — otherwise the next person to restore an
    // order would get the previous customer's number prefilled into checkout.
    reorderVerifiedPhone = '';
    renderReorderPhoneStep();
}

// ── Restoring an order into the cart ─────────────────────────────────────
// Spec §8: REPLACES the cart (never merges — silently merging two carts is
// something a customer would only discover at the payment screen), skips
// every `available: false` line, and toasts what got dropped. Regular
// lines are rebuilt in exactly the shape changeCartQty() produces; combo
// lines in exactly the shape addComboLineToCart() produces (see the
// COMBO_LINE_KEY_PREFIX comment above changeComboLineQty() for why combo
// lines need their own synthetic per-line key rather than being keyed by
// the shared "combo:<id>" server id).
function restoreOrderToCart(order) {
    if (Object.keys(cart).length > 0) {
        const proceed = window.confirm('Nahradit obsah košíku touto objednávkou? Aktuální košík bude vyprázdněn.');
        if (!proceed) return;
    }

    const lines = Array.isArray(order.lines) ? order.lines : [];
    const droppedNames = [];
    const newCart = {};

    lines.forEach(line => {
        if (line.available === false) {
            droppedNames.push(line.name);
            return; // never restored — the server already re-checked this against the live menu
        }

        const qty = Number(line.qty) || 1;
        const price = Number(line.price) || 0;

        if (typeof line.id === 'string' && line.id.startsWith(COMBO_ITEM_ID_PREFIX)) {
            // Combo line. `line.comboConfig` is expected to ride along on an
            // available combo line (previewOrder/priceOrderItems preserve it
            // unchanged — spec §6.3) so the restored line reproduces the
            // exact customization (removed/swapped slots, extras, note) the
            // customer originally chose; if it's ever absent, default to "no
            // customization" rather than throwing, so the base combo still
            // restores. Uses the SAME synthetic-local-key scheme as
            // addComboLineToCart() (COMBO_LINE_KEY_PREFIX + comboId + running
            // counter) so several distinctly-customized lines of the same
            // combo id restore as separate cart lines, never merged.
            const comboConfig = (line.comboConfig && typeof line.comboConfig === 'object' && !Array.isArray(line.comboConfig))
                ? line.comboConfig
                : {};
            const comboId = line.id.slice(COMBO_ITEM_ID_PREFIX.length);
            const localKey = `${COMBO_LINE_KEY_PREFIX}${comboId}:${++comboLineSeq}`;
            newCart[localKey] = {
                id: line.id, // already carries the "combo:" prefix
                name: line.name,
                price,
                qty,
                categoryId: COMBO_CATEGORY_ID,
                comboConfig
            };
        } else {
            // Regular dish line. categoryId isn't part of the reorder
            // preview payload (spec §6 — the preview line shape has no
            // category field), so it's looked up in the live menu index
            // built by the last renderMenuSections() call. A dish that
            // isn't in dishIndex would already have been priced as
            // unavailable by the server (see reorder.js's previewOrder),
            // so this branch shouldn't be reachable for a live dish — coded
            // defensively anyway: fall back to an empty categoryId (still a
            // usable cart line; only the cart drawer's category label would
            // read blank) rather than dropping the line outright.
            const indexed = dishIndex[line.id];
            if (!indexed) {
                console.warn(`Reorder: dish "${line.id}" ("${line.name}") is not in the current menu index; restoring it with no category.`);
            }
            newCart[line.id] = {
                id: line.id,
                name: line.name,
                price,
                categoryId: indexed ? indexed.categoryId : '',
                qty
            };
        }
    });

    cart = newCart;
    prefillCheckoutFromOrder(order);
    renderCartCount();
    renderCartDrawer();
    renderMenuSections(); // full rebuild — resyncs every dish row's +/stepper to the restored cart (same call submitOrder() makes after clearing the cart)
    closeSheet('reorderSheetBackdrop', 'reorderSheet');

    // showToast() sets textContent (never innerHTML), so raw server-provided
    // dish names here don't need escapeHtml().
    if (droppedNames.length > 0) {
        showToast(`Některé položky už nejsou v nabídce: ${droppedNames.join(', ')}`, true);
    } else {
        showToast('Objednávka byla vložena do košíku.');
    }
}

// Prefills the checkout form from the restored order's delivery details
// (`order.customer` — name/address/PSČ/e-mail, echoed back by the server only
// to a browser holding a verified reorder token; see previewOrder() in
// reorder.js). Without this the customer still retypes four fields, which is
// most of the typing "one-tap reorder" exists to remove.
//
// Deliberately fills ONLY fields that are currently empty. A customer who has
// already typed something into checkout has said something more specific than
// the old order does — for instance ordering to a different address this time
// — and silently overwriting that would be the kind of bug nobody notices
// until the food arrives at the wrong door. On a fresh page load every field
// is empty, so the common case is still a complete prefill.
//
// The phone field is filled from the number the customer just verified in the
// reorder sheet rather than from the server response: the server deliberately
// doesn't echo the phone back, and this is the same value the customer typed
// moments ago.
function prefillCheckoutFromOrder(order) {
    const customer = (order && order.customer && typeof order.customer === 'object') ? order.customer : {};

    const fills = [
        ['checkoutNameInput', customer.customerName],
        ['checkoutAddressInput', customer.address],
        ['checkoutPscInput', customer.psc],
        ['checkoutEmailInput', customer.email],
        ['checkoutPhoneInput', reorderVerifiedPhone]
    ];

    fills.forEach(([elementId, value]) => {
        const el = document.getElementById(elementId);
        if (!el) return;                      // defensive: checkout markup is in delivery.html, not built here
        if (el.value.trim() !== '') return;   // never clobber what the customer already typed
        if (typeof value !== 'string' || value === '') return;
        el.value = value;
    });
}

// ── Sheet open/close wiring ───────────────────────────────────────────────

document.getElementById('reorderChipBtn').addEventListener('click', () => {
    openSheet('reorderSheetBackdrop', 'reorderSheet');
    loadReorderRecent();
});
document.getElementById('reorderSheetCloseBtn').addEventListener('click', () => {
    closeSheet('reorderSheetBackdrop', 'reorderSheet');
});
document.getElementById('reorderSheetBackdrop').addEventListener('click', () => {
    closeSheet('reorderSheetBackdrop', 'reorderSheet');
});

// ── INIT ─────────────────────────────────────────────────────────────────

(async function init() {
    await fetchMenu();
    // Combo menus reference regular menu dishes by id (see
    // isComboRenderable()/findDishInMenu()), so this is fetched only after
    // fetchMenu() above has populated currentMenu. A failure here degrades
    // gracefully to "no combos section" (see fetchCombos()) — never blocks
    // the rest of the page.
    await fetchCombos();
    // go-live Task 3 (spec §5): daily specials, fetched alongside the
    // regular menu so the very first render already shows/hides the
    // "Polední menu" section correctly (no flash of it appearing later).
    await fetchDailyMenu();
    // Settings (fee/minOrder/freeAbove/etaMinutes/hours) fetched before the
    // first cart render so the sticky bar/checkout summary show the right
    // fee from the very first paint instead of a flash of "0 Kč fee".
    await fetchRestaurantSettings();
    renderFooterBusinessLine();
    renderCatTabs();
    renderMenuSections();
    renderCartCount();
    renderCartDrawer();
    setupPaymentOptions();
    resumePendingPaymentIfAny();
    applyDeliveryClosedUi();
})();
