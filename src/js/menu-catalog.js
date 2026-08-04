// ════════════════════════════════════════════════════════════════════════
// MENU-CATALOG.JS — the shared MENU DATA layer for every customer-facing
// ordering surface: the delivery page (src/js/delivery.js) and the QR
// table-order page (src/js/table-order.js).
//
// DATA ONLY. No DOM, no rendering, no cart. The two pages render the same
// menu very differently — the table page has no address, no PSČ, no
// delivery fee, no minimum order and no reorder flow — so their markup
// stays in their own files. What must NOT diverge is the shape of the menu,
// the id-prefix conventions the server's priceOrderItems() keys off, and
// the combo price formula the customer sees before they commit.
//
// Extracted from delivery.js (spec 2026-08-04 §8.1) with NO behavioural
// change. In particular the two fetchers fail differently ON PURPOSE:
// fetchMenu() surfaces a toast because a page with no menu is broken, while
// fetchCombos() fails silently to an empty array because combos are a bonus
// on top of the regular menu and must never block it. That asymmetry was
// deliberate in delivery.js and is preserved here.
//
// No build step in this app — this is a plain script exposing ONE global,
// window.MenuCatalog. It MUST be loaded before delivery.js and before
// table-order.js, both of which read window.MenuCatalog at parse time.
//
// Wrapped in an IIFE (same pattern as src/js/qr.js) rather than declaring
// MENU_CATEGORIES etc. as bare top-level `const`s: classic (non-module)
// <script> tags all share ONE global lexical environment, so a bare
// top-level `const MENU_CATEGORIES` here would collide with delivery.js's
// own top-level `const MENU_CATEGORIES = MC.MENU_CATEGORIES;` alias — a
// SyntaxError that silently kills the *entire* second script with no
// runtime exception to catch. Keeping everything but the one intentional
// global inside this function scope avoids that trap entirely.
// ════════════════════════════════════════════════════════════════════════

