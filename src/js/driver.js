// ════════════════════════════════════════════════════════════════════════
// DRIVER PORTAL — login, then view + claim delivery orders.
// Orders are created by customers on /delivery (POST /orders) and sit as
// "pending" until a driver claims one (POST /orders/:id/claim). The server
// re-checks status right before writing, so if two drivers tap "Vyzvednout"
// on the same order at nearly the same time, only the first one wins — the
// second gets a 409 and this page just refreshes the list to show it's gone.
//
// Rendering: a single "Moje rozvozy" feed instead of separate tabs — orders
// this driver could claim are mixed in with orders already claimed by them,
// distinguished by card styling (see renderOrderCard). Orders claimed by a
// *different* driver are filtered out entirely, same privacy boundary the
// old two-tab UI had (a driver never sees another driver's customer PII).
// ════════════════════════════════════════════════════════════════════════

const API_BASE_URL = window.API_BASE_URL || `http://${window.location.hostname}:3000`;
const API_URL = `${API_BASE_URL}/reservation/api`;

const SESSION_KEY = 'drv_session_driver';
let currentDriver = null; // { id, name, username }
let orders = [];
let pollHandle = null;
let ordersStream = null; // EventSource — see startBoardStream() below

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
    setTimeout(() => t.classList.remove('show'), 2600);
}

function formatPrice(n) {
    return `${Number(n || 0).toFixed(0)} Kč`;
}

function formatTime(iso) {
    try {
        const d = new Date(iso);
        return d.toLocaleString('cs-CZ', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    } catch { return ''; }
}

// Orders don't carry a short human ticket number — build a stable, readable
// "#XXXX" tag from the tail of the generated order id (same id used for
// every API call), just for quick verbal reference ("máš tam objednávku
// eF3B?") between kitchen/driver.
function shortOrderTag(order) {
    return `#${(order.id || '').slice(-4).toUpperCase()}`;
}

// SECURITY (3rd hardening pass): CSRF token for state-changing calls (here,
// mainly POST /orders/:id/claim) — same scheme as inner.js, see that file's
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

// Attaches the auth cookie + CSRF header to every API call and drops back
// to the login gate if the session is missing/expired, instead of orders
// just silently failing to load/claim.
async function apiFetch(url, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    if (CSRF_METHODS.has(method)) {
        const token = await ensureCsrfToken();
        options = { ...options, headers: { ...(options.headers || {}), 'x-csrf-token': token || '' } };
    }

    const res = await fetch(url, { ...options, credentials: 'include' });
    if (res.status === 401) {
        setSession(null);
        stopBoardStream();
        stopPolling();
        showLoginGate();
        showToast('Přihlášení vypršelo, přihlaste se prosím znovu.', true);
    } else if (res.status === 403) {
        cachedCsrfToken = null;
        showToast('Nemáte oprávnění k této akci.', true);
    }
    return res;
}

// ── SESSION ──────────────────────────────────────────────────────────────

function getSession() {
    try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); } catch { return null; }
}

function setSession(driver) {
    currentDriver = driver;
    if (driver) sessionStorage.setItem(SESSION_KEY, JSON.stringify(driver));
    else sessionStorage.removeItem(SESSION_KEY);
    applySessionToUI();
}

function applySessionToUI() {
    document.getElementById('loggedInDriverText').textContent = currentDriver ? `Řidič: ${currentDriver.name}` : '';
    document.getElementById('logoutBtn').classList.toggle('drv-hidden', !currentDriver);
}

function showLoginGate() {
    document.getElementById('loginGateOverlay').classList.remove('drv-hidden');
    document.getElementById('loginUsernameInput').value = '';
    document.getElementById('loginPasswordInput').value = '';
    document.getElementById('loginError').classList.remove('show');
    setTimeout(() => document.getElementById('loginUsernameInput').focus(), 50);
}

function hideLoginGate() {
    document.getElementById('loginGateOverlay').classList.add('drv-hidden');
}

async function attemptLogin() {
    const username = document.getElementById('loginUsernameInput').value.trim();
    const password = document.getElementById('loginPasswordInput').value;
    const errorEl = document.getElementById('loginError');
    errorEl.classList.remove('show');

    if (!username || !password) {
        errorEl.textContent = 'Vyplňte jméno i heslo.';
        errorEl.classList.add('show');
        return;
    }

    try {
        // Drivers now log in with the same accounts created in the admin
        // panel (Uživatelé) — the account just needs "Řidič" checked there.
        const res = await fetch(`${API_URL}/users/login`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ abbreviation: username, password })
        });
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            errorEl.textContent = data.error === 'Invalid password' ? 'Nesprávné heslo.'
                : data.error === 'User not found' ? 'Účet nenalezen.'
                : 'Přihlášení se nezdařilo.';
            errorEl.classList.add('show');
            return;
        }
        const account = await res.json();
        if (!account.isDriver) {
            errorEl.textContent = 'Tento účet nemá oprávnění řidiče. Požádejte administrátora, aby ho v sekci Uživatelé označil jako řidiče.';
            errorEl.classList.add('show');
            return;
        }
        const driver = { id: account.id, name: account.name, username: account.abbreviation };
        setSession(driver);
        hideLoginGate();
        showToast(`Přihlášen jako ${driver.name}`);
        startBoardStream(fetchOrders);
    } catch (e) {
        errorEl.textContent = 'Nepodařilo se spojit se serverem.';
        errorEl.classList.add('show');
    }
}

