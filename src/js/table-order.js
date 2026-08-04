// ════════════════════════════════════════════════════════════════════════
// TABLE-ORDER.JS — guest-facing controller for the QR table self-order page
// (src/html/table.html). Spec: docs/superpowers/specs/2026-08-04-table-qr-
// self-order-design.md §8.2.
//
// A stranger's phone lands here straight from a QR scan, with no session,
// no cookie, and (per D5) nothing to type but an optional name and note —
// no address, PSČ, phone or e-mail, because there is nothing to deliver:
// the guest is already sitting at the table. The menu browsing, cart and
// combo-customize logic below is a close port of src/js/delivery.js, minus
// every delivery-only concept (fee, minimum order, ETA, payment method,
// reorder). The server is still the price/availability/opening-hours
// authority throughout — every number shown here is a preview.
//
// ── SCOPE HAZARD (read before adding a single top-level declaration) ────
// Classic <script src> tags sharing this page (config.js, menu-catalog.js,
// this file) all execute in ONE global lexical environment. menu-catalog.js
// avoids collisions by wrapping itself in an IIFE and exposing exactly one
// global, window.MenuCatalog; this file does the same. A stray top-level
// `const`/`let` here that happens to share a name with something in
// config.js would be a SyntaxError that kills this entire script with NO
// console output — the page would just render blank menu-less nothing,
// which already happened once during this feature's development. Every
// declaration below therefore lives inside the one IIFE at the bottom.
//
// The one deliberate exception is `showToast`: MenuCatalog.fetchMenu() (see
// src/js/menu-catalog.js) calls a bare, unqualified `showToast(...)` on
// failure, which — because menu-catalog.js runs in strict mode — only
// resolves if a `showToast` property already exists on the global object.
// So this file must genuinely publish `window.showToast`, not merely
// declare a same-named local function; see the assignment near the top of
// the IIFE below.
// ════════════════════════════════════════════════════════════════════════