(function (global) {
    'use strict';

    const MENU_CATEGORIES = [
        { id: 'main',     label: 'Hlavní jídla' },
        { id: 'side',     label: 'Přílohy' },
        { id: 'drinks',   label: 'Nápoje' },
        { id: 'desserts', label: 'Dezerty' },
    ];

    // go-live Task 3 (spec §5): today's specials ("Polední menu"), fetched
    // from the PUBLIC GET /daily-menu (no ?date=) — only ever returns items
    // while settings.dailyMenu.enabled and the current time is within
    // from/to (empty list otherwise, e.g. outside the window or nothing
    // entered today). Each item's cart/dish id is namespaced "daily:<id>"
    // (see DAILY_ITEM_ID_PREFIX in server.js) so priceOrderItems() there
    // can tell a daily-menu line apart from a regular menu dish id/name and
    // price it from the dailyMenu record instead — the server never trusts
    // this client-side price for these items either, same as regular
    // dishes.
    const DAILY_ITEM_ID_PREFIX = 'daily:';
    const DAILY_CATEGORY_ID = 'daily-menu';

    // ── COMBO MENUS ("Zvýhodněná menu") ─────────────────────────────────
    // Spec: docs/superpowers/specs/2026-07-22-combo-menus-design.md.
    // Fetched from the PUBLIC GET /combos alongside the regular menu. Each
    // combo bundles a few regular-menu dishes (by id, "slots") for one
    // price, and the customer may customize it before adding it to the
    // cart: remove a slot (subtracts that slot's admin-set removeValue),
    // swap a slot's dish for one of the admin-allowed alternatives (price
    // difference applies both ways), tick paid extras, and attach a short
    // note. A customized combo becomes ONE cart line, namespaced
    // "combo:<comboId>" (mirrors the "daily:" pattern above) — each
    // consuming page keeps its own cart-line bookkeeping (see e.g.
    // delivery.js's COMBO_LINE_KEY_PREFIX) since that's local UI state, not
    // shared menu data. The server is always the price/name authority (see
    // priceOrderItems()'s combo: branch, server.js); comboPricePreview()
    // below mirrors that formula for display, but must match it exactly so
    // the customer isn't surprised at checkout.
    const COMBO_ITEM_ID_PREFIX = 'combo:';
    const COMBO_CATEGORY_ID = 'combo-menu'; // pseudo-category, mirrors DAILY_CATEGORY_ID

    // Category-label lookup that also understands the daily-menu and
    // combo-menu pseudo-categories (neither is in MENU_CATEGORIES — each is
    // rendered separately by the consuming page) — used by cart drawers to
    // show a category label.
    function categoryLabel(categoryId) {
        if (categoryId === DAILY_CATEGORY_ID) return 'Polední menu';
        if (categoryId === COMBO_CATEGORY_ID) return 'Zvýhodněná menu';
        return (MENU_CATEGORIES.find(c => c.id === categoryId) || {}).label || '';
    }

    // ── DATA LOADING ─────────────────────────────────────────────────────
    // Every fetcher takes `apiUrl` as its first argument (this module has
    // no API_URL of its own — each consuming page has a differently-derived
    // one) and RETURNS its result rather than assigning module-level
    // state — this module is data-only and stateless; each consuming page
    // keeps its own currentMenu / dailyMenuItems / combos variables and
    // assigns from the return value.

    // fetchMenu() calls the global `showToast(msg, isError)` on failure —
    // every page that loads this module (delivery.js, table-order.js)
    // defines its own toast function under that name, and by the time
    // fetchMenu() is actually invoked (during that page's own init, after
    // its whole script has run) the global is in place. A page with no menu
    // is broken, so this is the one fetcher in this module that surfaces
    // the failure to the customer.
    async function fetchMenu(apiUrl) {
        let menu;
        try {
            const res = await fetch(`${apiUrl}/menu`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            menu = await res.json();
        } catch (e) {
            console.error('Failed to load menu:', e);
            menu = {};
            showToast('Nepodařilo se načíst menu', true);
        }
        return menu;
    }

    // go-live Task 3 (spec §5): public, no ?date= — server only ever
    // returns today's items, and only inside the configured window. Fails
    // open to an empty list (never blocks the rest of the page from
    // loading) on any error.
    async function fetchDailyMenu(apiUrl) {
        let items;
        try {
            const res = await fetch(`${apiUrl}/daily-menu`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            items = Array.isArray(data.items) ? data.items : [];
        } catch (e) {
            console.error('Failed to load daily menu:', e);
            items = [];
        }
        return items;
    }

    async function fetchCombos(apiUrl) {
        let combos;
        try {
            const res = await fetch(`${apiUrl}/combos`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            combos = Array.isArray(data) ? data : [];
        } catch (e) {
            // Fails open to "no combos" — the section simply doesn't render
            // (see isComboRenderable()). Combos are a bonus on top of the
            // regular menu, so a failure here must never block the rest of
            // the page (no toast, unlike fetchMenu()).
            console.error('Failed to load combos:', e);
            combos = [];
        }
        return combos;
    }

    // Dish lookup restricted to the regular menu categories
    // (MENU_CATEGORIES) — combo slots/swaps only ever reference regular
    // menu dishes, never daily-menu items. Mirrors
    // flattenMenuDishes()/findMenuDish() in server.js, just client-side and
    // by exact id. Private to this module — isComboRenderable()/
    // comboPricePreview() are the only callers; consuming pages that need
    // dish lookups for their own rendering (e.g. delivery.js's combo
    // customize dialog) keep their own copy, since it closes over their own
    // currentMenu variable rather than taking `menu` as a parameter.
    function findDishInMenu(menu, dishId) {
        for (const cat of MENU_CATEGORIES) {
            const found = ((menu && menu[cat.id]) || []).find(d => d.id === dishId);
            if (found) return found;
        }
        return null;
    }

    // "A combo whose slot references a dish missing from the fetched menu
    // is skipped (not rendered)" (plan, Task 3). Only the *default* dish of
    // every slot is checked here — a default dish that still exists but is
    // itself soldOut is left to render as-is; the server rejects the order
    // at checkout time if the customer doesn't remove/swap that slot away
    // (same "server is the source of truth" spirit as everywhere else on
    // these pages).
    function isComboRenderable(combo, menu) {
        if (!combo || !Array.isArray(combo.items) || combo.items.length === 0) return false;
        return combo.items.every(it => it && !!findDishInMenu(menu, it.dishId));
    }

    // Same formula as the server's combo: branch in priceOrderItems() (spec
    // "Cart line & server-side pricing"): base price − removed slots'
    // removeValue + (swap dish price − default dish price) for swapped
    // slots + checked extras, clamped at 0. Display-only — the server
    // always recomputes for real.
    //
    // `selection` is { slotSelections, extrasSelected }:
    //   slotSelections: { [slotId]: 'default' | 'removed' | 'swap:<dishId>' }
    //   extrasSelected: a Set (or array) of selected extra ids
    //
    // Returns { total, lines } — `total` is the same number
    // computeComboUnitPrice() used to return; `lines` is the itemized
    // breakdown (one entry per non-default slot choice and per selected
    // extra, each `{ label, delta }`) that a consuming page can use to show
    // *why* the price changed, beyond just the final number.
    function comboPricePreview(combo, selection, menu) {
        const slotSelections = (selection && selection.slotSelections) || {};
        const rawExtras = (selection && selection.extrasSelected) || [];
        const extrasSelected = rawExtras instanceof Set ? rawExtras : new Set(rawExtras);

        let total = Number(combo.price) || 0;
        const lines = [];

        (combo.items || []).forEach(it => {
            const sel = slotSelections[it.slotId] || 'default';
            if (sel === 'removed') {
                const delta = -(Number(it.removeValue) || 0);
                total += delta;
                const dish = findDishInMenu(menu, it.dishId);
                lines.push({ label: `bez ${dish ? dish.name : it.slotId}`, delta });
            } else if (typeof sel === 'string' && sel.startsWith('swap:')) {
                const swapDish = findDishInMenu(menu, sel.slice(5));
                const defaultDish = findDishInMenu(menu, it.dishId);
                if (swapDish && defaultDish) {
                    const delta = (Number(swapDish.price) || 0) - (Number(defaultDish.price) || 0);
                    total += delta;
                    lines.push({ label: `${swapDish.name} místo ${defaultDish.name}`, delta });
                }
            }
        });

        (combo.extras || []).forEach(ex => {
            if (extrasSelected.has(ex.id)) {
                const delta = Number(ex.price) || 0;
                total += delta;
                lines.push({ label: `+ ${ex.name}`, delta });
            }
        });

        total = Math.max(0, total);
        return { total, lines };
    }

    const MenuCatalog = {
        MENU_CATEGORIES,
        DAILY_ITEM_ID_PREFIX,
        DAILY_CATEGORY_ID,
        COMBO_ITEM_ID_PREFIX,
        COMBO_CATEGORY_ID,
        categoryLabel,
        fetchMenu,
        fetchDailyMenu,
        fetchCombos,
        isComboRenderable,
        comboPricePreview,
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = MenuCatalog;
    global.MenuCatalog = MenuCatalog;
})(typeof window !== 'undefined' ? window : globalThis);
