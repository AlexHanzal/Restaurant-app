// ════════════════════════════════════════════════════════════════════════
// KITCHEN BOARD — shows every order that currently exists, split into two
// rows: food ordered alongside a table reservation ("indoor") and food
// ordered for delivery ("delivery"). Each card just gets Complete + Remove.
//
// Indoor orders live embedded inside a timetable's booking grid (the same
// order payload gets written into every hour slot a reservation occupies),
// so the server groups consecutive matching hours into one order and hands
// back a stable id plus fileId/dateStr/dayIndex/startHour/endHour — that's
// what we send back to mark it complete or remove it.
// ════════════════════════════════════════════════════════════════════════

const API_BASE_URL = window.API_BASE_URL || `http://${window.location.hostname}:3000`;
const API_URL = `${API_BASE_URL}/reservation/api`;

// hourIndex 1-12 -> "8:00-9:00", "9:00-10:00", ... (matches renderer.js)
const HOUR_SLOTS = [
    '8:00-9:00', '9:00-10:00', '10:00-11:00', '11:00-12:00',
    '12:00-13:00', '13:00-14:00', '14:00-15:00', '15:00-16:00',
    '16:00-17:00', '17:00-18:00', '18:00-19:00', '19:00-20:00'
];

let board = { indoor: [], delivery: [] };
let pollHandle = null;
let boardStream = null; // EventSource — see startBoardStream() below

// ── UTIL ─────────────────────────────────────────────────────────────────

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str ?? '';
    return div.innerHTML;
}

