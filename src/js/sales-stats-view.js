// ============================================================================
// sales-stats-view.js — the admin "Prodeje" (sales) screen.
//
// go-live sales stats, docs/superpowers/specs/2026-08-02-sales-stats-design.md.
// Reads GET /stats/sales?days=N (N in 1, 7, 30, 90 — see src/server/sales-
// stats.js for the exact payload shape) and renders it: a flush-left period
// switcher, one wide revenue chart, a four-tile KPI row, then (Task 8) the
// ranking / never-sold / patterns / refunds panels, then the receipts panel.
//
// This used to be ~90 lines at the bottom of inner.js (fetchSalesStats,
// renderSalesTable, renderSalesView). It moved out into its own file for the
// same reason pos-db.js / pos-sync.js / floorplan.js / qr.js did: inner.js is
// 275 KB and growing, and this screen is about to grow a lot more (rankings,
// weekday/hour patterns, refund analytics) in Task 8.
//
// Zero frontend dependencies, no bundler, no build step, CSP is
// `script-src 'self'` — plain global functions, loaded as a plain <script>
// tag in inner.html, AFTER inner.js. That load order is safe: renderSalesView
// is a hoisted function declaration and is only ever invoked later, from a
// nav click handler, long after every script on the page has evaluated.
//
// Reused from inner.js at call time (NOT redefined here): apiFetch,
// escapeHtml, showToast, API_URL, renderReceiptsPanel. renderReceiptsPanel in
// particular stays in inner.js and is still called at the bottom of this
// view — the receipts panel is unchanged by this feature.
// ============================================================================

// Selected period. Module-level only — not persisted across reloads, exactly
// as the design doc specifies (§5.1). Default matches the tab that used to
// be "Tento týden".
let salesPeriod = 7;

const PERIODS = [
    { days: 1, label: 'Dnes', caption: 'Dnešek od půlnoci' },
    { days: 7, label: '7 dní', caption: 'Posledních 7 dní' },
    { days: 30, label: '30 dní', caption: 'Posledních 30 dní' },
    { days: 90, label: '90 dní', caption: 'Posledních 90 dní' },
];

// Server sends neutral channel/payment/reason ids only — every label here is
// applied client-side. CHANNEL_LABELS / PAYMENT_LABELS / WEEKDAYS /
// REFUND_REASONS aren't read yet in this task (they belong to the Task 8
// panels — rankings, patterns, refunds) but live here now so both tasks share
// one source of Czech copy instead of two.
const CHANNEL_LABELS = { delivery: 'Rozvoz', table: 'Stůl', indoor: 'Na místě' };
const PAYMENT_LABELS = {
    cash: 'Hotově', card_on_delivery: 'Kartou u řidiče',
    online_card: 'Online', onsite: 'Na místě',
};
const WEEKDAYS = ['Neděle', 'Pondělí', 'Úterý', 'Středa', 'Čtvrtek', 'Pátek', 'Sobota'];
const REFUND_REASONS = [
    { id: 'badly_prepared', label: 'Špatně připravené' },
    { id: 'late', label: 'Pozdě doručené' },
    { id: 'customer_cancelled', label: 'Zákazník zrušil' },
    { id: 'wrong_order', label: 'Chyba objednávky' },
    { id: 'other', label: 'Jiný' },
];

const czk = n => `${Math.round(Number(n) || 0).toLocaleString('cs-CZ')} Kč`;

// ── small formatting helpers ────────────────────────────────────────────

// null/undefined -> not shown at all (previous-period-empty case, §5.3/§5.4
// of the design doc — showing "+∞%"/"+100%" against a zero baseline is worse
// than showing nothing). Uses the U+2212 minus sign the rest of inner.js
// already uses for signed figures, not a plain hyphen.
function formatDelta(delta) {
    if (delta === null || delta === undefined) return null;
    const positive = delta >= 0;
    const sign = positive ? '+' : '−';
    return { text: `${sign}${Math.abs(delta).toLocaleString('cs-CZ')} %`, positive };
}