(function () {
    'use strict';

    const API_BASE_URL = window.API_BASE_URL || `http://${window.location.hostname}:3000`;
    const API_URL = `${API_BASE_URL}/reservation/api`;

    // Menu data layer, shared with the delivery page — see
    // src/js/menu-catalog.js. Loaded by a <script> tag ahead of this file.
    const MC = window.MenuCatalog;
    const MENU_CATEGORIES = MC.MENU_CATEGORIES;
    const DAILY_ITEM_ID_PREFIX = MC.DAILY_ITEM_ID_PREFIX;
    const DAILY_CATEGORY_ID = MC.DAILY_CATEGORY_ID;
    const COMBO_ITEM_ID_PREFIX = MC.COMBO_ITEM_ID_PREFIX;
    const COMBO_CATEGORY_ID = MC.COMBO_CATEGORY_ID;

    // Token comes from the path — /reservation/stul/<token> — not a query
    // string, so it survives being typed off a printed card (spec §8.2
    // step 2). filter(Boolean) drops the leading '' from the split on '/'.
    const TOKEN = window.location.pathname.split('/').filter(Boolean).pop();

    // sessionStorage key is scoped to this exact token, not just a bare
    // constant string — a phone that somehow ends up with two table tabs
    // open (unlikely, but sessionStorage is per-tab anyway) must never let
    // one table's refresh resume the other table's order.
    const SESSION_KEY = `tableOrder:${TOKEN}`;

    // ── STATE ────────────────────────────────────────────────────────────
    let currentMenu = {};
    let dailyMenuItems = [];
    let combos = [];
    let cart = {}; // same shape as delivery.js: key -> { id, name, price, categoryId, qty[, comboConfig] }
    let dishIndex = {}; // dishId -> { dish, categoryId } — for in-place row updates
    let sectionObserver = null;
    let activeCategory = null;

    let tableName = '';
    let orderingOpen = true;
    let orderingNoticeText = null;

    let statusPollHandle = null;
    let statusOrderId = null;
    let statusPollInFlight = false;

    // ── UTIL ─────────────────────────────────────────────────────────────

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str ?? '';
        return div.innerHTML;
    }

    // Published on window — see the header comment above for why this
    // can't just be a local function.
    window.showToast = function showToast(msg, isError) {
        const t = document.getElementById('toast');
        if (!t) return;
        t.textContent = msg;
        t.className = 'ds-toast show' + (isError ? ' error' : '');
        clearTimeout(showToast._t);
        showToast._t = setTimeout(() => t.classList.remove('show'), 2400);
    };

    function formatPrice(n) {
        return `${Number(n || 0).toFixed(0)} Kč`;
    }

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

    // ── TOP-LEVEL SCREENS (loading / error / menu / status) ─────────────
    // Siblings toggled via `hidden`, per spec §8.2. #tableHero (the
    // prominent table-name heading) is shown alongside menu AND status —
    // a guest resuming straight into the status screen after a refresh
    // still needs to see which table this is.

    function showLoadingScreen() {
        document.getElementById('loadingScreen').hidden = false;
        document.getElementById('errorScreen').hidden = true;
        document.getElementById('menuScreen').hidden = true;
        document.getElementById('statusScreen').hidden = true;
        document.getElementById('tableHero').hidden = true;
    }

    function showErrorScreen(message) {
        document.getElementById('loadingScreen').hidden = true;
        document.getElementById('errorScreen').hidden = false;
        document.getElementById('menuScreen').hidden = true;
        document.getElementById('statusScreen').hidden = true;
        document.getElementById('tableHero').hidden = true;
        document.getElementById('errorMessage').textContent = message;
        stopStatusPolling();
    }

    function showMenuScreen() {
        document.getElementById('loadingScreen').hidden = true;
        document.getElementById('errorScreen').hidden = true;
        document.getElementById('menuScreen').hidden = false;
        document.getElementById('statusScreen').hidden = true;
        document.getElementById('tableHero').hidden = false;
        stopStatusPolling();
    }

    function showStatusScreen() {
        document.getElementById('loadingScreen').hidden = true;
        document.getElementById('errorScreen').hidden = true;
        document.getElementById('menuScreen').hidden = true;
        document.getElementById('statusScreen').hidden = false;
        document.getElementById('tableHero').hidden = false;
    }

    function renderTableHeading() {
        document.getElementById('tableNameHeading').textContent = tableName;
    }

    // ── SESSION PERSISTENCE (refresh must resume live status, not an
    // empty cart — spec §8.2 step 5) ────────────────────────────────────

    function saveOrderSession(orderId) {
        try {
            sessionStorage.setItem(SESSION_KEY, JSON.stringify({ orderId, token: TOKEN }));
        } catch (e) {
            // sessionStorage unavailable (private mode, quota) — the order
            // still succeeded server-side; the guest just won't get the
            // auto-resume-on-refresh convenience. Not worth surfacing.
            console.warn('Failed to persist order session:', e);
        }
    }

    function loadOrderSession() {
        try {
            const raw = sessionStorage.getItem(SESSION_KEY);
            if (!raw) return null;
            const data = JSON.parse(raw);
            if (!data || typeof data.orderId !== 'string' || data.token !== TOKEN) return null;
            return data;
        } catch (e) {
            return null;
        }
    }

    function clearOrderSession() {
        try { sessionStorage.removeItem(SESSION_KEY); } catch (e) { /* ignore */ }
    }

    // ── BOOT: resolve the token, then either resume a live order or show
    // the menu (spec §5.2 / §8.2 step 1) ─────────────────────────────────

    async function boot() {
        showLoadingScreen();
        try {
            const res = await fetch(`${API_URL}/table-session/${encodeURIComponent(TOKEN)}`);

            if (res.status === 404) {
                showErrorScreen('Neplatný kód stolu. Zkuste prosím QR kód naskenovat znovu, nebo se obraťte na obsluhu.');
                return;
            }
            if (res.status === 410) {
                showErrorScreen('Tento stůl už neexistuje. Obraťte se prosím na obsluhu.');
                return;
            }
            if (!res.ok) {
                showErrorScreen('Nepodařilo se načíst stůl. Zkuste to prosím znovu.');
                return;
            }

            const data = await res.json();
            tableName = data.tableName || '';
            const ordering = data.ordering || {};
            orderingOpen = !!ordering.open;
            orderingNoticeText = ordering.notice || null;
            renderTableHeading();

            // A refresh (or a guest re-opening the QR link after already
            // ordering) must resume the live status screen, never drop them
            // back into an empty cart (spec §8.2 step 5).
            const existing = loadOrderSession();
            if (existing) {
                statusOrderId = existing.orderId;
                showStatusScreen();
                document.getElementById('statusOrderId').textContent = statusOrderId;
                startStatusPolling();
                return;
            }

            await loadMenuAndShow();
        } catch (e) {
            console.error('Failed to resolve table session:', e);
            showErrorScreen('Nepodařilo se načíst stůl. Zkontrolujte prosím připojení a zkuste to znovu.');
        }
    }

    async function loadMenuAndShow() {
        currentMenu = await MC.fetchMenu(API_URL);
        // Combo menus reference regular menu dishes by id, so fetch combos
        // only after currentMenu is populated (mirrors delivery.js's init
        // order exactly).
        combos = await MC.fetchCombos(API_URL);
        dailyMenuItems = await MC.fetchDailyMenu(API_URL);

        applyOrderingNoticeUi();
        renderCatTabs();
        renderMenuSections();
        renderCartCount();
        renderCartDrawer();
        showMenuScreen();
    }

    // ── ORDERING-CLOSED BANNER ────────────────────────────────────────────
    // Menu stays fully browsable either way (spec §5.2/§8.2) — only the
    // submit button and its sheet-local hint reflect the closed state.

    function applyOrderingNoticeUi() {
        const notice = document.getElementById('orderingNotice');
        if (notice) {
            if (!orderingOpen && orderingNoticeText) {
                notice.textContent = orderingNoticeText;
                notice.hidden = false;
            } else {
                notice.hidden = true;
            }
        }
        const hint = document.getElementById('submitClosedHint');
        if (hint) {
            if (!orderingOpen && orderingNoticeText) {
                hint.textContent = orderingNoticeText;
                hint.hidden = false;
            } else {
                hint.hidden = true;
            }
        }
        const submitBtn = document.getElementById('submitTableOrderBtn');
        if (submitBtn) submitBtn.disabled = !orderingOpen;
    }

    // ── CATEGORY NAV (sticky chips, scroll-spy highlight) — verbatim port
    // of delivery.js's version, section order per spec §8.2: Zvýhodněná
    // menu → Polední menu → MENU_CATEGORIES. ───────────────────────────

    function renderCatTabs() {
        const container = document.getElementById('catTabs');
        container.innerHTML = '';

        const cats = MENU_CATEGORIES.filter(cat => (currentMenu[cat.id] || []).length > 0);
        const hasDaily = dailyMenuItems.length > 0;
        const hasCombos = combos.filter(c => MC.isComboRenderable(c, currentMenu)).length > 0;
        container.hidden = cats.length === 0 && !hasDaily && !hasCombos;
        if (cats.length === 0 && !hasDaily && !hasCombos) return;

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
            tab.className = 'ds-chip' + (i === 0 && !hasDaily && !hasCombos ? ' ds-chip--selected' : '');
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

    // ── MENU SECTIONS ─────────────────────────────────────────────────────

    function dailyItemAsDish(item) {
        return { id: `${DAILY_ITEM_ID_PREFIX}${item.id}`, name: item.name, price: item.price, info: '', imageUrl: '', soldOut: false };
    }

    function renderMenuSections() {
        const container = document.getElementById('menuSections');
        container.innerHTML = '';
        dishIndex = {};

        // ── Zvýhodněná menu (combos — rendered first) ─────────────────────
        const renderableCombos = combos.filter(c => MC.isComboRenderable(c, currentMenu));
        if (renderableCombos.length > 0) {
            container.appendChild(buildCombosSection(renderableCombos));
        }

        // ── Polední menu ────────────────────────────────────────────────
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

    // ── COMBO MENUS ("Zvýhodněná menu") — cards + customize dialog ──────
    // Ported from delivery.js with full functionality (spec D10): slot
    // removal, slot swaps, paid extras, per-line note.

    function findDishInMenu(dishId) {
        for (const cat of MENU_CATEGORIES) {
            const found = (currentMenu[cat.id] || []).find(d => d.id === dishId);
            if (found) return found;
        }
        return null;
    }

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

    function buildComboAction(combo) {
        if (combo.soldOut) return document.createDocumentFragment();

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'del-combo__customize-btn ds-btn ds-btn--primary';
        btn.textContent = 'Přizpůsobit a přidat';
        btn.addEventListener('click', () => openComboDialog(combo));
        return btn;
    }

    function formatSignedDelta(delta) {
        const n = Math.round(Number(delta) || 0);
        if (n === 0) return '+0 Kč';
        return n > 0 ? `+${n} Kč` : `−${Math.abs(n)} Kč`;
    }

    // Rebuilds the same human-readable breakdown the server stores as the
    // order line's name (see delivery.js's buildComboDisplayName — kept
    // word-for-word identical so a combo ordered from either page reads
    // the same way on the kitchen ticket/receipt).
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
                .filter(s => s.dish && !s.dish.soldOut);

            const group = document.createElement('div');
            group.className = 'del-combo-slot';

            const label = document.createElement('div');
            label.className = 'del-combo-slot__label';
            label.textContent = defaultDish.name;
            group.appendChild(label);

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
        const { total } = MC.comboPricePreview(combo, { slotSelections, extrasSelected }, currentMenu);
        document.getElementById('comboDialogTotal').textContent = formatPrice(total);
    }

    // ── Combo cart lines — same synthetic-local-key scheme as delivery.js
    // (COMBO_LINE_KEY_PREFIX): several distinctly-customized lines of the
    // same combo id are never merged (spec D10 / combo-menus spec).
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

    // ── CART ─────────────────────────────────────────────────────────────

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

    function renderCartCount() {
        const count = getCartCount();
        const subtotal = getCartTotal();
        document.getElementById('cartCount').textContent = count;
        // No delivery fee here (spec D5) — the sticky-bar total IS the
        // final payable amount, unlike delivery.html's subtotal+fee figure.
        document.getElementById('cartBarTotal').textContent = formatPrice(subtotal);
        document.getElementById('openCartBtn').hidden = count === 0;
    }

    function renderCartDrawer() {
        const itemsEl = document.getElementById('cartItems');
        itemsEl.innerHTML = '';

        const entries = Object.entries(cart);
        if (entries.length === 0) {
            itemsEl.innerHTML = `<p class="ds-empty">Košík je zatím prázdný.<br>Přidejte si něco z menu.</p>`;
        } else {
            entries.forEach(([localKey, item]) => {
                const catLabel = MC.categoryLabel(item.categoryId);
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

        document.getElementById('cartTotalText').textContent = formatPrice(getCartTotal());
    }

    // ── SUBMIT ───────────────────────────────────────────────────────────

    async function submitOrder() {
        // Re-apply the last known open/closed state right before submitting
        // — the authoritative check is the server's own 403 below, this is
        // only belt-and-braces so a guest doesn't wait on a request we
        // already know will be rejected.
        applyOrderingNoticeUi();
        if (!orderingOpen) {
            window.showToast(orderingNoticeText || 'Objednávky u stolu jsou momentálně uzavřeny.', true);
            return;
        }

        const items = Object.values(cart);
        if (items.length === 0) {
            window.showToast('Košík je prázdný', true);
            return;
        }

        const nameInput = document.getElementById('tblGuestNameInput');
        const noteInput = document.getElementById('tblNoteInput');
        const submitBtn = document.getElementById('submitTableOrderBtn');

        // Defense in depth to match the inputs' own maxlength attributes —
        // the server re-validates these bounds anyway (V.tableOrderSchema).
        const guestName = nameInput.value.trim().slice(0, 150);
        const note = noteInput.value.trim().slice(0, 500);

        submitBtn.disabled = true;
        submitBtn.textContent = 'Odesílám…';

        try {
            const res = await fetch(`${API_URL}/table-orders`, {
                method: 'POST',
                // No CSRF header — this route has none (spec §5.3). It is
                // public and session-less, same posture as POST /orders.
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token: TOKEN, guestName, note, items })
            });
            const result = await res.json();

            if (res.status === 403) {
                // Server is the authority on opening hours — a tab left
                // open since lunch must be told so, not just get a generic
                // error toast (spec §8.2 step 4).
                orderingOpen = false;
                orderingNoticeText = result.error || 'Objednávky u stolu jsou momentálně uzavřeny.';
                applyOrderingNoticeUi();
                window.showToast(orderingNoticeText, true);
                return;
            }
            if (!res.ok) {
                // Typically a sold-out item (400) — show the server's own
                // message verbatim (spec §8.2 step 4).
                window.showToast(result.error || 'Objednávku se nepodařilo odeslat', true);
                return;
            }

            cart = {};
            nameInput.value = '';
            noteInput.value = '';
            closeSheet('cartSheetBackdrop', 'cartSheet');

            statusOrderId = result.orderId;
            saveOrderSession(statusOrderId);
            showStatusScreen();
            document.getElementById('statusOrderId').textContent = statusOrderId;
            document.getElementById('statusTotal').textContent = `Celkem: ${formatPrice(result.total)}`;
            startStatusPolling();
        } catch (e) {
            console.error('Failed to submit table order:', e);
            window.showToast('Nepodařilo se odeslat objednávku. Zkontrolujte prosím připojení.', true);
        } finally {
            submitBtn.disabled = !orderingOpen;
            submitBtn.textContent = 'Odeslat objednávku';
        }
    }

    // ── STATUS SCREEN — poll every 15s, map kitchenStatus, stop on
    // completed, pause while the tab is hidden (guest's battery — spec
    // §8.2 step 5). ────────────────────────────────────────────────────

    const STATUS_POLL_INTERVAL_MS = 15000;

    // The board only ever writes "pending" or "completed" to kitchenStatus
    // (see src/server/validation.js's kitchenStatusSchema) — there is no
    // server-side "in preparation" state to read. "Přijato" is therefore
    // shown as the immediate, optimistic state right after a successful
    // submit (the guest just placed the order — of course it was
    // received); the very first status poll response that confirms it is
    // still "pending" upgrades the label to "Připravuje se", so the guest
    // sees the order visibly move forward rather than sitting on "Přijato"
    // for the entire wait. "Hotovo" is the one label backed by a real,
    // distinct server value.
    let hasPolledOnceThisSession = false;

    function renderStatus(kitchenStatus) {
        const icon = document.getElementById('statusIcon');
        const label = document.getElementById('statusLabel');

        if (kitchenStatus === 'completed') {
            icon.textContent = '✅';
            label.textContent = 'Hotovo';
        } else if (hasPolledOnceThisSession) {
            icon.textContent = '👨‍🍳';
            label.textContent = 'Připravuje se';
        } else {
            icon.textContent = '⏳';
            label.textContent = 'Přijato';
        }
    }

    async function pollOrderStatus() {
        if (statusPollInFlight || !statusOrderId) return;
        statusPollInFlight = true;
        try {
            const res = await fetch(`${API_URL}/table-orders/${encodeURIComponent(statusOrderId)}/status?token=${encodeURIComponent(TOKEN)}`);
            if (!res.ok) {
                // 404 here means the order/token pairing no longer resolves
                // (e.g. the table was deleted after the order was placed) —
                // there is nothing left worth polling for.
                if (res.status === 404 || res.status === 410) {
                    clearOrderSession();
                    stopStatusPolling();
                    showErrorScreen('Tuto objednávku se nepodařilo najít. Obraťte se prosím na obsluhu.');
                }
                return; // transient failure — keep the last known status on screen, try again next tick
            }
            const data = await res.json();
            document.getElementById('statusTotal').textContent = `Celkem: ${formatPrice(data.total)}`;
            renderStatus(data.kitchenStatus);
            hasPolledOnceThisSession = true;

            if (data.kitchenStatus === 'completed') {
                stopStatusPolling();
            }
        } catch (e) {
            console.error('Failed to poll order status:', e);
        } finally {
            statusPollInFlight = false;
        }
    }

    function startStatusPolling() {
        stopStatusPolling();
        renderStatus(null); // optimistic "Přijato" the instant the status screen appears
        pollOrderStatus();
        // Only actually runs while the tab is visible — see the
        // visibilitychange handler below, which starts/stops this same
        // interval rather than letting it tick uselessly in the
        // background and drain a guest's phone battery.
        if (document.visibilityState !== 'hidden') {
            statusPollHandle = setInterval(pollOrderStatus, STATUS_POLL_INTERVAL_MS);
        }
    }

    function stopStatusPolling() {
        if (statusPollHandle) clearInterval(statusPollHandle);
        statusPollHandle = null;
    }

    document.addEventListener('visibilitychange', () => {
        // Only meaningful while a status screen is actually active — on
        // the menu screen there is nothing to poll.
        if (!statusOrderId || document.getElementById('statusScreen').hidden) return;

        if (document.visibilityState === 'hidden') {
            stopStatusPolling();
        } else {
            // Resume immediately with a fresh check (the kitchen may have
            // finished while the guest's screen was off), then resume the
            // regular interval.
            pollOrderStatus();
            stopStatusPolling();
            statusPollHandle = setInterval(pollOrderStatus, STATUS_POLL_INTERVAL_MS);
        }
    });

    // ── EVENT WIRING ─────────────────────────────────────────────────────

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
    document.getElementById('submitTableOrderBtn').addEventListener('click', submitOrder);

    document.getElementById('comboSheetCancelBtn').addEventListener('click', closeComboDialog);
    document.getElementById('comboSheetCloseBtn').addEventListener('click', closeComboDialog);
    document.getElementById('comboSheetBackdrop').addEventListener('click', closeComboDialog);

    document.getElementById('comboSheetConfirmBtn').addEventListener('click', () => {
        if (!comboDialogState) return;
        const { combo, slotSelections, extrasSelected } = comboDialogState;

        const note = document.getElementById('comboNoteInput').value.trim().slice(0, 200);

        const removed = [];
        const swaps = {};
        Object.keys(slotSelections).forEach(slotId => {
            const sel = slotSelections[slotId];
            if (sel === 'removed') removed.push(slotId);
            else if (sel && sel.startsWith('swap:')) swaps[slotId] = sel.slice(5);
        });
        const extras = Array.from(extrasSelected);

        const comboConfig = {};
        if (removed.length > 0) comboConfig.removed = removed;
        if (Object.keys(swaps).length > 0) comboConfig.swaps = swaps;
        if (extras.length > 0) comboConfig.extras = extras;
        if (note) comboConfig.note = note;

        const { total: price } = MC.comboPricePreview(combo, { slotSelections, extrasSelected }, currentMenu);
        const name = buildComboDisplayName(combo, removed, swaps, extras, note);

        addComboLineToCart(combo, comboConfig, price, name);
        closeComboDialog();
        window.showToast(`${combo.name} přidáno do košíku`);
    });

    // ── INIT ─────────────────────────────────────────────────────────────
    boot();
})();
