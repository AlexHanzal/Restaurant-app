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
// neverSold groups come back keyed by the raw menu category — map to Czech,
// falling back to the raw key for any category this map doesn't know about
// (a new menu section added later degrades gracefully instead of vanishing).
const NEVER_SOLD_CATEGORY_LABELS = { main: 'Hlavní jídla', side: 'Přílohy', drinks: 'Nápoje', desserts: 'Dezerty' };

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

// ── shared rank list (design doc §5.4 / Task 8 step 1) ──────────────────
//
// "Rank, name, thin proportional bar behind the row, metric" — used by the
// three ranking cards AND by the refunds panel's item co-occurrence list
// (Task 8 step 4), so it lives here once instead of twice. `metric` formats
// the trailing figure; `valueOf` returns the raw number the bar width is
// scaled against (bars are relative to THIS list's own max, per card/list,
// not a global max — see buildRankingCard/buildRefundsPanel callers).
function buildRankList(items, metric, valueOf) {
    const max = items.reduce((m, item) => Math.max(m, valueOf(item)), 0);
    const list = document.createElement('div');
    list.className = 'inn-stat-rank-list';

    items.forEach((item, idx) => {
        const row = document.createElement('div');
        row.className = 'inn-stat-rank-row';

        const bar = document.createElement('div');
        bar.className = 'inn-stat-rank-bar';
        bar.style.width = max > 0 ? `${(valueOf(item) / max) * 100}%` : '0%';
        row.appendChild(bar);

        const content = document.createElement('div');
        content.className = 'inn-stat-rank-content';
        const rank = document.createElement('span');
        rank.className = 'inn-stat-rank-num';
        rank.textContent = String(idx + 1);
        const name = document.createElement('span');
        name.className = 'inn-stat-rank-name';
        name.textContent = item.name;
        const value = document.createElement('span');
        value.className = 'inn-stat-rank-value';
        value.textContent = metric(item);
        content.append(rank, name, value);
        row.appendChild(content);

        list.appendChild(row);
    });

    return list;
}

// ── ranking cards (Task 8 step 1) ────────────────────────────────────────

const RANKING_DEFS = [
    { key: 'topByCount', title: 'Nejprodávanější' },
    { key: 'bottomByCount', title: 'Nejméně prodávané' },
    { key: 'topByRevenue', title: 'Největší tržba' },
];

function buildRankingCard(def, items) {
    const card = document.createElement('div');
    card.className = 'inn-stat-panel inn-stat-rank-card';

    const title = document.createElement('div');
    title.className = 'inn-stat-panel-title';
    title.textContent = def.title;
    card.appendChild(title);

    if (!items || items.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'inn-stat-empty';
        empty.textContent = 'Zatím žádné prodeje';
        card.appendChild(empty);
        return card;
    }

    const isRevenue = def.key === 'topByRevenue';
    const metric = isRevenue
        ? item => czk(item.revenue)
        : item => `${Number(item.count).toLocaleString('cs-CZ')} ks`;
    const valueOf = isRevenue ? item => item.revenue : item => item.count;

    card.appendChild(buildRankList(items, metric, valueOf));
    return card;
}

function buildRankingsRow(data) {
    const row = document.createElement('div');
    row.className = 'inn-stat-rankings-row';
    const rankings = data.rankings || {};
    RANKING_DEFS.forEach(def => {
        row.appendChild(buildRankingCard(def, rankings[def.key]));
    });
    return row;
}

// ── never-sold panel (Task 8 step 2) ─────────────────────────────────────

function buildNeverSoldPanel(data) {
    const panel = document.createElement('div');
    panel.className = 'inn-stat-panel';

    const title = document.createElement('div');
    title.className = 'inn-stat-panel-title';
    title.textContent = 'Neprodalo se vůbec';
    panel.appendChild(title);

    const groups = data.neverSold || [];
    if (groups.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'inn-stat-empty';
        empty.textContent = 'Všechny položky menu se v tomto období prodaly.';
        panel.appendChild(empty);
        return panel;
    }

    const wrap = document.createElement('div');
    wrap.className = 'inn-stat-never-sold-groups';
    groups.forEach(group => {
        const groupEl = document.createElement('div');
        groupEl.className = 'inn-stat-never-sold-group';

        const label = document.createElement('div');
        label.className = 'inn-stat-never-sold-cat';
        label.textContent = NEVER_SOLD_CATEGORY_LABELS[group.category] || group.category;
        groupEl.appendChild(label);

        const items = document.createElement('ul');
        items.className = 'inn-stat-never-sold-items';
        (group.items || []).forEach(name => {
            const li = document.createElement('li');
            li.textContent = name;
            items.appendChild(li);
        });
        groupEl.appendChild(items);

        wrap.appendChild(groupEl);
    });
    panel.appendChild(wrap);
    return panel;
}