function logout() {
    setSession(null);
    stopBoardStream();
    stopPolling();
    showLoginGate();
}

document.getElementById('loginSubmitBtn').addEventListener('click', attemptLogin);
document.getElementById('loginUsernameInput').addEventListener('keypress', e => { if (e.key === 'Enter') attemptLogin(); });
document.getElementById('loginPasswordInput').addEventListener('keypress', e => { if (e.key === 'Enter') attemptLogin(); });
document.getElementById('logoutBtn').addEventListener('click', logout);

// ── ORDERS ───────────────────────────────────────────────────────────────

async function fetchOrders() {
    try {
        const res = await apiFetch(`${API_URL}/orders`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        orders = await res.json();
        renderOrders();
    } catch (e) {
        console.error('Failed to load orders:', e);
    }
}

function startPolling() {
    fetchOrders();
    stopPolling();
    pollHandle = setInterval(fetchOrders, 5000);
}

function stopPolling() {
    if (pollHandle) clearInterval(pollHandle);
    pollHandle = null;
}

// ── LIVE UPDATES (SSE) ───────────────────────────────────────────────────
// Orders used to be polled every 5s no matter what, for as long as a driver
// stayed logged in. Now the feed opens a Server-Sent Events connection to
// <API_URL>/events/board and only refetches when the server says something
// changed (order placed/claimed/completed/paid) — the 5s polling above
// becomes just a fallback for whenever the stream can't connect or drops
// (old browser, network blip, server restart, ...). Worst case is exactly
// today's always-poll behavior. Started on login (or on init if a session
// is already stored), stopped on logout/401 alongside the polling fallback.
function startBoardStream(refetchFn) {
    if (typeof EventSource === 'undefined') {
        // Very old browser, no SSE support at all — just poll like before.
        startPolling();
        return;
    }

    stopBoardStream();
    // withCredentials so the same session cookie the apiFetch() calls above
    // send along (credentials: 'include') also rides along on the stream.
    ordersStream = new EventSource(`${API_URL}/events/board`, { withCredentials: true });

    ordersStream.onopen = () => {
        // (Re)connected — fallback polling isn't needed anymore, and do one
        // refetch in case something changed while we were disconnected.
        if (pollHandle) stopPolling();
        refetchFn();
    };

    ordersStream.onmessage = () => {
        // Payload is just `{"type":"orders-changed"}` — no need to parse
        // it, any message here just means "go refetch the orders".
        refetchFn();
    };

    ordersStream.onerror = () => {
        // EventSource retries the connection on its own; meanwhile make
        // sure the list doesn't go stale by falling back to polling.
        // Guarded so a flurry of reconnect attempts never starts a second
        // interval on top of an already-running one.
        if (!pollHandle) startPolling();
    };
}

function stopBoardStream() {
    if (ordersStream) {
        ordersStream.close();
        ordersStream = null;
    }
}

function renderOrders() {
    const container = document.getElementById('ordersList');
    container.innerHTML = '';

    // Same visibility rule the old "available" + "mine" tabs enforced
    // together: an order this driver can act on (still unclaimed) or
    // already claimed by them. Another driver's claimed order never shows.
    const visible = orders.filter(o => o.status === 'pending' || o.claimedBy === currentDriver?.id);

    if (visible.length === 0) {
        container.innerHTML = '<div class="ds-empty drv-empty-wrap">Momentálně nemáte žádné rozvozy.</div>';
        return;
    }

    visible.forEach(order => container.appendChild(renderOrderCard(order)));
}

function renderOrderCard(order) {
    const mine = order.claimedBy === currentDriver?.id;
    const ready = order.kitchenStatus === 'completed';
    // Not claimed yet and the kitchen hasn't finished preparing it — nothing
    // for a driver to do here yet, so the card is greyed and inert.
    const queued = !mine && !ready;

    const card = document.createElement('div');
    card.className = 'ds-card drv-order' + (mine ? ' drv-order--mine' : '') + (queued ? ' drv-order--queued' : '');

    const mapsUrl = `https://maps.google.com/?q=${encodeURIComponent(order.address || '')}`;

    let bodyHtml = `
        <div class="drv-order__top">
            <div class="drv-order__id">${shortOrderTag(order)} · ${escapeHtml(order.customerName)}</div>
            <span class="drv-order__time">${formatTime(order.createdAt)}</span>
        </div>
        <div class="drv-order__address">📍 ${escapeHtml(order.address)}${order.psc ? ` (PSČ ${escapeHtml(order.psc)})` : ''}</div>
    `;

    if (queued) {
        bodyHtml += `<div class="drv-order__queued">⏳ čeká v kuchyni…</div>`;
        card.innerHTML = bodyHtml;
        return card;
    }

    bodyHtml += `
        <div class="drv-order__actions-row">
            ${order.phone ? `<a class="ds-btn ds-btn--ghost" href="tel:${escapeHtmlAttr(order.phone)}">📞 Volat</a>` : ''}
            <a class="ds-btn ds-btn--ghost" href="${escapeHtmlAttr(mapsUrl)}" target="_blank" rel="noopener noreferrer">🗺 Navigovat</a>
        </div>
        <div class="drv-order__meta">
            <span class="drv-order__price">${formatPrice(order.total)} · ${paymentMethodLabel(order)}</span>
            ${order.paymentStatus !== 'paid' ? '<span class="ds-badge ds-badge--unpaid">Nezaplaceno</span>' : ''}
        </div>
        ${order.note ? `<div class="drv-order__note">Poznámka: ${escapeHtml(order.note)}</div>` : ''}
    `;

    card.innerHTML = bodyHtml;

    if (!mine) {
        const claimBtn = document.createElement('button');
        claimBtn.type = 'button';
        claimBtn.className = 'ds-btn ds-btn--primary ds-btn--block';
        claimBtn.textContent = 'Vyzvednout objednávku';
        claimBtn.addEventListener('click', () => claimOrder(order.id, claimBtn));
        card.appendChild(claimBtn);
    } else if (order.paymentMethod !== 'online_card' && order.paymentStatus !== 'paid') {
        // Cash / card-on-delivery: driver confirms delivery + payment collected
        // on handoff in one tap. Online-card orders are settled by the
        // gateway already, so they fall through to the "done" state below.
        const payBtn = document.createElement('button');
        payBtn.type = 'button';
        payBtn.className = 'ds-btn ds-btn--success ds-btn--block';
        payBtn.textContent = 'Doručeno + zaplaceno ✓';
        payBtn.addEventListener('click', () => markOrderPaid(order.id, payBtn));
        card.appendChild(payBtn);
    } else {
        const done = document.createElement('div');
        done.className = 'drv-order__done';
        done.textContent = '✓ Doručeno a zaplaceno';
        card.appendChild(done);
    }

    return card;
}

function paymentMethodLabel(order) {
    const labels = { cash: '💵 hotově', card_on_delivery: '💳 kartou při doručení', online_card: '🌐 zaplaceno online' };
    return labels[order.paymentMethod] || '';
}

async function markOrderPaid(orderId, buttonEl) {
    buttonEl.disabled = true;
    buttonEl.textContent = 'Ukládám…';
    try {
        const res = await apiFetch(`${API_URL}/orders/${orderId}/mark-paid`, { method: 'POST' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        showToast('Doručeno a zaplaceno');
        await fetchOrders();
    } catch (e) {
        console.error(e);
        showToast('Nepodařilo se zaznamenat platbu', true);
        buttonEl.disabled = false;
        buttonEl.textContent = 'Doručeno + zaplaceno ✓';
    }
}

async function claimOrder(orderId, buttonEl) {
    buttonEl.disabled = true;
    buttonEl.textContent = 'Přebírám…';

    try {
        const res = await apiFetch(`${API_URL}/orders/${orderId}/claim`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ driverId: currentDriver.id, driverName: currentDriver.name })
        });
        const result = await res.json();

        if (res.status === 409) {
            showToast('Tuto objednávku už převzal jiný řidič.', true);
            await fetchOrders();
            return;
        }
        if (!res.ok) throw new Error(result.error || 'Nepodařilo se převzít objednávku');

        showToast('Objednávka převzata!');
        await fetchOrders();
    } catch (e) {
        console.error(e);
        showToast(e.message || 'Nepodařilo se převzít objednávku', true);
        buttonEl.disabled = false;
        buttonEl.textContent = 'Vyzvednout objednávku';
    }
}

// ── INIT ─────────────────────────────────────────────────────────────────

(function init() {
    const session = getSession();
    if (session) {
        setSession(session);
        hideLoginGate();
        startBoardStream(fetchOrders);
    } else {
        showLoginGate();
    }
})();