// Czech plural forms: 1 objednávka, 2-4 objednávky, 0/5+ objednávek.
function ordersWord(n) {
    if (n === 1) return 'objednávka';
    if (n >= 2 && n <= 4) return 'objednávky';
    return 'objednávek';
}

// "D.M." for a day bucket (key "YYYY-MM-DD"), "H:00" for an hour bucket. Hour
// bucket keys come back from the server as zero-padded STRINGS ("00".."23" —
// see buildChart() in sales-stats.js), not numbers, despite how that field
// might sound from its name alone; Number() strips the padding either way.
function bucketLabel(bucket, unit) {
    if (unit === 'hour') return `${Number(bucket.key)}:00`;
    const [, m, d] = bucket.key.split('-').map(Number);
    return `${d}.${m}.`;
}

async function fetchSalesStats(days) {
    const res = await apiFetch(`${API_URL}/stats/sales?days=${days}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

// ── period switcher (design doc §5.1) ───────────────────────────────────
//
// Flush-left tab strip, text labels on a shared baseline — NOT filled pills.
// The active tab is marked by weight plus a 2px accent underline (CSS).

function buildPeriodSwitcher() {
    const nav = document.createElement('div');
    nav.className = 'inn-stat-tabs';
    nav.setAttribute('role', 'tablist');

    PERIODS.forEach(period => {
        const active = period.days === salesPeriod;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'inn-stat-tab' + (active ? ' active' : '');
        btn.setAttribute('role', 'tab');
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
        btn.textContent = period.label;
        btn.addEventListener('click', () => {
            if (salesPeriod === period.days) return;
            salesPeriod = period.days;
            renderSalesView();
        });
        nav.appendChild(btn);
    });

    return nav;
}

// ── revenue chart (design doc §5.2) — the headline ──────────────────────

// One bar per chart.buckets entry, each in a pale full-height rail so a
// low-revenue day still reads as present rather than as missing data. `max`
// is passed in (already computed by the caller, which also needs it to
// decide whether to show the empty state) so this never has to divide by
// zero itself — when max is 0 every fill is styled to 0% height directly.
function buildChartBars(chart, max, days) {
    const wrap = document.createElement('div');
    wrap.className = 'inn-stat-chart-bars';

    const buckets = chart.buckets || [];
    // Day axis only, and only on the two long ranges — 7 daily bars or 24
    // hourly bars both fit without collision, so every one gets a label.
    const labelEvery = (chart.unit === 'day' && (days === 30 || days === 90)) ? 5 : 1;

    buckets.forEach((bucket, idx) => {
        const label = bucketLabel(bucket, chart.unit);
        const tooltip = `${label} — ${czk(bucket.revenue)}, ${bucket.orders} ${ordersWord(bucket.orders)}`;

        const bar = document.createElement('div');
        bar.className = 'inn-stat-bar';
        // Hover can never be the only affordance on a touch surface (the
        // admin is a floor tablet as well as an office monitor) — the bar
        // itself is keyboard-reachable and carries the same info as an
        // aria-label a screen reader can announce.
        bar.tabIndex = 0;
        bar.title = tooltip;
        bar.setAttribute('role', 'img');
        bar.setAttribute('aria-label', tooltip);

        const rail = document.createElement('div');
        rail.className = 'inn-stat-bar-rail';
        const fill = document.createElement('div');
        fill.className = 'inn-stat-bar-fill';
        fill.style.height = max > 0 ? `${(bucket.revenue / max) * 100}%` : '0%';
        rail.appendChild(fill);
        bar.appendChild(rail);

        const labelEl = document.createElement('div');
        labelEl.className = 'inn-stat-bar-label';
        // A non-breaking space rather than an empty node keeps every column
        // the same height whether or not it carries a label this time.
        labelEl.textContent = idx % labelEvery === 0 ? label : ' ';
        bar.appendChild(labelEl);

        wrap.appendChild(bar);
    });

    return wrap;
}

function buildChartCard(data) {
    const card = document.createElement('div');
    card.className = 'inn-stat-chart-card';

    const period = PERIODS.find(p => p.days === data.days) || PERIODS[1];

    const head = document.createElement('div');
    head.className = 'inn-stat-chart-head';

    const total = document.createElement('div');
    total.className = 'inn-stat-chart-total';
    total.textContent = czk(data.totals.revenue);
    head.appendChild(total);

    const deltaInfo = formatDelta(data.deltas.revenue);
    if (deltaInfo) {
        const delta = document.createElement('div');
        delta.className = 'inn-stat-chart-delta ' + (deltaInfo.positive ? 'up' : 'down');
        delta.textContent = deltaInfo.text;
        head.appendChild(delta);
    }
    card.appendChild(head);

    const caption = document.createElement('div');
    caption.className = 'inn-stat-chart-caption';
    caption.textContent = period.caption;
    card.appendChild(caption);

    const chart = data.chart || { unit: 'day', buckets: [] };
    const buckets = chart.buckets || [];
    const max = buckets.reduce((m, b) => Math.max(m, b.revenue), 0);

    if (max === 0) {
        const empty = document.createElement('p');
        empty.className = 'inn-stat-chart-empty';
        empty.textContent = 'Zatím žádné prodeje v tomto období.';
        card.appendChild(empty);
    } else {
        card.appendChild(buildChartBars(chart, max, data.days));
    }

    return card;
}

// ── KPI row (design doc §5.3) — four tiles ──────────────────────────────

const KPI_DEFS = [
    { key: 'revenue', label: 'Tržba', format: czk },
    { key: 'orders', label: 'Objednávky', format: v => Number(v || 0).toLocaleString('cs-CZ') },
    { key: 'avgOrder', label: 'Průměrná objednávka', format: v => (v === null ? '—' : czk(v)) },
    { key: 'items', label: 'Prodáno položek', format: v => Number(v || 0).toLocaleString('cs-CZ') },
];

function buildKpiRow(data) {
    const row = document.createElement('div');
    row.className = 'inn-stat-kpi-row';

    KPI_DEFS.forEach(def => {
        const tile = document.createElement('div');
        tile.className = 'inn-stat-kpi';

        const label = document.createElement('div');
        label.className = 'inn-stat-kpi-label';
        label.textContent = def.label;
        tile.appendChild(label);

        const value = document.createElement('div');
        value.className = 'inn-stat-kpi-value';
        value.textContent = def.format(data.totals[def.key]);
        tile.appendChild(value);

        const deltaInfo = formatDelta(data.deltas[def.key]);
        if (deltaInfo) {
            const delta = document.createElement('div');
            delta.className = 'inn-stat-kpi-delta ' + (deltaInfo.positive ? 'up' : 'down');
            delta.textContent = deltaInfo.text;
            tile.appendChild(delta);
        }

        row.appendChild(tile);
    });

    return row;
}

// ── view entry point ─────────────────────────────────────────────────────

async function renderSalesView() {
    const container = document.getElementById('salesView');
    if (!container) return;
    container.innerHTML = '<p style="color:var(--muted);">Načítání…</p>';

    let data;
    try {
        data = await fetchSalesStats(salesPeriod);
    } catch (e) {
        console.error(e);
        container.innerHTML = '';
        const err = document.createElement('p');
        err.className = 'inn-stat-error';
        err.textContent = 'Nepodařilo se načíst statistiky prodejů.';
        container.appendChild(err);
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'inn-btn';
        retry.textContent = 'Zkusit znovu';
        retry.addEventListener('click', () => renderSalesView());
        container.appendChild(retry);
        return;
    }

    container.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'inn-menu-header';
    header.innerHTML = '<h2>Prodeje</h2>';
    container.appendChild(header);

    container.appendChild(buildPeriodSwitcher());
    container.appendChild(buildChartCard(data));
    container.appendChild(buildKpiRow(data));

    // Task 8 appends the rankings / never-sold / patterns / refunds panels
    // here, still reading from the same `data` this task already fetched.

    await renderReceiptsPanel(container);
}