// ── patterns panel (Task 8 step 3) ───────────────────────────────────────

// One labelled proportional bar row per split entry (channel or payment
// method). `labelFn` maps the neutral server id to Czech. `onsiteNote`, when
// given, is appended under the "onsite" row only — see the module header
// note on why that slice needs an explicit "settled at the table, not
// missing data" label rather than looking like an unexplained gap.
function buildSplitRows(entries, labelFn, onsiteNote) {
    const rows = document.createElement('div');
    rows.className = 'inn-stat-split-rows';

    entries.forEach(entry => {
        const row = document.createElement('div');
        row.className = 'inn-stat-split-row';

        const head = document.createElement('div');
        head.className = 'inn-stat-split-head';
        const name = document.createElement('span');
        name.className = 'inn-stat-split-name';
        name.textContent = labelFn(entry.id);
        const value = document.createElement('span');
        value.className = 'inn-stat-split-value';
        value.textContent = `${czk(entry.revenue)} · ${entry.share.toLocaleString('cs-CZ')} %`;
        head.append(name, value);
        row.appendChild(head);

        const rail = document.createElement('div');
        rail.className = 'inn-stat-split-rail';
        const fill = document.createElement('div');
        fill.className = 'inn-stat-split-fill';
        fill.style.width = `${entry.share}%`;
        rail.appendChild(fill);
        row.appendChild(rail);

        if (onsiteNote && entry.id === 'onsite') {
            const note = document.createElement('p');
            note.className = 'inn-stat-split-note';
            note.textContent = onsiteNote;
            row.appendChild(note);
        }

        rows.appendChild(row);
    });

    return rows;
}

function buildPatternBlock(label, valueText) {
    const block = document.createElement('div');
    block.className = 'inn-stat-pattern-block';
    const l = document.createElement('div');
    l.className = 'inn-stat-pattern-label';
    l.textContent = label;
    const v = document.createElement('div');
    v.className = 'inn-stat-pattern-value';
    v.textContent = valueText;
    block.append(l, v);
    return block;
}

function buildSplitBlock(label, entries, labelFn, onsiteNote) {
    const block = document.createElement('div');
    block.className = 'inn-stat-pattern-block inn-stat-pattern-split';
    const l = document.createElement('div');
    l.className = 'inn-stat-pattern-label';
    l.textContent = label;
    block.appendChild(l);

    if (!entries || entries.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'inn-stat-empty';
        empty.textContent = 'Zatím žádné prodeje';
        block.appendChild(empty);
        return block;
    }

    block.appendChild(buildSplitRows(entries, labelFn, onsiteNote));
    return block;
}

function buildPatternsPanel(data) {
    const panel = document.createElement('div');
    panel.className = 'inn-stat-panel';

    const title = document.createElement('div');
    title.className = 'inn-stat-panel-title';
    title.textContent = 'Vzorce';
    panel.appendChild(title);

    const patterns = data.patterns || {};
    const grid = document.createElement('div');
    grid.className = 'inn-stat-patterns-grid';

    const bestWeekdayText = (patterns.bestWeekday === null || patterns.bestWeekday === undefined)
        ? '—' : WEEKDAYS[patterns.bestWeekday];
    const bestHourText = (patterns.bestHour === null || patterns.bestHour === undefined)
        ? '—' : `${patterns.bestHour}:00`;

    grid.appendChild(buildPatternBlock('Nejsilnější den', bestWeekdayText));
    grid.appendChild(buildPatternBlock('Nejsilnější hodina', bestHourText));
    grid.appendChild(buildSplitBlock('Podle kanálu', patterns.channels, id => CHANNEL_LABELS[id] || id));
    grid.appendChild(buildSplitBlock(
        'Podle platby', patterns.payments, id => PAYMENT_LABELS[id] || id,
        // "Onsite" here is genuinely "paid at the table/counter, no card or
        // online record" — not a data gap — see the module header note.
        'Uhrazeno na místě / u stolu — nejde o chybějící údaj, jen tyto platby nemají zaznamenanou platební metodu.'
    ));

    panel.appendChild(grid);
    return panel;
}

// ── refunds panel (Task 8 step 4) ────────────────────────────────────────