function escapeHtmlAttr(str) {
    return (str ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function showToast(msg, isError = false) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className = 'ds-toast show' + (isError ? ' error' : '');
    setTimeout(() => t.classList.remove('show'), 2400);
}

function formatPrice(n) {
    return `${Number(n || 0).toFixed(0)} Kč`;
}

function timeRangeLabel(startHour, endHour) {
    if (!startHour || !endHour) return null;
    const start = HOUR_SLOTS[startHour - 1]?.split('-')[0] || '?';
    const end = HOUR_SLOTS[endHour - 1]?.split('-')[1] || '?';
    return `${start}–${end}`;
}

function formatTime(iso) {
    try {
        const d = new Date(iso);
        return d.toLocaleString('cs-CZ', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    } catch { return ''; }
}

// ── AGE TIMER ────────────────────────────────────────────────────────────
// "● N min" since the order was created — left border + timer color flip to
// --ds-accent once a ticket has been sitting for OVERDUE_MINUTES or more.
// Only orders that carry a createdAt timestamp get a timer (delivery orders
// and walk-in table orders always do; reservation-embedded food orders
// don't record one server-side, so those tickets render without a timer
// rather than showing a misleading time).
const OVERDUE_MINUTES = 10;

function ageMinutes(iso) {
    if (!iso) return null;
    const created = new Date(iso).getTime();
    if (Number.isNaN(created)) return null;
    return Math.max(0, Math.floor((Date.now() - created) / 60000));
}

function timerBadgeHtml(iso) {
    const mins = ageMinutes(iso);
    if (mins === null) return '';
    const overdue = mins >= OVERDUE_MINUTES;
    return `<span class="kit-ticket__timer${overdue ? ' kit-ticket__timer--overdue' : ''}">● ${mins} min</span>`;
}

// Live wall clock in the header, ticking every second — a wall-tablet board
// should never look frozen.
function tickClock() {
    const el = document.getElementById('kitClock');
    if (el) el.textContent = new Date().toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// SECURITY (3rd hardening pass): CSRF token for state-changing calls
// (kitchen-status / remove) — same scheme as inner.js, see that file's
// header comment on ensureCsrfToken() for the full reasoning. Fetched from
// GET /api/csrf-token and cached; cleared on 403 so a stale token self-heals
// on the next attempt.
let cachedCsrfToken = null;

async function ensureCsrfToken() {
    if (cachedCsrfToken) return cachedCsrfToken;
    try {
        const res = await fetch(`${API_URL}/csrf-token`, { credentials: 'include' });
        if (res.ok) {
            const data = await res.json();
            cachedCsrfToken = data.csrfToken || null;
        }
    } catch (e) { /* apiFetch proceeds without the header; server 403s and this retries next call */ }
    return cachedCsrfToken;
}

const CSRF_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);

// This screen has no login form of its own — it's meant to sit on a kitchen
// tablet where staff already signed in once via /admin (or /driver) in the
// same browser, and the session cookie just carries over. If that cookie is
// missing/expired, surface it clearly instead of actions silently failing.
async function apiFetch(url, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    if (CSRF_METHODS.has(method)) {
        const token = await ensureCsrfToken();
        options = { ...options, headers: { ...(options.headers || {}), 'x-csrf-token': token || '' } };
    }

    const res = await fetch(url, { ...options, credentials: 'include' });
    if (res.status === 401) {
        showToast('Přihlášení vypršelo. Přihlaste se prosím na /admin v tomto prohlížeči.', true);
    } else if (res.status === 403) {
        cachedCsrfToken = null;
        showToast('Nemáte oprávnění k této akci.', true);
    }
    return res;
}

// ── DATA LOADING ─────────────────────────────────────────────────────────

async function fetchBoard() {
    try {
        const res = await fetch(`${API_URL}/kitchen/orders`, { credentials: 'include' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        board = await res.json();
        renderBoard();
        document.getElementById('lastUpdatedText').textContent =
            `Aktualizováno ${new Date().toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' })}`;
    } catch (e) {
        console.error('Failed to load kitchen board:', e);
    }
}

function startPolling() {
    fetchBoard();
    stopPolling();
    pollHandle = setInterval(fetchBoard, 5000);
}
function stopPolling() {
    if (pollHandle) clearInterval(pollHandle);
    pollHandle = null;
}

// ── LIVE UPDATES (SSE) ───────────────────────────────────────────────────
// The board used to poll every 5s no matter what. Now it opens a
// Server-Sent Events connection to <API_URL>/events/board and refetches
// only when the server says something changed (order placed/completed/
// removed) — the 5s polling above becomes just a fallback for whenever the
// stream can't connect or drops (old browser, network blip, server
// restart, ...). Worst case is exactly today's always-poll behavior.
function startBoardStream(refetchFn) {
    if (typeof EventSource === 'undefined') {
        // Very old browser, no SSE support at all — just poll like before.
        startPolling();
        return;
    }

    stopBoardStream();
    // withCredentials so the same session cookie the fetch() calls above
    // send along (credentials: 'include') also rides along on the stream.
    boardStream = new EventSource(`${API_URL}/events/board`, { withCredentials: true });

    boardStream.onopen = () => {
        // (Re)connected — fallback polling isn't needed anymore, and do one
        // refetch in case something changed while we were disconnected.
        if (pollHandle) stopPolling();
        refetchFn();
    };

    boardStream.onmessage = () => {
        // Payload is just `{"type":"orders-changed"}` — no need to parse
        // it, any message here just means "go refetch the board".
        refetchFn();
    };

    boardStream.onerror = () => {
        // EventSource retries the connection on its own; meanwhile make
        // sure the board doesn't go stale by falling back to polling.
        // Guarded so a flurry of reconnect attempts never starts a second
        // interval on top of an already-running one.
        if (!pollHandle) startPolling();
    };
}

function stopBoardStream() {
    if (boardStream) {
        boardStream.close();
        boardStream = null;
    }
}

// ── RENDER ───────────────────────────────────────────────────────────────

function renderBoard() {
    renderIndoorRow();
    renderDeliveryRow();
}

function renderIndoorRow() {
    const container = document.getElementById('indoorOrders');
    const countEl = document.getElementById('indoorCount');
    container.innerHTML = '';

    const orders = board.indoor || [];
    countEl.textContent = orders.length ? `${orders.length}` : '';

    if (orders.length === 0) {
        container.innerHTML = '<div class="ds-empty">Žádné objednávky u stolu.</div>';
        return;
    }

    orders.forEach(order => container.appendChild(renderIndoorCard(order)));
}

function renderIndoorCard(order) {
    const isDone = order.kitchenStatus === 'completed';
    const overdue = (ageMinutes(order.createdAt) ?? 0) >= OVERDUE_MINUTES;
    const card = document.createElement('div');
    card.className = 'ds-card kit-ticket' + (overdue && !isDone ? ' kit-ticket--overdue' : '') + (isDone ? ' kit-ticket--done' : '');

    const itemsHtml = (order.order || []).map(item => `
        <li class="kit-ticket__item">
            <span><span class="kit-ticket__qty">${item.qty}×</span>${escapeHtml(item.item)}</span>
            <span class="kit-ticket__item-price">${formatPrice(item.price * item.qty)}</span>
        </li>
    `).join('');

    const subLabel = order.kind === 'walkin'
        ? `Objednáno u stolu · ${formatTime(order.createdAt)}`
        : `${escapeHtml(order.dateStr)} · ${timeRangeLabel(order.startHour, order.endHour) || '?'}`;

    // Table QR self-order (plan Task 6, spec §8.4). `source` is normalised
    // server-side to "staff"|"qr" on every row of this board's `indoor`
    // array — but rows that predate this feature still round-trip through
    // here with no `source` at all, so the guard is an explicit '==='
    // rather than a truthy check: `undefined === 'qr'` is false, which is
    // exactly "render like today" for legacy orders and waiter-placed ones.
    const qrBadge = order.source === 'qr' ? `<span class="ds-badge ds-badge--qr">QR</span>` : '';

    card.innerHTML = `
        <div class="kit-ticket__top">
            <div>
                <div class="kit-ticket__source">${escapeHtml(order.tableName)}${order.guestName ? ' — ' + escapeHtml(order.guestName) : ''} ${qrBadge}</div>
                <div class="kit-ticket__sub">${subLabel}</div>
            </div>
            ${timerBadgeHtml(order.createdAt)}
        </div>
        <ul class="kit-ticket__items">
            ${itemsHtml}
        </ul>
        <div class="kit-ticket__total">
            <span>Celkem</span>
            <span>${formatPrice(order.orderTotal)}</span>
        </div>
        ${order.note ? `<div class="kit-ticket__note">Poznámka: ${escapeHtml(order.note)}</div>` : ''}
        <div class="kit-ticket__footer">
            <button class="ds-btn ds-btn--ghost kit-ticket__remove" type="button" title="Odstranit objednávku" aria-label="Odstranit objednávku">🗑️</button>
            <button class="ds-btn ${isDone ? 'ds-btn--success' : 'ds-btn--primary'} ds-btn--block kit-ticket__action" type="button" ${isDone ? 'disabled' : ''}>${isDone ? 'HOTOVO ✓' : 'Začít připravovat'}</button>
        </div>
    `;

    if (!isDone) {
        card.querySelector('.kit-ticket__action').addEventListener('click', () => completeIndoorOrder(order));
    }
    card.querySelector('.kit-ticket__remove').addEventListener('click', () => removeIndoorOrder(order));

    return card;
}

function renderDeliveryRow() {
    const container = document.getElementById('deliveryOrders');
    const countEl = document.getElementById('deliveryCount');
    container.innerHTML = '';

    const orders = board.delivery || [];
    countEl.textContent = orders.length ? `${orders.length}` : '';

    if (orders.length === 0) {
        container.innerHTML = '<div class="ds-empty">Žádné objednávky k rozvozu.</div>';
        return;
    }

    orders.forEach(order => container.appendChild(renderDeliveryCard(order)));
}

function renderDeliveryCard(order) {
    const isDone = order.kitchenStatus === 'completed';
    const overdue = (ageMinutes(order.createdAt) ?? 0) >= OVERDUE_MINUTES;
    const card = document.createElement('div');
    card.className = 'ds-card kit-ticket' + (overdue && !isDone ? ' kit-ticket--overdue' : '') + (isDone ? ' kit-ticket--done' : '');

    const itemsHtml = (order.items || []).map(item => `
        <li class="kit-ticket__item">
            <span><span class="kit-ticket__qty">${item.qty}×</span>${escapeHtml(item.name)}</span>
            <span class="kit-ticket__item-price">${formatPrice(item.price * item.qty)}</span>
        </li>
    `).join('');

    // Payment state is only ever exposed here for delivery orders (the
    // /kitchen/orders response hands back the raw order record for those) —
    // indoor tickets don't carry paymentStatus, so no badge is rendered for
    // them at all, per spec (§6: "paid badge only where the API already
    // provides payment state").
    const paidBadge = order.paymentMethod
        ? `<span class="ds-badge ${order.paymentStatus === 'paid' ? 'ds-badge--paid' : 'ds-badge--unpaid'}">${order.paymentStatus === 'paid' ? 'Zaplaceno' : 'Nezaplaceno'}</span>`
        : '';
    const paymentLabel = order.paymentMethod === 'cash' ? 'hotově'
        : order.paymentMethod === 'card_on_delivery' ? 'kartou při doručení'
        : order.paymentMethod === 'online_card' ? 'online' : '';

    card.innerHTML = `
        <div class="kit-ticket__top">
            <div>
                <div class="kit-ticket__source">Rozvoz — ${escapeHtml(order.customerName)}</div>
                <div class="kit-ticket__sub">📍 ${escapeHtml(order.address)}</div>
            </div>
            ${timerBadgeHtml(order.createdAt)}
        </div>
        ${order.phone ? `<a class="ds-btn ds-btn--ghost kit-ticket__call" href="tel:${escapeHtmlAttr(order.phone)}">📞 Zavolat</a>` : ''}
        <ul class="kit-ticket__items">
            ${itemsHtml}
        </ul>
        <div class="kit-ticket__total">
            <span>Celkem</span>
            <span>${formatPrice(order.total)}</span>
        </div>
        ${order.note ? `<div class="kit-ticket__note">Poznámka: ${escapeHtml(order.note)}</div>` : ''}
        ${paidBadge ? `<div class="kit-ticket__badges">${paidBadge}<span class="kit-ticket__note">${paymentLabel}</span></div>` : ''}
        <div class="kit-ticket__footer">
            <button class="ds-btn ds-btn--ghost kit-ticket__remove" type="button" title="Odstranit objednávku" aria-label="Odstranit objednávku">🗑️</button>
            <button class="ds-btn ${isDone ? 'ds-btn--success' : 'ds-btn--primary'} ds-btn--block kit-ticket__action" type="button" ${isDone ? 'disabled' : ''}>${isDone ? 'HOTOVO ✓' : 'Začít připravovat'}</button>
        </div>
    `;

    if (!isDone) {
        card.querySelector('.kit-ticket__action').addEventListener('click', () => completeDeliveryOrder(order));
    }
    card.querySelector('.kit-ticket__remove').addEventListener('click', () => removeDeliveryOrder(order));

    return card;
}

// ── ACTIONS ──────────────────────────────────────────────────────────────

async function completeIndoorOrder(order) {
    try {
        const res = order.kind === 'walkin'
            ? await apiFetch(`${API_URL}/indoor-orders/${order.id}/kitchen-status`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: 'completed' })
            })
            : await apiFetch(`${API_URL}/kitchen/indoor/status`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    fileId: order.fileId,
                    dateStr: order.dateStr,
                    dayIndex: order.dayIndex,
                    startHour: order.startHour,
                    endHour: order.endHour,
                    status: 'completed'
                })
            });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        showToast('Objednávka označena jako hotová');
        await fetchBoard();
    } catch (e) {
        console.error(e);
        showToast('Nepodařilo se označit objednávku', true);
    }
}

async function removeIndoorOrder(order) {
    const label = order.guestName ? `„${order.guestName}“ (${order.tableName})` : order.tableName;
    if (!confirm(`Odstranit objednávku jídla pro ${label}?`)) return;
    try {
        const res = order.kind === 'walkin'
            ? await apiFetch(`${API_URL}/indoor-orders/${order.id}`, { method: 'DELETE' })
            : await apiFetch(`${API_URL}/kitchen/indoor/remove`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    fileId: order.fileId,
                    dateStr: order.dateStr,
                    dayIndex: order.dayIndex,
                    startHour: order.startHour,
                    endHour: order.endHour
                })
            });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        showToast('Objednávka odstraněna');
        await fetchBoard();
    } catch (e) {
        console.error(e);
        showToast('Nepodařilo se odstranit objednávku', true);
    }
}

async function completeDeliveryOrder(order) {
    try {
        const res = await apiFetch(`${API_URL}/orders/${order.id}/kitchen-status`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'completed' })
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        showToast('Objednávka označena jako hotová');
        await fetchBoard();
    } catch (e) {
        console.error(e);
        showToast('Nepodařilo se označit objednávku', true);
    }
}

async function removeDeliveryOrder(order) {
    if (!confirm(`Odstranit objednávku od „${order.customerName}“?`)) return;
    try {
        const res = await apiFetch(`${API_URL}/orders/${order.id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        showToast('Objednávka odstraněna');
        await fetchBoard();
    } catch (e) {
        console.error(e);
        showToast('Nepodařilo se odstranit objednávku', true);
    }
}

// ── INIT ─────────────────────────────────────────────────────────────────

tickClock();
setInterval(tickClock, 1000);
// Age timers ("● N min") tick up between the 5s data polls too, so a ticket
// sitting untouched visibly ages/flips to accent color without waiting on
// fresh data from the server.
setInterval(renderBoard, 20000);

startBoardStream(fetchBoard);