function refundReasonLabel(id) {
    if (id === 'none') return 'Bez důvodu';
    const found = REFUND_REASONS.find(r => r.id === id);
    return found ? found.label : id;
}

function renderReasonsList(container, reasons) {
    container.innerHTML = '';
    const list = reasons || [];
    if (list.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'inn-stat-empty';
        empty.textContent = 'Žádné důvody k zobrazení.';
        container.appendChild(empty);
        return;
    }
    list.forEach(r => {
        const row = document.createElement('div');
        row.className = 'inn-stat-reason-row';
        const label = document.createElement('span');
        label.className = 'inn-stat-reason-label';
        label.textContent = refundReasonLabel(r.id);
        const count = document.createElement('span');
        count.className = 'inn-stat-reason-count';
        count.textContent = String(r.count);
        row.append(label, count);
        container.appendChild(row);
    });
}

// Moves one order's contribution from `fromId`'s bucket to `toId`'s, in
// place, then re-sorts highest-first — mirrors buildRefunds()'s server-side
// sort (src/server/sales-stats.js) so the client-side update after a
// successful POST reflects the same ordering a refetch would have produced,
// without actually doing one (brief step 4: "update the reason breakdown
// without a full refetch").
function shiftRefundReasonCount(refunds, fromId, toId) {
    if (fromId === toId) return;
    const from = refunds.reasons.find(r => r.id === fromId);
    if (from) {
        from.count -= 1;
        if (from.count <= 0) refunds.reasons = refunds.reasons.filter(r => r !== from);
    }
    let to = refunds.reasons.find(r => r.id === toId);
    if (!to) {
        to = { id: toId, count: 0 };
        refunds.reasons.push(to);
    }
    to.count += 1;
    refunds.reasons.sort((a, b) => b.count - a.count);
}

// POSTs the label. Throws with a Czech message on failure so callers can
// show it via showToast directly. apiFetch (inner.js:108) already attaches
// the x-csrf-token header for POST and already toasts on 401/403 itself —
// this only needs to handle the "request went through but the server said
// no" (400/404) case with its own message.
async function submitRefundReason(orderId, reason, note) {
    const res = await apiFetch(`${API_URL}/orders/${orderId}/refund-reason`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason, note }),
    });
    if (!res.ok) {
        let msg = 'Nepodařilo se uložit důvod vrácení.';
        try {
            const body = await res.json();
            if (body && body.error) msg = body.error;
        } catch (_e) { /* non-JSON error body (e.g. the 401/403 case apiFetch already toasted) */ }
        throw new Error(msg);
    }
}

// One row of the refund orders table. `order.id` is null for a refunded
// TABLE-channel sale (see collectSales() in sales-stats.js — only delivery
// orders carry refundReason/refundNote/an orderId the /refund-reason route
// can look up); the select/note stay visible for those rows so the row is
// still legible, but disabled, since POSTing would 404 against an order
// that isn't in the orders collection at all.
function buildRefundOrderRow(order, refunds, reasonsListEl) {
    const tr = document.createElement('tr');

    const dateTd = document.createElement('td');
    const parsed = Date.parse(order.createdAt);
    dateTd.textContent = Number.isFinite(parsed)
        ? new Date(parsed).toLocaleString('cs-CZ', { dateStyle: 'short', timeStyle: 'short' })
        : '—';
    tr.appendChild(dateTd);

    const totalTd = document.createElement('td');
    totalTd.textContent = czk(order.total);
    tr.appendChild(totalTd);

    const itemsTd = document.createElement('td');
    itemsTd.textContent = (order.itemNames || []).join(', ') || '—';
    tr.appendChild(itemsTd);

    const reasonTd = document.createElement('td');
    const select = document.createElement('select');
    select.className = 'inn-stat-refund-select';
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = 'Vyberte důvod…';
    select.appendChild(blank);
    REFUND_REASONS.forEach(r => {
        const opt = document.createElement('option');
        opt.value = r.id;
        opt.textContent = r.label;
        select.appendChild(opt);
    });
    select.value = order.reason || '';
    reasonTd.appendChild(select);
    tr.appendChild(reasonTd);

    const noteTd = document.createElement('td');
    const noteInput = document.createElement('input');
    noteInput.type = 'text';
    noteInput.className = 'inn-stat-refund-note';
    noteInput.maxLength = 200;
    noteInput.placeholder = 'Poznámka';
    noteInput.value = order.note || '';
    noteTd.appendChild(noteInput);
    tr.appendChild(noteTd);

    const canLabel = order.id != null;
    if (!canLabel) {
        select.disabled = true;
        noteInput.disabled = true;
        select.title = 'U objednávek k rezervaci stolu nelze důvod vrácení upravit zde.';
        noteInput.title = select.title;
        return tr;
    }

    let previousReason = order.reason || '';

    select.addEventListener('change', async () => {
        const nextReason = select.value;
        if (!nextReason) {
            // The server requires a valid enum reason — a blank selection
            // is a UI-only "not yet labelled" state, never a submit target.
            select.value = previousReason;
            return;
        }
        select.disabled = true;
        noteInput.disabled = true;
        try {
            await submitRefundReason(order.id, nextReason, noteInput.value.trim());
            shiftRefundReasonCount(refunds, previousReason || 'none', nextReason);
            renderReasonsList(reasonsListEl, refunds.reasons);
            order.reason = nextReason;
            previousReason = nextReason;
            showToast('Důvod vrácení uložen.');
        } catch (e) {
            console.error(e);
            select.value = previousReason;
            showToast(e.message || 'Nepodařilo se uložit důvod vrácení.', true);
        } finally {
            select.disabled = false;
            noteInput.disabled = false;
        }
    });

    // Not spelled out by the brief (which only requires the select to POST),
    // but the note field would otherwise be write-only dead weight — persist
    // it too, using whatever reason is already saved. Only reachable once a
    // reason exists, since the server requires one on every POST.
    noteInput.addEventListener('change', async () => {
        if (!previousReason) return;
        const prevNote = order.note || '';
        select.disabled = true;
        noteInput.disabled = true;
        try {
            await submitRefundReason(order.id, previousReason, noteInput.value.trim());
            order.note = noteInput.value.trim() || null;
            showToast('Poznámka uložena.');
        } catch (e) {
            console.error(e);
            noteInput.value = prevNote;
            showToast(e.message || 'Nepodařilo se uložit poznámku.', true);
        } finally {
            select.disabled = false;
            noteInput.disabled = false;
        }
    });

    return tr;
}

function buildRefundOrdersTable(refunds, reasonsListEl) {
    const wrap = document.createElement('div');
    wrap.className = 'inn-bookings-table-wrap';
    const table = document.createElement('table');
    table.className = 'inn-bookings-table';
    const thead = document.createElement('thead');
    thead.innerHTML = '<tr><th>Datum</th><th>Částka</th><th>Položky</th><th>Důvod</th><th>Poznámka</th></tr>';
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    (refunds.orders || []).forEach(order => {
        tbody.appendChild(buildRefundOrderRow(order, refunds, reasonsListEl));
    });
    table.appendChild(tbody);

    wrap.appendChild(table);
    return wrap;
}

// Whole panel is hidden (returns null) when refunds.count === 0 — an empty
// refunds panel would just be noise (brief step 4).
function buildRefundsPanel(data) {
    const refunds = data.refunds;
    if (!refunds || !refunds.count) return null;

    const panel = document.createElement('div');
    panel.className = 'inn-stat-panel';

    const title = document.createElement('div');
    title.className = 'inn-stat-panel-title';
    title.textContent = 'Vrácené platby';
    panel.appendChild(title);

    const stats = document.createElement('div');
    stats.className = 'inn-stat-refund-stats';
    [
        ['Vráceno celkem', czk(refunds.total)],
        ['Počet vrácení', Number(refunds.count).toLocaleString('cs-CZ')],
        ['Podíl na tržbách', `${refunds.rate.toLocaleString('cs-CZ')} %`],
    ].forEach(([label, value]) => {
        const stat = document.createElement('div');
        stat.className = 'inn-stat-refund-stat';
        const l = document.createElement('div');
        l.className = 'inn-stat-refund-stat-label';
        l.textContent = label;
        const v = document.createElement('div');
        v.className = 'inn-stat-refund-stat-value';
        v.textContent = value;
        stat.append(l, v);
        stats.appendChild(stat);
    });
    panel.appendChild(stats);

    // A GoPay refund is always whole-order, never per-item — this list is
    // co-occurrence ("how often did this item appear on a refunded order"),
    // not per-item attribution, and is titled + captioned to say exactly
    // that so nobody reads it as "these items were refunded".
    const itemsTitle = document.createElement('div');
    itemsTitle.className = 'inn-stat-subtitle';
    itemsTitle.textContent = 'Položky ve vrácených objednávkách';
    panel.appendChild(itemsTitle);

    const itemsNote = document.createElement('p');
    itemsNote.className = 'inn-stat-note';
    itemsNote.textContent = 'Platba se vrací vždy za celou objednávku, nikdy za jednotlivou položku — jde tedy o to, jak často se položka vyskytla ve vrácené objednávce, ne o to, že by byla vrácena samotná položka.';
    panel.appendChild(itemsNote);

    if ((refunds.topItems || []).length === 0) {
        const empty = document.createElement('p');
        empty.className = 'inn-stat-empty';
        empty.textContent = 'Žádné položky k zobrazení.';
        panel.appendChild(empty);
    } else {
        panel.appendChild(buildRankList(refunds.topItems, item => `${item.count}×`, item => item.count));
    }

    const reasonsTitle = document.createElement('div');
    reasonsTitle.className = 'inn-stat-subtitle';
    reasonsTitle.textContent = 'Důvody vrácení';
    panel.appendChild(reasonsTitle);

    const reasonsListEl = document.createElement('div');
    reasonsListEl.className = 'inn-stat-reasons-list';
    renderReasonsList(reasonsListEl, refunds.reasons);
    panel.appendChild(reasonsListEl);

    const ordersTitle = document.createElement('div');
    ordersTitle.className = 'inn-stat-subtitle';
    ordersTitle.textContent = 'Seznam vrácených objednávek';
    panel.appendChild(ordersTitle);

    panel.appendChild(buildRefundOrdersTable(refunds, reasonsListEl));

    return panel;
}

// ── item table (Task 8 step 5) ───────────────────────────────────────────

function buildItemsTable(data) {
    const panel = document.createElement('div');
    panel.className = 'inn-stat-panel';

    const title = document.createElement('div');
    title.className = 'inn-stat-panel-title';
    title.textContent = 'Prodané položky';
    panel.appendChild(title);

    const caption = document.createElement('p');
    caption.className = 'inn-stat-note';
    caption.textContent = 'Počty zahrnují i vrácené objednávky. Tržba je za jednotlivou položku (cena × počet), takže se nemusí shodovat s celkovou tržbou nahoře, která navíc zahrnuje poplatky za dopravu.';
    panel.appendChild(caption);

    const items = data.items || [];
    if (items.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'inn-stat-empty';
        empty.textContent = 'Zatím žádné prodeje v tomto období.';
        panel.appendChild(empty);
        return panel;
    }

    const wrap = document.createElement('div');
    wrap.className = 'inn-bookings-table-wrap';
    const table = document.createElement('table');
    table.className = 'inn-bookings-table';
    const thead = document.createElement('thead');
    thead.innerHTML = '<tr><th>#</th><th>Položka</th><th>Prodáno (ks)</th><th>Tržba</th></tr>';
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    items.forEach((item, idx) => {
        const tr = document.createElement('tr');
        const rankTd = document.createElement('td');
        rankTd.textContent = String(idx + 1);
        const nameTd = document.createElement('td');
        nameTd.textContent = item.name;
        const countTd = document.createElement('td');
        countTd.textContent = Number(item.count || 0).toLocaleString('cs-CZ');
        const revenueTd = document.createElement('td');
        revenueTd.textContent = czk(item.revenue);
        tr.append(rankTd, nameTd, countTd, revenueTd);
        tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    wrap.appendChild(table);
    panel.appendChild(wrap);
    return panel;
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

    // Scope note: which sales this whole screen counts. Restores a note an
    // earlier task dropped that named only two of the three channels
    // (rozvoz + rezervace stolu) and silently omitted walk-in/indoor sales —
    // wrong, because every figure on this screen already includes all three;
    // see collectSales() in src/server/sales-stats.js for the source of
    // truth ("delivery", "table", "indoor").
    const scopeNote = document.createElement('p');
    scopeNote.className = 'inn-stat-scope-note';
    scopeNote.textContent = 'Zahrnuje jídlo objednané k rozvozu, k rezervaci stolu i prodej na místě.';
    container.appendChild(scopeNote);

    container.appendChild(buildPeriodSwitcher());
    container.appendChild(buildChartCard(data));
    container.appendChild(buildKpiRow(data));
    container.appendChild(buildRankingsRow(data));
    container.appendChild(buildNeverSoldPanel(data));
    container.appendChild(buildPatternsPanel(data));
    const refundsPanel = buildRefundsPanel(data);
    if (refundsPanel) container.appendChild(refundsPanel);
    container.appendChild(buildItemsTable(data));

    await renderReceiptsPanel(container);
}
