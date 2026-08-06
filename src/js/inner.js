// ════════════════════════════════════════════════════════════════════════
// CONFIG / STATE
// ════════════════════════════════════════════════════════════════════════

const urlParams = new URLSearchParams(window.location.search);
let API_BASE_URL = urlParams.get('api') || window.API_BASE_URL || `http://${window.location.hostname}:3000`;
// window.APP_BASE_PATH comes from config.js (server.basePath — see brand.js),
// which loads before this file on every page. Falls back to "/reservation"
// so a stale cached config.js degrades rather than breaking (finding C2).
let API_URL = `${API_BASE_URL}${window.APP_BASE_PATH || '/reservation'}/api`;

let tables = {};          // name -> timetable object (as returned by API, plus fileId)
let selectedTableName = null;
let currentView = 'overview'; // 'overview' | 'detail' | 'waiter' | 'menu' | 'sales' | 'users' | 'settings' | 'dailyMenu' | 'layout'

// Floorplan (docs/superpowers/specs/2026-07-27-floorplan-table-picking-
// design.md §6.4) — set the moment anything changes in the "Rozložení"
// editor (drag, resize, room/fixture CRUD, numeric field edit) and cleared
// only by a successful save or a confirmed "leave without saving". Declared
// up here with the rest of the top-level view state (rather than down in
// the editor's own section further below) so switchView()'s navigate-away
// guard and the window 'beforeunload' listener can read it regardless of
// script execution order. See the FLOORPLAN LAYOUT EDITOR section for the
// rest of this feature's state and logic.
let layoutDirty = false;

// go-live Task 6 (spec §11): reservations cover all 7 days now (previously
// Po-Pá only) — this labels every dayIdx (0-6) the admin bookings table can
// encounter, including Saturday/Sunday bookings.
const WEEKDAYS = ['Pondělí', 'Úterý', 'Středa', 'Čtvrtek', 'Pátek', 'Sobota', 'Neděle'];
const HOUR_LABELS = ['8:00-9:00','9:00-10:00','10:00-11:00','11:00-12:00','12:00-13:00',
                      '13:00-14:00','14:00-15:00','15:00-16:00','16:00-17:00','17:00-18:00',
                      '18:00-19:00','19:00-20:00'];

// ════════════════════════════════════════════════════════════════════════
// FUTURE-PROOFING NOTE
// ────────────────────────────────────────────────────────────────────────
// Each booking object currently looks like: { content, isPermanent, abbreviation }
// In the future, bookings will also carry order + payment info, e.g.:
//   {
//     content, isPermanent, abbreviation,
//     order: [{ item, qty, price }, ...],
//     orderTotal: number,
//     isPaid: boolean,
//     paidAt: ISOString
//   }
// The rendering functions below (renderOverviewCard, renderBookingsTable)
// are intentionally written to read booking.order / booking.isPaid if present
// and fall back gracefully when absent, so wiring up real order data later
// should not require restructuring this file — just populate those fields
// server-side and the "Objednávka" / "Platba" columns will start showing
// real data instead of the neutral placeholder shown now.
// ════════════════════════════════════════════════════════════════════════

function generateFileId(length = 12) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    return Array.from({ length }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

// API_URL is `${API_BASE_URL}/reservation/api` — strip the trailing "/api"
// to get the app's base path, which is also where the printable receipt
// page (/uctenka/:id) is served from.
function receiptUrl(receiptId) {
    return `${API_URL.replace(/\/api\/?$/, '')}/uctenka/${encodeURIComponent(receiptId)}`;
}

// ════════════════════════════════════════════════════════════════════════
// CSRF TOKEN — SECURITY (3rd hardening pass). Every cookie-authenticated
// mutating request (POST/PUT/DELETE through apiFetch below) needs an
// `x-csrf-token` header matching the server-issued CSRF cookie — see
// csrf.js and the csrf.requireCsrf-guarded routes in server.js. The token
// is fetched from GET /api/csrf-token (rather than read directly out of
// document.cookie) so this also works in the cross-origin-dev setup this
// page already supports (the "?api=" / gateApiInput override pointing at a
// different host:port) — this document's own cookies aren't readable across
// origins, but a fetch()'d JSON response is (subject to the server's CORS
// allow-list, same as any other API call here). Cached after the first
// fetch and cleared on a 403 so a stale/rotated token (e.g. after a server
// restart with no CSRF_SECRET set) self-heals on the very next action
// instead of getting the user permanently stuck.
// ════════════════════════════════════════════════════════════════════════

let cachedCsrfToken = null;

async function ensureCsrfToken() {
    if (cachedCsrfToken) return cachedCsrfToken;
    try {
        const res = await fetch(`${API_URL}/csrf-token`, { credentials: 'include' });
        if (res.ok) {
            const data = await res.json();
            cachedCsrfToken = data.csrfToken || null;
        }
    } catch (e) {
        // Network hiccup — apiFetch just proceeds without the header below;
        // the server will 403 and this cache gets retried on the next call.
    }
    return cachedCsrfToken;
}

const CSRF_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);

// ════════════════════════════════════════════════════════════════════════
// API FETCH WRAPPER — attaches the auth cookie (credentials:'include') and,
// for state-changing methods, the CSRF header, to every API call. Reacts to
// an expired/missing/insufficient session by clearing local state and
// dropping back to the login gate, instead of the request silently failing
// or the client-side isAdmin() check being the only thing standing between
// a logged-out user and a broken UI.
// ════════════════════════════════════════════════════════════════════════

async function apiFetch(url, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    if (CSRF_METHODS.has(method)) {
        const token = await ensureCsrfToken();
        options = { ...options, headers: { ...(options.headers || {}), 'x-csrf-token': token || '' } };
    }

    const res = await fetch(url, { ...options, credentials: 'include' });

    if (res.status === 401) {
        // Session missing/expired — force back to login.
        setSession(null);
        showLoginGate();
        showToast('Přihlášení vypršelo, přihlaste se prosím znovu.', true);
    } else if (res.status === 403) {
        // Logged in, but lacks the required role (e.g. non-admin hitting an
        // admin-only route) — OR a stale/invalid CSRF token. Clear the
        // cached token so the next attempt fetches a fresh one instead of
        // repeating the same failure indefinitely; don't log the user out
        // for this, just surface it.
        cachedCsrfToken = null;
        showToast('Nemáte oprávnění k této akci.', true);
    }

    return res;
}

// ════════════════════════════════════════════════════════════════════════
// TOAST
// ════════════════════════════════════════════════════════════════════════

function showToast(msg, isError = false) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className = 'inn-toast show' + (isError ? ' error' : '');
    clearTimeout(t._hideTimer);
    t._hideTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

// Same as showToast, but with a clickable "Účtenka" link when a mark-paid
// action returned a receiptId — stays up a bit longer so there's time to
// click it, and needs pointer-events re-enabled (the plain toast has
// pointer-events:none so it never blocks clicks underneath it).
function showToastWithReceipt(msg, receiptId) {
    if (!receiptId) return showToast(msg);
    const t = document.getElementById('toast');
    t.innerHTML = `${escapeHtml(msg)} — <a href="${receiptUrl(receiptId)}" target="_blank" rel="noopener">Účtenka</a>`;
    t.className = 'inn-toast show with-link';
    clearTimeout(t._hideTimer);
    t._hideTimer = setTimeout(() => t.classList.remove('show'), 6000);
}

// ════════════════════════════════════════════════════════════════════════
// CONNECTION / GATE
// ════════════════════════════════════════════════════════════════════════

async function tryConnect(url) {
    API_BASE_URL = url.replace(/\/$/, '');
    API_URL = `${API_BASE_URL}${window.APP_BASE_PATH || '/reservation'}/api`;
    try {
        const res = await fetch(`${API_BASE_URL}/`);
        if (!res.ok) throw new Error('bad status');
        document.getElementById('gateOverlay').style.display = 'none';
        document.getElementById('connDot').classList.remove('bad');
        document.getElementById('connText').textContent = API_BASE_URL;
        await loadAllTables();

        const session = getSession();
        if (session) {
            setSession(session);
            hideLoginGate();
        } else {
            setSession(null);
            showLoginGate();
        }
        return true;
    } catch (e) {
        document.getElementById('connDot').classList.add('bad');
        document.getElementById('connText').textContent = 'Nepřipojeno';
        return false;
    }
}

// The bar's Wi-Fi is down and the barman still has to open the till.
//
// Without this, a failed tryConnect() drops the connection gate over the
// whole app — an "enter the server address" dialog, which is exactly the
// wrong thing to show someone whose problem is that there is no network.
// The whole offline-first effort would be invisible behind that overlay.
//
// Everything the floor view needs (timetables, menu, the order list) is a
// GET under /api/, which the service worker serves from its cache when the
// network is unreachable — so loadAllTables() below genuinely works here.
async function enterOfflineMode() {
    // We just proved the server is unreachable — record it, so the status
    // pill agrees with the connection label instead of contradicting it.
    if (typeof POSSync !== 'undefined') POSSync.noteContact(false);
    document.getElementById('gateOverlay').style.display = 'none';
    document.getElementById('connDot').classList.add('bad');
    document.getElementById('connText').textContent = 'Offline';

    // A session that was valid when the network died is the best available
    // answer. The server revalidates it on the first successful drain, and
    // until then there is nothing this device could check it against.
    const session = getSession();
    if (session) {
        setSession(session);
        hideLoginGate();
    } else {
        // No cached session and no network: the app cannot authenticate, so
        // it must not pretend to work. Sales taken now could never be
        // attributed to anyone.
        setSession(null);
        showLoginGate();
    }

    try {
        await loadAllTables();
    } catch (e) {
        console.error('[pos] offline start could not restore the floor view', e);
    }

    await posRefreshStatus();
    showToast('Offline režim — objednávky se ukládají do zařízení', true);
}

// Can this device usefully run with no server? Only if the queue is alive
// AND the service worker has something cached to work from — otherwise
// "offline mode" is a blank screen with a reassuring label on it.
async function posCanRunOffline() {
    if (!posReady) return false;
    try {
        const cached = await POSDB.serverOrders.all();
        const hasShell = 'serviceWorker' in navigator && !!(await navigator.serviceWorker.getRegistration());
        return hasShell || cached.length > 0;
    } catch (e) {
        return false;
    }
}

document.getElementById('gateConnectBtn').addEventListener('click', () => {
    const val = document.getElementById('gateApiInput').value.trim();
    if (val) tryConnect(val);
});
document.getElementById('gateApiInput').addEventListener('keypress', e => {
    if (e.key === 'Enter') document.getElementById('gateConnectBtn').click();
});

// ════════════════════════════════════════════════════════════════════════
// LOGIN / SESSION
// ════════════════════════════════════════════════════════════════════════

const SESSION_KEY = 'inn_session_user';
let currentUser = null; // { id, name, abbreviation, isAdmin }

function getSession() {
    try {
        return JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
    } catch { return null; }
}

function setSession(user) {
    currentUser = user;
    if (user) {
        sessionStorage.setItem(SESSION_KEY, JSON.stringify(user));
    } else {
        sessionStorage.removeItem(SESSION_KEY);
    }
    applySessionToUI();
}

function isAdmin() {
    return !!(currentUser && currentUser.isAdmin);
}

function applySessionToUI() {
    document.body.classList.toggle('is-admin', !!(currentUser && currentUser.isAdmin));
    document.querySelectorAll('.admin-only').forEach(el => {
        // Some admin-only elements (e.g. #viewDailyMenuBtn) are ALSO feature-
        // gated via data-feature. This loop runs on every login/session
        // restore and would otherwise unconditionally re-show such an
        // element for an admin, undoing the one-time [data-feature] hide
        // further down and reopening a tab whose routes 404. Checking
        // window.APP_FEATURES here (same source the [data-feature] pass
        // below reads) keeps a feature-disabled element hidden regardless of
        // session state, without re-running a second querySelectorAll pass
        // on every session change.
        const feature = el.getAttribute('data-feature');
        const featureOff = feature && !(window.APP_FEATURES && window.APP_FEATURES[feature]);
        el.style.display = (currentUser && currentUser.isAdmin && !featureOff) ? '' : 'none';
    });
    document.getElementById('loggedInUserText').textContent = currentUser
        ? `${currentUser.name} (${currentUser.abbreviation})${currentUser.isAdmin ? ' — admin' : ''}`
        : '';
    document.getElementById('logoutBtn').style.display = currentUser ? 'inline-flex' : 'none';
}

// Hide anything belonging to a feature this installation did not buy.
// window.APP_FEATURES is set by the server-rendered config.js (see
// src/server/brand.js). Cosmetic only — the server 404s the matching
// routes regardless, so a hidden tab is not the security boundary. Unlike
// the .admin-only loop above, this runs once at load rather than on every
// session change — feature flags are fixed for the life of the page, they
// don't depend on who's logged in.
document.querySelectorAll('[data-feature]').forEach(el => {
    const feature = el.getAttribute('data-feature');
    if (!(window.APP_FEATURES && window.APP_FEATURES[feature])) {
        el.style.display = 'none';
    }
});

function showLoginGate() {
    document.getElementById('loginGateOverlay').style.display = 'flex';
    document.getElementById('loginAbbrInput').value = '';
    document.getElementById('loginPasswordInput').value = '';
    document.getElementById('loginError').style.display = 'none';
    setTimeout(() => document.getElementById('loginAbbrInput').focus(), 50);
}

function hideLoginGate() {
    document.getElementById('loginGateOverlay').style.display = 'none';
}

async function attemptLogin() {
    const abbreviation = document.getElementById('loginAbbrInput').value.trim();
    const password = document.getElementById('loginPasswordInput').value;
    const errorEl = document.getElementById('loginError');
    errorEl.style.display = 'none';

    if (!abbreviation || !password) {
        errorEl.textContent = 'Vyplňte zkratku i heslo.';
        errorEl.style.display = 'block';
        return;
    }

    try {
        const res = await fetch(`${API_URL}/users/login`, {
            credentials: 'include',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ abbreviation, password })
        });
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            errorEl.textContent = data.error === 'Invalid password' ? 'Nesprávné heslo.'
                : data.error === 'User not found' ? 'Uživatel nenalezen.'
                : 'Přihlášení se nezdařilo.';
            errorEl.style.display = 'block';
            return;
        }
        const user = await res.json();
        setSession(user);
        hideLoginGate();
        showToast(`Přihlášen jako ${user.name}`);
    } catch (e) {
        errorEl.textContent = 'Nepodařilo se spojit se serverem.';
        errorEl.style.display = 'block';
    }
}

document.getElementById('loginSubmitBtn').addEventListener('click', attemptLogin);
document.getElementById('loginAbbrInput').addEventListener('keypress', e => { if (e.key === 'Enter') attemptLogin(); });
document.getElementById('loginPasswordInput').addEventListener('keypress', e => { if (e.key === 'Enter') attemptLogin(); });

document.getElementById('logoutBtn').addEventListener('click', () => {
    // End of shift with money the server has never seen. The barman is
    // usually about to put the tablet in a drawer, which is exactly when
    // an unnoticed queue turns into an unreported sale.
    if (posReady) {
        const money = POSDB.unsentMoneyCount(posSales);
        const failed = POSDB.failedCount(posSales);
        if (money > 0 || failed > 0) {
            const parts = [];
            if (money) parts.push(`${money} zaplacených účtenek čeká na odeslání`);
            if (failed) parts.push(`${failed} účtenek server zamítl`);
            const proceed = confirm(
                `${parts.join(' a ')}.\n\n` +
                'Nechte tablet zapnutý a připojený, dokud se neodešlou. Přesto se odhlásit?'
            );
            if (!proceed) return;
        }
    }

    // NOTE: this clears the session and NOTHING else. The sales queue is
    // deliberately untouched — queued money is not session state, and a
    // logout (or a session expiring overnight) must never be able to
    // discard a sale that has not been reported. See spec §3.3.
    setSession(null);
    showLoginGate();
});

// ── Offline POS queue modal wiring (spec §3.4) ──────────────────────────

document.getElementById('posStatusPill').addEventListener('click', () => {
    posRenderQueueModal();
    document.getElementById('posQueueModal').style.display = 'flex';
});

document.getElementById('posQueueCloseBtn').addEventListener('click', () => {
    document.getElementById('posQueueModal').style.display = 'none';
});

document.getElementById('posQueueModal').addEventListener('click', e => {
    if (e.target.id === 'posQueueModal') document.getElementById('posQueueModal').style.display = 'none';
});

document.getElementById('posQueueRetryBtn').addEventListener('click', async () => {
    const btn = document.getElementById('posQueueRetryBtn');
    btn.disabled = true;
    btn.textContent = 'Odesílám…';
    try {
        // A manual retry deliberately ignores each sale's backoff: the
        // barman pressing this button is new information the schedule did
        // not have — usually "I can see the Wi-Fi is back".
        for (const sale of posSales) {
            if (sale.state === POSDB.STATE.FAILED) continue; // needs a human, not another attempt
            if (POSDB.pendingStep(sale) && sale.nextAttemptAt) {
                await POSDB.sales.put(Object.assign({}, sale, { nextAttemptAt: 0 }));
            }
        }
        const result = await POSSync.drain();
        await posRefreshStatus();
        posRenderQueueModal();
        showToast(result.synced ? `Odesláno: ${result.synced}` : 'Zatím se nepodařilo odeslat', !result.synced);
    } finally {
        btn.disabled = false;
        btn.textContent = 'Zkusit odeslat teď';
    }
});

document.getElementById('downloadDataBtn').addEventListener('click', () => {
    // Hits GET /export which streams down the actual SQLite database file
    // (data/app.db) as-is — this is now the single source of truth for all
    // data (timetables, users, drivers, orders, indoor orders, menu).
    // Save it somewhere safe; to restore, just put it back at data/app.db
    // (matching the SQLITE_PATH env var if you've customized it) before
    // starting the server.
    const link = document.createElement('a');
    link.href = `${API_URL}/export`;
    link.download = '';
    document.body.appendChild(link);
    link.click();
    link.remove();
    showToast('Stahuji zálohu databáze (.db)…');
});

// ════════════════════════════════════════════════════════════════════════
// OFFLINE-FIRST POS
//
// Spec: docs/superpowers/specs/2026-08-02-offline-first-pos-design.md
//
// Every table order and every payment is written to IndexedDB FIRST, then
// drained to the server by pos-sync.js. The point is not speed — it is that
// the offline path runs on every sale of every shift, so an outage changes
// nothing about which code executes. A queue-on-failure design would put
// this code's first real execution and its first business-critical
// execution on the same evening.
//
// This section owns three things: startup, the status pill, and the two
// write paths (submit an order, close a tab). It never talks to EET —
// eet-queue.js on the server already owns that, retries included.
// ════════════════════════════════════════════════════════════════════════

let posReady = false;
let posSales = [];        // local mirror, refreshed on every queue change
let posPersistence = null;
let posDeviceId = null;

async function posInit() {
    if (!root_hasIndexedDb()) {
        // Without IndexedDB there is no queue, and a till that silently
        // loses sales is worse than one that admits it cannot go offline.
        console.warn('[pos] IndexedDB unavailable — offline mode is OFF');
        return;
    }

    try {
        await POSDB.open();
        posPersistence = await POSDB.requestPersistence();
        if (!posPersistence.persisted) {
            // Not fatal — Chrome usually grants this once the app is
            // installed — but it means the browser may evict unsent sales
            // under storage pressure, which is money disappearing. Someone
            // has to be able to find out.
            console.warn('[pos] storage persistence NOT granted:', posPersistence);
        }

        const deviceId = await POSDB.deviceId();

        POSSync.configure({
            // A getter: tryConnect() rewrites API_URL, and a queue holding
            // a stale copy would drain a shift's sales at the wrong server.
            getApiUrl: () => API_URL,
            getCsrfToken: ensureCsrfToken,
            onChange: posRefreshStatus,
            // A 401 during a drain is NOT a reason to throw the barman back
            // to the login gate mid-service, and emphatically not a reason
            // to touch the queue: queued money is not session state.
            onAuthRequired: () => showToast('Přihlášení vypršelo — přihlaste se, aby se odeslaly účtenky', true),
            onCsrfStale: () => { cachedCsrfToken = null; },
        });

        POSSync.start();
        posDeviceId = deviceId;
        posReady = true;

        // The pill has to react to connectivity even when no drain runs —
        // going offline skips the drain entirely, so without these the
        // status would keep claiming "Online" until the next sale.
        window.addEventListener('online', posRefreshStatus);
        window.addEventListener('offline', posRefreshStatus);

        await POSDB.pruneSynced();
        await posRefreshStatus();
        posRegisterServiceWorker();
    } catch (e) {
        console.error('[pos] init failed — offline mode is OFF', e);
    }
}

function root_hasIndexedDb() {
    return typeof indexedDB !== 'undefined' && typeof POSDB !== 'undefined';
}

// ── Service worker ──────────────────────────────────────────────────────

function posRegisterServiceWorker() {
    if (!('serviceWorker' in navigator)) {
        console.warn('[pos] service workers unsupported — the app will not load offline');
        return;
    }

    // Service workers require a secure context. THIS is the failure worth
    // shouting about: a tablet pointed at http://192.168.x.x:3000 registers
    // nothing, reports no error anybody would see, and looks completely
    // fine right up until the morning the Wi-Fi is down and the till will
    // not open. localhost is exempt, so dev is unaffected.
    if (!window.isSecureContext) {
        console.error('[pos] insecure context — the service worker will NOT register. The till will not load offline. Serve the app over HTTPS.');
        showToast('Pozor: pokladna se bez HTTPS nenačte offline', true);
        return;
    }

    // Derived from THIS PAGE's location, never from API_BASE_URL. A service
    // worker can only be registered from its own origin, and in the
    // split-server dev setup the API lives on a different one — using it
    // here would fail with a SecurityError that looks like a bug in the
    // worker rather than in the URL.
    //
    //   /reservation/html/inner.html → /reservation
    //   /reservation/admin           → /reservation
    //   /inner.html                  → ""
    const appBase = window.location.pathname.replace(/\/(html\/)?[^/]*$/, '');

    navigator.serviceWorker.register(`${appBase}/sw.js`, { scope: `${appBase}/` })
        .catch(e => console.error('[pos] service worker registration failed', e));

    // Background Sync wakes the page when connectivity returns even if it
    // was closed; the worker cannot drain by itself because only this side
    // holds the idempotency keys.
    navigator.serviceWorker.addEventListener('message', event => {
        if (event.data && event.data.type === 'pos-drain') POSSync.drain();
    });
}

// ── Status pill ─────────────────────────────────────────────────────────

async function posRefreshStatus() {
    if (!posReady) return;
    try {
        posSales = await POSDB.sales.all();
    } catch (e) {
        console.error('[pos] could not read the queue', e);
        return;
    }

    const pill = document.getElementById('posStatusPill');
    const text = document.getElementById('posStatusText');
    if (!pill || !text) return;

    const money = POSDB.unsentMoneyCount(posSales);
    const pending = POSDB.pendingCount(posSales);
    const failed = POSDB.failedCount(posSales);
    // serverUnreachable(), not definitelyOffline(): the till can be sitting
    // in offline mode with the server dead while the tablet still has
    // perfectly good Wi-Fi. Reporting "Online" there is the pill lying
    // about the one thing it exists to report.
    const offline = POSSync.serverUnreachable();

    pill.hidden = false;
    pill.classList.toggle('stuck', failed > 0);
    pill.classList.toggle('waiting', failed === 0 && (pending > 0 || offline));

    if (failed > 0) {
        text.textContent = `${failed} ${czPlural(failed, 'účtenka', 'účtenky', 'účtenek')} zamítnuto`;
    } else if (money > 0) {
        // Money first. An unpaid order the kitchen cannot see matters, but
        // an unreported sale is the one with legal consequences.
        text.textContent = `${money} ${czPlural(money, 'účtenka', 'účtenky', 'účtenek')} k odeslání`;
    } else if (pending > 0) {
        text.textContent = `${pending} ${czPlural(pending, 'objednávka', 'objednávky', 'objednávek')} k odeslání`;
    } else {
        text.textContent = offline ? 'Offline' : 'Online';
    }

    pill.title = offline
        ? 'Zařízení je offline. Účtenky se odešlou automaticky po obnovení sítě.'
        : 'Připojeno k serveru.';

    posApplyOfflineUi(offline);
}

// Spec §5 — only the till goes offline. Everything else is either shared
// mutable state (no correct merge when two devices diverge) or needs a live
// third party, so it is visibly disabled rather than left to fail on tap.
//
// A control that silently does nothing when touched teaches staff to
// distrust the whole screen, and a waiter who has learned to ignore an
// unresponsive button is one who will also ignore the unsent-sales pill.
const POS_ONLINE_ONLY_IDS = [
    'viewMenuBtn',      // menu admin — shared state
    'viewSalesBtn',     // stats — server-computed
    'viewUsersBtn',     // staff admin — shared state
    'viewSettingsBtn',  // restaurant settings — shared state
    'viewLayoutBtn',    // floorplan editing — shared state
    'viewDailyMenuBtn', // daily menu — shared state
    'downloadDataBtn',  // streams the live SQLite file
];

function posApplyOfflineUi(offline) {
    for (const id of POS_ONLINE_ONLY_IDS) {
        const el = document.getElementById(id);
        if (!el) continue;
        el.classList.toggle('inn-offline-disabled', offline);
        if (offline) el.setAttribute('title', 'Nedostupné offline');
        else el.removeAttribute('title');
    }

    // GoPay needs a live gateway AND the guest's own phone; there is
    // nothing to queue and nothing to retry. These are rendered per row, so
    // they are selected rather than looked up by id.
    document.querySelectorAll('.inn-payonline-btn').forEach(btn => {
        btn.classList.toggle('inn-offline-disabled', offline);
        if (offline) btn.setAttribute('title', 'Online platba vyžaduje připojení');
        else btn.removeAttribute('title');
    });
}

// Czech has three plural forms (1 / 2–4 / 5+). Getting this wrong reads as
// broken software to a native speaker, and this string sits in the toolbar
// all shift.
function czPlural(n, one, few, many) {
    if (n === 1) return one;
    if (n >= 2 && n <= 4) return few;
    return many;
}

// ── Write paths ─────────────────────────────────────────────────────────

// A local sale rendered in the shape the existing table/order UI expects,
// so nothing downstream has to know whether an order came from the server
// or from this device's queue.
function posSaleToOrderShape(sale) {
    return {
        id: sale.serverOrderId || `local:${sale.clientId}`,
        tableName: sale.tableName,
        guestName: sale.guestName,
        items: sale.items,
        total: sale.total,
        kitchenStatus: 'pending',
        createdAt: sale.createdAt,
        paymentStatus: sale.state === POSDB.STATE.PAID || sale.state === POSDB.STATE.SYNCED ? 'paid' : 'unpaid',
        receiptId: sale.receiptId || null,
        // Markers the UI can use to explain why this row looks different.
        posLocal: true,
        posState: sale.state,
        posClientId: sale.clientId,
    };
}

// Server list ∪ local unsynced sales. A one-way merge, not bidirectional
// sync: local wins only while the server does not yet know the truth.
function posMergeOrders(serverList) {
    const local = posSales.filter(s => s.state !== POSDB.STATE.SYNCED);
    const overriddenIds = new Set(local.map(s => s.serverOrderId).filter(Boolean));
    const merged = (serverList || []).filter(o => !overriddenIds.has(o.id));
    return merged.concat(local.map(posSaleToOrderShape));
}

// Called by the "Odeslat do kuchyně" button. Returns immediately — the sale
// is durable the moment this resolves, network or not.
async function posSubmitOrder({ tableName, guestName, items, total }) {
    const sale = POSDB.createSale({ tableName, guestName, items, total, deviceId: posDeviceId });
    await POSSync.enqueuePaid(sale); // durable write, then an immediate drain attempt
    await posRefreshStatus();
    return sale;
}

// Called when a tab is closed. `orderId` is either a real server order id or
// the `local:<clientId>` placeholder used by a sale that has not reached the
// server yet.
async function posMarkPaid(orderId) {
    let sale = null;

    if (String(orderId).startsWith('local:')) {
        const clientId = String(orderId).slice('local:'.length);
        sale = posSales.find(s => s.clientId === clientId) || null;
    } else {
        sale = posSales.find(s => s.serverOrderId === orderId) || null;
        if (!sale) {
            // An order that exists only on the server — created online,
            // possibly by a different device. Adopt it into this device's
            // queue so the payment is durable here even if the network dies
            // between this click and the request.
            const existing = indoorWalkinOrders.find(o => o.id === orderId);
            if (!existing) throw new Error('Objednávka nenalezena');
            sale = POSDB.createSale({
                tableName: existing.tableName,
                guestName: existing.guestName,
                items: existing.items,
                total: existing.total,
                deviceId: posDeviceId,
            });
            sale = POSDB.advanceSale(sale, 'created', { serverOrderId: orderId });
        }
    }

    if (!sale) throw new Error('Objednávka nenalezena');

    const paid = POSDB.advanceSale(sale, 'pay', { paymentMethod: 'cash' });
    await POSSync.enqueuePaid(paid);
    await posRefreshStatus();
    return paid;
}

// ── Queue modal ─────────────────────────────────────────────────────────

function posRenderQueueModal() {
    const pendingBox = document.getElementById('posQueuePending');
    const failedBox = document.getElementById('posQueueFailed');
    const intro = document.getElementById('posQueueIntro');
    if (!pendingBox || !failedBox) return;

    const pending = posSales.filter(s => POSDB.pendingStep(s) !== null);
    const failed = posSales.filter(s => s.state === POSDB.STATE.FAILED);

    intro.textContent = pending.length === 0 && failed.length === 0
        ? 'Vše je odesláno na server.'
        : 'Účtenky se odešlou automaticky, jakmile bude dostupná síť.';

    const row = sale => {
        const isMoney = sale.state === POSDB.STATE.PAID;
        return `<div class="inn-pos-sale">
            <div>
                <div><strong>Stůl ${escapeHtml(sale.tableName)}</strong>${sale.guestName ? ' — ' + escapeHtml(sale.guestName) : ''}</div>
                <div class="inn-pos-sale-meta">${isMoney ? 'zaplaceno' : 'objednávka'} ${escapeHtml(posTimeLabel(sale.paidAt || sale.createdAt))}${sale.attempts ? ` · ${sale.attempts}. pokus` : ''}</div>
                ${sale.lastError ? `<div class="inn-pos-sale-error">${escapeHtml(sale.lastError)}</div>` : ''}
            </div>
            <div class="inn-pos-sale-amount">${Number(sale.total).toFixed(0)} Kč</div>
        </div>`;
    };

    pendingBox.innerHTML = pending.length
        ? `<div class="inn-pos-queue-group"><h4>Čeká na odeslání (${pending.length})</h4>${pending.map(row).join('')}</div>`
        : '';

    // Kept visually and structurally separate from the pending list: these
    // will never resolve on their own, and burying them among rows that
    // will is how a rejected sale goes unnoticed for a week.
    failedBox.innerHTML = failed.length
        ? `<div class="inn-pos-queue-group"><h4>Zamítnuto serverem — vyžaduje zásah (${failed.length})</h4>${failed.map(row).join('')}</div>`
        : '';
}

function posTimeLabel(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });
}

// ════════════════════════════════════════════════════════════════════════
// DATA LOADING
// ════════════════════════════════════════════════════════════════════════

let indoorWalkinOrders = []; // walk-in table orders (no reservation) — see fetchIndoorWalkinOrders

async function fetchIndoorWalkinOrders() {
    // Finding I1: GET /indoor-orders is requireFeature("pos") on the server
    // — with pos:false it does not exist at all, so there is nothing to
    // fetch. Skip the call entirely rather than treating a guaranteed 404
    // as evidence the network is down (see the 404 handling below for the
    // second half of this fix — belt and braces, in case this function is
    // ever called before window.APP_FEATURES is known to be current).
    if (!(window.APP_FEATURES && window.APP_FEATURES.pos)) {
        indoorWalkinOrders = [];
        return;
    }

    let serverList = null;
    try {
        const res = await apiFetch(`${API_URL}/indoor-orders`);
        if (!res.ok) {
            const err = new Error('HTTP ' + res.status);
            err.status = res.status;
            throw err;
        }
        serverList = await res.json();
        // The server answered — real evidence the network works, which is
        // the only kind the status pill accepts.
        if (typeof POSSync !== 'undefined') POSSync.noteContact(true);
        // Cache it so the next offline start still shows the floor's state
        // rather than an empty room.
        if (posReady) await POSDB.serverOrders.bulkPut(serverList);
    } catch (e) {
        console.error('Failed to load walk-in orders', e);
        // A 404 is evidence the route does not exist (e.g. pos disabled on
        // the server while this tab still holds a stale APP_FEATURES), not
        // evidence the server is unreachable — it must not flip the status
        // pill to offline and disable the admin panel's other tabs (I1).
        if (e.status !== 404 && typeof POSSync !== 'undefined') POSSync.noteContact(false);
        // Offline: fall back to the last known server state instead of
        // blanking the screen. An empty list here would read as "no open
        // tabs", which is a far more dangerous lie than stale data.
        if (posReady) {
            try { serverList = await POSDB.serverOrders.all(); } catch (e2) { serverList = []; }
        } else {
            serverList = [];
        }
    }

    indoorWalkinOrders = posReady ? posMergeOrders(serverList) : serverList;
}

async function loadAllTables() {
    try {
        const res = await apiFetch(`${API_URL}/timetables`);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const names = [...new Set(await res.json())];

        const loaded = {};
        for (const name of names) {
            try {
                const r = await apiFetch(`${API_URL}/timetables/${encodeURIComponent(name)}`);
                if (!r.ok) continue;
                const data = await r.json();
                loaded[name] = data;
            } catch (e) { console.error('Failed to load', name, e); }
        }
        tables = loaded;
        // A table create/rename/delete may have happened since the last
        // fetch (this reload is how all three of those surface) — the
        // cached QR tokens key off className, so a stale cache here would
        // show the wrong table name/URL on the next QR panel or print sheet.
        tableQrTokensCache = null;
        await fetchIndoorWalkinOrders();
        renderSidebar();
        if (currentView === 'overview') renderOverview();
        else if (selectedTableName && tables[selectedTableName]) renderDetail(selectedTableName);
        else { currentView = 'overview'; switchView('overview'); }
    } catch (e) {
        console.error(e);
        showToast('Nepodařilo se načíst stoly', true);
    }
}

// ════════════════════════════════════════════════════════════════════════
// BOOKING EXTRACTION (handles both object-of-hours and legacy array shapes)
// ════════════════════════════════════════════════════════════════════════

// ─── DATE MATH (string-based, avoids timezone parsing bugs) ──────────────

function parseDateStr(dateStr) {
    const [y, m, d] = dateStr.split('-').map(n => parseInt(n, 10));
    return { y, m, d };
}

function addDaysToDateStr(dateStr, days) {
    // Builds a UTC-anchored Date purely as a calendar calculator (noon avoids
    // any DST/timezone edge rolling the day over), then re-serializes to
    // YYYY-MM-DD without ever reading local getDate()/getMonth() (which is
    // what caused the earlier timezone bug).
    const { y, m, d } = parseDateStr(dateStr);
    const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
    dt.setUTCDate(dt.getUTCDate() + days);
    const yy = dt.getUTCFullYear();
    const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(dt.getUTCDate()).padStart(2, '0');
    return `${yy}-${mm}-${dd}`;
}

function getUTCWeekday(dateStr) {
    // 0 = Sunday, 1 = Monday, ... 6 = Saturday
    const { y, m, d } = parseDateStr(dateStr);
    return new Date(Date.UTC(y, m - 1, d, 12, 0, 0)).getUTCDay();
}

function snapToMonday(dateStr) {
    // The customer app's older getDateString() implementation used
    // toISOString(), which converts to UTC before formatting and could
    // shift the stored "week start" key by a day depending on timezone —
    // some existing data on disk may be keyed by a Sunday instead of the
    // intended Monday. Snapping here means both old (slightly-off) and
    // newly-saved (correct) data resolve to the same real calendar dates.
    const weekday = getUTCWeekday(dateStr); // 0=Sun..6=Sat
    const offsetToMonday = weekday === 0 ? -6 : 1 - weekday;
    return offsetToMonday === 0 ? dateStr : addDaysToDateStr(dateStr, offsetToMonday);
}

function extractBookings(timetable) {
    const out = [];
    const data = timetable.data || {};
    for (const weekStartStr of Object.keys(data)) {
        const dayData = data[weekStartStr];
        if (!dayData) continue;
        const dayIndices = Array.isArray(dayData)
            ? dayData.map((_, i) => i)
            : Object.keys(dayData).map(k => parseInt(k, 10));

        dayIndices.forEach(dayIdx => {
            const hours = Array.isArray(dayData) ? dayData[dayIdx] : dayData[dayIdx];
            if (!hours || typeof hours !== 'object') return;

            // The stored key is supposed to be the Monday of that week, but
            // some legacy data may be keyed by a Sunday (see snapToMonday).
            // Snap first, then add the day-of-week offset (dayIdx).
            const realWeekStart = snapToMonday(weekStartStr);
            const actualDateStr = addDaysToDateStr(realWeekStart, dayIdx);

            Object.keys(hours).forEach(hourKey => {
                const booking = hours[hourKey];
                if (!booking || !booking.content) return;
                const hourIdx = parseInt(hourKey, 10) - 1; // stored 1-indexed, same convention as customer site
                out.push({
                    dateStr: actualDateStr,
                    weekStartStr,
                    dayIdx,
                    hourIdx,
                    hourKey: parseInt(hourKey, 10), // original stored key, needed for writes
                    dayLabel: WEEKDAYS[dayIdx] || `Den ${dayIdx}`,
                    timeLabel: HOUR_LABELS[hourIdx] || `Hodina ${hourKey}`,
                    content: booking.content,
                    abbreviation: booking.abbreviation || '',
                    isPermanent: !!booking.isPermanent,
                    // Future fields — read if present, otherwise undefined
                    order: booking.order,
                    orderTotal: booking.orderTotal,
                    isPaid: booking.isPaid,
                    paymentFailed: booking.paymentFailed,
                    receiptId: booking.receiptId,
                });
            });
        });
    }
    // Sort by actual date then time
    out.sort((a, b) => {
        if (a.dateStr !== b.dateStr) return a.dateStr.localeCompare(b.dateStr);
        return a.hourIdx - b.hourIdx;
    });
    return out;
}

function todayDateStr() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function isFutureOrToday(dateStr) {
    // Plain string comparison avoids timezone parsing bugs (new Date("YYYY-MM-DD")
    // parses as UTC midnight, which can fall on the "wrong side" of local midnight).
    return dateStr >= todayDateStr();
}

function isToday(dateStr) {
    return dateStr === todayDateStr();
}


// ════════════════════════════════════════════════════════════════════════
// SIDEBAR
// ════════════════════════════════════════════════════════════════════════

// A table counts as occupied (not free) right now if either:
//  - it has a reservation for today whose hour block covers the current
//    time (8:00–20:00, one block per hour, same convention as HOUR_LABELS)
//  - it has a booking today carrying an order that isn't marked paid yet
//    (booking.order / booking.isPaid — same fields statusPillHTML reads)
// Past days and future dates don't affect the table's *current* floor
// status, so only today's bookings are considered.
function isTableFreeNow(name) {
    const bookings = extractBookings(tables[name]).filter(b => isToday(b.dateStr));
    const currentHour = new Date().getHours(); // 8 => "8:00-9:00" block, etc.

    for (const b of bookings) {
        const slotStartHour = 8 + b.hourIdx;
        const isHappeningNow = currentHour >= slotStartHour && currentHour < slotStartHour + 1;
        const hasUnpaidOrder = Array.isArray(b.order) && b.order.length > 0 && b.isPaid !== true;
        if (isHappeningNow || hasUnpaidOrder) return false;
    }

    // Walk-in orders placed straight on a table (no reservation) also keep
    // it occupied until a waiter marks the order paid.
    const hasUnpaidWalkin = indoorWalkinOrders.some(o => o.tableName === name && o.paymentStatus !== 'paid');
    if (hasUnpaidWalkin) return false;

    return true;
}

function renderSidebar() {
    const names = Object.keys(tables).sort((a,b) => a.localeCompare(b, 'cs'));
    document.getElementById('statTableCount').textContent = names.length;

    const freeTables = names.filter(n => isTableFreeNow(n)).length;
    document.getElementById('statBookingCount').textContent = freeTables;

    const query = (document.getElementById('tableSearchInput').value || '').toLowerCase();
    const list = document.getElementById('tableNavList');
    list.innerHTML = '';

    names.filter(n => n.toLowerCase().includes(query)).forEach(name => {
        const bookings = extractBookings(tables[name]).filter(b => isFutureOrToday(b.dateStr));
        const item = document.createElement('div');
        item.className = 'inn-table-nav-item' + (name === selectedTableName && currentView === 'detail' ? ' active' : '');
        item.innerHTML = `<span class="tn-name">${escapeHtml(name)}</span><span class="tn-count">${bookings.length}</span>`;
        item.addEventListener('click', () => {
            selectedTableName = name;
            switchView('detail');
        });
        list.appendChild(item);
    });

    if (names.length === 0) {
        list.innerHTML = '<p style="color:var(--muted); font-size:0.85em; padding:8px 4px;">Žádné stoly</p>';
    }
}

document.getElementById('tableSearchInput').addEventListener('input', renderSidebar);

// ════════════════════════════════════════════════════════════════════════
// VIEW SWITCHING
// ════════════════════════════════════════════════════════════════════════

function switchView(view) {
    if (view === 'users' && !(currentUser && currentUser.isAdmin)) return;
    if (view === 'settings' && !(currentUser && currentUser.isAdmin)) return;
    if (view === 'dailyMenu' && !(currentUser && currentUser.isAdmin)) return;
    if (view === 'layout' && !(currentUser && currentUser.isAdmin)) return;

    // Floorplan (design §6.4): "Uložit rozložení" is an explicit, separate
    // step — nothing in the editor persists on its own. Leaving the tab any
    // other way (another nav tile, table search, logout, …) would otherwise
    // silently throw away in-progress drags/resizes/room edits, so ask first
    // here, the in-app equivalent of the 'beforeunload' guard registered
    // below for closing/reloading the tab entirely.
    if (currentView === 'layout' && view !== 'layout' && layoutDirty) {
        if (!confirm('Máte neuložené změny rozložení. Opustit bez uložení?')) return;
        layoutDirty = false;
    }

    currentView = view;
    document.getElementById('viewOverviewBtn').classList.toggle('active', view === 'overview');
    document.getElementById('viewDetailBtn').classList.toggle('active', view === 'detail');
    document.getElementById('viewWaiterBtn').classList.toggle('active', view === 'waiter');
    document.getElementById('viewMenuBtn').classList.toggle('active', view === 'menu');
    document.getElementById('viewSalesBtn').classList.toggle('active', view === 'sales');
    document.getElementById('viewUsersBtn').classList.toggle('active', view === 'users');
    document.getElementById('viewSettingsBtn').classList.toggle('active', view === 'settings');
    document.getElementById('viewDailyMenuBtn').classList.toggle('active', view === 'dailyMenu');
    document.getElementById('viewLayoutBtn').classList.toggle('active', view === 'layout');
    document.getElementById('viewDetailBtn').disabled = !selectedTableName;
    document.getElementById('overviewView').style.display = view === 'overview' ? 'block' : 'none';
    document.getElementById('detailView').style.display = view === 'detail' ? 'block' : 'none';
    document.getElementById('waiterView').style.display = view === 'waiter' ? 'block' : 'none';
    document.getElementById('menuView').style.display = view === 'menu' ? 'block' : 'none';
    document.getElementById('salesView').style.display = view === 'sales' ? 'block' : 'none';
    document.getElementById('usersView').style.display = view === 'users' ? 'block' : 'none';
    document.getElementById('settingsView').style.display = view === 'settings' ? 'block' : 'none';
    document.getElementById('dailyMenuView').style.display = view === 'dailyMenu' ? 'block' : 'none';
    document.getElementById('layoutView').style.display = view === 'layout' ? 'block' : 'none';

    if (view === 'overview') renderOverview();
    else if (view === 'detail' && selectedTableName) renderDetail(selectedTableName);
    else if (view === 'waiter') renderWaiterView();
    else if (view === 'menu') renderMenuView();
    else if (view === 'sales') renderSalesView();
    else if (view === 'users') renderUsersView();
    else if (view === 'settings') renderSettingsView();
    else if (view === 'dailyMenu') renderDailyMenuView();
    else if (view === 'layout') renderLayoutView();

    renderSidebar();
}

document.getElementById('viewOverviewBtn').addEventListener('click', () => switchView('overview'));
document.getElementById('viewDetailBtn').addEventListener('click', () => { if (selectedTableName) switchView('detail'); });
document.getElementById('viewWaiterBtn').addEventListener('click', () => switchView('waiter'));
document.getElementById('viewMenuBtn').addEventListener('click', () => switchView('menu'));
document.getElementById('viewSalesBtn').addEventListener('click', () => switchView('sales'));
document.getElementById('viewUsersBtn').addEventListener('click', () => switchView('users'));
document.getElementById('viewSettingsBtn').addEventListener('click', () => switchView('settings'));
document.getElementById('viewDailyMenuBtn').addEventListener('click', () => switchView('dailyMenu'));
document.getElementById('viewLayoutBtn').addEventListener('click', () => switchView('layout'));

// Floorplan (design §6.4): browser-level equivalent of the in-app guard
// above — closing the tab, reloading, or navigating to a different URL
// entirely with unsaved layout edits gets the browser's own "leave site?"
// prompt. Most browsers ignore the custom returnValue text and show their
// own generic message, but both need to be set for cross-browser support.
window.addEventListener('beforeunload', (e) => {
    if (currentView === 'layout' && layoutDirty) {
        e.preventDefault();
        e.returnValue = '';
    }
});

// ════════════════════════════════════════════════════════════════════════
// OVERVIEW (ALL TABLES)
// ════════════════════════════════════════════════════════════════════════

// Floorplan (design §6.3): which room's floorplan the overview mini-plan is
// currently showing. Module-level so it survives renderOverview() being
// called again and again (every loadAllTables() refresh, every switchView
// back to 'overview') without resetting the admin's chosen room each time.
let overviewActiveRoomId = null;

async function renderOverview() {
    // Floorplan (design §6.3): the mini-plan needs settings.floorplan.rooms,
    // which normally only gets fetched by the Nastavení/Rozložení views.
    // Fetch it here too (once — reuse the cache afterwards, same as every
    // other consumer of settingsCache in this file) so the floorplan shows
    // up the very first time an admin opens Přehled, not only after they've
    // separately visited one of those other tabs first.
    if (!settingsCache) await fetchSettings();

    const container = document.getElementById('overviewView');
    const names = Object.keys(tables).sort((a, b) => {
        const aToday = extractBookings(tables[a]).some(bk => isToday(bk.dateStr));
        const bToday = extractBookings(tables[b]).some(bk => isToday(bk.dateStr));
        if (aToday !== bToday) return aToday ? -1 : 1;
        return a.localeCompare(b, 'cs');
    });

    if (names.length === 0) {
        container.innerHTML = `<div class="inn-empty-state"><div class="big">Zatím žádné stoly</div>Vytvořte první stůl v levém panelu.</div>`;
        return;
    }

    container.innerHTML = '';

    // ── Floorplan (design §6.3) — ADDITIVE ONLY. Inserted above the existing
    // per-table card grid below, which is otherwise completely untouched:
    // same markup, same data, same order. Read-only with respect to booking
    // state (no onTableClick-driven modal) — clicking a table just scrolls
    // to and briefly highlights that table's existing card. Falls back to
    // nothing at all when no rooms are configured yet (design §9), leaving
    // today's behaviour exactly as it was. ──
    const rooms = (settingsCache && settingsCache.floorplan && settingsCache.floorplan.rooms) || [];
    if (rooms.length > 0 && typeof FloorPlan !== 'undefined') {
        if (!overviewActiveRoomId || !rooms.some(r => r.id === overviewActiveRoomId)) {
            overviewActiveRoomId = rooms[0].id;
        }
        const fpTables = names.map(buildOverviewFpTable);
        const canvasHost = document.createElement('div');
        canvasHost.className = 'inn-overview-floorplan';
        container.appendChild(canvasHost);
        FloorPlan.render(canvasHost, {
            rooms,
            tables: fpTables,
            activeRoomId: overviewActiveRoomId,
            onRoomChange: (roomId) => { overviewActiveRoomId = roomId; renderOverview(); },
            onTableClick: scrollToOverviewCard,
        });
        // Occupied tables get no click handler from FloorPlan.render() itself
        // (see makeAllFloorplanTablesClickable's header comment) — bolt one
        // on so clicking a booked table still scrolls to its card too.
        makeAllFloorplanTablesClickable(canvasHost, scrollToOverviewCard);
    }

    const grid = document.createElement('div');
    grid.className = 'inn-overview-grid';

    names.forEach(name => {
        grid.appendChild(renderOverviewCard(name));
    });

    container.appendChild(grid);
}

// Builds one { name, seats, layout, state, sublabel } entry for the
// overview's read-only floorplan (design §5.1 render() contract). State is
// purely informational here (no click gating — see renderOverview's
// onTableClick), and sublabel carries today's booking count per design §6.3
// ("each table showing today's booking count") instead of the customer/
// waiter surfaces' "obsazeno"/"málo míst" wording.
function buildOverviewFpTable(name) {
    const t = tables[name];
    const todayCount = extractBookings(t).filter(b => isToday(b.dateStr)).length;
    return {
        name,
        seats: typeof t.seats === 'number' ? t.seats : undefined,
        layout: t.layout || null,
        state: isTableFreeNow(name) ? 'free' : 'occupied',
        sublabel: todayCount > 0 ? `dnes: ${todayCount}` : '',
    };
}

// Floorplan (design §6.3): "Clicking a table scrolls to and highlights that
// table's existing card." Matches by the data-table-name attribute
// renderOverviewCard() sets below, comparing in JS rather than building a
// CSS attribute-selector string out of a user-supplied table name (names can
// contain quotes/backslashes that would need escaping either way).
function scrollToOverviewCard(name) {
    const cards = document.querySelectorAll('#overviewView .inn-overview-card');
    for (const card of cards) {
        if (card.dataset.tableName === name) {
            card.scrollIntoView({ behavior: 'smooth', block: 'center' });
            card.classList.add('inn-oc-highlight');
            setTimeout(() => card.classList.remove('inn-oc-highlight'), 1600);
            return;
        }
    }
}

function renderOverviewCard(name) {
    const t = tables[name];
    const bookings = extractBookings(t).filter(b => isFutureOrToday(b.dateStr));
    const todayBookings = bookings.filter(b => isToday(b.dateStr));
    const laterBookings = bookings.filter(b => !isToday(b.dateStr)).slice(0, 3);

    const card = document.createElement('div');
    card.className = 'inn-overview-card' + (todayBookings.length > 0 ? ' has-today' : '');
    // Floorplan (design §6.3): lets scrollToOverviewCard() find this card
    // again from a floorplan table click.
    card.dataset.tableName = name;

    const header = document.createElement('div');
    header.className = 'inn-oc-header';
    header.innerHTML = `
        <span class="inn-oc-title">${escapeHtml(name)}</span>
        ${todayBookings.length > 0 ? `<span class="inn-oc-today-badge">Dnes: ${todayBookings.length}</span>` : ''}
    `;
    const editBtn = document.createElement('button');
    editBtn.className = 'inn-oc-edit-btn';
    editBtn.textContent = '✎ Upravit';
    editBtn.addEventListener('click', () => { selectedTableName = name; switchView('detail'); });
    header.appendChild(editBtn);
    card.appendChild(header);

    const attrsRow = document.createElement('div');
    attrsRow.className = 'inn-oc-attrs';
    (t.attributes || []).forEach(a => {
        const tag = document.createElement('span');
        tag.className = 'inn-oc-tag';
        tag.textContent = a;
        attrsRow.appendChild(tag);
    });
    card.appendChild(attrsRow);

    const body = document.createElement('div');
    body.className = 'inn-oc-body';

    const statRow = document.createElement('div');
    statRow.className = 'inn-oc-stat-row';
    statRow.innerHTML = `<span>Nadcházející rezervace</span><b>${bookings.length}</b>`;
    body.appendChild(statRow);

    // ─── TODAY'S RESERVATIONS ───────────────────────────────────────────
    const todayLabel = document.createElement('div');
    todayLabel.className = 'inn-oc-upcoming-label inn-oc-today-label';
    todayLabel.textContent = 'Dnešní rezervace';
    body.appendChild(todayLabel);

    if (todayBookings.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'inn-oc-empty-note';
        empty.textContent = 'Dnes žádná rezervace';
        body.appendChild(empty);
    } else {
        todayBookings.forEach(b => body.appendChild(renderOverviewBookingRow(name, b, true)));
    }

    // ─── LATER RESERVATIONS ──────────────────────────────────────────────
    if (laterBookings.length > 0) {
        const label = document.createElement('div');
        label.className = 'inn-oc-upcoming-label';
        label.textContent = 'Další rezervace';
        body.appendChild(label);
        laterBookings.forEach(b => body.appendChild(renderOverviewBookingRow(name, b, false)));
    }

    // ─── WALK-IN ORDERS (no reservation) ─────────────────────────────────
    // Only unpaid ones are shown — once marked paid it drops off the card,
    // same as the ask: "as that happens it will stop showing".
    const walkinOrders = indoorWalkinOrders.filter(o => o.tableName === name && o.paymentStatus !== 'paid');
    if (walkinOrders.length > 0) {
        const label = document.createElement('div');
        label.className = 'inn-oc-upcoming-label inn-oc-today-label';
        label.textContent = 'Objednávka u stolu (bez rezervace)';
        body.appendChild(label);
        walkinOrders.forEach(o => body.appendChild(renderWalkinOrderRow(o)));
    }

    card.appendChild(body);
    return card;
}

function orderItemsSummary(order) {
    if (!Array.isArray(order) || order.length === 0) return '';
    return order.map(i => `${i.qty}× ${i.item}`).join(', ');
}

function renderOverviewBookingRow(tableName, b, highlightToday) {
    const row = document.createElement('div');
    row.className = 'inn-oc-booking-row' + (highlightToday ? ' inn-oc-booking-today' : '');

    const dateLabel = isToday(b.dateStr) ? 'Dnes' : formatDateShort(b.dateStr);
    const itemsLine = orderItemsSummary(b.order);

    row.innerHTML = `
        <span class="inn-oc-booking-time">${dateLabel}<br><small>${escapeHtml(b.timeLabel)}</small></span>
        <span class="inn-oc-booking-who">
            ${escapeHtml(b.content)}
            ${itemsLine ? `<br><small style="color:var(--muted);">${escapeHtml(itemsLine)}</small>` : ''}
        </span>
        <span class="inn-status-cell">${statusPillHTML(b)}</span>
    `;

    wireStatusCellButtons(row, tableName, b);

    return row;
}

function renderWalkinOrderRow(order) {
    const row = document.createElement('div');
    row.className = 'inn-oc-booking-row inn-oc-booking-today';

    const itemsLine = (order.items || []).map(i => `${i.qty}× ${i.item}`).join(', ');
    // Table QR self-order (plan Task 6, spec §8.3) — guard explicitly on the
    // string, not truthiness: rows predating this feature have no `source`
    // field at all, and `undefined === 'qr'` is false, so they keep
    // rendering exactly as before with no badge.
    const qrBadge = order.source === 'qr' ? `<span class="inn-qr-badge" title="Objednáno hostem naskenováním QR kódu u stolu">QR</span>` : '';
    row.innerHTML = `
        <span class="inn-oc-booking-who" style="flex:1;">
            ${qrBadge}${order.guestName ? `${escapeHtml(order.guestName)} — ` : ''}${escapeHtml(itemsLine)}
            <br><small style="color:var(--muted); font-family:var(--mono);">${Number(order.total || 0).toFixed(0)} Kč</small>
        </span>
        <span class="inn-status-cell">
            <button type="button" class="inn-status-pill unpaid inn-pay-btn" title="Označit jako zaplaceno">Nezaplaceno</button>
            <button type="button" class="inn-btn small inn-payonline-btn" title="Platba online (QR kód / odkaz)">💳 Online</button>
        </span>
    `;

    row.querySelector('.inn-pay-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        markWalkinOrderPaid(order.id);
    });
    row.querySelector('.inn-payonline-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        payIndoorOrderOnline(order.id);
    });

    return row;
}

function statusPillHTML(booking) {
    // Future-proofed: shows real payment status once `isPaid`/`order` exist on the booking,
    // otherwise shows a neutral "no order data yet" pill.
    if (booking.order !== undefined || booking.isPaid !== undefined) {
        if (booking.isPaid) {
            const link = booking.receiptId
                ? ` <a class="inn-receipt-link" href="${receiptUrl(booking.receiptId)}" target="_blank" rel="noopener" title="Zobrazit účtenku">🧾</a>`
                : '';
            return `<span class="inn-status-pill paid">Zaplaceno</span>${link}`;
        }
        const hasOrder = Array.isArray(booking.order) && booking.order.length > 0;
        return `
            <button type="button" class="inn-status-pill unpaid inn-pay-btn" title="Označit jako zaplaceno">Nezaplaceno</button>
            ${hasOrder ? `<button type="button" class="inn-btn small inn-payonline-btn" title="Platba online (QR kód / odkaz)">💳 Online</button>` : ''}
        `;
    }
    return `<span class="inn-status-pill noorder">Bez objednávky</span>`;
}

// Wires up whatever pay buttons statusPillHTML rendered into `row` for a
// reservation booking (shared between the overview card and the detail
// view's bookings table, both of which build a row around statusPillHTML).
function wireStatusCellButtons(row, tableName, booking) {
    const payBtn = row.querySelector('.inn-pay-btn');
    if (payBtn) payBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        markReservationOrderPaid(tableName, booking);
    });
    const payOnlineBtn = row.querySelector('.inn-payonline-btn');
    if (payOnlineBtn) payOnlineBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        payReservationOrderOnline(tableName, booking);
    });
}

// ── Mark-as-paid actions ────────────────────────────────────────────────

// A reservation's order is written into every hour slot the booking spans
// (see applyBookingToTimetable on the server), so paying it off needs to
// touch every slot in that same run at once. Reconstruct the run by
// matching same day + same order payload, same convention the kitchen
// board's collectIndoorOrderEvents uses server-side.
function findReservationRun(tableName, booking) {
    const t = tables[tableName];
    if (!t || !t.fileId) return null;

    const sig = JSON.stringify(booking.order || null);
    const run = extractBookings(t).filter(b =>
        b.weekStartStr === booking.weekStartStr &&
        b.dayIdx === booking.dayIdx &&
        JSON.stringify(b.order || null) === sig
    );
    if (run.length === 0) return null;

    const hours = run.map(b => b.hourKey);
    return {
        fileId: t.fileId,
        dateStr: booking.weekStartStr,
        dayIndex: booking.dayIdx,
        startHour: Math.min(...hours),
        endHour: Math.max(...hours),
    };
}

async function markReservationOrderPaid(tableName, booking) {
    const run = findReservationRun(tableName, booking);
    if (!run) return;

    try {
        const res = await apiFetch(`${API_URL}/kitchen/reservation/mark-paid`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(run)
        });
        const result = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error('HTTP ' + res.status);
        showToastWithReceipt('Objednávka označena jako zaplacená', result.receiptId);
        await loadAllTables();
    } catch (e) {
        console.error(e);
        showToast('Nepodařilo se označit jako zaplaceno', true);
    }
}

async function markWalkinOrderPaid(orderId) {
    // Offline-first (spec §3.3): the payment is recorded locally and the
    // server call is a drain step, not a precondition. The barman must be
    // able to close a tab with the Wi-Fi down, and the guest is already
    // walking away.
    if (posReady) {
        try {
            const sale = await posMarkPaid(orderId);
            if (sale.state === POSDB.STATE.SYNCED) {
                showToastWithReceipt('Objednávka označena jako zaplacená', sale.receiptId);
            } else {
                // Deliberately different wording. "Paid" and "paid, and the
                // server knows" are not the same fact, and a barman who is
                // told the second when only the first is true has no way to
                // notice a queue that is quietly failing.
                showToast('Zaplaceno — účtenka se odešle po obnovení sítě');
            }
            await refreshWalkinAndRender();
            return;
        } catch (e) {
            console.error(e);
            showToast('Nepodařilo se označit jako zaplaceno', true);
            return;
        }
    }

    // No IndexedDB — fall back to the original online-only behaviour rather
    // than refusing to take money.
    try {
        const res = await apiFetch(`${API_URL}/indoor-orders/${orderId}/mark-paid`, { method: 'POST' });
        const result = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error('HTTP ' + res.status);
        showToastWithReceipt('Objednávka označena jako zaplacená', result.receiptId);
        await loadAllTables();
    } catch (e) {
        console.error(e);
        showToast('Nepodařilo se označit jako zaplaceno', true);
    }
}

// Refreshes the walk-in list and repaints the current view WITHOUT going
// through loadAllTables(), which also refetches every timetable and fails
// wholesale when offline — taking the repaint down with it.
async function refreshWalkinAndRender() {
    await fetchIndoorWalkinOrders();
    renderSidebar();
    if (currentView === 'overview') renderOverview();
    else if (selectedTableName && tables[selectedTableName]) renderDetail(selectedTableName);
    // Rows are rebuilt above, which means any per-row online-only control
    // (the GoPay buttons) is a fresh element without the disabled class.
    await posRefreshStatus();
}

// ════════════════════════════════════════════════════════════════════════
// ONLINE CARD PAYMENTS (GoPay) — "Zaplatit online" for table / reservation
// food orders.
//
// This screen is normally held by a waiter, not the guest, so the natural
// flow is: start the payment, then show a QR code encoding GoPay's
// redirectUrl for the guest to scan with their own phone (rather than
// redirecting *this* device, which would strand the waiter's screen on
// GoPay's checkout page). A plain link is offered too, in case staff want
// to open it directly (e.g. testing, or a tablet handed to the guest).
// In simulated mode (no GOPAY_* env vars configured) there's no real
// redirectUrl — show the dev-mode notice instead, and keep polling, since
// hitting the logged webhook URL server-side is what "pays" it.
// Status is polled every 3s while the modal is open; closing it stops
// polling (the actual payment can still complete server-side in the
// background — reopening the table will show it as paid once it does).
// ════════════════════════════════════════════════════════════════════════

let payOnlinePollHandle = null;

function stopPayOnlinePolling() {
    if (payOnlinePollHandle) clearInterval(payOnlinePollHandle);
    payOnlinePollHandle = null;
}

function openPayOnlineModal(title) {
    document.getElementById('payOnlineTitle').textContent = title || 'Platba online';
    document.getElementById('payOnlineModal').classList.add('active');
}

function setPayOnlineBody(html) {
    document.getElementById('payOnlineBody').innerHTML = html;
}

function closePayOnlineModal() {
    stopPayOnlinePolling();
    document.getElementById('payOnlineModal').classList.remove('active');
}

document.getElementById('payOnlineCloseBtn').addEventListener('click', closePayOnlineModal);
document.getElementById('payOnlineModal').addEventListener('click', (e) => {
    if (e.target.id === 'payOnlineModal') closePayOnlineModal();
});

// Renders the "payment just started" state: dev-mode notice, or a QR code
// + direct link to the real gateway.
function renderPayOnlineStarted(result) {
    if (result.simulated) {
        setPayOnlineBody(`
            <p class="inn-payonline-note"><strong>🧪 Testovací režim</strong><br>
            Platební brána zatím není nastavena (chybí GoPay přihlašovací údaje) — platba je simulována.
            Podrobnosti o tom, jak ji lokálně dokončit, najdete v konzoli serveru.</p>
            <p class="inn-payonline-waiting">⏳ Čekám na potvrzení platby…</p>
        `);
        return;
    }
    if (result.redirectUrl) {
        let svg = '';
        try { svg = QR.renderSVG(result.redirectUrl, { ecLevel: 'M', scale: 5 }); }
        catch (e) { console.error('QR render failed', e); }
        setPayOnlineBody(`
            <p class="inn-payonline-note">Nechte hosta naskenovat QR kód mobilem a dokončit platbu kartou.</p>
            <div class="inn-payonline-qr">${svg}</div>
            <p class="inn-payonline-note">Nebo otevřete platbu přímo na tomto zařízení:</p>
            <a class="inn-btn" href="${escapeHtmlAttr(result.redirectUrl)}" target="_blank" rel="noopener">Otevřít platební bránu ↗</a>
            <p class="inn-payonline-waiting">⏳ Čekám na potvrzení platby…</p>
        `);
        return;
    }
    setPayOnlineBody('<p class="inn-payonline-failed">Platbu se nepodařilo zahájit.</p>');
}

function renderPayOnlinePaid(receiptId) {
    const link = receiptId
        ? `<a class="inn-btn primary" href="${receiptUrl(receiptId)}" target="_blank" rel="noopener">🧾 Zobrazit účtenku</a>`
        : '';
    setPayOnlineBody(`<p class="inn-payonline-paid">✅ Zaplaceno</p>${link}`);
    showToast('Platba přijata');
}

function renderPayOnlineFailed() {
    setPayOnlineBody('<p class="inn-payonline-failed">Platba se nezdařila nebo vypršela. Zavřete okno a zkuste to prosím znovu.</p>');
    showToast('Platba se nezdařila', true);
}

// checkFn resolves to true once polling should stop (paid, failed, or a
// hard error) — the modal itself decides what to render along the way.
function startPayOnlinePolling(checkFn) {
    stopPayOnlinePolling();
    payOnlinePollHandle = setInterval(async () => {
        try {
            const done = await checkFn();
            if (done) stopPayOnlinePolling();
        } catch (e) {
            console.error('Payment status poll failed:', e);
        }
    }, 3000);
}

// Table / walk-in order, no reservation attached — POST /indoor-orders/:id/pay-online.
async function payIndoorOrderOnline(orderId) {
    openPayOnlineModal('Platba online — objednávka u stolu');
    setPayOnlineBody('<p class="inn-payonline-note">Zahajuji platbu…</p>');

    try {
        const res = await apiFetch(`${API_URL}/indoor-orders/${orderId}/pay-online`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });
        const result = await res.json();
        if (!res.ok) throw new Error(result.error || 'Nepodařilo se zahájit platbu');

        renderPayOnlineStarted(result);
        startPayOnlinePolling(async () => {
            const r = await apiFetch(`${API_URL}/payments/${orderId}/status`);
            if (!r.ok) return false;
            const st = await r.json();
            if (st.paymentStatus === 'paid') {
                await loadAllTables();
                const fresh = indoorWalkinOrders.find(o => o.id === orderId);
                renderPayOnlinePaid(fresh && fresh.receiptId);
                if (currentView === 'overview') renderOverview();
                return true;
            }
            if (st.paymentStatus === 'refunded') { renderPayOnlineFailed(); return true; }
            return false;
        });
    } catch (e) {
        console.error(e);
        setPayOnlineBody(`<p class="inn-payonline-failed">${escapeHtml(e.message || 'Nepodařilo se zahájit platbu')}</p>`);
    }
}

// Reservation-attached food order — POST /kitchen/reservation/pay-online.
// Same run-reconstruction as markReservationOrderPaid (the order lives on
// every hour slot the booking spans).
async function payReservationOrderOnline(tableName, booking) {
    const run = findReservationRun(tableName, booking);
    if (!run) return;

    openPayOnlineModal(`Platba online — ${tableName}`);
    setPayOnlineBody('<p class="inn-payonline-note">Zahajuji platbu…</p>');

    try {
        const res = await apiFetch(`${API_URL}/kitchen/reservation/pay-online`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(run)
        });
        const result = await res.json();
        if (!res.ok) throw new Error(result.error || 'Nepodařilo se zahájit platbu');

        renderPayOnlineStarted(result);
        startPayOnlinePolling(async () => {
            const r = await apiFetch(`${API_URL}/payments/tx/${encodeURIComponent(result.gatewayTransactionId)}/status`);
            if (!r.ok) return false;
            const st = await r.json();
            if (st.status === 'paid') {
                await loadAllTables();
                const t2 = tables[tableName];
                const fresh = t2 && extractBookings(t2).find(b =>
                    b.weekStartStr === run.dateStr && b.dayIdx === run.dayIndex && b.hourKey === run.startHour
                );
                renderPayOnlinePaid(fresh && fresh.receiptId);
                if (currentView === 'overview') renderOverview();
                else if (selectedTableName === tableName) renderDetail(tableName);
                return true;
            }
            if (st.status === 'failed') { renderPayOnlineFailed(); return true; }
            return false;
        });
    } catch (e) {
        console.error(e);
        setPayOnlineBody(`<p class="inn-payonline-failed">${escapeHtml(e.message || 'Nepodařilo se zahájit platbu')}</p>`);
    }
}

function formatDateShort(dateStr) {
    const parts = dateStr.split('-');
    if (parts.length !== 3) return dateStr;
    const [y, m, d] = parts;
    return `${parseInt(d, 10)}.${parseInt(m, 10)}.`;
}

// ════════════════════════════════════════════════════════════════════════
// TABLE QR SELF-ORDER — admin panel + kitchen badge (plan Task 6, spec §8.3)
// ────────────────────────────────────────────────────────────────────────
// The signed per-table capability token is minted SERVER-SIDE ONLY — this
// client never sees, holds, or could reconstruct the signing key, only the
// finished token GET /table-qr-tokens (requireAuth) hands back. That route
// is deliberately separate from the public GET /timetables list (which
// renderer.js also depends on staying public) — see its header comment in
// server.js for why folding QR tokens into that response would defeat the
// whole point of a signed capability.
// ════════════════════════════════════════════════════════════════════════

// Cached across the whole admin session: a table's fileId (what the token is
// derived from) never changes once created, so re-minting on every
// renderDetail() call/print click would just be wasted round-trips. The
// cache is invalidated (see loadAllTables()/deleteTable() below) wherever a
// table could plausibly have been created, renamed or deleted since the last
// fetch, so a stale className/URL never lingers longer than one reload.
let tableQrTokensCache = null;

async function fetchTableQrTokens() {
    if (tableQrTokensCache) return tableQrTokensCache;
    try {
        const res = await apiFetch(`${API_URL}/table-qr-tokens`);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        tableQrTokensCache = await res.json();
    } catch (e) {
        console.error('Failed to load table QR tokens:', e);
        tableQrTokensCache = [];
    }
    return tableQrTokensCache;
}

// Populates the QR panel inside a table's detail view. Split out of
// renderDetail() itself because the token fetch is async while renderDetail()
// is not — the panel starts in a "Načítání…" state and this function fills
// it in once the (possibly cached) tokens resolve. Guards on
// `selectedTableName === name` before touching the DOM: the admin may have
// clicked to a different table, or away from the detail view entirely,
// while this request was in flight, and painting a slow response into a
// panel nobody's looking at would be a silent bug waiting to happen.
async function renderTableQrPanel(panel, name) {
    const tokens = await fetchTableQrTokens();
    if (selectedTableName !== name || currentView !== 'detail') return;

    const entry = tokens.find(t => t.className === name);
    if (!entry) {
        panel.innerHTML = `
            <h3>QR kód pro objednávky u stolu</h3>
            <p class="inn-oc-empty-note" style="margin:0;">QR kód se nepodařilo vygenerovat. Zkuste stránku obnovit.</p>
        `;
        return;
    }

    // Same call site/options as the payment QR at renderPayOnlineStarted()
    // (inner.js ~1517) — 'M' error-correction and scale 5 are what that
    // call already established as legible on a phone camera from table
    // distance, so this reuses it rather than picking new numbers.
    let svg = '';
    try { svg = QR.renderSVG(entry.url, { ecLevel: 'M', scale: 5 }); }
    catch (e) { console.error('QR render failed', e); }

    panel.innerHTML = `
        <h3>QR kód pro objednávky u stolu</h3>
        <div class="inn-qr-panel__code">${svg}</div>
        <p class="inn-qr-panel__url">${escapeHtml(entry.url)}</p>
        <button type="button" class="inn-btn" id="tableQrPrintBtn">Tisknout</button>
    `;
    panel.querySelector('#tableQrPrintBtn').addEventListener('click', () => printTableQrSheet([entry]));
}

// Builds an in-page print sheet — one card per table entry — rather than a
// popup window: a fresh window.open() document has neither QR.renderSVG nor
// this app's CSS loaded, and re-injecting both into a popup is more moving
// parts for no benefit. Instead this appends an overlay to the CURRENT
// document and relies on the `@media print` rules in inner.css (which hide
// every other top-level element while the overlay is present) so Ctrl+P /
// this function's own window.print() call produces just the cards. Used by
// both the single-table "Tisknout" button above (one entry) and the
// Rozložení view's "Tisknout QR kódy všech stolů" button (every table).
function printTableQrSheet(entries) {
    if (!entries || entries.length === 0) {
        showToast('Nejsou k dispozici žádné QR kódy k tisku', true);
        return;
    }

    const existing = document.getElementById('tableQrPrintSheet');
    if (existing) existing.remove();

    const sheet = document.createElement('div');
    sheet.id = 'tableQrPrintSheet';
    sheet.className = 'inn-print-sheet';

    entries.forEach(entry => {
        let svg = '';
        try { svg = QR.renderSVG(entry.url, { ecLevel: 'M', scale: 5 }); }
        catch (e) { console.error('QR render failed', e); }

        const card = document.createElement('div');
        card.className = 'inn-print-card';
        card.innerHTML = `
            <div class="inn-print-card__name">${escapeHtml(entry.className)}</div>
            <div class="inn-print-card__code">${svg}</div>
            <div class="inn-print-card__caption">Naskenujte a objednejte</div>
        `;
        sheet.appendChild(card);
    });

    document.body.appendChild(sheet);

    // 'afterprint' fires whether the admin actually printed or hit Cancel in
    // the print dialog, so this is the one reliable place to tear the
    // overlay back down — leaving it in the DOM would mean it silently
    // reappears (still hidden on screen, but present) the next time
    // anything calls window.print() for an unrelated reason.
    function cleanup() {
        sheet.remove();
        window.removeEventListener('afterprint', cleanup);
    }
    window.addEventListener('afterprint', cleanup);

    window.print();
}

// ════════════════════════════════════════════════════════════════════════
// DETAIL VIEW (SINGLE TABLE — FULL EDIT)
// ════════════════════════════════════════════════════════════════════════

function renderDetail(name) {
    const t = tables[name];
    if (!t) { switchView('overview'); return; }

    const container = document.getElementById('detailView');
    container.innerHTML = '';

    // Header
    const header = document.createElement('div');
    header.className = 'inn-detail-header';
    header.innerHTML = `
        <div class="inn-detail-title-block">
            <h2>${escapeHtml(name)}</h2>
        </div>
        <div class="inn-detail-actions">
            <button class="inn-btn" id="backToOverviewBtn">← Zpět na přehled</button>
            <button class="inn-btn danger" id="deleteTableBtn" style="${isAdmin() ? '' : 'display:none;'}">Smazat stůl</button>
        </div>
    `;
    container.appendChild(header);

    // Panels: basic info + attributes
    const panels = document.createElement('div');
    panels.className = 'inn-detail-panels';

    // Info panel
    const infoPanel = document.createElement('div');
    infoPanel.className = 'inn-panel';
    infoPanel.innerHTML = `
        <h3>Základní informace</h3>
        <div class="inn-field-group">
            <label for="detailNameInput">Název stolu</label>
            <input type="text" id="detailNameInput" value="${escapeHtmlAttr(name)}">
        </div>
        <div class="inn-field-group">
            <label for="detailDescInput">Popis</label>
            <textarea id="detailDescInput">${escapeHtml(t.info || '')}</textarea>
        </div>
        <button class="inn-btn primary" id="saveInfoBtn" style="margin-top:4px;">Uložit informace</button>
    `;
    panels.appendChild(infoPanel);

    // Attributes panel
    const attrPanel = document.createElement('div');
    attrPanel.className = 'inn-panel';
    attrPanel.innerHTML = `
        <h3>Vlastnosti stolu</h3>
        <div class="inn-attr-edit-row">
            <input type="text" id="newAttrInput" placeholder="Např. U okna, 4 místa…">
            <button class="inn-attr-add-btn-small" id="addAttrBtn">+ Přidat</button>
        </div>
        <div class="inn-attr-tag-edit-list" id="attrTagList"></div>
    `;
    panels.appendChild(attrPanel);

    container.appendChild(panels);

    // Bookings panel
    const bookingsPanel = document.createElement('div');
    bookingsPanel.className = 'inn-bookings-panel';
    bookingsPanel.innerHTML = `<h3 style="font-family:var(--mono); font-size:0.75em; text-transform:uppercase; letter-spacing:0.12em; color:var(--muted); margin:0 0 14px;">Rezervace tohoto stolu</h3>`;

    const bookings = extractBookings(t);
    const table = document.createElement('table');
    table.className = 'inn-bookings-table';
    table.innerHTML = `
        <thead>
            <tr>
                <th>Datum</th>
                <th>Den</th>
                <th>Čas</th>
                <th>Rezervace</th>
                <th>Objednávka</th>
                <th>Platba</th>
                <th></th>
            </tr>
        </thead>
        <tbody id="bookingsTbody"></tbody>
    `;
    bookingsPanel.appendChild(table);

    if (bookings.length === 0) {
        const p = document.createElement('p');
        p.className = 'inn-oc-empty-note';
        p.style.marginTop = '6px';
        p.textContent = 'Tento stůl zatím nemá žádné rezervace.';
        bookingsPanel.appendChild(p);
    }

    container.appendChild(bookingsPanel);

    // QR panel (plan Task 6, spec §8.3) — the code itself loads async (it
    // depends on a staff-authenticated fetch), so it starts in a loading
    // state and renderTableQrPanel() fills it in once tokens resolve.
    const qrPanel = document.createElement('div');
    qrPanel.className = 'inn-panel inn-qr-panel';
    qrPanel.innerHTML = `
        <h3>QR kód pro objednávky u stolu</h3>
        <p class="inn-oc-empty-note" style="margin:0;">Načítání…</p>
    `;
    container.appendChild(qrPanel);
    renderTableQrPanel(qrPanel, name);

    // Wire up tbody rows
    const tbody = table.querySelector('#bookingsTbody');
    bookings.forEach(b => tbody.appendChild(renderBookingRow(name, b)));

    renderAttrTagList(name);

    // Event listeners
    document.getElementById('backToOverviewBtn').addEventListener('click', () => switchView('overview'));
    document.getElementById('deleteTableBtn').addEventListener('click', () => deleteTable(name));
    document.getElementById('saveInfoBtn').addEventListener('click', () => saveInfo(name));
    document.getElementById('addAttrBtn').addEventListener('click', () => addAttribute(name));
    document.getElementById('newAttrInput').addEventListener('keypress', e => {
        if (e.key === 'Enter') { e.preventDefault(); addAttribute(name); }
    });
}

function renderBookingRow(tableName, booking) {
    const tr = document.createElement('tr');

    const permBadge = booking.isPermanent ? `<span class="inn-perm-badge">trvalá</span>` : '';

    tr.innerHTML = `
        <td class="inn-bk-date">${escapeHtml(booking.dateStr)}</td>
        <td>${escapeHtml(booking.dayLabel)}</td>
        <td class="inn-bk-time">${escapeHtml(booking.timeLabel)}</td>
        <td>
            <input type="text" class="inn-bk-content-input" value="${escapeHtmlAttr(booking.content)}" ${isAdmin() ? '' : 'disabled'}>
            ${permBadge}
        </td>
        <td>${orderCellHTML(booking)}</td>
        <td><span class="inn-status-cell">${statusPillHTML(booking)}</span></td>
        <td><button class="inn-bk-delete-btn" title="Smazat rezervaci" style="${isAdmin() ? '' : 'display:none;'}">✕</button></td>
    `;

    const input = tr.querySelector('.inn-bk-content-input');
    input.addEventListener('change', () => {
        updateBookingContent(tableName, booking, input.value);
    });

    tr.querySelector('.inn-bk-delete-btn').addEventListener('click', () => {
        deleteBooking(tableName, booking);
    });

    wireStatusCellButtons(tr, tableName, booking);

    return tr;
}

function orderCellHTML(booking) {
    // Placeholder until order data exists — reads booking.order if present so
    // this slots in automatically once the ordering feature is built.
    if (Array.isArray(booking.order) && booking.order.length > 0) {
        const items = booking.order.map(i => escapeHtml(i.item || '')).join(', ');
        return `<span style="font-size:0.85em;">${items}</span>`;
    }
    return `<span style="color:var(--muted); font-size:0.85em; font-style:italic;">—</span>`;
}

function renderAttrTagList(name) {
    const list = document.getElementById('attrTagList');
    if (!list) return;
    list.innerHTML = '';
    const attrs = tables[name].attributes || [];
    if (attrs.length === 0) {
        list.innerHTML = '<span style="color:var(--muted); font-size:0.85em; font-style:italic;">Žádné vlastnosti</span>';
        return;
    }
    attrs.forEach(attr => {
        const tag = document.createElement('span');
        tag.className = 'inn-attr-tag-removable';
        tag.innerHTML = `${escapeHtml(attr)} <button title="Odebrat">×</button>`;
        tag.querySelector('button').addEventListener('click', () => removeAttribute(name, attr));
        list.appendChild(tag);
    });
}

// ════════════════════════════════════════════════════════════════════════
// MUTATIONS (PUT to API)
// ════════════════════════════════════════════════════════════════════════

async function persistTimetable(name, overrides = {}) {
    const t = tables[name];
    if (!t) return false;
    const payload = {
        fileId: t.fileId,
        data: overrides.data !== undefined ? overrides.data : t.data,
        info: overrides.info !== undefined ? overrides.info : (t.info || ''),
        attributes: overrides.attributes !== undefined ? overrides.attributes : (t.attributes || []),
        calendar: t.calendar,
        currentWeek: t.currentWeek,
        permanentHours: t.permanentHours,
        // Floorplan (design doc §8, persistence hazard #2): this payload is
        // rebuilt field-by-field rather than spreading `t`, so any field not
        // explicitly listed here is silently dropped on every save through
        // this function — which is EVERY table save (description, attributes,
        // booking edits, and the layout editor's own per-table PUTs all funnel
        // through here). Before this fix, editing a table's description would
        // silently wipe its floorplan placement. Same overrides-or-fallback
        // pattern as the fields above.
        seats: overrides.seats !== undefined ? overrides.seats : t.seats,
        layout: overrides.layout !== undefined ? overrides.layout : (t.layout || null),
    };
    try {
        const res = await apiFetch(`${API_URL}/timetables/${encodeURIComponent(name)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        Object.assign(t, payload, { className: name });
        return true;
    } catch (e) {
        console.error(e);
        showToast('Uložení se nezdařilo', true);
        return false;
    }
}

async function saveInfo(name) {
    const newName = document.getElementById('detailNameInput').value.trim();
    const newDesc = document.getElementById('detailDescInput').value;

    if (!newName) { showToast('Název nesmí být prázdný', true); return; }

    if (newName !== name) {
        // Renaming is ONE server-side operation (POST /timetables/:name/rename)
        // that mutates className on the existing record.
        //
        // It used to be done here as create-under-the-new-name + copy every
        // field across + delete the old one — except the delete was only ever
        // `delete tables[name]`, a client-side object key, so the server kept
        // the old record forever and every rename quietly duplicated the table.
        // Once tables gained floorplan placements the duplicate inherited the
        // same coordinates, so the two stacked on one spot and the orphan was
        // still bookable.
        //
        // Renaming in place removes the whole class of bug rather than patching
        // it: nothing is copied (so nothing can be copied incompletely), there
        // is no window where both names exist, `fileId` and reservations stay
        // put because it is the same row, and the server moves any OPEN walk-in
        // orders — which key off the table's name, not its fileId — over in the
        // same transaction so a tab can't go missing. See the route's header
        // comment in server.js for why paid orders deliberately don't move.
        try {
            // The description shares this form with the name. Save it first,
            // while the record still answers to its current name, so that one
            // reload at the end shows a fully-applied state rather than a
            // rename with a stale description.
            if ((tables[name].info || '') !== newDesc) {
                const infoOk = await persistTimetable(name, { info: newDesc });
                if (!infoOk) return; // persistTimetable already surfaced the error
            }

            const res = await apiFetch(`${API_URL}/timetables/${encodeURIComponent(name)}/rename`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ newName })
            });
            const result = await res.json().catch(() => ({}));
            // Surface the server's own message — a name clash (409) says which
            // name is taken, which is exactly what the admin needs to hear.
            if (!res.ok) throw new Error(result.error || 'Přejmenování se nezdařilo');

            if (selectedTableName === name) selectedTableName = newName;
            await loadAllTables();
            showToast(result.ordersMoved > 0
                ? `Stůl přejmenován, přesunuto objednávek: ${result.ordersMoved}`
                : 'Stůl přejmenován');
        } catch (e) {
            console.error(e);
            showToast(e.message || 'Přejmenování se nezdařilo', true);
        }
        return;
    }

    const ok = await persistTimetable(name, { info: newDesc });
    if (ok) {
        showToast('Informace uloženy');
        renderSidebar();
        if (currentView === 'overview') renderOverview();
    }
}

async function addAttribute(name) {
    const input = document.getElementById('newAttrInput');
    const val = input.value.trim();
    if (!val) return;
    const t = tables[name];
    const attrs = t.attributes || [];
    if (attrs.includes(val)) { showToast('Tato vlastnost už existuje', true); return; }
    const updated = [...attrs, val];
    const ok = await persistTimetable(name, { attributes: updated });
    if (ok) {
        input.value = '';
        renderAttrTagList(name);
        renderSidebar();
    }
}

async function removeAttribute(name, attr) {
    const t = tables[name];
    const updated = (t.attributes || []).filter(a => a !== attr);
    const ok = await persistTimetable(name, { attributes: updated });
    if (ok) renderAttrTagList(name);
}

async function updateBookingContent(name, booking, newContent) {
    const t = tables[name];
    const data = JSON.parse(JSON.stringify(t.data || {}));
    const dayData = data[booking.weekStartStr];
    if (!dayData) return;

    const hourSlot = Array.isArray(dayData) ? dayData[booking.dayIdx] : dayData[booking.dayIdx];
    if (!hourSlot) return;

    if (newContent.trim() === '') {
        delete hourSlot[booking.hourKey];
    } else {
        hourSlot[booking.hourKey] = { ...hourSlot[booking.hourKey], content: newContent.trim() };
    }

    const ok = await persistTimetable(name, { data });
    if (ok) {
        showToast('Rezervace upravena');
        renderDetail(name);
        renderSidebar();
    }
}

async function deleteBooking(name, booking) {
    if (!confirm(`Smazat rezervaci „${booking.content}“ (${formatDateShort(booking.dateStr)}, ${booking.timeLabel})?`)) return;

    const t = tables[name];
    const data = JSON.parse(JSON.stringify(t.data || {}));
    const dayData = data[booking.weekStartStr];
    if (!dayData) return;
    const hourSlot = Array.isArray(dayData) ? dayData[booking.dayIdx] : dayData[booking.dayIdx];
    if (!hourSlot) return;

    delete hourSlot[booking.hourKey];

    const ok = await persistTimetable(name, { data });
    if (ok) {
        showToast('Rezervace smazána');
        renderDetail(name);
        renderSidebar();
    }
}

async function deleteTable(name) {
    if (!confirm(`Opravdu smazat stůl „${name}“? Tuto akci nelze vrátit zpět.`)) return;
    const t = tables[name];
    try {
        // Mirror the customer app's soft-delete-by-name approach
        const deleted = JSON.parse(localStorage.getItem('deletedClasses') || '[]');
        if (!deleted.includes(name)) deleted.push(name);
        localStorage.setItem('deletedClasses', JSON.stringify(deleted));

        if (t.fileId) {
            apiFetch(`${API_URL}/timetables/file/${t.fileId}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } }).catch(() => {});
        }

        delete tables[name];
        selectedTableName = null;
        // See loadAllTables() — this path deletes locally without a full
        // reload, so the QR token cache needs the same invalidation here or
        // a subsequent print-all sheet would still include the deleted table.
        tableQrTokensCache = null;
        showToast('Stůl smazán');
        switchView('overview');
    } catch (e) {
        console.error(e);
        showToast('Smazání se nezdařilo', true);
    }
}

// ════════════════════════════════════════════════════════════════════════
// NEW TABLE MODAL
// ════════════════════════════════════════════════════════════════════════

document.getElementById('newTableBtn').addEventListener('click', () => {
    document.getElementById('newTableName').value = '';
    document.getElementById('newTableDesc').value = '';
    document.getElementById('newTableModal').classList.add('active');
});
document.getElementById('newTableCancelBtn').addEventListener('click', () => {
    document.getElementById('newTableModal').classList.remove('active');
});
document.getElementById('newTableModal').addEventListener('click', e => {
    if (e.target.id === 'newTableModal') document.getElementById('newTableModal').classList.remove('active');
});

document.getElementById('newTableCreateBtn').addEventListener('click', async () => {
    const name = document.getElementById('newTableName').value.trim();
    const desc = document.getElementById('newTableDesc').value;
    if (!name) { showToast('Zadejte název stolu', true); return; }
    if (tables[name]) { showToast('Stůl s tímto názvem už existuje', true); return; }

    try {
        const res = await apiFetch(`${API_URL}/timetables`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, info: desc })
        });
        const created = await res.json();
        if (!res.ok) throw new Error(created.error || 'Chyba');

        document.getElementById('newTableModal').classList.remove('active');
        showToast('Stůl vytvořen');
        await loadAllTables();
        selectedTableName = name;
        switchView('detail');
    } catch (e) {
        console.error(e);
        showToast('Vytvoření se nezdařilo', true);
    }
});

// ════════════════════════════════════════════════════════════════════════
// UTIL
// ════════════════════════════════════════════════════════════════════════

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str ?? '';
    return div.innerHTML;
}
function escapeHtmlAttr(str) {
    return (str ?? '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function updateClock() {
    const now = new Date();
    document.getElementById('clockText').textContent = now.toLocaleString('cs-CZ', { dateStyle: 'medium', timeStyle: 'short' });
}
setInterval(updateClock, 1000 * 30);
updateClock();

// ════════════════════════════════════════════════════════════════════════
// INIT
// ════════════════════════════════════════════════════════════════════════

(async function init() {
    // This tool runs on a wide tablet as often as on a monitor, and a tablet
    // is a touch device with no hover: every :hover rule here is behind
    // @media (hover: hover), so the :active states are the ONLY feedback a
    // tap gets. Safari applies :active to an element only once the document
    // carries a touch listener, so without this the ink fill never fires on
    // an iPad and a tap looks like nothing happened.
    document.addEventListener('touchstart', () => {}, { passive: true });

    document.getElementById('gateApiInput').value = API_BASE_URL;

    // The queue comes up BEFORE the first server contact, so a till that
    // boots with no network already has somewhere to put a sale.
    await posInit();

    const ok = await tryConnect(API_BASE_URL);
    if (!ok) {
        if (await posCanRunOffline()) {
            await enterOfflineMode();
        } else {
            // Genuinely nothing to work from — a first run on this device,
            // or a wrong server address. The connect gate is the right
            // answer here and only here.
            document.getElementById('gateOverlay').style.display = 'flex';
        }
    }
})();

// ════════════════════════════════════════════════════════════════════════
// MENU  –  local storage backed, full CRUD with categories
// ════════════════════════════════════════════════════════════════════════

const MENU_CATEGORIES = [
    { id: 'main',  label: 'Hlavní jídla', icon: '🍖' },
    { id: 'side',  label: 'Přílohy', icon: '🥔' },
    { id: 'drinks',label: 'Nápoje', icon: '🥤' },
    { id: 'desserts', label: 'Dezerty', icon: '🍰' },
];

// ── Persistence (server-backed, shared across devices) ─────────────────────

let menuCache = {};

async function fetchMenu() {
    try {
        const res = await apiFetch(`${API_URL}/menu`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        menuCache = await res.json();
    } catch (e) {
        console.error('Failed to load menu:', e);
        showToast('Nepodařilo se načíst menu ze serveru', true);
    }
    return menuCache;
}

async function persistMenu(menu) {
    menuCache = menu;
    try {
        const res = await apiFetch(`${API_URL}/menu`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(menu)
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (e) {
        console.error('Failed to save menu:', e);
        showToast('Nepodařilo se uložit menu na server', true);
    }
}

// Kept as a synchronous accessor for the current in-memory copy
function loadMenu() {
    return menuCache;
}

// ── Render ───────────────────────────────────────────────────────────────

async function renderMenuView() {
    const container = document.getElementById('menuView');
    const menu = await fetchMenu();
    // go-live combo menus (spec: docs/superpowers/specs/2026-07-22-combo-
    // menus-design.md, plan Task 2): combos reference dishes by id, so the
    // menu must already be loaded (above) before the combo section builds
    // its dish dropdowns/summaries/missing-dish check.
    const combos = await fetchCombos();

    container.innerHTML = '';

    // Header
    const header = document.createElement('div');
    header.className = 'inn-menu-header';
    header.innerHTML = `<h2>Jídelní lístek</h2>`;
    container.appendChild(header);

    // Combo menus ("Zvýhodněná menu") — rendered ABOVE the regular
    // categories per the spec, using the same "category section" visual
    // language (inn-menu-category / inn-menu-dishes-grid) as the categories
    // below so the whole view reads as one consistent list.
    container.appendChild(buildComboSection(combos));

    // Categories
    const categoriesEl = document.createElement('div');
    categoriesEl.className = 'inn-menu-categories';

    MENU_CATEGORIES.forEach(cat => {
        const dishes = menu[cat.id] || [];
        const section = document.createElement('div');
        section.className = 'inn-menu-category';

        // Category header
        const catHeader = document.createElement('div');
        catHeader.className = 'inn-menu-cat-header';
        catHeader.innerHTML = `
            <h3>${cat.icon} ${escapeHtml(cat.label)}
                <span class="inn-menu-cat-count">${dishes.length} položek</span>
            </h3>
        `;
        section.appendChild(catHeader);

        // Dishes grid
        const grid = document.createElement('div');
        grid.className = 'inn-menu-dishes-grid';

        if (dishes.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'inn-menu-empty';
            empty.textContent = 'Zatím žádné položky v této kategorii.';
            grid.appendChild(empty);
        }

        dishes.forEach(dish => {
            grid.appendChild(buildDishCard(dish, cat.id));
        });

        // Add new card (admin only)
        if (isAdmin()) {
            const addCard = document.createElement('div');
            addCard.className = 'inn-dish-add-card';
            addCard.innerHTML = `<span class="plus">+</span><span>Přidat pokrm</span>`;
            addCard.addEventListener('click', () => openDishModal(cat.id, null));
            grid.appendChild(addCard);
        }

        section.appendChild(grid);
        categoriesEl.appendChild(section);
    });

    container.appendChild(categoriesEl);
}

function buildDishCard(dish, categoryId) {
    const card = document.createElement('div');
    card.className = 'inn-dish-card' + (dish.soldOut ? ' is-soldout' : '');

    if (dish.imageUrl) {
        const img = document.createElement('img');
        img.className = 'inn-dish-img';
        img.src = dish.imageUrl;
        img.alt = dish.name;
        img.onerror = function() {
            this.replaceWith(makePlaceholder());
        };
        card.appendChild(img);
    } else {
        card.appendChild(makePlaceholder());
    }

    const body = document.createElement('div');
    body.className = 'inn-dish-body';
    body.innerHTML = `
        <div class="inn-dish-name">${escapeHtml(dish.name)}</div>
        ${dish.info ? `<div class="inn-dish-info">${escapeHtml(dish.info)}</div>` : ''}
        <div class="inn-dish-price">${dish.price != null ? Number(dish.price).toFixed(0) + ' Kč' : '—'} <small style="color:var(--muted); font-weight:500;">· DPH ${dish.vatRate != null ? dish.vatRate : 12} %</small></div>
    `;
    card.appendChild(body);

    // go-live Task 3 (spec §5): quick "Vyprodáno" toggle directly in the
    // list row, no need to open the dish editor modal for the common daily
    // action (kitchen ran out of something). Admins get a clickable pill
    // that flips soldOut and saves immediately; everyone else (who can't
    // toggle it — PUT /menu is admin+CSRF-gated server-side) just sees a
    // plain read-only badge when a dish is sold out, so waiters/kitchen
    // staff still know not to offer it.
    const footerRow = document.createElement('div');
    footerRow.className = 'inn-dish-footer';
    if (isAdmin()) {
        const toggleBtn = document.createElement('button');
        toggleBtn.type = 'button';
        toggleBtn.className = 'inn-status-pill' + (dish.soldOut ? ' unpaid' : ' paid');
        toggleBtn.textContent = dish.soldOut ? 'Vyprodáno' : 'Dostupné';
        toggleBtn.title = dish.soldOut ? 'Klikněte pro obnovení dostupnosti' : 'Klikněte pro označení jako vyprodané';
        toggleBtn.addEventListener('click', (e) => {
            e.stopPropagation(); // don't also open the dish edit modal
            toggleDishSoldOut(categoryId, dish.id);
        });
        footerRow.appendChild(toggleBtn);
    } else if (dish.soldOut) {
        const badge = document.createElement('span');
        badge.className = 'inn-status-pill unpaid';
        badge.textContent = 'Vyprodáno';
        footerRow.appendChild(badge);
    }
    if (footerRow.childNodes.length > 0) card.appendChild(footerRow);

    if (isAdmin()) {
        card.style.cursor = 'pointer';
        card.addEventListener('click', () => openDishModal(categoryId, dish));
    }
    return card;
}

// Flips one dish's soldOut flag in place and persists the whole menu (same
// full-object PUT /menu as the dish editor modal uses) — the admin menu-list
// "quick toggle" (go-live Task 3, spec §5), no modal round-trip needed.
async function toggleDishSoldOut(categoryId, dishId) {
    const menu = loadMenu();
    const dish = (menu[categoryId] || []).find(d => d.id === dishId);
    if (!dish) return;
    dish.soldOut = !dish.soldOut;
    await persistMenu(menu);
    showToast(dish.soldOut ? 'Pokrm označen jako vyprodaný' : 'Pokrm je opět dostupný');
    renderMenuView();
}

function makePlaceholder() {
    const div = document.createElement('div');
    div.className = 'inn-dish-img-placeholder';
    return div;
}

// ── Modal ────────────────────────────────────────────────────────────────

function openDishModal(categoryId, dish) {
    const isEdit = !!dish;
    document.getElementById('dishModalTitle').textContent = isEdit ? 'Upravit pokrm' : 'Nový pokrm';
    document.getElementById('dishModalCategory').value = categoryId;
    document.getElementById('dishModalId').value = dish ? dish.id : '';
    document.getElementById('dishName').value = dish ? dish.name : '';
    document.getElementById('dishPrice').value = dish ? dish.price : '';
    document.getElementById('dishVatRate').value = dish && dish.vatRate != null ? String(dish.vatRate) : '12';
    document.getElementById('dishInfo').value = dish ? (dish.info || '') : '';
    document.getElementById('dishImageUrl').value = dish ? (dish.imageUrl || '') : '';
    document.getElementById('dishImageFile').value = '';
    document.getElementById('dishSoldOut').checked = dish ? !!dish.soldOut : false;
    document.getElementById('dishModalDeleteBtn').style.display = isEdit ? 'inline-flex' : 'none';
    updateDishImgPreview(dish ? dish.imageUrl : '');
    document.getElementById('dishModal').classList.add('active');
}

// SECURITY (3rd hardening pass): this used to build the <img> via an
// innerHTML template string with an inline onerror="..." attribute — an
// inline event handler, which a strict CSP script-src (no 'unsafe-inline')
// blocks outright (see configureHelmet() in src/server/server.js). Rebuilt
// with plain DOM APIs + a real JS property assignment (img.onerror = fn),
// which isn't inline markup at all and isn't subject to CSP script-src —
// same pattern already used by buildDishCard() elsewhere in this file.
function updateDishImgPreview(url) {
    const preview = document.getElementById('dishImgPreview');
    preview.innerHTML = '';
    if (url && url.trim()) {
        const img = document.createElement('img');
        img.src = url;
        img.alt = 'Náhled';
        img.onerror = function () { preview.innerHTML = ''; };
        preview.appendChild(img);
    }
}

document.getElementById('dishImageUrl').addEventListener('input', function() {
    updateDishImgPreview(this.value.trim());
});

// ── Shared image downscaler (dish + combo uploads) ──────────────────────
// Every dish/combo image is stored inline (base64 data-URL) inside the one
// menu/combos JSON document that PUT re-uploads WHOLESALE on every save —
// so raw camera photos (3–8 MB) are structurally wrong here: a single one
// blew past the server's JSON body limit in production (HTTP 413), and the
// old 4MB pre-check didn't prevent that at all. Instead of only raising
// server limits, every uploaded file is now downscaled through a canvas
// before it's stored: longest edge capped, JPEG-compressed, retried at
// lower size/quality until it fits IMG_TARGET_CHARS. A typical phone photo
// lands at ~100–300 KB, so even a menu full of photos stays well under the
// server's 10 MB body limit and validation.js's per-image cap.
const IMG_TARGET_CHARS = 1_400_000; // ~1 MB binary as base64 — keep in sync with validation.js image caps

function downscaleImageFile(file, onDone, onError) {
    const reader = new FileReader();
    reader.onerror = () => onError();
    reader.onload = () => {
        const img = new Image();
        img.onerror = () => onError();
        img.onload = () => {
            // (maxDim, quality) attempts, best first — first result that
            // fits the target wins.
            const attempts = [[1200, 0.8], [1000, 0.65], [800, 0.5]];
            for (const [maxDim, quality] of attempts) {
                const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
                const canvas = document.createElement('canvas');
                canvas.width = Math.max(1, Math.round(img.width * scale));
                canvas.height = Math.max(1, Math.round(img.height * scale));
                const ctx = canvas.getContext('2d');
                // JPEG has no alpha — flatten transparent PNGs onto white
                // instead of the black that toDataURL would produce.
                ctx.fillStyle = '#fff';
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                const dataUrl = canvas.toDataURL('image/jpeg', quality);
                if (dataUrl.length <= IMG_TARGET_CHARS) { onDone(dataUrl); return; }
            }
            onError(); // pathological image — didn't fit even at 800px / q0.5
        };
        img.src = reader.result;
    };
    reader.readAsDataURL(file);
}

document.getElementById('dishImageFile').addEventListener('change', function(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;

    // Raw-file sanity gate only — the stored size is controlled by the
    // downscaler, so even large camera originals are fine to accept here.
    const MAX_BYTES = 15 * 1024 * 1024;
    if (file.size > MAX_BYTES) {
        showToast('Obrázek je příliš velký (max. 15 MB)', true);
        e.target.value = '';
        return;
    }

    downscaleImageFile(file, dataUrl => {
        // Stored the same way as a pasted URL — a data: URL works directly
        // as an <img src>, so nothing else about save/render needs to change.
        document.getElementById('dishImageUrl').value = dataUrl;
        updateDishImgPreview(dataUrl);
    }, () => {
        showToast('Nepodařilo se zpracovat obrázek', true);
        e.target.value = '';
    });
});

document.getElementById('dishModalCancelBtn').addEventListener('click', () => {
    document.getElementById('dishModal').classList.remove('active');
});

document.getElementById('dishModal').addEventListener('click', e => {
    if (e.target.id === 'dishModal') document.getElementById('dishModal').classList.remove('active');
});

document.getElementById('dishModalSaveBtn').addEventListener('click', async () => {
    const name = document.getElementById('dishName').value.trim();
    if (!name) { showToast('Zadejte název pokrmu', true); return; }

    const categoryId = document.getElementById('dishModalCategory').value;
    const existingId = document.getElementById('dishModalId').value;
    const price = parseFloat(document.getElementById('dishPrice').value) || 0;
    const vatRate = Number(document.getElementById('dishVatRate').value);
    const info = document.getElementById('dishInfo').value.trim();
    const imageUrl = document.getElementById('dishImageUrl').value.trim();
    const soldOut = document.getElementById('dishSoldOut').checked;

    const menu = loadMenu();
    if (!menu[categoryId]) menu[categoryId] = [];

    if (existingId) {
        // Edit existing
        const idx = menu[categoryId].findIndex(d => d.id === existingId);
        if (idx !== -1) {
            menu[categoryId][idx] = { id: existingId, name, price, vatRate, info, imageUrl, soldOut };
        }
    } else {
        // New dish
        const newDish = {
            id: generateFileId(10),
            name, price, vatRate, info, imageUrl, soldOut,
            createdAt: new Date().toISOString()
        };
        menu[categoryId].push(newDish);
    }

    await persistMenu(menu);
    document.getElementById('dishModal').classList.remove('active');
    showToast(existingId ? 'Pokrm upraven' : 'Pokrm přidán');
    renderMenuView();
});

document.getElementById('dishModalDeleteBtn').addEventListener('click', async () => {
    const categoryId = document.getElementById('dishModalCategory').value;
    const existingId = document.getElementById('dishModalId').value;
    const name = document.getElementById('dishName').value.trim();
    if (!confirm(`Smazat pokrm „${name}"?`)) return;

    const menu = loadMenu();
    if (menu[categoryId]) {
        menu[categoryId] = menu[categoryId].filter(d => d.id !== existingId);
    }
    await persistMenu(menu);
    document.getElementById('dishModal').classList.remove('active');
    showToast('Pokrm smazán');
    renderMenuView();
});

// ════════════════════════════════════════════════════════════════════════
// COMBO MENUS ("Zvýhodněná menu") — go-live feature (spec: docs/superpowers/
// specs/2026-07-22-combo-menus-design.md, plan Task 2). Restaurant-defined
// set menus made of several dishes for one price — e.g. "Menu 1: polévka +
// hlavní jídlo + nápoj". A combo is stored as { id, name, description,
// price, image, soldOut, vatRate, items: [{slotId, dishId, removable,
// removeValue, swaps}], extras: [{id, name, price}] } — see the spec for
// the full shape. Persisted server-side as ONE singleton array (same
// pattern as the menu), via GET/PUT {API_URL}/combos, full-replace on save
// exactly like persistMenu() above. This section mirrors the MENU section
// above as closely as possible (same card/modal CSS classes, same image
// upload 4MB cap, same sold-out quick toggle) — it's a different shape of
// item (a combo bundles several *existing* dishes rather than being a dish
// itself), not a different UI language.
// ════════════════════════════════════════════════════════════════════════

// ── Persistence (server-backed, shared across devices) ─────────────────────

let combosCache = [];

async function fetchCombos() {
    try {
        const res = await apiFetch(`${API_URL}/combos`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        combosCache = await res.json();
    } catch (e) {
        console.error('Failed to load combos:', e);
        showToast('Nepodařilo se načíst zvýhodněná menu ze serveru', true);
    }
    return combosCache;
}

async function persistCombos(combos) {
    combosCache = combos;
    try {
        const res = await apiFetch(`${API_URL}/combos`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(combos)
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (e) {
        console.error('Failed to save combos:', e);
        showToast('Nepodařilo se uložit zvýhodněná menu na server', true);
    }
}

// Kept as a synchronous accessor for the current in-memory copy, same as
// loadMenu() above.
function loadCombos() {
    return combosCache;
}

// Looks a dish up by id across every category of the currently-loaded menu
// (menuCache — populated by fetchMenu(), which renderMenuView() always
// awaits before fetchCombos(), so this is safe to call anywhere below).
// Returns null if the dish was deleted from the menu after a combo was
// built to reference it — the caller is expected to handle that (missing-
// dish warning badge, "???" summary text, excluding it from dropdowns).
function findDishInMenu(dishId) {
    for (const cat of MENU_CATEGORIES) {
        const dish = (menuCache[cat.id] || []).find(d => d.id === dishId);
        if (dish) return dish;
    }
    return null;
}

// ── Render: section + cards ─────────────────────────────────────────────

function buildComboSection(combos) {
    const section = document.createElement('div');
    section.className = 'inn-menu-category inn-combo-section';

    const catHeader = document.createElement('div');
    catHeader.className = 'inn-menu-cat-header';
    catHeader.innerHTML = `
        <h3>🍱 Zvýhodněná menu
            <span class="inn-menu-cat-count">${combos.length} položek</span>
        </h3>
    `;
    if (isAdmin()) {
        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'inn-btn primary small';
        addBtn.textContent = '+ Přidat menu';
        addBtn.addEventListener('click', () => openComboModal(null));
        catHeader.appendChild(addBtn);
    }
    section.appendChild(catHeader);

    const grid = document.createElement('div');
    grid.className = 'inn-menu-dishes-grid';

    if (combos.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'inn-menu-empty';
        empty.textContent = 'Zatím žádná zvýhodněná menu.';
        grid.appendChild(empty);
    }

    combos.forEach(combo => grid.appendChild(buildComboCard(combo)));

    section.appendChild(grid);
    return section;
}

function buildComboCard(combo) {
    const card = document.createElement('div');
    card.className = 'inn-dish-card inn-combo-card' + (combo.soldOut ? ' is-soldout' : '');

    if (combo.image) {
        const img = document.createElement('img');
        img.className = 'inn-dish-img';
        img.src = combo.image;
        img.alt = combo.name;
        img.onerror = function() {
            this.replaceWith(makePlaceholder());
        };
        card.appendChild(img);
    } else {
        card.appendChild(makePlaceholder());
    }

    // "one-line contents summary" (spec/plan Task 2) — default dish names
    // joined by " + "; a slot whose dish was since deleted from the menu
    // shows as "???" here AND trips the warning badge below.
    const items = Array.isArray(combo.items) ? combo.items : [];
    const missingDish = items.some(it => !findDishInMenu(it.dishId));
    const contentsSummary = items.length
        ? items.map(it => { const d = findDishInMenu(it.dishId); return d ? d.name : '???'; }).join(' + ')
        : '—';

    const body = document.createElement('div');
    body.className = 'inn-dish-body';
    body.innerHTML = `
        <div class="inn-dish-name">${escapeHtml(combo.name)}</div>
        <div class="inn-dish-info">${escapeHtml(contentsSummary)}</div>
        <div class="inn-dish-price">${combo.price != null ? Number(combo.price).toFixed(0) + ' Kč' : '—'} <small style="color:var(--muted); font-weight:500;">· DPH ${combo.vatRate != null ? combo.vatRate : 12} %</small></div>
        ${missingDish ? `<div class="inn-combo-warning">⚠ obsahuje smazané jídlo</div>` : ''}
    `;
    card.appendChild(body);

    // Footer: admin gets the same sold-out quick-toggle pill as dishes,
    // plus explicit Upravit/Smazat buttons (spec/plan Task 2 — the combo
    // card needs both edit AND delete controls, unlike a dish card where
    // only the modal has a delete button); everyone else just sees the
    // read-only sold-out badge when relevant.
    const footerRow = document.createElement('div');
    footerRow.className = 'inn-dish-footer inn-combo-footer';
    if (isAdmin()) {
        const toggleBtn = document.createElement('button');
        toggleBtn.type = 'button';
        toggleBtn.className = 'inn-status-pill' + (combo.soldOut ? ' unpaid' : ' paid');
        toggleBtn.textContent = combo.soldOut ? 'Vyprodáno' : 'Dostupné';
        toggleBtn.title = combo.soldOut ? 'Klikněte pro obnovení dostupnosti' : 'Klikněte pro označení jako vyprodané';
        toggleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleComboSoldOut(combo.id);
        });
        footerRow.appendChild(toggleBtn);

        const editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.className = 'inn-btn small';
        editBtn.textContent = 'Upravit';
        editBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            openComboModal(combo);
        });
        footerRow.appendChild(editBtn);

        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'inn-btn danger small';
        deleteBtn.textContent = 'Smazat';
        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            deleteCombo(combo.id, combo.name);
        });
        footerRow.appendChild(deleteBtn);
    } else if (combo.soldOut) {
        const badge = document.createElement('span');
        badge.className = 'inn-status-pill unpaid';
        badge.textContent = 'Vyprodáno';
        footerRow.appendChild(badge);
    }
    if (footerRow.childNodes.length > 0) card.appendChild(footerRow);

    if (isAdmin()) {
        card.style.cursor = 'pointer';
        card.addEventListener('click', () => openComboModal(combo));
    }
    return card;
}

// Same "flip in place + persist the whole array" quick toggle as
// toggleDishSoldOut() above.
async function toggleComboSoldOut(comboId) {
    const combos = loadCombos();
    const combo = combos.find(c => c.id === comboId);
    if (!combo) return;
    combo.soldOut = !combo.soldOut;
    await persistCombos(combos);
    showToast(combo.soldOut ? 'Menu označeno jako vyprodané' : 'Menu je opět dostupné');
    renderMenuView();
}

async function deleteCombo(comboId, name) {
    if (!confirm(`Smazat menu „${name}"?`)) return;
    const combos = loadCombos().filter(c => c.id !== comboId);
    await persistCombos(combos);
    showToast('Menu smazáno');
    renderMenuView();
}

// ── Modal: shared state for the slot/extras builders ────────────────────
// Both builders edit a plain-array working copy while the modal is open —
// Save writes it into combosCache + persists, Cancel just discards it by
// closing the modal without ever touching combosCache. This mirrors how
// the dish modal reads/writes its fields directly, just with two arrays
// of sub-rows instead of a handful of scalar fields.

let comboModalEditingId = null;    // id of the combo being edited, or null when adding
let comboModalSlots = [];          // [{slotId, dishId, removable, removeValue, swaps:[dishId,...]}]
let comboModalExtras = [];         // [{id, name, price}]

// Populates a <select> with every current menu dish, grouped into
// <optgroup>s by MENU_CATEGORIES, option label "Název — 120 Kč" (plan
// Task 2's exact format).
function buildDishSelectOptions(selectEl, selectedDishId) {
    selectEl.innerHTML = '<option value="">— vyberte pokrm —</option>';
    MENU_CATEGORIES.forEach(cat => {
        const dishes = menuCache[cat.id] || [];
        if (dishes.length === 0) return;
        const group = document.createElement('optgroup');
        group.label = `${cat.icon} ${cat.label}`;
        dishes.forEach(dish => {
            const opt = document.createElement('option');
            opt.value = dish.id;
            opt.textContent = `${dish.name} — ${Number(dish.price).toFixed(0)} Kč`;
            if (dish.id === selectedDishId) opt.selected = true;
            group.appendChild(opt);
        });
        selectEl.appendChild(group);
    });
}

// Checkbox list of every menu dish that may replace THIS slot's currently-
// selected default dish — the default itself is excluded (plan Task 2:
// "the default dish itself excluded"). Rebuilt whenever the slot's dish
// dropdown changes, since the exclusion set depends on it.
function renderSwapPicker(container, slot) {
    container.innerHTML = '';
    let any = false;
    MENU_CATEGORIES.forEach(cat => {
        const dishes = menuCache[cat.id] || [];
        dishes.forEach(dish => {
            if (dish.id === slot.dishId) return; // can't swap the default dish for itself
            any = true;
            const label = document.createElement('label');
            label.className = 'inn-swap-item';
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = slot.swaps.includes(dish.id);
            checkbox.addEventListener('change', () => {
                if (checkbox.checked) {
                    if (!slot.swaps.includes(dish.id)) slot.swaps.push(dish.id);
                } else {
                    slot.swaps = slot.swaps.filter(id => id !== dish.id);
                }
            });
            label.appendChild(checkbox);
            label.appendChild(document.createTextNode(` ${dish.name} (${cat.label})`));
            container.appendChild(label);
        });
    });
    if (!any) {
        const empty = document.createElement('span');
        empty.className = 'inn-swap-empty';
        empty.textContent = 'Žádné další pokrmy k výběru.';
        container.appendChild(empty);
    }
}

function renderComboSlotRows() {
    const container = document.getElementById('comboSlotRows');
    container.innerHTML = '';

    comboModalSlots.forEach((slot, idx) => {
        const row = document.createElement('div');
        row.className = 'inn-slot-row';

        const rowHeader = document.createElement('div');
        rowHeader.className = 'inn-slot-row-header';

        const dishSelect = document.createElement('select');
        dishSelect.className = 'inn-slot-dish-select';
        buildDishSelectOptions(dishSelect, slot.dishId);
        rowHeader.appendChild(dishSelect);

        const removableLabel = document.createElement('label');
        removableLabel.className = 'inn-slot-removable-label';
        const removableCheckbox = document.createElement('input');
        removableCheckbox.type = 'checkbox';
        removableCheckbox.checked = !!slot.removable;
        removableLabel.appendChild(removableCheckbox);
        removableLabel.appendChild(document.createTextNode(' lze odebrat'));
        rowHeader.appendChild(removableLabel);

        const removeValueInput = document.createElement('input');
        removeValueInput.type = 'number';
        removeValueInput.min = '0';
        removeValueInput.step = '0.50';
        removeValueInput.className = 'inn-slot-removevalue-input';
        removeValueInput.placeholder = 'Sleva při odebrání (Kč)';
        removeValueInput.value = slot.removeValue != null ? slot.removeValue : 0;
        removeValueInput.disabled = !slot.removable;
        removeValueInput.addEventListener('input', () => {
            slot.removeValue = parseFloat(removeValueInput.value) || 0;
        });
        rowHeader.appendChild(removeValueInput);

        // Swap picker built here (needs to exist before the dish-select's
        // change handler below can reference it via closure).
        const swapWrap = document.createElement('div');
        swapWrap.className = 'inn-swap-wrap';
        const swapLabel = document.createElement('div');
        swapLabel.className = 'inn-swap-label';
        swapLabel.textContent = 'Povolené náhrady (host si místo tohoto jídla může vybrat):';
        swapWrap.appendChild(swapLabel);
        const swapPickerEl = document.createElement('div');
        swapPickerEl.className = 'inn-swap-list';
        swapWrap.appendChild(swapPickerEl);
        renderSwapPicker(swapPickerEl, slot);

        dishSelect.addEventListener('change', () => {
            slot.dishId = dishSelect.value;
            // The newly-picked default dish can't also be its own swap
            // target — drop it from the swap set if it was checked there
            // while a different dish was selected as the default.
            slot.swaps = slot.swaps.filter(id => id !== slot.dishId);
            renderSwapPicker(swapPickerEl, slot);
        });

        removableCheckbox.addEventListener('change', () => {
            slot.removable = removableCheckbox.checked;
            removeValueInput.disabled = !slot.removable;
            if (!slot.removable) {
                slot.removeValue = 0;
                removeValueInput.value = 0;
            }
        });

        const removeRowBtn = document.createElement('button');
        removeRowBtn.type = 'button';
        removeRowBtn.className = 'inn-btn danger small';
        removeRowBtn.textContent = 'Odebrat položku';
        removeRowBtn.disabled = comboModalSlots.length <= 1; // spec: 1–10 slots, at least one required
        removeRowBtn.addEventListener('click', () => {
            comboModalSlots.splice(idx, 1);
            renderComboSlotRows();
        });
        rowHeader.appendChild(removeRowBtn);

        row.appendChild(rowHeader);
        row.appendChild(swapWrap);
        container.appendChild(row);
    });
}

function renderComboExtraRows() {
    const container = document.getElementById('comboExtraRows');
    container.innerHTML = '';
    if (comboModalExtras.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'inn-combo-extras-empty';
        empty.textContent = 'Žádné příplatkové položky.';
        container.appendChild(empty);
    }

    comboModalExtras.forEach((extra, idx) => {
        // Reuses the daily-menu item row's classes/layout (name+price+
        // remove button) — same shape of row, different data.
        const row = document.createElement('div');
        row.className = 'inn-daily-item-row';

        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.placeholder = 'Název (např. Extra sýr)';
        nameInput.maxLength = 120;
        nameInput.className = 'inn-daily-item-name';
        nameInput.value = extra.name || '';
        nameInput.addEventListener('input', () => { extra.name = nameInput.value; });

        const priceInput = document.createElement('input');
        priceInput.type = 'number';
        priceInput.min = '0';
        priceInput.step = '0.50';
        priceInput.placeholder = 'Cena (Kč)';
        priceInput.className = 'inn-daily-item-price';
        priceInput.value = extra.price != null ? extra.price : '';
        priceInput.addEventListener('input', () => { extra.price = parseFloat(priceInput.value) || 0; });

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'inn-btn danger small';
        removeBtn.textContent = 'Odebrat';
        removeBtn.addEventListener('click', () => {
            comboModalExtras.splice(idx, 1);
            renderComboExtraRows();
        });

        row.appendChild(nameInput);
        row.appendChild(priceInput);
        row.appendChild(removeBtn);
        container.appendChild(row);
    });
}

function openComboModal(combo) {
    const isEdit = !!combo;
    comboModalEditingId = isEdit ? combo.id : null;

    document.getElementById('comboModalTitle').textContent = isEdit ? 'Upravit zvýhodněné menu' : 'Nové zvýhodněné menu';
    document.getElementById('comboName').value = combo ? combo.name : '';
    document.getElementById('comboDescription').value = combo ? (combo.description || '') : '';
    document.getElementById('comboPrice').value = combo ? combo.price : '';
    document.getElementById('comboVatRate').value = combo && combo.vatRate != null ? String(combo.vatRate) : '12';
    document.getElementById('comboImageUrl').value = combo ? (combo.image || '') : '';
    document.getElementById('comboImageFile').value = '';
    document.getElementById('comboSoldOut').checked = combo ? !!combo.soldOut : false;
    document.getElementById('comboModalDeleteBtn').style.display = isEdit ? 'inline-flex' : 'none';
    updateComboImgPreview(combo ? combo.image : '');

    // Working copies, deep-cloned so in-modal edits never touch combosCache
    // until Save runs — Cancel just closes the modal and the clones are
    // thrown away. A brand-new combo starts with exactly one empty slot row
    // (spec: 1–10 slots, so it can never start at 0).
    comboModalSlots = (isEdit && Array.isArray(combo.items) && combo.items.length > 0)
        ? combo.items.map(it => ({
            slotId: it.slotId || generateFileId(8),
            dishId: it.dishId || '',
            removable: !!it.removable,
            removeValue: it.removeValue != null ? it.removeValue : 0,
            swaps: Array.isArray(it.swaps) ? [...it.swaps] : [],
        }))
        : [{ slotId: generateFileId(8), dishId: '', removable: false, removeValue: 0, swaps: [] }];

    comboModalExtras = (isEdit && Array.isArray(combo.extras))
        ? combo.extras.map(ex => ({ id: ex.id || generateFileId(8), name: ex.name || '', price: ex.price != null ? ex.price : 0 }))
        : [];

    renderComboSlotRows();
    renderComboExtraRows();

    document.getElementById('comboModal').classList.add('active');
}

// Same "URL or upload" image field as the dish modal, same 4MB client cap
// (see the dishImageFile handler above for the size-limit rationale).
function updateComboImgPreview(url) {
    const preview = document.getElementById('comboImgPreview');
    preview.innerHTML = '';
    if (url && url.trim()) {
        const img = document.createElement('img');
        img.src = url;
        img.alt = 'Náhled';
        img.onerror = function () { preview.innerHTML = ''; };
        preview.appendChild(img);
    }
}

document.getElementById('comboImageUrl').addEventListener('input', function() {
    updateComboImgPreview(this.value.trim());
});

document.getElementById('comboImageFile').addEventListener('change', function(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;

    // Same downscale pipeline as dish images (see downscaleImageFile above)
    // — combos.json holds every image inline too, so the same size rules
    // apply.
    const MAX_BYTES = 15 * 1024 * 1024;
    if (file.size > MAX_BYTES) {
        showToast('Obrázek je příliš velký (max. 15 MB)', true);
        e.target.value = '';
        return;
    }

    downscaleImageFile(file, dataUrl => {
        document.getElementById('comboImageUrl').value = dataUrl;
        updateComboImgPreview(dataUrl);
    }, () => {
        showToast('Nepodařilo se zpracovat obrázek', true);
        e.target.value = '';
    });
});

document.getElementById('comboAddSlotBtn').addEventListener('click', () => {
    if (comboModalSlots.length >= 10) { showToast('Menu může mít nejvýše 10 položek', true); return; }
    comboModalSlots.push({ slotId: generateFileId(8), dishId: '', removable: false, removeValue: 0, swaps: [] });
    renderComboSlotRows();
});

document.getElementById('comboAddExtraBtn').addEventListener('click', () => {
    if (comboModalExtras.length >= 10) { showToast('Menu může mít nejvýše 10 příplatkových položek', true); return; }
    comboModalExtras.push({ id: generateFileId(8), name: '', price: 0 });
    renderComboExtraRows();
});

document.getElementById('comboModalCancelBtn').addEventListener('click', () => {
    document.getElementById('comboModal').classList.remove('active');
});

document.getElementById('comboModal').addEventListener('click', e => {
    if (e.target.id === 'comboModal') document.getElementById('comboModal').classList.remove('active');
});

document.getElementById('comboModalSaveBtn').addEventListener('click', async () => {
    // ── Validation (Czech messages, same toast pattern as the rest of the
    // admin UI) — every check below mirrors a constraint from the spec's
    // data model, so a save that passes here can never fail the server's
    // combosPutSchema validation.
    const name = document.getElementById('comboName').value.trim();
    if (!name) { showToast('Zadejte název menu', true); return; }
    if (name.length > 120) { showToast('Název menu je příliš dlouhý (max. 120 znaků)', true); return; }

    const description = document.getElementById('comboDescription').value.trim();
    if (description.length > 500) { showToast('Popis je příliš dlouhý (max. 500 znaků)', true); return; }

    const priceRaw = document.getElementById('comboPrice').value;
    const price = parseFloat(priceRaw);
    if (priceRaw === '' || Number.isNaN(price) || price < 0) {
        showToast('Zadejte platnou základní cenu menu (Kč, ≥ 0)', true);
        return;
    }

    if (comboModalSlots.length === 0) {
        showToast('Menu musí obsahovat alespoň jednu položku', true);
        return;
    }
    if (comboModalSlots.length > 10) {
        showToast('Menu může mít nejvýše 10 položek', true);
        return;
    }
    for (const slot of comboModalSlots) {
        if (!slot.dishId) { showToast('U každé položky menu vyberte pokrm', true); return; }
        if (slot.removable && !(Number(slot.removeValue) >= 0)) {
            showToast('Sleva při odebrání položky musí být nezáporné číslo', true);
            return;
        }
        if (!slot.removable) slot.removeValue = 0; // not removable → no discount ever applies; keep the stored value clean
    }

    if (comboModalExtras.length > 10) {
        showToast('Menu může mít nejvýše 10 příplatkových položek', true);
        return;
    }
    for (const extra of comboModalExtras) {
        if (!extra.name || !extra.name.trim()) { showToast('Každá příplatková položka musí mít název', true); return; }
        if (!(Number(extra.price) >= 0)) { showToast('Cena příplatkové položky musí být nezáporné číslo', true); return; }
    }

    const vatRate = Number(document.getElementById('comboVatRate').value);
    const image = document.getElementById('comboImageUrl').value.trim();
    const soldOut = document.getElementById('comboSoldOut').checked;

    const items = comboModalSlots.map(slot => ({
        slotId: slot.slotId,
        dishId: slot.dishId,
        removable: !!slot.removable,
        removeValue: Number(slot.removeValue) || 0,
        swaps: [...slot.swaps],
    }));
    const extras = comboModalExtras.map(ex => ({
        id: ex.id,
        name: ex.name.trim(),
        price: Number(ex.price) || 0,
    }));

    const combos = loadCombos();
    if (comboModalEditingId) {
        const idx = combos.findIndex(c => c.id === comboModalEditingId);
        if (idx !== -1) {
            combos[idx] = { id: comboModalEditingId, name, description, price, image, soldOut, vatRate, items, extras };
        }
    } else {
        combos.push({
            id: generateFileId(10),
            name, description, price, image, soldOut, vatRate, items, extras,
            createdAt: new Date().toISOString()
        });
    }

    await persistCombos(combos);
    document.getElementById('comboModal').classList.remove('active');
    showToast(comboModalEditingId ? 'Menu upraveno' : 'Menu přidáno');
    renderMenuView();
});

document.getElementById('comboModalDeleteBtn').addEventListener('click', async () => {
    const name = document.getElementById('comboName').value.trim();
    if (!confirm(`Smazat menu „${name}"?`)) return;

    const combos = loadCombos().filter(c => c.id !== comboModalEditingId);
    await persistCombos(combos);
    document.getElementById('comboModal').classList.remove('active');
    showToast('Menu smazáno');
    renderMenuView();
});

// ════════════════════════════════════════════════════════════════════════
// WAITER — pick a table, open the menu, send an order straight to the
// kitchen. Independent of the reservation system (works for walk-ins too).
// ════════════════════════════════════════════════════════════════════════

let waiterActiveTable = null;   // table name the order modal is currently open for
let waiterCart = {};            // dishId -> { item, price, qty }

// Floorplan (design §6.3-style room-remembering, applied to §6.2 here):
// which room the waiter floorplan is currently showing, kept across
// re-renders the same way overviewActiveRoomId is.
let waiterActiveRoomId = null;

async function renderWaiterView() {
    if (!settingsCache) await fetchSettings();

    const container = document.getElementById('waiterView');
    container.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'inn-menu-header';
    header.innerHTML = `<h2>🧑‍🍳 Objednat ke stolu</h2>`;
    container.appendChild(header);

    const hint = document.createElement('p');
    hint.style.cssText = 'color:var(--muted); font-size:0.9em; margin:-6px 0 16px;';
    hint.textContent = 'Vyberte stůl na plánku — i obsazený, obsazeno tu znamená usazeno, tedy přesně kdy se objednává — otevřete menu a odešlete objednávku přímo do kuchyně.';
    container.appendChild(hint);

    const names = Object.keys(tables).sort((a, b) => a.localeCompare(b, 'cs'));

    if (names.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'inn-menu-empty';
        empty.textContent = 'Zatím nejsou vytvořeny žádné stoly.';
        container.appendChild(empty);
        return;
    }

    // ── Floorplan (design §6.2): the 🍽️ card grid this view used to show is
    // replaced by the same floorplan the customer/overview surfaces use.
    // UNLIKE the customer page, every table is clickable here, occupied ones
    // included — occupied means seated, which is exactly when a waiter would
    // place an order, so occupancy is shown as information only, never as a
    // click barrier (see buildWaiterFpTable's onTableClick below, which
    // always opens the order modal regardless of state). ──
    const rooms = (settingsCache && settingsCache.floorplan && settingsCache.floorplan.rooms) || [];
    const fpTables = names.map(buildWaiterFpTable);
    let unplacedNames = names;

    if (rooms.length > 0 && typeof FloorPlan !== 'undefined') {
        if (!waiterActiveRoomId || !rooms.some(r => r.id === waiterActiveRoomId)) {
            waiterActiveRoomId = rooms[0].id;
        }
        const canvasHost = document.createElement('div');
        container.appendChild(canvasHost);
        FloorPlan.render(canvasHost, {
            rooms,
            tables: fpTables,
            activeRoomId: waiterActiveRoomId,
            onRoomChange: (roomId) => { waiterActiveRoomId = roomId; renderWaiterView(); },
            onTableClick: (name) => openWaiterOrderModal(name),
        });
        // Design §6.2's hard requirement — EVERY table clickable, occupied
        // included — needs this: FloorPlan.render() itself leaves occupied
        // tables without a click handler (see the helper's header comment).
        makeAllFloorplanTablesClickable(canvasHost, openWaiterOrderModal);
        unplacedNames = partitionFloorplanTables(fpTables, rooms).unplaced.map(t => t.name);
    }

    // Nezařazené stoly (design §9): tables with no layout yet — or, when no
    // rooms are configured at all, every table — stay orderable via the
    // pre-existing .inn-dish-add-card grid this view always used.
    if (unplacedNames.length > 0) {
        if (rooms.length > 0) {
            const label = document.createElement('div');
            label.className = 'inn-oc-upcoming-label';
            label.style.margin = '18px 0 8px';
            label.textContent = 'Nezařazené stoly';
            container.appendChild(label);
        }

        const grid = document.createElement('div');
        grid.className = 'inn-menu-dishes-grid';
        unplacedNames.forEach(name => {
            const card = document.createElement('div');
            card.className = 'inn-dish-add-card';
            card.style.cursor = 'pointer';
            card.innerHTML = `<span style="font-size:1.6em;">🍽️</span><span>${escapeHtml(name)}</span>`;
            card.addEventListener('click', () => openWaiterOrderModal(name));
            grid.appendChild(card);
        });
        container.appendChild(grid);
    }
}

// Builds one { name, seats, layout, state, sublabel } entry for the waiter
// floorplan. Reuses isTableFreeNow() — the exact same "is it occupied right
// now" logic already driving the sidebar's free-table count — so the
// floorplan's occupied/free coloring always agrees with the rest of this
// page instead of introducing a second notion of occupancy.
function buildWaiterFpTable(name) {
    const t = tables[name];
    const occupied = !isTableFreeNow(name);
    return {
        name,
        seats: typeof t.seats === 'number' ? t.seats : undefined,
        layout: t.layout || null,
        state: occupied ? 'occupied' : 'free',
        sublabel: occupied ? 'obsazeno' : '',
    };
}

// Normalizes FloorPlan.partitionTables()'s return value to a plain
// { placed, unplaced } shape regardless of whether it comes back as that
// object or as a [placed, unplaced] tuple — the design doc's contract
// doesn't pin down which, so both are handled defensively. Shared by the
// waiter view and the Rozložení editor.
function partitionFloorplanTables(fpTables, rooms) {
    const result = FloorPlan.partitionTables(fpTables, rooms);
    if (Array.isArray(result)) return { placed: result[0] || [], unplaced: result[1] || [] };
    return { placed: (result && result.placed) || [], unplaced: (result && result.unplaced) || [] };
}

// floorplan.js only wires up a click/keydown handler (and removes
// aria-disabled) for tables whose resolved state is 'free' or 'selected' —
// 'occupied' and 'too-small' ones are left deliberately inert, which is
// exactly right for the read-only customer table picker. Two of this file's
// own surfaces need every table clickable regardless of state though:
//   - the waiter view (design §6.2) — occupied means seated, precisely when
//     a waiter places an order, so occupancy must never block the click;
//   - the overview (design §6.3) — clicking ANY table, occupied ones
//     included, should scroll to its card; that's arguably the most useful
//     case, since an occupied table is the one you're most likely checking.
// Rather than reaching into floorplan.js (owned by a different track) to
// change that gating, this bolts an independent handler onto whichever
// table elements it left without one, matching the same clickable styling/
// keyboard affordance the free/selected tables already got for free.
function makeAllFloorplanTablesClickable(host, onClick) {
    host.querySelectorAll('.fp-table:not(.fp-table--clickable)').forEach(el => {
        const nameEl = el.querySelector('.fp-table__name');
        const name = nameEl ? nameEl.textContent : null;
        if (!name) return;
        el.classList.add('fp-table--clickable');
        el.setAttribute('role', 'button');
        el.setAttribute('tabindex', '0');
        el.removeAttribute('aria-disabled');
        el.addEventListener('click', () => onClick(name));
        el.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
                e.preventDefault();
                onClick(name);
            }
        });
    });
}

async function openWaiterOrderModal(tableName) {
    waiterActiveTable = tableName;
    waiterCart = {};

    document.getElementById('waiterOrderModalTitle').textContent = `Objednávka — ${tableName}`;
    document.getElementById('waiterGuestNameInput').value = '';

    const menu = await fetchMenu();
    renderWaiterOrderMenu(menu);
    updateWaiterOrderTotal();

    document.getElementById('waiterOrderModal').classList.add('active');
}

function renderWaiterOrderMenu(menu) {
    const container = document.getElementById('waiterOrderMenu');
    container.innerHTML = '';

    // go-live Task 3 (spec §5): sold-out dishes are rejected server-side by
    // every order-creation route (priceOrderItems in server.js), including
    // this waiter/indoor-order picker's POST /indoor-orders — filtering them
    // out here too avoids a confusing "item sold out" error after a waiter
    // already picked it during a rush.
    const anyDishes = MENU_CATEGORIES.some(cat => (menu[cat.id] || []).some(d => !d.soldOut));
    if (!anyDishes) {
        container.innerHTML = '<p style="color:var(--muted);">Menu je zatím prázdné — přidejte pokrmy v sekci Menu.</p>';
        return;
    }

    MENU_CATEGORIES.forEach(cat => {
        const dishes = (menu[cat.id] || []).filter(d => !d.soldOut);
        if (dishes.length === 0) return;

        const section = document.createElement('div');
        section.style.marginBottom = '14px';
        section.innerHTML = `<h4 style="margin:10px 0 6px;">${escapeHtml(cat.label)}</h4>`;

        dishes.forEach(dish => {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex; align-items:center; justify-content:space-between; gap:10px; padding:6px 0; border-bottom:1px solid var(--line, #eee);';

            const qty = waiterCart[dish.id]?.qty || 0;

            row.innerHTML = `
                <div style="flex:1; min-width:0;">
                    <div style="font-weight:600; font-size:0.92em;">${escapeHtml(dish.name)}</div>
                    <div style="font-size:0.8em; color:var(--muted);">${Number(dish.price).toLocaleString('cs-CZ')} Kč</div>
                </div>
                <div style="display:flex; align-items:center; gap:8px;">
                    <button type="button" class="inn-btn waiter-qty-minus" style="padding:2px 10px;">−</button>
                    <span class="waiter-qty-val" style="min-width:18px; text-align:center; font-weight:bold;">${qty}</span>
                    <button type="button" class="inn-btn waiter-qty-plus" style="padding:2px 10px;">+</button>
                </div>
            `;

            row.querySelector('.waiter-qty-minus').addEventListener('click', () => changeWaiterQty(dish, -1, menu));
            row.querySelector('.waiter-qty-plus').addEventListener('click', () => changeWaiterQty(dish, 1, menu));

            section.appendChild(row);
        });

        container.appendChild(section);
    });
}

function changeWaiterQty(dish, delta, menu) {
    const existing = waiterCart[dish.id];
    const newQty = Math.max(0, (existing?.qty || 0) + delta);

    if (newQty === 0) {
        delete waiterCart[dish.id];
    } else {
        waiterCart[dish.id] = { item: dish.name, price: Number(dish.price) || 0, qty: newQty };
    }

    renderWaiterOrderMenu(menu);
    updateWaiterOrderTotal();
}

function getWaiterCartTotal() {
    return Object.values(waiterCart).reduce((sum, i) => sum + i.price * i.qty, 0);
}

function updateWaiterOrderTotal() {
    document.getElementById('waiterOrderTotalText').textContent =
        `${getWaiterCartTotal().toLocaleString('cs-CZ')} Kč`;
}

function closeWaiterOrderModal() {
    document.getElementById('waiterOrderModal').classList.remove('active');
    waiterActiveTable = null;
    waiterCart = {};
}

document.getElementById('waiterOrderCancelBtn').addEventListener('click', closeWaiterOrderModal);
document.getElementById('waiterOrderModal').addEventListener('click', (e) => {
    if (e.target.id === 'waiterOrderModal') closeWaiterOrderModal();
});

document.getElementById('waiterOrderSendBtn').addEventListener('click', async () => {
    const items = Object.values(waiterCart);
    if (items.length === 0) {
        showToast('Přidejte alespoň jednu položku', true);
        return;
    }

    const guestName = document.getElementById('waiterGuestNameInput').value.trim();
    const btn = document.getElementById('waiterOrderSendBtn');
    btn.disabled = true;
    btn.textContent = 'Odesílám…';

    try {
        if (posReady) {
            // Durable the moment this resolves, network or not.
            await posSubmitOrder({
                tableName: waiterActiveTable,
                guestName,
                items,
                total: getWaiterCartTotal(),
            });
            // The kitchen board is a server-side SSE push, so an order that
            // has not reached the server does not exist to the kitchen.
            // That is a real operational consequence of working offline and
            // the person who just took the order has to be told it — not
            // left to find out when the food never arrives.
            showToast(POSSync.serverUnreachable()
                ? `Objednávka pro ${waiterActiveTable} uložena — do kuchyně se odešle po obnovení sítě`
                : `Objednávka pro ${waiterActiveTable} odeslána do kuchyně`);
            closeWaiterOrderModal();
            await refreshWalkinAndRender();
            return;
        }

        const res = await apiFetch(`${API_URL}/indoor-orders`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                tableName: waiterActiveTable,
                guestName,
                items,
                total: getWaiterCartTotal()
            })
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        showToast(`Objednávka pro ${waiterActiveTable} odeslána do kuchyně`);
        closeWaiterOrderModal();
    } catch (e) {
        console.error(e);
        showToast('Nepodařilo se odeslat objednávku', true);
    } finally {
        btn.disabled = false;
        btn.textContent = 'Odeslat do kuchyně';
    }
});

// ── RECEIPTS (účtenky) — staff listing with date filter, in the Prodeje view ──

function todayISODate() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function fetchReceipts(from, to) {
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    const qs = params.toString();
    const res = await apiFetch(`${API_URL}/receipts${qs ? '?' + qs : ''}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

function receiptKindLabel(kind) {
    return kind === 'delivery' ? 'Rozvoz' : kind === 'indoor' ? 'Stůl' : kind === 'reservation' ? 'Rezervace' : (kind || '—');
}

function formatReceiptDateTime(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString('cs-CZ', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function renderReceiptsTable(receipts) {
    const wrap = document.createElement('div');
    wrap.className = 'inn-bookings-table-wrap';

    if (receipts.length === 0) {
        wrap.innerHTML = '<p style="color:var(--muted);">V tomto období nejsou žádné účtenky.</p>';
        return wrap;
    }

    const table = document.createElement('table');
    table.className = 'inn-bookings-table';
    table.innerHTML = `
        <thead>
            <tr><th>Č. dokladu</th><th>Datum</th><th>Popis</th><th>Typ</th><th>Platba</th><th>Částka</th><th></th></tr>
        </thead>
        <tbody></tbody>
    `;
    const tbody = table.querySelector('tbody');
    receipts.forEach(r => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td style="font-family:var(--mono); font-size:0.85em;">${escapeHtml(r.number)}</td>
            <td>${formatReceiptDateTime(r.issuedAt)}</td>
            <td>${escapeHtml(r.description || '—')}</td>
            <td>${receiptKindLabel(r.kind)}</td>
            <td>${escapeHtml(r.paymentMethodLabel || '—')}</td>
            <td><strong>${Number(r.total).toLocaleString('cs-CZ')} Kč</strong></td>
            <td><a class="inn-btn small" href="${receiptUrl(r.id)}" target="_blank" rel="noopener">🧾 Otevřít</a></td>
        `;
        tbody.appendChild(tr);
    });
    wrap.appendChild(table);
    return wrap;
}

async function renderReceiptsPanel(container) {
    const box = document.createElement('div');
    box.className = 'inn-panel';

    const heading = document.createElement('h3');
    heading.style.marginTop = '0';
    heading.textContent = 'Účtenky';
    box.appendChild(heading);

    const filterRow = document.createElement('div');
    filterRow.style.cssText = 'display:flex; gap:10px; align-items:flex-end; flex-wrap:wrap; margin-bottom:14px;';
    filterRow.innerHTML = `
        <div class="inn-field-group" style="margin-bottom:0;">
            <label for="receiptsFromInput">Od</label>
            <input type="date" id="receiptsFromInput">
        </div>
        <div class="inn-field-group" style="margin-bottom:0;">
            <label for="receiptsToInput">Do</label>
            <input type="date" id="receiptsToInput">
        </div>
        <button class="inn-btn" id="receiptsFilterBtn">Filtrovat</button>
    `;
    box.appendChild(filterRow);

    const resultsHolder = document.createElement('div');
    resultsHolder.innerHTML = '<p style="color:var(--muted);">Načítání…</p>';
    box.appendChild(resultsHolder);

    container.appendChild(box);

    const toDefault = todayISODate();
    const fromDateObj = new Date();
    fromDateObj.setDate(fromDateObj.getDate() - 30);
    const fromDefault = fromDateObj.toISOString().slice(0, 10);
    document.getElementById('receiptsFromInput').value = fromDefault;
    document.getElementById('receiptsToInput').value = toDefault;

    async function reload() {
        resultsHolder.innerHTML = '<p style="color:var(--muted);">Načítání…</p>';
        try {
            const from = document.getElementById('receiptsFromInput').value;
            const toInputVal = document.getElementById('receiptsToInput').value;
            // The "Do" field reads as an inclusive whole day, but the API
            // compares against issuedAt (a full timestamp) — so a plain
            // "YYYY-MM-DD" `to` would cut off at that day's midnight and
            // silently exclude everything issued *on* the selected day.
            // Push it one day forward to keep the field's obvious meaning.
            const to = toInputVal ? addDaysToDateStr(toInputVal, 1) : toInputVal;
            const receipts = await fetchReceipts(from, to);
            resultsHolder.innerHTML = '';
            resultsHolder.appendChild(renderReceiptsTable(receipts));
        } catch (e) {
            console.error(e);
            resultsHolder.innerHTML = '<p style="color:var(--danger);">Nepodařilo se načíst účtenky.</p>';
        }
    }

    document.getElementById('receiptsFilterBtn').addEventListener('click', reload);
    await reload();
}

// ════════════════════════════════════════════════════════════════════════
// USERS (admin only)
// ════════════════════════════════════════════════════════════════════════

async function renderUsersView() {
    const container = document.getElementById('usersView');
    container.innerHTML = '<p style="color:var(--muted);">Načítání…</p>';

    let users = [];
    try {
        const res = await apiFetch(`${API_URL}/users`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        users = await res.json();
    } catch (e) {
        container.innerHTML = '<p style="color:var(--danger);">Nepodařilo se načíst uživatele.</p>';
        return;
    }

    container.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'inn-menu-header';
    header.innerHTML = `<h2>Uživatelé</h2>`;
    const addBtn = document.createElement('button');
    addBtn.className = 'inn-btn primary';
    addBtn.textContent = '+ Nový účet';
    addBtn.addEventListener('click', openUserModal);
    header.appendChild(addBtn);
    container.appendChild(header);

    const panel = document.createElement('div');
    panel.className = 'inn-panel';

    if (users.length === 0) {
        panel.innerHTML = '<p style="color:var(--muted);">Žádní uživatelé.</p>';
    } else {
        const wrap = document.createElement('div');
        wrap.className = 'inn-bookings-table-wrap';
        const table = document.createElement('table');
        table.className = 'inn-bookings-table';
        table.innerHTML = `
            <thead><tr><th>Jméno</th><th>Zkratka</th><th>Role</th></tr></thead>
            <tbody></tbody>
        `;
        const tbody = table.querySelector('tbody');
        users.forEach(u => {
            const tr = document.createElement('tr');
            const roleBadges = [
                u.isAdmin ? '<span class="inn-status-pill paid">Admin</span>' : '',
                u.isDriver ? '<span class="inn-status-pill unpaid">Řidič</span>' : '',
            ].filter(Boolean).join(' ') || '<span class="inn-status-pill noorder">Uživatel</span>';
            tr.innerHTML = `
                <td>${escapeHtml(u.name)}</td>
                <td>${escapeHtml(u.abbreviation)}</td>
                <td>${roleBadges}</td>
            `;
            tbody.appendChild(tr);
        });
        wrap.appendChild(table);
        panel.appendChild(wrap);
    }

    container.appendChild(panel);
}

function openUserModal() {
    document.getElementById('userNameInput').value = '';
    document.getElementById('userAbbrInput').value = '';
    document.getElementById('userPasswordInput').value = '';
    document.getElementById('userIsAdminInput').checked = false;
    document.getElementById('userIsDriverInput').checked = false;
    document.getElementById('userModalError').style.display = 'none';
    document.getElementById('userModal').classList.add('active');
}

document.getElementById('userModalCancelBtn').addEventListener('click', () => {
    document.getElementById('userModal').classList.remove('active');
});
document.getElementById('userModal').addEventListener('click', e => {
    if (e.target.id === 'userModal') document.getElementById('userModal').classList.remove('active');
});

document.getElementById('userModalCreateBtn').addEventListener('click', async () => {
    const name = document.getElementById('userNameInput').value.trim();
    const abbreviation = document.getElementById('userAbbrInput').value.trim();
    const password = document.getElementById('userPasswordInput').value;
    const isAdminFlag = document.getElementById('userIsAdminInput').checked;
    const isDriverFlag = document.getElementById('userIsDriverInput').checked;
    const errorEl = document.getElementById('userModalError');
    errorEl.style.display = 'none';

    if (!name || !abbreviation || !password) {
        errorEl.textContent = 'Vyplňte všechna pole.';
        errorEl.style.display = 'block';
        return;
    }

    try {
        const res = await apiFetch(`${API_URL}/users`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, abbreviation, password, isAdmin: isAdminFlag, isDriver: isDriverFlag })
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        document.getElementById('userModal').classList.remove('active');
        showToast('Účet vytvořen');
        renderUsersView();
    } catch (e) {
        errorEl.textContent = 'Nepodařilo se vytvořit účet.';
        errorEl.style.display = 'block';
    }
});

// ════════════════════════════════════════════════════════════════════════
// SETTINGS (Nastavení) — hours, closed days, pause (go-live Task 1).
// Fetches/saves the WHOLE settings object (same full-replace pattern as
// PUT /menu, PUT /timetables/:name) so sections this task's admin UI
// doesn't expose yet (delivery.fee/minOrder/freeAbove/pscWhitelist/
// etaMinutes, dailyMenu, notifications — later tasks' admin UI) always
// round-trip unchanged. See src/server/settings.js for the canonical shape.
// ════════════════════════════════════════════════════════════════════════

// go-live Task 6 (spec §11): reservation hours table now shows all 7 days,
// same list as delivery's (Sat/Sun are ordinary rows, toggled the same way).
const SETTINGS_RESV_WEEKDAYS = ['Pondělí', 'Úterý', 'Středa', 'Čtvrtek', 'Pátek', 'Sobota', 'Neděle'];
const SETTINGS_DELIVERY_WEEKDAYS = ['Pondělí', 'Úterý', 'Středa', 'Čtvrtek', 'Pátek', 'Sobota', 'Neděle'];

let settingsCache = null;
let settingsWorkingClosedDays = [];
// go-live Task 2 (delivery rules): the PSČ whitelist chip list, same
// "working array edited in place, replaced wholesale on save" pattern as
// settingsWorkingClosedDays above.
let settingsWorkingPscWhitelist = [];

async function fetchSettings() {
    try {
        const res = await apiFetch(`${API_URL}/settings`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        settingsCache = await res.json();
    } catch (e) {
        console.error('Failed to load settings:', e);
        settingsCache = null;
    }
    return settingsCache;
}

// hourIndex 1-12 -> its start-time label ("8:00" for 1, matches HOUR_LABELS
// already used by the table-detail hour grid elsewhere in this file).
function hourIndexLabel(hourIndex) {
    const label = HOUR_LABELS[hourIndex - 1];
    return label ? label.split('-')[0] : String(hourIndex);
}

function buildHourSelect(selectedValue) {
    const select = document.createElement('select');
    for (let h = 1; h <= 12; h++) {
        const opt = document.createElement('option');
        opt.value = String(h);
        opt.textContent = hourIndexLabel(h);
        if (h === selectedValue) opt.selected = true;
        select.appendChild(opt);
    }
    return select;
}

function renderReservationHoursTable(container, days) {
    container.innerHTML = '';
    SETTINGS_RESV_WEEKDAYS.forEach((label, i) => {
        const key = String(i);
        const day = (days && days[key]) || { open: true, fromHour: 1, toHour: 12 };

        const row = document.createElement('div');
        row.className = 'inn-hours-row';
        row.dataset.dayKey = key;

        const nameEl = document.createElement('span');
        nameEl.className = 'inn-hours-row__day';
        nameEl.textContent = label;
        row.appendChild(nameEl);

        const openLabel = document.createElement('label');
        openLabel.className = 'inn-hours-row__open';
        const openCheckbox = document.createElement('input');
        openCheckbox.type = 'checkbox';
        openCheckbox.checked = !!day.open;
        openCheckbox.className = 'inn-resv-open-input';
        openLabel.appendChild(openCheckbox);
        openLabel.appendChild(document.createTextNode('Otevřeno'));
        row.appendChild(openLabel);

        const fromSelect = buildHourSelect(day.fromHour || 1);
        fromSelect.className = 'inn-resv-from-input';
        const toSelect = buildHourSelect(day.toHour || 12);
        toSelect.className = 'inn-resv-to-input';

        const rangeWrap = document.createElement('span');
        rangeWrap.className = 'inn-hours-row__range';
        rangeWrap.appendChild(document.createTextNode('od'));
        rangeWrap.appendChild(fromSelect);
        rangeWrap.appendChild(document.createTextNode('do'));
        rangeWrap.appendChild(toSelect);
        row.appendChild(rangeWrap);

        container.appendChild(row);
    });
}

function renderDeliveryHoursTable(container, days) {
    container.innerHTML = '';
    SETTINGS_DELIVERY_WEEKDAYS.forEach((label, i) => {
        const key = String(i);
        const day = (days && days[key]) || { open: true, from: '10:30', to: '21:00' };

        const row = document.createElement('div');
        row.className = 'inn-hours-row';
        row.dataset.dayKey = key;

        const nameEl = document.createElement('span');
        nameEl.className = 'inn-hours-row__day';
        nameEl.textContent = label;
        row.appendChild(nameEl);

        const openLabel = document.createElement('label');
        openLabel.className = 'inn-hours-row__open';
        const openCheckbox = document.createElement('input');
        openCheckbox.type = 'checkbox';
        openCheckbox.checked = !!day.open;
        openCheckbox.className = 'inn-delivery-open-input';
        openLabel.appendChild(openCheckbox);
        openLabel.appendChild(document.createTextNode('Otevřeno'));
        row.appendChild(openLabel);

        const fromInput = document.createElement('input');
        fromInput.type = 'time';
        fromInput.className = 'inn-delivery-from-input';
        fromInput.value = day.from || '10:30';

        const toInput = document.createElement('input');
        toInput.type = 'time';
        toInput.className = 'inn-delivery-to-input';
        toInput.value = day.to || '21:00';

        const rangeWrap = document.createElement('span');
        rangeWrap.className = 'inn-hours-row__range';
        rangeWrap.appendChild(document.createTextNode('od'));
        rangeWrap.appendChild(fromInput);
        rangeWrap.appendChild(document.createTextNode('do'));
        rangeWrap.appendChild(toInput);
        row.appendChild(rangeWrap);

        container.appendChild(row);
    });
}

// Table QR self-order (plan Task 6, spec §7) — straight clone of
// renderDeliveryHoursTable() above; settings.tableOrdering.days reuses
// deliveryDaysSchema server-side specifically so this could be a clone
// rather than a new shape to learn. Own class names on the inputs
// (inn-tableordering-*) so collectTableOrderingDaysFromForm() below can't
// accidentally pick up the delivery hours table's rows or vice versa.
function renderTableOrderingHoursTable(container, days) {
    container.innerHTML = '';
    SETTINGS_DELIVERY_WEEKDAYS.forEach((label, i) => {
        const key = String(i);
        const day = (days && days[key]) || { open: true, from: '11:00', to: '21:00' };

        const row = document.createElement('div');
        row.className = 'inn-hours-row';
        row.dataset.dayKey = key;

        const nameEl = document.createElement('span');
        nameEl.className = 'inn-hours-row__day';
        nameEl.textContent = label;
        row.appendChild(nameEl);

        const openLabel = document.createElement('label');
        openLabel.className = 'inn-hours-row__open';
        const openCheckbox = document.createElement('input');
        openCheckbox.type = 'checkbox';
        openCheckbox.checked = !!day.open;
        openCheckbox.className = 'inn-tableordering-open-input';
        openLabel.appendChild(openCheckbox);
        openLabel.appendChild(document.createTextNode('Otevřeno'));
        row.appendChild(openLabel);

        const fromInput = document.createElement('input');
        fromInput.type = 'time';
        fromInput.className = 'inn-tableordering-from-input';
        fromInput.value = day.from || '11:00';

        const toInput = document.createElement('input');
        toInput.type = 'time';
        toInput.className = 'inn-tableordering-to-input';
        toInput.value = day.to || '21:00';

        const rangeWrap = document.createElement('span');
        rangeWrap.className = 'inn-hours-row__range';
        rangeWrap.appendChild(document.createTextNode('od'));
        rangeWrap.appendChild(fromInput);
        rangeWrap.appendChild(document.createTextNode('do'));
        rangeWrap.appendChild(toInput);
        row.appendChild(rangeWrap);

        container.appendChild(row);
    });
}

function renderClosedDaysList(container) {
    container.innerHTML = '';
    if (settingsWorkingClosedDays.length === 0) {
        const empty = document.createElement('p');
        empty.style.color = 'var(--muted)';
        empty.style.fontSize = '0.85em';
        empty.textContent = 'Žádné zavřené dny.';
        container.appendChild(empty);
        return;
    }
    settingsWorkingClosedDays.forEach((cd, idx) => {
        const row = document.createElement('div');
        row.className = 'inn-closed-day-row';

        const dateEl = document.createElement('span');
        dateEl.className = 'inn-closed-day-row__date';
        dateEl.textContent = cd.date;
        row.appendChild(dateEl);

        const noteEl = document.createElement('span');
        noteEl.className = 'inn-closed-day-row__note';
        noteEl.textContent = cd.note || '';
        row.appendChild(noteEl);

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'inn-btn danger small';
        removeBtn.textContent = 'Odebrat';
        removeBtn.addEventListener('click', () => {
            settingsWorkingClosedDays.splice(idx, 1);
            renderClosedDaysList(container);
        });
        row.appendChild(removeBtn);

        container.appendChild(row);
    });
}

// go-live Task 2 (delivery rules) — PSČ whitelist chips. Empty list means
// "no restriction" (settings.js's quoteDelivery skips the whitelist check
// entirely when the array is empty) — shown here as a hint, not an error.
const PSC_RE = /^\d{5}$/;

function renderPscChips(container) {
    container.innerHTML = '';
    if (settingsWorkingPscWhitelist.length === 0) {
        const empty = document.createElement('span');
        empty.className = 'inn-psc-empty';
        empty.textContent = 'Bez omezení — rozvážíme do všech PSČ.';
        container.appendChild(empty);
        return;
    }
    settingsWorkingPscWhitelist.forEach((psc, idx) => {
        const chip = document.createElement('span');
        chip.className = 'inn-psc-chip';
        chip.textContent = psc;

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'inn-psc-chip__remove';
        removeBtn.setAttribute('aria-label', `Odebrat PSČ ${psc}`);
        removeBtn.textContent = '×';
        removeBtn.addEventListener('click', () => {
            settingsWorkingPscWhitelist.splice(idx, 1);
            renderPscChips(container);
        });
        chip.appendChild(removeBtn);

        container.appendChild(chip);
    });
}

function updatePauseSwitchVisual(rowEl, checkbox) {
    rowEl.classList.toggle('is-active', checkbox.checked);
}

function buildPauseSwitchRow(id, label, hint, checked) {
    const row = document.createElement('div');
    row.className = 'inn-switch-row';

    const body = document.createElement('span');
    body.className = 'inn-switch-row__body';
    const labelEl = document.createElement('span');
    labelEl.className = 'inn-switch-row__label';
    labelEl.textContent = label;
    const hintEl = document.createElement('span');
    hintEl.className = 'inn-switch-row__hint';
    hintEl.textContent = hint;
    body.appendChild(labelEl);
    body.appendChild(hintEl);
    row.appendChild(body);

    const switchLabel = document.createElement('label');
    switchLabel.className = 'inn-switch';
    const checkboxEl = document.createElement('input');
    checkboxEl.type = 'checkbox';
    checkboxEl.id = id;
    checkboxEl.className = 'inn-switch-input';
    checkboxEl.checked = !!checked;
    const track = document.createElement('span');
    track.className = 'inn-switch-track';
    switchLabel.appendChild(checkboxEl);
    switchLabel.appendChild(track);
    row.appendChild(switchLabel);

    updatePauseSwitchVisual(row, checkboxEl);
    checkboxEl.addEventListener('change', () => updatePauseSwitchVisual(row, checkboxEl));

    return { row, checkbox: checkboxEl };
}

async function renderSettingsView() {
    const container = document.getElementById('settingsView');
    container.innerHTML = '<p style="color:var(--muted);">Načítání…</p>';

    const settings = await fetchSettings();
    if (!settings) {
        container.innerHTML = '<p style="color:var(--danger);">Nepodařilo se načíst nastavení.</p>';
        return;
    }

    settingsWorkingClosedDays = (settings.closedDays || []).map(cd => ({ date: cd.date, note: cd.note || '' }));
    settingsWorkingPscWhitelist = (settings.delivery.pscWhitelist || []).slice();

    container.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'inn-menu-header';
    header.innerHTML = '<h2>Nastavení</h2>';
    container.appendChild(header);

    const panels = document.createElement('div');
    panels.className = 'inn-settings-panels';
    container.appendChild(panels);

    // ── Provozovna ───────────────────────────────────────────────────────
    const bizPanel = document.createElement('div');
    bizPanel.className = 'inn-panel';
    bizPanel.innerHTML = `
        <h3 class="inn-settings-section-title">Provozovna</h3>
        <div class="inn-settings-grid">
            <div class="inn-field-group"><label for="setBizName">Název provozovny</label><input type="text" id="setBizName" maxlength="200"></div>
            <div class="inn-field-group"><label for="setBizIco">IČO</label><input type="text" id="setBizIco" maxlength="20"></div>
            <div class="inn-field-group"><label for="setBizDic">DIČ</label><input type="text" id="setBizDic" maxlength="20"></div>
            <div class="inn-field-group"><label for="setBizAddress">Adresa</label><input type="text" id="setBizAddress" maxlength="300"></div>
            <div class="inn-field-group"><label for="setBizEmail">E-mail</label><input type="email" id="setBizEmail" maxlength="200"></div>
            <div class="inn-field-group"><label for="setBizPhone">Telefon</label><input type="tel" id="setBizPhone" maxlength="30"></div>
            <div class="inn-field-group"><label for="setBizTermsDate">Účinnost obchodních podmínek</label><input type="text" id="setBizTermsDate" maxlength="40" placeholder="např. 19. 7. 2026 — prázdné = dnešní datum"></div>
        </div>
    `;
    panels.appendChild(bizPanel);
    bizPanel.querySelector('#setBizName').value = settings.business.name || '';
    bizPanel.querySelector('#setBizIco').value = settings.business.ico || '';
    bizPanel.querySelector('#setBizDic').value = settings.business.dic || '';
    bizPanel.querySelector('#setBizAddress').value = settings.business.address || '';
    bizPanel.querySelector('#setBizEmail').value = settings.business.email || '';
    bizPanel.querySelector('#setBizPhone').value = settings.business.phone || '';
    bizPanel.querySelector('#setBizTermsDate').value = settings.business.termsEffectiveDate || '';

    // ── Rezervace — otevírací hodiny ─────────────────────────────────────
    const resvPanel = document.createElement('div');
    resvPanel.className = 'inn-panel';
    resvPanel.innerHTML = '<h3 class="inn-settings-section-title">Rezervace — otevírací hodiny</h3><div class="inn-hours-table" id="setResvHoursTable"></div>';
    panels.appendChild(resvPanel);
    renderReservationHoursTable(resvPanel.querySelector('#setResvHoursTable'), settings.reservations.days);

    // ── Rozvoz — hodiny ───────────────────────────────────────────────────
    const deliveryPanel = document.createElement('div');
    deliveryPanel.className = 'inn-panel';
    deliveryPanel.innerHTML = '<h3 class="inn-settings-section-title">Rozvoz — hodiny</h3><div class="inn-hours-table" id="setDeliveryHoursTable"></div>';
    panels.appendChild(deliveryPanel);
    renderDeliveryHoursTable(deliveryPanel.querySelector('#setDeliveryHoursTable'), settings.delivery.days);

    // ── Objednávky u stolu (plan Task 6, spec §7) ───────────────────────────
    // `days` reuses deliveryDaysSchema server-side — same shape as
    // "Rozvoz — hodiny" above by design — so renderTableOrderingHoursTable()
    // below is a straight clone of renderDeliveryHoursTable().
    //
    // The `enabled` checkbox is deliberately a plain checkbox, NOT
    // buildPauseSwitchRow's red/"danger" switch (used elsewhere in this view
    // for Pozastavení and Notifikace): that styling means "you have turned
    // something off/risky for real customers", which is backwards here —
    // turning THIS on is the normal, correct end state once the QR codes are
    // printed and placed, and painting it red the moment an admin does the
    // right thing would read as an error. It defaults to OFF server-side
    // (settings.js) purely because printing/placing the codes is the actual
    // deployment step, not because being on is itself a risk.
    const tableOrderingPanel = document.createElement('div');
    tableOrderingPanel.className = 'inn-panel';
    tableOrderingPanel.innerHTML = `
        <h3 class="inn-settings-section-title">Objednávky u stolu</h3>
        <label class="inn-tableordering-enable-row" for="setTableOrderingEnabled">
            <input type="checkbox" id="setTableOrderingEnabled">
            <span>
                <strong>Povolit objednávky u stolu</strong>
                <small>Hosté budou moci naskenovat QR kód na stole a objednat si přímo z mobilu. Zapněte až po vytištění a rozmístění QR kódů (detail stolu, nebo „Tisknout QR kódy všech stolů“ v Rozložení).</small>
            </span>
        </label>
        <div class="inn-hours-table" id="setTableOrderingHoursTable"></div>
    `;
    panels.appendChild(tableOrderingPanel);
    tableOrderingPanel.querySelector('#setTableOrderingEnabled').checked = !!settings.tableOrdering.enabled;
    renderTableOrderingHoursTable(tableOrderingPanel.querySelector('#setTableOrderingHoursTable'), settings.tableOrdering.days);

    // ── Rozvoz — pravidla (fee/min-order/free-above/PSČ/ETA — go-live Task 2) ──
    const deliveryRulesPanel = document.createElement('div');
    deliveryRulesPanel.className = 'inn-panel';
    deliveryRulesPanel.innerHTML = `
        <h3 class="inn-settings-section-title">Rozvoz — pravidla</h3>
        <div class="inn-settings-grid">
            <div class="inn-field-group"><label for="setDeliveryFee">Poplatek za dopravu (Kč)</label><input type="number" id="setDeliveryFee" min="0" max="10000" step="1"></div>
            <div class="inn-field-group"><label for="setDeliveryMinOrder">Minimální objednávka (Kč)</label><input type="number" id="setDeliveryMinOrder" min="0" max="100000" step="1"></div>
            <div class="inn-field-group"><label for="setDeliveryFreeAbove">Doprava zdarma od (Kč, 0 = nikdy)</label><input type="number" id="setDeliveryFreeAbove" min="0" max="100000" step="1"></div>
            <div class="inn-field-group"><label for="setDeliveryEta">Doba doručení (min)</label><input type="number" id="setDeliveryEta" min="1" max="600" step="1"></div>
        </div>
        <div class="inn-field-group inn-psc-field-group">
            <label>PSČ whitelist</label>
            <p class="inn-settings-hint">Prázdný seznam = rozvážíme do všech PSČ.</p>
            <div class="inn-psc-chips" id="setPscChips"></div>
            <div class="inn-psc-add">
                <input type="text" id="setPscInput" inputmode="numeric" maxlength="5" placeholder="Např. 12000">
                <button type="button" class="inn-btn" id="setPscAddBtn">+ Přidat</button>
            </div>
        </div>
    `;
    panels.appendChild(deliveryRulesPanel);
    deliveryRulesPanel.querySelector('#setDeliveryFee').value = settings.delivery.fee;
    deliveryRulesPanel.querySelector('#setDeliveryMinOrder').value = settings.delivery.minOrder;
    deliveryRulesPanel.querySelector('#setDeliveryFreeAbove').value = settings.delivery.freeAbove;
    deliveryRulesPanel.querySelector('#setDeliveryEta').value = settings.delivery.etaMinutes;
    const pscChipsEl = deliveryRulesPanel.querySelector('#setPscChips');
    renderPscChips(pscChipsEl);

    function addPscFromInput() {
        const input = deliveryRulesPanel.querySelector('#setPscInput');
        const value = input.value.trim();
        if (!PSC_RE.test(value)) {
            showToast('PSČ musí být přesně 5 číslic', true);
            return;
        }
        if (settingsWorkingPscWhitelist.includes(value)) {
            showToast('Toto PSČ už je v seznamu', true);
            return;
        }
        settingsWorkingPscWhitelist.push(value);
        settingsWorkingPscWhitelist.sort();
        renderPscChips(pscChipsEl);
        input.value = '';
        input.focus();
    }
    deliveryRulesPanel.querySelector('#setPscAddBtn').addEventListener('click', addPscFromInput);
    deliveryRulesPanel.querySelector('#setPscInput').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); addPscFromInput(); }
    });

    // ── Zavřené dny ───────────────────────────────────────────────────────
    const closedPanel = document.createElement('div');
    closedPanel.className = 'inn-panel';
    closedPanel.innerHTML = `
        <h3 class="inn-settings-section-title">Zavřené dny</h3>
        <div id="setClosedDaysList"></div>
        <div class="inn-closed-day-add">
            <input type="date" id="setClosedDayDate">
            <input type="text" id="setClosedDayNote" placeholder="Poznámka (např. Vánoce)" maxlength="200">
            <button type="button" class="inn-btn" id="setClosedDayAddBtn">+ Přidat</button>
        </div>
    `;
    panels.appendChild(closedPanel);
    const closedDaysListEl = closedPanel.querySelector('#setClosedDaysList');
    renderClosedDaysList(closedDaysListEl);
    closedPanel.querySelector('#setClosedDayAddBtn').addEventListener('click', () => {
        const dateInput = closedPanel.querySelector('#setClosedDayDate');
        const noteInput = closedPanel.querySelector('#setClosedDayNote');
        const date = dateInput.value;
        const note = noteInput.value.trim();
        if (!date) {
            showToast('Vyberte prosím datum', true);
            return;
        }
        if (settingsWorkingClosedDays.some(cd => cd.date === date)) {
            showToast('Tento den už je v seznamu zavřených dnů', true);
            return;
        }
        settingsWorkingClosedDays.push({ date, note });
        settingsWorkingClosedDays.sort((a, b) => a.date.localeCompare(b.date));
        renderClosedDaysList(closedDaysListEl);
        dateInput.value = '';
        noteInput.value = '';
    });

    // ── Pozastavení ───────────────────────────────────────────────────────
    const pausePanel = document.createElement('div');
    pausePanel.className = 'inn-panel';
    const pauseTitle = document.createElement('h3');
    pauseTitle.className = 'inn-settings-section-title';
    pauseTitle.textContent = 'Pozastavení';
    pausePanel.appendChild(pauseTitle);

    const resvPause = buildPauseSwitchRow(
        'setResvPaused',
        'Pozastavit rezervace',
        'Zákazníci uvidí zprávu, že rezervace jsou dočasně pozastaveny, a nemohou rezervovat.',
        settings.reservations.paused
    );
    pausePanel.appendChild(resvPause.row);

    const deliveryPause = buildPauseSwitchRow(
        'setDeliveryPaused',
        'Pozastavit rozvoz',
        'Zákazníci uvidí zprávu, že rozvoz je dočasně pozastaven, a nemohou objednat.',
        settings.delivery.paused
    );
    pausePanel.appendChild(deliveryPause.row);

    panels.appendChild(pausePanel);

    // ── Notifikace (go-live Task 4, spec §6) ────────────────────────────────
    // Five independent toggles — each one gates exactly one server-side
    // notification event (see notify.js/server.js). Reuses buildPauseSwitchRow
    // (same styled switch as the Pozastavení section above) purely for visual
    // consistency; semantically these are plain on/off settings, not "pause"
    // switches, so none of them turn red/is-active-styled the way a pause
    // does — that styling only keys off buildPauseSwitchRow's own CSS class,
    // which is agnostic to what the switch actually means.
    const notifPanel = document.createElement('div');
    notifPanel.className = 'inn-panel';
    const notifTitle = document.createElement('h3');
    notifTitle.className = 'inn-settings-section-title';
    notifTitle.textContent = 'Notifikace';
    notifPanel.appendChild(notifTitle);

    const notif = settings.notifications || {};

    const notifOrderConfirmed = buildPauseSwitchRow(
        'setNotifOrderConfirmed', 'SMS: potvrzení objednávky',
        'Zákazník dostane SMS hned po přijetí rozvozové objednávky.',
        notif.smsOrderConfirmed
    );
    notifPanel.appendChild(notifOrderConfirmed.row);

    const notifOrderOnTheWay = buildPauseSwitchRow(
        'setNotifOrderOnTheWay', 'SMS: objednávka na cestě',
        'Zákazník dostane SMS, jakmile řidič objednávku převezme.',
        notif.smsOrderOnTheWay
    );
    notifPanel.appendChild(notifOrderOnTheWay.row);

    const notifReservationConfirmed = buildPauseSwitchRow(
        'setNotifReservationConfirmed', 'SMS: potvrzení rezervace',
        'Zákazník dostane SMS se shrnutím ihned po dokončení rezervace.',
        notif.smsReservationConfirmed
    );
    notifPanel.appendChild(notifReservationConfirmed.row);

    const notifReservationReminder = buildPauseSwitchRow(
        'setNotifReservationReminder', 'SMS: připomenutí rezervace (2 h předem)',
        'Zákazník dostane připomínku přibližně 2 hodiny před začátkem rezervace.',
        notif.smsReservationReminder
    );
    notifPanel.appendChild(notifReservationReminder.row);

    const notifEmailEnabled = buildPauseSwitchRow(
        'setNotifEmailEnabled', 'E-mailová potvrzení',
        'Pokud zákazník při objednávce zadá e-mail, pošleme mu potvrzení objednávky.',
        notif.emailEnabled
    );
    notifPanel.appendChild(notifEmailEnabled.row);

    const notifHint = document.createElement('p');
    notifHint.className = 'inn-settings-hint';
    notifHint.textContent = 'Každá odeslaná SMS je zpoplatněna dle ceníku Twilio.';
    notifPanel.appendChild(notifHint);

    panels.appendChild(notifPanel);

    // ── Save ──────────────────────────────────────────────────────────────
    const actions = document.createElement('div');
    actions.className = 'inn-settings-actions';
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'inn-btn primary';
    saveBtn.id = 'setSaveBtn';
    saveBtn.textContent = 'Uložit nastavení';
    saveBtn.addEventListener('click', () => saveSettingsFromForm(resvPause.checkbox, deliveryPause.checkbox, {
        smsOrderConfirmed: notifOrderConfirmed.checkbox,
        smsOrderOnTheWay: notifOrderOnTheWay.checkbox,
        smsReservationConfirmed: notifReservationConfirmed.checkbox,
        smsReservationReminder: notifReservationReminder.checkbox,
        emailEnabled: notifEmailEnabled.checkbox,
    }));
    actions.appendChild(saveBtn);
    container.appendChild(actions);
}

function collectReservationDaysFromForm() {
    const days = {};
    document.querySelectorAll('#setResvHoursTable .inn-hours-row').forEach(row => {
        const key = row.dataset.dayKey;
        days[key] = {
            open: row.querySelector('.inn-resv-open-input').checked,
            fromHour: Number(row.querySelector('.inn-resv-from-input').value),
            toHour: Number(row.querySelector('.inn-resv-to-input').value),
        };
    });
    return days;
}

function collectDeliveryDaysFromForm() {
    const days = {};
    document.querySelectorAll('#setDeliveryHoursTable .inn-hours-row').forEach(row => {
        const key = row.dataset.dayKey;
        days[key] = {
            open: row.querySelector('.inn-delivery-open-input').checked,
            from: row.querySelector('.inn-delivery-from-input').value,
            to: row.querySelector('.inn-delivery-to-input').value,
        };
    });
    return days;
}

// Table QR self-order (plan Task 6, spec §7) — mirrors collectDeliveryDaysFromForm().
function collectTableOrderingDaysFromForm() {
    const days = {};
    document.querySelectorAll('#setTableOrderingHoursTable .inn-hours-row').forEach(row => {
        const key = row.dataset.dayKey;
        days[key] = {
            open: row.querySelector('.inn-tableordering-open-input').checked,
            from: row.querySelector('.inn-tableordering-from-input').value,
            to: row.querySelector('.inn-tableordering-to-input').value,
        };
    });
    return days;
}

async function saveSettingsFromForm(resvPausedCheckbox, deliveryPausedCheckbox, notifCheckboxes) {
    if (!settingsCache) return;
    const saveBtn = document.getElementById('setSaveBtn');

    const resvDays = collectReservationDaysFromForm();
    for (const key of Object.keys(resvDays)) {
        if (resvDays[key].fromHour > resvDays[key].toHour) {
            showToast('U rezervací musí být hodina „od“ menší nebo rovna hodině „do“.', true);
            return;
        }
    }

    const deliveryDays = collectDeliveryDaysFromForm();
    for (const key of Object.keys(deliveryDays)) {
        if (!(deliveryDays[key].from < deliveryDays[key].to)) {
            showToast('U rozvozu musí být čas „od“ dříve než čas „do“.', true);
            return;
        }
    }

    // Table QR self-order (plan Task 6, spec §7) — same shape/validation as
    // delivery hours above (deliveryDaysSchema is reused server-side too).
    const tableOrderingDays = collectTableOrderingDaysFromForm();
    for (const key of Object.keys(tableOrderingDays)) {
        if (!(tableOrderingDays[key].from < tableOrderingDays[key].to)) {
            showToast('U objednávek u stolu musí být čas „od“ dříve než čas „do“.', true);
            return;
        }
    }

    // go-live Task 2 — delivery rules (fee/min-order/free-above/ETA). Mirrors
    // the bounds already enforced server-side by settingsSchema in
    // validation.js (nonNegNumber/boundedInt) so a bad value gets a clear
    // Czech message here instead of a generic 400 round-trip.
    const deliveryFeeVal = Number(document.getElementById('setDeliveryFee').value);
    const deliveryMinOrderVal = Number(document.getElementById('setDeliveryMinOrder').value);
    const deliveryFreeAboveVal = Number(document.getElementById('setDeliveryFreeAbove').value);
    const deliveryEtaVal = Number(document.getElementById('setDeliveryEta').value);

    if (!Number.isFinite(deliveryFeeVal) || deliveryFeeVal < 0) {
        showToast('Poplatek za dopravu musí být nezáporné číslo', true);
        return;
    }
    if (!Number.isFinite(deliveryMinOrderVal) || deliveryMinOrderVal < 0) {
        showToast('Minimální objednávka musí být nezáporné číslo', true);
        return;
    }
    if (!Number.isFinite(deliveryFreeAboveVal) || deliveryFreeAboveVal < 0) {
        showToast('Doprava zdarma od musí být nezáporné číslo', true);
        return;
    }
    if (!Number.isInteger(deliveryEtaVal) || deliveryEtaVal < 1 || deliveryEtaVal > 600) {
        showToast('Doba doručení musí být celé číslo 1–600 minut', true);
        return;
    }

    const updated = {
        ...settingsCache,
        business: {
            ...settingsCache.business,
            name: document.getElementById('setBizName').value.trim(),
            ico: document.getElementById('setBizIco').value.trim(),
            dic: document.getElementById('setBizDic').value.trim(),
            address: document.getElementById('setBizAddress').value.trim(),
            email: document.getElementById('setBizEmail').value.trim(),
            phone: document.getElementById('setBizPhone').value.trim(),
            termsEffectiveDate: document.getElementById('setBizTermsDate').value.trim(),
        },
        reservations: {
            ...settingsCache.reservations,
            paused: resvPausedCheckbox.checked,
            days: resvDays,
        },
        delivery: {
            ...settingsCache.delivery,
            paused: deliveryPausedCheckbox.checked,
            days: deliveryDays,
            fee: deliveryFeeVal,
            minOrder: deliveryMinOrderVal,
            freeAbove: deliveryFreeAboveVal,
            etaMinutes: deliveryEtaVal,
            pscWhitelist: settingsWorkingPscWhitelist.slice(),
        },
        // Table QR self-order (plan Task 6, spec §7) — read straight off the
        // DOM by id (same pattern as the Provozovna fields above) rather than
        // threaded through as a function argument like the pause/notification
        // checkboxes, since it isn't built via buildPauseSwitchRow.
        tableOrdering: {
            ...settingsCache.tableOrdering,
            enabled: document.getElementById('setTableOrderingEnabled').checked,
            days: tableOrderingDays,
        },
        closedDays: settingsWorkingClosedDays.map(cd => ({ date: cd.date, note: cd.note || '' })),
        // go-live Task 4 (spec §6) — Notifikace toggles.
        notifications: {
            ...settingsCache.notifications,
            smsOrderConfirmed: notifCheckboxes.smsOrderConfirmed.checked,
            smsOrderOnTheWay: notifCheckboxes.smsOrderOnTheWay.checked,
            smsReservationConfirmed: notifCheckboxes.smsReservationConfirmed.checked,
            smsReservationReminder: notifCheckboxes.smsReservationReminder.checked,
            emailEnabled: notifCheckboxes.emailEnabled.checked,
        },
    };

    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Ukládám…'; }
    try {
        const res = await apiFetch(`${API_URL}/settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(updated)
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        settingsCache = data.settings || updated;
        showToast('Nastavení uloženo');
    } catch (e) {
        console.error('Failed to save settings:', e);
        showToast(e.message || 'Nepodařilo se uložit nastavení', true);
    } finally {
        if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Uložit nastavení'; }
    }
}

// ════════════════════════════════════════════════════════════════════════
// FLOORPLAN LAYOUT EDITOR ("Rozložení") — design doc §6.4. Admin-only
// drag/resize editor for settings.floorplan.rooms (rooms + fixtures) and
// each table's seats/layout.
//
// Everything below operates on WORKING COPIES — layoutWorkingRooms and
// layoutWorkingTables — deep-cloned from settingsCache/`tables` the moment
// the editor is opened (renderLayoutView). Dragging, resizing, typing into
// the side panel, and all room/fixture CRUD only ever mutate those working
// copies and flip the top-level `layoutDirty` flag (declared with the other
// view-level state near the top of this file, so switchView()'s
// navigate-away guard and the 'beforeunload' listener can see it). Nothing
// reaches the server until saveLayoutChanges() runs, which is exactly the
// design's "nothing persists until Uložit rozložení is clicked" — see
// renderLayoutView()/saveLayoutChanges() below.
//
// FloorPlan.render() (src/js/floorplan.js, built in parallel by a different
// track against the same fixed contract this file was written against) only
// draws the room/fixtures/tables — it doesn't know anything about editing.
// The drag/resize/select interactions below are layered on top of whatever
// DOM it produces. Since this file doesn't own floorplan.js and can't
// assume its exact markup, element lookup goes through a few defensive
// strategies (see findRenderedTableEl/findRenderedFixtureEl) rather than one
// hardcoded selector, and canvas pixel measurements are taken via
// `el.offsetParent` — the nearest positioned ancestor is, by definition,
// whatever element FloorPlan sized to the room's aspect ratio and
// percentage-positions children against (design §4.3), so this works
// regardless of what that element is called or how it's structured.
// ════════════════════════════════════════════════════════════════════════

let layoutWorkingRooms = [];        // deep clone of settings.floorplan.rooms — edited in place
let layoutOriginalTables = {};      // name -> JSON snapshot of {seats,layout} at editor-open time, for diffing on save
let layoutWorkingTables = {};       // name -> { seats, layout } — the editable copy of every table's placement
let layoutActiveRoomId = null;
let layoutSelectedTableName = null;
let layoutSelectedFixtureIndex = null; // index into layoutWorkingRooms[activeRoom].fixtures
let layoutSaving = false;

// Room shape editing (docs/superpowers/specs/2026-07-28-room-shape-editing-
// design.md §5) — a room's optional `corners` array is edited through this
// SAME layoutWorkingRooms working copy and the SAME dirty/save machinery as
// everything else in this file (design §6.4/§5.2's "no new save path"):
// dragging or numerically editing a corner just writes room.corners and
// calls markLayoutDirty(), exactly like a table drag writes layout.x/y.
// Corner editing is gated on the active room being empty of placed tables
// (design §5.1) — see roomPlacedTableNames()/renderLayoutGateBanner() below.
let layoutSelectedCornerIndex = null; // index into FloorPlan.roomCorners(activeRoom)

async function renderLayoutView() {
    const container = document.getElementById('layoutView');
    container.innerHTML = '<p style="color:var(--muted);">Načítání…</p>';

    const settings = await fetchSettings();
    if (!settings) {
        container.innerHTML = '<p style="color:var(--danger);">Nepodařilo se načíst nastavení.</p>';
        return;
    }

    // Fresh working copies every time the editor is (re)opened. switchView()'s
    // navigate-away guard already asked about any unsaved changes before we
    // get here, so it's safe to discard whatever was in progress and start
    // clean from the server's current state.
    layoutWorkingRooms = JSON.parse(JSON.stringify(settings.floorplan?.rooms || []));
    layoutWorkingTables = {};
    layoutOriginalTables = {};
    Object.keys(tables).forEach(name => {
        const t = tables[name];
        const seats = typeof t.seats === 'number' ? t.seats : undefined;
        const layout = t.layout ? { ...t.layout } : null;
        layoutWorkingTables[name] = { seats, layout };
        layoutOriginalTables[name] = layoutSnapshotKey(seats, layout);
    });
    layoutActiveRoomId = layoutWorkingRooms[0] ? layoutWorkingRooms[0].id : null;
    layoutSelectedTableName = null;
    layoutSelectedFixtureIndex = null;
    layoutSelectedCornerIndex = null;
    layoutDirty = false;

    container.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'inn-menu-header';
    header.innerHTML = `<h2>Rozložení sálu <span class="inn-layout-unsaved-badge" id="layoutUnsavedBadge" style="display:none;">Neuložené změny</span></h2>`;
    container.appendChild(header);

    const hint = document.createElement('p');
    hint.style.cssText = 'color:var(--muted); font-size:0.9em; margin:-6px 0 16px;';
    hint.textContent = 'Přetáhněte stůl na plánku, nebo změňte jeho polohu a velikost úchytem vpravo dole. Tvar prázdné místnosti upravíte tažením rohů (čtverečky v rozích) — kliknutím na „+“ uprostřed stěny přidáte roh. Vpravo lze vše nastavit i číselně. Nic se neuloží, dokud nekliknete na „Uložit rozložení“.';
    container.appendChild(hint);

    const toolbar = document.createElement('div');
    toolbar.className = 'inn-layout-toolbar';
    toolbar.innerHTML = `
        <button class="inn-btn small" id="layoutAddRoomBtn">+ Místnost</button>
        <button class="inn-btn small" id="layoutEditRoomBtn">✎ Upravit místnost</button>
        <button class="inn-btn danger small" id="layoutDeleteRoomBtn">Smazat místnost</button>
        <span class="inn-layout-toolbar-spacer"></span>
        <button class="inn-btn small" id="layoutAddBlockBtn">+ Blok</button>
        <button class="inn-btn small" id="layoutAddDoorBtn">+ Dveře</button>
        <button class="inn-btn small" id="layoutAutoArrangeBtn">Auto-rozmístit</button>
        <span class="inn-layout-toolbar-spacer"></span>
        <button class="inn-btn small" id="layoutPrintQrBtn">🖨 Tisknout QR kódy všech stolů</button>
        <button class="inn-btn primary" id="layoutSaveBtn">Uložit rozložení</button>
    `;
    container.appendChild(toolbar);

    const body = document.createElement('div');
    body.className = 'inn-layout-body';

    const canvasCol = document.createElement('div');
    canvasCol.className = 'inn-layout-canvas-col';

    // Empty-room gate (design §5.1) and the outside-walls warning (design
    // §5.3) are persistent elements, updated in place by renderLayoutCanvas()
    // every re-render rather than rebuilt from scratch — same reasoning as
    // layoutUnsavedBadge above: they sit outside FloorPlan.render()'s own
    // container.innerHTML wipe, so they survive every canvas re-render.
    const gateBanner = document.createElement('div');
    gateBanner.id = 'layoutGateBanner';
    gateBanner.className = 'inn-layout-gate';
    gateBanner.style.display = 'none';
    canvasCol.appendChild(gateBanner);

    const canvasHost = document.createElement('div');
    canvasHost.id = 'layoutCanvasHost';
    canvasCol.appendChild(canvasHost);

    const outsideWarning = document.createElement('div');
    outsideWarning.id = 'layoutOutsideWarning';
    outsideWarning.className = 'inn-layout-outside-warning';
    outsideWarning.style.display = 'none';
    canvasCol.appendChild(outsideWarning);
    const trayHost = document.createElement('div');
    trayHost.id = 'layoutTrayHost';
    trayHost.className = 'inn-layout-tray';
    canvasCol.appendChild(trayHost);
    body.appendChild(canvasCol);

    const sidePanel = document.createElement('div');
    sidePanel.id = 'layoutSidePanel';
    sidePanel.className = 'inn-layout-side-panel';
    body.appendChild(sidePanel);

    container.appendChild(body);

    document.getElementById('layoutAddRoomBtn').addEventListener('click', openRoomModalForCreate);
    document.getElementById('layoutEditRoomBtn').addEventListener('click', openRoomModalForEdit);
    document.getElementById('layoutDeleteRoomBtn').addEventListener('click', deleteActiveRoom);
    document.getElementById('layoutAddBlockBtn').addEventListener('click', () => addFixture('block'));
    document.getElementById('layoutAddDoorBtn').addEventListener('click', () => addFixture('door'));
    document.getElementById('layoutAutoArrangeBtn').addEventListener('click', autoArrangeUnplaced);
    document.getElementById('layoutPrintQrBtn').addEventListener('click', async () => {
        const tokens = await fetchTableQrTokens();
        printTableQrSheet(tokens);
    });
    document.getElementById('layoutSaveBtn').addEventListener('click', saveLayoutChanges);

    renderLayoutCanvas();
    renderLayoutSidePanel();
    renderLayoutTray();
    updateLayoutSaveBadge();
}

function layoutSnapshotKey(seats, layout) {
    return JSON.stringify({ seats: seats ?? null, layout: layout || null });
}

function markLayoutDirty() {
    layoutDirty = true;
    updateLayoutSaveBadge();
}

function updateLayoutSaveBadge() {
    const badge = document.getElementById('layoutUnsavedBadge');
    if (badge) badge.style.display = layoutDirty ? 'inline-block' : 'none';
}

// ── Canvas (FloorPlan.render + drag/resize wiring) ─────────────────────────

function buildLayoutFpTables() {
    return Object.keys(layoutWorkingTables).map(name => {
        const w = layoutWorkingTables[name];
        return {
            name,
            seats: w.seats,
            layout: w.layout,
            state: name === layoutSelectedTableName ? 'selected' : 'free',
            sublabel: '',
        };
    });
}

function renderLayoutCanvas() {
    const host = document.getElementById('layoutCanvasHost');
    if (!host) return;
    host.innerHTML = '';

    if (layoutWorkingRooms.length === 0) {
        host.innerHTML = '<p style="color:var(--muted);">Zatím není definována žádná místnost. Přidejte první tlačítkem „+ Místnost“ výše.</p>';
        renderLayoutGateBanner(null, []);
        renderLayoutOutsideWarning([]);
        return;
    }
    if (!layoutActiveRoomId || !layoutWorkingRooms.some(r => r.id === layoutActiveRoomId)) {
        layoutActiveRoomId = layoutWorkingRooms[0].id;
    }

    FloorPlan.render(host, {
        rooms: layoutWorkingRooms,
        tables: buildLayoutFpTables(),
        activeRoomId: layoutActiveRoomId,
        onRoomChange: (roomId) => {
            layoutActiveRoomId = roomId;
            layoutSelectedTableName = null;
            layoutSelectedFixtureIndex = null;
            layoutSelectedCornerIndex = null;
            renderLayoutCanvas();
            renderLayoutSidePanel();
        },
        onTableClick: (name) => {
            layoutSelectedTableName = name;
            layoutSelectedFixtureIndex = null;
            layoutSelectedCornerIndex = null;
            renderLayoutSidePanel();
            renderLayoutCanvas(); // re-render so the 'selected' visual state applies
        },
    });

    wireLayoutTableDragHandlers(host);
    wireLayoutFixtureHandlers(host);

    // Room shape editing (design §5) — layered on top of whatever
    // FloorPlan.render() just drew, same "this file doesn't own floorplan.js
    // so element lookup is defensive" spirit as the table/fixture wiring
    // above. The empty-room gate (§5.1) is checked FIRST: it decides whether
    // renderLayoutCorners() draws interactive drag handles or greyed,
    // non-interactive ones, and whether a stale corner selection from before
    // a table got (re)placed in this room needs clearing.
    const room = layoutWorkingRooms.find(r => r.id === layoutActiveRoomId);
    const gateNames = room ? roomPlacedTableNames(room.id) : [];
    const isGated = gateNames.length > 0;
    if (isGated && layoutSelectedCornerIndex != null) layoutSelectedCornerIndex = null;

    renderLayoutGateBanner(room, gateNames);
    renderLayoutCorners(room, isGated);

    // Outside-walls flag (design §5.3) — editor-only, applied here (never in
    // floorplan.js's render(), which also serves the customer/waiter pages
    // that must never show it).
    const offenders = room ? applyOutsideTableFlags(host, room) : [];
    renderLayoutOutsideWarning(offenders);
}

// Names (sorted, Czech collation — matches renderLayoutTray()'s sort) of
// every table currently placed in `roomId` per the WORKING copy, i.e.
// reflecting in-progress drags/placements that haven't been saved yet. This
// is the single source of truth for the empty-room gate (design §5.1): a
// room only "has tables" for gating purposes once persisted, but the gate
// reacts live to unsaved changes too, exactly like every other gate/badge in
// this editor.
function roomPlacedTableNames(roomId) {
    return Object.keys(layoutWorkingTables)
        .filter(n => layoutWorkingTables[n].layout && layoutWorkingTables[n].layout.room === roomId)
        .sort((a, b) => a.localeCompare(b, 'cs'));
}

// FloorPlan.roomCorners() is Track E's helper (built in parallel against the
// same fixed contract this file already trusts for snapToGrid/autoArrange/
// etc. — see this section's header comment). Wrapped defensively, matching
// the try/catch precedent set by placeTableInRoom()/autoArrangeUnplaced()
// just above for the same reason: a shared-module call this file doesn't
// control should never be able to throw and blank the whole editor.
function getRoomCorners(room) {
    try {
        const c = FloorPlan.roomCorners(room);
        return Array.isArray(c) ? c : [];
    } catch (e) {
        console.error('FloorPlan.roomCorners failed', e);
        return [];
    }
}

// Empty-room gate banner (design §5.1). A persistent element
// (#layoutGateBanner, created once in renderLayoutView()) rather than
// rebuilt inside host.innerHTML='' above, so it survives FloorPlan.render()
// wiping the canvas host on every redraw.
function renderLayoutGateBanner(room, gateNames) {
    const el = document.getElementById('layoutGateBanner');
    if (!el) return;
    el.innerHTML = '';
    if (!room || gateNames.length === 0) {
        el.style.display = 'none';
        return;
    }
    el.style.display = 'block';

    const msg = document.createElement('p');
    msg.className = 'inn-layout-gate__msg';
    msg.textContent = `Tvar místnosti lze upravit jen u prázdné místnosti. Nejdříve odeberte stoly: ${gateNames.join(', ')}`;
    el.appendChild(msg);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'inn-btn danger small';
    btn.textContent = 'Odebrat stoly z místnosti';
    btn.addEventListener('click', () => unplaceAllTablesInRoom(room.id));
    el.appendChild(btn);
}

// The gate's escape hatch (design §5.1) — without this the restriction is a
// dead end, since the owner would otherwise have to hunt down and unplace
// each table individually via the side panel. Goes through the exact same
// layoutWorkingTables mutation + markLayoutDirty() as every other edit in
// this file, so it rides the existing dirty/save machinery: leaving the tab
// without clicking "Uložit rozložení" undoes it, same as a mis-drag.
function unplaceAllTablesInRoom(roomId) {
    const names = roomPlacedTableNames(roomId);
    if (names.length === 0) return;
    names.forEach(n => { layoutWorkingTables[n].layout = null; });
    layoutSelectedTableName = null;
    markLayoutDirty();
    renderLayoutCanvas();
    renderLayoutSidePanel();
    renderLayoutTray();
    showToast('Stoly odebrány z místnosti — nezapomeňte uložit');
}

// Outside-walls flag (design §5.3). Runs after FloorPlan.render() has
// already drawn every table for the active room, adding `.fp-table--outside`
// to the ones whose rectangle isn't fully inside the room polygon. Returns
// the offending table names so the caller can render the warning line.
// Non-blocking by design — this never touches layoutWorkingTables, so it
// can't fight or undo a drag.
function applyOutsideTableFlags(host, room) {
    const offenders = [];
    Object.keys(layoutWorkingTables).forEach(name => {
        const w = layoutWorkingTables[name];
        if (!w.layout || w.layout.room !== room.id) return;
        let outside = false;
        try {
            outside = !!FloorPlan.tableOutsideRoom({ layout: w.layout }, room);
        } catch (e) {
            console.error('FloorPlan.tableOutsideRoom failed', e);
        }
        if (!outside) return;
        offenders.push(name);
        const el = findRenderedTableEl(host, name);
        if (el) el.classList.add('fp-table--outside');
    });
    return offenders;
}

function renderLayoutOutsideWarning(offenders) {
    const el = document.getElementById('layoutOutsideWarning');
    if (!el) return;
    if (!offenders || offenders.length === 0) {
        el.style.display = 'none';
        el.textContent = '';
        return;
    }
    el.style.display = 'block';
    el.textContent = `Mimo stěny místnosti (přesuňte stůl nebo upravte tvar): ${offenders.join(', ')}`;
}

// Locates the DOM element FloorPlan.render() drew for a given table name.
// floorplan.js (.fp-table / .fp-table__name — see its module header comment)
// carries the name only as the .fp-table__name child's textContent, no data
// attribute, so matching is by that text rather than any attribute lookup.
// If nothing matches, the table simply isn't draggable on the canvas this
// render (it's still fully editable via the numeric x/y/w/h fields in the
// side panel, so nothing is unreachable — see design §6.4's explicit
// keyboard-accessibility requirement for exactly this reason).
function findRenderedTableEl(host, name) {
    const tableEls = host.querySelectorAll('.fp-table');
    for (const el of tableEls) {
        const nameEl = el.querySelector('.fp-table__name');
        if (nameEl && nameEl.textContent === name) return el;
    }
    return null;
}

// Same idea as findRenderedTableEl, for the active room's fixtures[index].
// Fixtures have no name/label guaranteed unique (a door's label is even
// optional), so this matches by DOM order instead — floorplan.js's render()
// builds .fp-fixture elements by iterating activeRoom.fixtures in array
// order, so positional lookup is exact, not a fallback guess.
function findRenderedFixtureEl(host, index) {
    const fixtureEls = host.querySelectorAll('.fp-fixture');
    return fixtureEls[index] || null;
}

function wireLayoutTableDragHandlers(host) {
    Object.keys(layoutWorkingTables).forEach(name => {
        const w = layoutWorkingTables[name];
        if (!w.layout || w.layout.room !== layoutActiveRoomId) return;
        const el = findRenderedTableEl(host, name);
        if (!el) return;
        attachTableDrag(el, name);
        attachTableResizeHandle(el, name);
    });
}

// Whole-table drag, snapped to the 10-unit grid (design §6.4). Pixel deltas
// are converted to room units using el.offsetParent's CURRENT measured size
// (design §4.3: "convert pointer pixel deltas into room units using the
// canvas's measured size at drag time") rather than any cached size, so a
// resize of the browser window mid-drag can't desync the math. The element
// itself is moved live via inline style during the drag for smooth visual
// feedback; the working model (and hence a real re-render) only updates on
// pointerup, because a full renderLayoutCanvas() mid-drag would destroy the
// very element that has pointer capture.
function attachTableDrag(el, name) {
    el.style.touchAction = 'none'; // pointer events must not fight the browser's own touch scrolling/zooming
    el.addEventListener('pointerdown', (e) => {
        if (e.target.closest && e.target.closest('.inn-layout-resize-handle')) return; // let the resize handle's own listener handle this
        e.preventDefault();
        el.setPointerCapture(e.pointerId);

        const room = layoutWorkingRooms.find(r => r.id === layoutActiveRoomId);
        const canvasEl = el.offsetParent || el.parentElement;
        const canvasRect = canvasEl.getBoundingClientRect();
        const startX = e.clientX, startY = e.clientY;
        const startLayout = { ...layoutWorkingTables[name].layout };

        function onMove(ev) {
            const dxUnits = (ev.clientX - startX) / canvasRect.width * room.width;
            const dyUnits = (ev.clientY - startY) / canvasRect.height * room.height;
            const snappedX = clamp(FloorPlan.snapToGrid(startLayout.x + dxUnits, 10), 0, Math.max(0, room.width - startLayout.w));
            const snappedY = clamp(FloorPlan.snapToGrid(startLayout.y + dyUnits, 10), 0, Math.max(0, room.height - startLayout.h));
            el.style.left = (snappedX / room.width * 100) + '%';
            el.style.top = (snappedY / room.height * 100) + '%';
            el._innPendingLayout = { ...startLayout, x: snappedX, y: snappedY };
        }
        function onUp() {
            el.removeEventListener('pointermove', onMove);
            el.removeEventListener('pointerup', onUp);
            el.removeEventListener('pointercancel', onUp);
            if (el._innPendingLayout) {
                layoutWorkingTables[name].layout = el._innPendingLayout;
                delete el._innPendingLayout;
                markLayoutDirty();
                renderLayoutCanvas();
                if (layoutSelectedTableName === name) renderLayoutSidePanel();
            }
        }
        el.addEventListener('pointermove', onMove);
        el.addEventListener('pointerup', onUp);
        el.addEventListener('pointercancel', onUp);
    });
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

// Bottom-right resize handle (design §6.4). Reuses whatever handle element
// FloorPlan.render() already drew if it tagged one with a recognizable
// class; otherwise injects a small one — either way it becomes a child of
// the table element, which is already the percentage-sized positioning
// context the design calls for, so no extra CSS from floorplan.css is
// required for it to sit in the right place.
function attachTableResizeHandle(el, name) {
    let handle = el.querySelector('.inn-layout-resize-handle');
    if (!handle) {
        handle = document.createElement('div');
        handle.className = 'inn-layout-resize-handle';
        handle.title = 'Přetažením změnit velikost';
        el.appendChild(handle);
    }
    handle.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation(); // don't also start attachTableDrag's whole-table move
        handle.setPointerCapture(e.pointerId);

        const room = layoutWorkingRooms.find(r => r.id === layoutActiveRoomId);
        const canvasEl = el.offsetParent || el.parentElement;
        const canvasRect = canvasEl.getBoundingClientRect();
        const startX = e.clientX, startY = e.clientY;
        const startLayout = { ...layoutWorkingTables[name].layout };

        function onMove(ev) {
            const dwUnits = (ev.clientX - startX) / canvasRect.width * room.width;
            const dhUnits = (ev.clientY - startY) / canvasRect.height * room.height;
            const snappedW = Math.max(10, FloorPlan.snapToGrid(startLayout.w + dwUnits, 10));
            const snappedH = Math.max(10, FloorPlan.snapToGrid(startLayout.h + dhUnits, 10));
            el.style.width = (snappedW / room.width * 100) + '%';
            el.style.height = (snappedH / room.height * 100) + '%';
            el._innPendingLayout = { ...startLayout, w: snappedW, h: snappedH };
        }
        function onUp() {
            handle.removeEventListener('pointermove', onMove);
            handle.removeEventListener('pointerup', onUp);
            handle.removeEventListener('pointercancel', onUp);
            if (el._innPendingLayout) {
                layoutWorkingTables[name].layout = el._innPendingLayout;
                delete el._innPendingLayout;
                markLayoutDirty();
                renderLayoutCanvas();
                if (layoutSelectedTableName === name) renderLayoutSidePanel();
            }
        }
        handle.addEventListener('pointermove', onMove);
        handle.addEventListener('pointerup', onUp);
        handle.addEventListener('pointercancel', onUp);
    });
}

// Fixtures: click to select (own listener — FloorPlan's onTableClick is for
// tables only), drag to move, snapped the same way tables are. No resize
// handle — design §6.4 only calls for drag/label-edit/delete on fixtures.
function wireLayoutFixtureHandlers(host) {
    const room = layoutWorkingRooms.find(r => r.id === layoutActiveRoomId);
    if (!room) return;
    room.fixtures.forEach((fx, idx) => {
        const el = findRenderedFixtureEl(host, idx);
        if (!el) return;
        el.style.touchAction = 'none';
        el.style.cursor = 'grab';
        el.addEventListener('click', () => {
            layoutSelectedFixtureIndex = idx;
            layoutSelectedTableName = null;
            layoutSelectedCornerIndex = null;
            renderLayoutSidePanel();
        });
        el.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            el.setPointerCapture(e.pointerId);
            const canvasEl = el.offsetParent || el.parentElement;
            const canvasRect = canvasEl.getBoundingClientRect();
            const startX = e.clientX, startY = e.clientY;
            const startFx = { x: fx.x, y: fx.y };

            function onMove(ev) {
                const dxUnits = (ev.clientX - startX) / canvasRect.width * room.width;
                const dyUnits = (ev.clientY - startY) / canvasRect.height * room.height;
                const snappedX = clamp(FloorPlan.snapToGrid(startFx.x + dxUnits, 10), 0, Math.max(0, room.width - fx.w));
                const snappedY = clamp(FloorPlan.snapToGrid(startFx.y + dyUnits, 10), 0, Math.max(0, room.height - fx.h));
                el.style.left = (snappedX / room.width * 100) + '%';
                el.style.top = (snappedY / room.height * 100) + '%';
                el._innPendingFx = { x: snappedX, y: snappedY };
            }
            function onUp() {
                el.removeEventListener('pointermove', onMove);
                el.removeEventListener('pointerup', onUp);
                el.removeEventListener('pointercancel', onUp);
                if (el._innPendingFx) {
                    fx.x = el._innPendingFx.x;
                    fx.y = el._innPendingFx.y;
                    delete el._innPendingFx;
                    markLayoutDirty();
                    renderLayoutCanvas();
                    if (layoutSelectedFixtureIndex === idx) renderLayoutSidePanel();
                }
            }
            el.addEventListener('pointermove', onMove);
            el.addEventListener('pointerup', onUp);
            el.addEventListener('pointercancel', onUp);
        });
    });
}

// ── Corner (room shape) editing — design §5.2 ───────────────────────────────
//
// Corner handles and edge-midpoint "+" affordances are markup THIS file
// produces (per the room-shape-editing design's file split: floorplan.js
// only supplies the pure geometry helpers + the `.fp-corner`/`.fp-table--
// outside` CSS, the editor produces the elements). They're appended directly
// onto whatever element FloorPlan.render() sized to the room's aspect ratio
// (found via findLayoutCanvasEl(), the same lookup the tray drop already
// relies on), positioned with the same x/room.width*100% percentage math
// floorplan.js itself uses — see that module's `pct()` — so they land
// exactly on the wall polygon's vertices/edges regardless of viewport size.

function pctOf(value, total) {
    if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) return 0;
    return (value / total) * 100;
}

// Draws every corner handle for `room`, plus (only when the room isn't
// gated) the edge-midpoint "+" insert affordances. `isGated` mirrors the
// empty-room gate (design §5.1): a gated room still shows its corners, so
// the shape stays legible, but as non-interactive, greyed handles — no drag
// listeners, no "+" affordances, `aria-disabled="true"`.
function renderLayoutCorners(room, isGated) {
    const canvasEl = findLayoutCanvasEl();
    if (!canvasEl || !room) return;
    const corners = getRoomCorners(room);
    if (corners.length < 3) return; // degenerate — nothing sane to draw or edit

    corners.forEach((corner, idx) => {
        const handle = document.createElement('div');
        let cls = 'fp-corner';
        if (isGated) cls += ' fp-corner--disabled';
        else if (idx === layoutSelectedCornerIndex) cls += ' fp-corner--selected';
        handle.className = cls;
        handle.style.left = pctOf(corner.x, room.width) + '%';
        handle.style.top = pctOf(corner.y, room.height) + '%';
        handle.setAttribute('aria-disabled', isGated ? 'true' : 'false');
        handle.title = isGated
            ? 'Tvar místnosti lze upravit jen u prázdné místnosti'
            : `Roh ${idx + 1} — přetáhněte, nebo vyberte a upravte souřadnice vpravo`;

        if (!isGated) {
            handle.setAttribute('role', 'button');
            handle.tabIndex = 0;
            handle.addEventListener('click', (e) => {
                e.stopPropagation();
                selectCorner(idx);
            });
            handle.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectCorner(idx); }
            });
            attachCornerDrag(handle, room, idx);
        }
        canvasEl.appendChild(handle);
    });

    if (!isGated) {
        corners.forEach((corner, edgeIndex) => {
            const next = corners[(edgeIndex + 1) % corners.length];
            const midX = (corner.x + next.x) / 2;
            const midY = (corner.y + next.y) / 2;
            const add = document.createElement('button');
            add.type = 'button';
            add.className = 'fp-edge-add';
            add.textContent = '+';
            add.title = 'Přidat roh uprostřed této stěny';
            add.style.left = pctOf(midX, room.width) + '%';
            add.style.top = pctOf(midY, room.height) + '%';
            add.addEventListener('click', (e) => {
                e.stopPropagation();
                insertCornerAtEdge(room, edgeIndex);
            });
            canvasEl.appendChild(add);
        });
    }
}

function selectCorner(idx) {
    layoutSelectedCornerIndex = idx;
    layoutSelectedTableName = null;
    layoutSelectedFixtureIndex = null;
    renderLayoutCanvas();
    renderLayoutSidePanel();
}

// Corner drag — pointer events with setPointerCapture (design §5.2, so touch
// works), snapped to the 10-unit grid, clamped to the room's own width x
// height box (design §2: "corners are points inside that box and clamp to
// it"). Pixel deltas are converted to room units using the canvas's CURRENT
// measured size at drag time, same approach and same reasoning as
// attachTableDrag()/attachTableResizeHandle() above (design's explicit
// instruction to follow that existing code). Only the live-dragged handle's
// own inline position updates during the drag; the working model (and a real
// re-render) only updates on pointerup, for the same "don't destroy the
// element that has pointer capture" reason attachTableDrag() documents.
function attachCornerDrag(handle, room, idx) {
    handle.style.touchAction = 'none';
    handle.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation(); // don't also trigger a fixture/table click underneath
        handle.setPointerCapture(e.pointerId);

        const canvasEl = handle.offsetParent || handle.parentElement;
        const canvasRect = canvasEl.getBoundingClientRect();
        const startX = e.clientX, startY = e.clientY;
        const startCorner = getRoomCorners(room)[idx] || { x: 0, y: 0 };

        function onMove(ev) {
            const dxUnits = (ev.clientX - startX) / canvasRect.width * room.width;
            const dyUnits = (ev.clientY - startY) / canvasRect.height * room.height;
            const snappedX = clamp(FloorPlan.snapToGrid(startCorner.x + dxUnits, 10), 0, room.width);
            const snappedY = clamp(FloorPlan.snapToGrid(startCorner.y + dyUnits, 10), 0, room.height);
            handle.style.left = pctOf(snappedX, room.width) + '%';
            handle.style.top = pctOf(snappedY, room.height) + '%';
            handle._innPendingCorner = { x: snappedX, y: snappedY };
        }
        function onUp() {
            handle.removeEventListener('pointermove', onMove);
            handle.removeEventListener('pointerup', onUp);
            handle.removeEventListener('pointercancel', onUp);
            if (handle._innPendingCorner) {
                const base = getRoomCorners(room);
                room.corners = base.map((c, i) => (i === idx ? { ...handle._innPendingCorner } : c));
                delete handle._innPendingCorner;
                markLayoutDirty();
                renderLayoutCanvas();
                if (layoutSelectedCornerIndex === idx) renderLayoutSidePanel();
            }
        }
        handle.addEventListener('pointermove', onMove);
        handle.addEventListener('pointerup', onUp);
        handle.addEventListener('pointercancel', onUp);
    });
}

// Insert a corner at the midpoint of `edgeIndex` (FloorPlan.insertCornerAt,
// design §4). The new corner becomes selected — same UX as "add a fixture"
// (addFixture()) above, which also selects what it just created.
function insertCornerAtEdge(room, edgeIndex) {
    const corners = getRoomCorners(room);
    let next;
    try {
        next = FloorPlan.insertCornerAt(corners, edgeIndex);
    } catch (e) {
        console.error('FloorPlan.insertCornerAt failed', e);
        showToast('Přidání rohu se nezdařilo', true);
        return;
    }
    if (!Array.isArray(next) || next.length <= corners.length) return; // contract: unchanged input on an invalid edgeIndex

    room.corners = next;
    layoutSelectedCornerIndex = edgeIndex + 1;
    layoutSelectedTableName = null;
    layoutSelectedFixtureIndex = null;
    markLayoutDirty();
    renderLayoutCanvas();
    renderLayoutSidePanel();
}

// Remove the selected corner (the "Odebrat roh" button and the Delete/
// Backspace key both call this — design §5.2). FloorPlan.removeCornerAt()
// itself enforces the 3-corner floor by returning its input unchanged; this
// is what turns that into the toast the design calls for ("blocked at 3
// corners, with a toast explaining why").
function removeSelectedCorner() {
    const room = layoutWorkingRooms.find(r => r.id === layoutActiveRoomId);
    if (!room || layoutSelectedCornerIndex == null) return;
    const corners = getRoomCorners(room);
    let next;
    try {
        next = FloorPlan.removeCornerAt(corners, layoutSelectedCornerIndex);
    } catch (e) {
        console.error('FloorPlan.removeCornerAt failed', e);
        showToast('Odebrání rohu se nezdařilo', true);
        return;
    }
    if (!Array.isArray(next) || next.length >= corners.length) {
        showToast('Místnost musí mít alespoň 3 rohy', true);
        return;
    }
    room.corners = next;
    layoutSelectedCornerIndex = null;
    markLayoutDirty();
    renderLayoutCanvas();
    renderLayoutSidePanel();
}

// Delete/Backspace deletes the selected corner (design §5.2), scoped to the
// Rozložení view and only while a corner (not some unrelated text field) has
// focus/selection — otherwise Backspace inside, say, the fixture label input
// while a corner happens to still be selected in the background would delete
// the corner instead of erasing a character. A single document-level
// listener (registered once, like the roomModal listeners above) rather than
// one added/removed per render, since renderLayoutCanvas() runs far too
// often to be a sane place to (re)attach a document listener.
document.addEventListener('keydown', (e) => {
    if (currentView !== 'layout') return;
    if (layoutSelectedCornerIndex == null) return;
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        removeSelectedCorner();
    }
});

// ── Side panel (design §6.4: "fully usable by keyboard", the numeric
// x/y/w/h + seats + room-dropdown fields below are the accessible path that
// doesn't depend on drag precision at all) ─────────────────────────────────

function renderLayoutSidePanel() {
    const panel = document.getElementById('layoutSidePanel');
    if (!panel) return;
    panel.innerHTML = '';

    if (layoutSelectedFixtureIndex != null) {
        renderFixtureSidePanel(panel);
        return;
    }
    if (layoutSelectedTableName && layoutWorkingTables[layoutSelectedTableName]) {
        renderTableSidePanel(panel);
        return;
    }
    if (layoutSelectedCornerIndex != null) {
        const room = layoutWorkingRooms.find(r => r.id === layoutActiveRoomId);
        const gated = room ? roomPlacedTableNames(room.id).length > 0 : true;
        if (room && !gated && getRoomCorners(room)[layoutSelectedCornerIndex]) {
            renderCornerSidePanel(panel, room);
            return;
        }
        // Selection no longer makes sense (room gone, room became gated by a
        // table getting placed in it, or the corner itself was removed) —
        // deselect defensively rather than render a panel for nothing.
        layoutSelectedCornerIndex = null;
    }
    panel.innerHTML = '<p style="color:var(--muted); font-size:0.85em;">Vyberte stůl, roh nebo prvek na plánku, nebo stůl v podnosu nezařazených stolů níže, pro úpravu jeho polohy a velikosti.</p>';
}

// Numeric x/y inputs for the selected corner (design §5.2 — "so shaping is
// possible without dragging and by keyboard"), mirroring
// renderTableCoordFields()'s pattern below exactly: an <input type=number>
// per axis, snapped to the grid and clamped to the room box on change.
function renderCornerSidePanel(panel, room) {
    const idx = layoutSelectedCornerIndex;
    const corner = getRoomCorners(room)[idx];
    if (!corner) { layoutSelectedCornerIndex = null; return; }

    const box = document.createElement('div');
    box.className = 'inn-panel';
    const heading = document.createElement('h3');
    heading.textContent = `Roh ${idx + 1}`;
    box.appendChild(heading);

    const sub = document.createElement('p');
    sub.style.cssText = 'color:var(--muted); font-size:0.85em; margin:-6px 0 10px;';
    sub.textContent = `Místnost „${room.name}“`;
    box.appendChild(sub);

    const grid = document.createElement('div');
    grid.className = 'inn-layout-coord-grid';
    const AXIS_LABELS = { x: 'X', y: 'Y' };
    Object.keys(AXIS_LABELS).forEach(key => {
        const g = document.createElement('div');
        g.className = 'inn-field-group';
        const label = document.createElement('label');
        label.setAttribute('for', `layoutCornerCoord_${key}`);
        label.textContent = AXIS_LABELS[key];
        g.appendChild(label);

        const inp = document.createElement('input');
        inp.type = 'number';
        inp.step = '10';
        inp.id = `layoutCornerCoord_${key}`;
        inp.value = String(Math.round(corner[key]));
        inp.addEventListener('change', () => {
            const v = parseFloat(inp.value);
            const current = getRoomCorners(room)[idx];
            if (!current) return;
            if (!Number.isFinite(v)) { inp.value = String(Math.round(current[key])); return; }
            const max = key === 'x' ? room.width : room.height;
            const snapped = clamp(FloorPlan.snapToGrid(v, 10), 0, max);
            const base = getRoomCorners(room);
            room.corners = base.map((c, i) => (i === idx ? Object.assign({}, c, { [key]: snapped }) : c));
            inp.value = String(snapped);
            markLayoutDirty();
            renderLayoutCanvas();
        });
        g.appendChild(inp);
        grid.appendChild(g);
    });
    box.appendChild(grid);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'inn-btn danger small';
    removeBtn.style.marginTop = '10px';
    removeBtn.textContent = 'Odebrat roh';
    removeBtn.addEventListener('click', removeSelectedCorner);
    box.appendChild(removeBtn);

    const hint = document.createElement('p');
    hint.style.cssText = 'color:var(--muted); font-size:0.8em; margin-top:10px;';
    hint.textContent = 'Roh lze také odstranit klávesou Delete nebo Backspace. Nový roh přidáte kliknutím na „+“ uprostřed stěny na plánku.';
    box.appendChild(hint);

    panel.appendChild(box);
}

function renderTableSidePanel(panel) {
    const name = layoutSelectedTableName;
    const w = layoutWorkingTables[name];

    const box = document.createElement('div');
    box.className = 'inn-panel';
    const heading = document.createElement('h3');
    heading.textContent = name;
    box.appendChild(heading);

    const seatsGroup = document.createElement('div');
    seatsGroup.className = 'inn-field-group';
    seatsGroup.innerHTML = '<label for="layoutSeatsInput">Počet míst</label>';
    const seatsInput = document.createElement('input');
    seatsInput.type = 'number';
    seatsInput.id = 'layoutSeatsInput';
    seatsInput.min = '1';
    seatsInput.max = '20';
    seatsInput.placeholder = 'Výchozí (4)';
    seatsInput.value = w.seats != null ? String(w.seats) : '';
    seatsInput.addEventListener('change', () => {
        const v = parseInt(seatsInput.value, 10);
        w.seats = (Number.isFinite(v) && v >= 1 && v <= 20) ? v : undefined;
        seatsInput.value = w.seats != null ? String(w.seats) : '';
        markLayoutDirty();
    });
    seatsGroup.appendChild(seatsInput);
    box.appendChild(seatsGroup);

    const roomGroup = document.createElement('div');
    roomGroup.className = 'inn-field-group';
    roomGroup.innerHTML = '<label for="layoutRoomSelect">Místnost</label>';
    const roomSelect = document.createElement('select');
    roomSelect.id = 'layoutRoomSelect';
    const noneOpt = document.createElement('option');
    noneOpt.value = '';
    noneOpt.textContent = '— Nezařazeno —';
    if (!w.layout) noneOpt.selected = true;
    roomSelect.appendChild(noneOpt);
    layoutWorkingRooms.forEach(r => {
        const opt = document.createElement('option');
        opt.value = r.id;
        opt.textContent = r.name;
        if (w.layout && w.layout.room === r.id) opt.selected = true;
        roomSelect.appendChild(opt);
    });
    roomGroup.appendChild(roomSelect);
    box.appendChild(roomGroup);

    const coordsWrap = document.createElement('div');
    box.appendChild(coordsWrap);
    renderTableCoordFields(coordsWrap, name);

    roomSelect.addEventListener('change', () => {
        const roomId = roomSelect.value;
        if (!roomId) {
            w.layout = null;
        } else if (!w.layout || w.layout.room !== roomId) {
            const room = layoutWorkingRooms.find(r => r.id === roomId);
            placeTableInRoom(name, room);
            layoutActiveRoomId = roomId; // jump the canvas to show where it landed
        }
        markLayoutDirty();
        renderTableCoordFields(coordsWrap, name);
        renderLayoutCanvas();
        renderLayoutTray();
    });

    const removeBtn = document.createElement('button');
    removeBtn.className = 'inn-btn danger small';
    removeBtn.style.marginTop = '10px';
    removeBtn.textContent = 'Odebrat z plánku';
    removeBtn.addEventListener('click', () => {
        layoutWorkingTables[name].layout = null;
        markLayoutDirty();
        renderLayoutSidePanel();
        renderLayoutCanvas();
        renderLayoutTray();
    });
    box.appendChild(removeBtn);

    panel.appendChild(box);
}

function renderTableCoordFields(coordsWrap, name) {
    coordsWrap.innerHTML = '';
    const w = layoutWorkingTables[name];
    if (!w.layout) {
        const note = document.createElement('p');
        note.style.cssText = 'color:var(--muted); font-size:0.85em;';
        note.textContent = 'Stůl zatím není umístěn na plánku. Vyberte místnost výše, nebo jej přetáhněte z podnosu nezařazených stolů na plánek.';
        coordsWrap.appendChild(note);
        return;
    }
    const grid = document.createElement('div');
    grid.className = 'inn-layout-coord-grid';
    const COORD_LABELS = { x: 'X', y: 'Y', w: 'Šířka', h: 'Výška' };
    Object.keys(COORD_LABELS).forEach(key => {
        const g = document.createElement('div');
        g.className = 'inn-field-group';
        g.innerHTML = `<label for="layoutCoord_${key}">${COORD_LABELS[key]}</label>`;
        const inp = document.createElement('input');
        inp.type = 'number';
        inp.step = '10';
        inp.id = `layoutCoord_${key}`;
        inp.value = String(Math.round(w.layout[key]));
        inp.addEventListener('change', () => {
            const v = parseFloat(inp.value);
            if (!Number.isFinite(v)) { inp.value = String(Math.round(w.layout[key])); return; }
            const isSize = key === 'w' || key === 'h';
            const snapped = isSize ? Math.max(10, FloorPlan.snapToGrid(v, 10)) : FloorPlan.snapToGrid(v, 10);
            w.layout[key] = snapped;
            inp.value = String(snapped);
            markLayoutDirty();
            renderLayoutCanvas();
        });
        g.appendChild(inp);
        grid.appendChild(g);
    });
    coordsWrap.appendChild(grid);
}

function renderFixtureSidePanel(panel) {
    const room = layoutWorkingRooms.find(r => r.id === layoutActiveRoomId);
    const fx = room && room.fixtures[layoutSelectedFixtureIndex];
    if (!fx) { layoutSelectedFixtureIndex = null; return; }

    const box = document.createElement('div');
    box.className = 'inn-panel';
    const heading = document.createElement('h3');
    heading.textContent = fx.type === 'door' ? 'Dveře' : 'Blok';
    box.appendChild(heading);

    if (fx.type === 'block') {
        const g = document.createElement('div');
        g.className = 'inn-field-group';
        g.innerHTML = '<label for="layoutFxLabel">Popisek</label>';
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.id = 'layoutFxLabel';
        inp.maxLength = 80;
        inp.value = fx.label || '';
        inp.addEventListener('change', () => {
            fx.label = inp.value.trim();
            markLayoutDirty();
            renderLayoutCanvas();
        });
        g.appendChild(inp);
        box.appendChild(g);
    } else {
        const g = document.createElement('div');
        g.className = 'inn-field-group';
        g.innerHTML = '<label for="layoutFxFacing">Orientace</label>';
        const sel = document.createElement('select');
        sel.id = 'layoutFxFacing';
        const FACING_LABELS = { left: 'Vlevo', right: 'Vpravo', up: 'Nahoru', down: 'Dolů' };
        Object.keys(FACING_LABELS).forEach(f => {
            const opt = document.createElement('option');
            opt.value = f;
            opt.textContent = FACING_LABELS[f];
            if ((fx.facing || 'left') === f) opt.selected = true;
            sel.appendChild(opt);
        });
        sel.addEventListener('change', () => {
            fx.facing = sel.value;
            markLayoutDirty();
            renderLayoutCanvas();
        });
        g.appendChild(sel);
        box.appendChild(g);
    }

    const grid = document.createElement('div');
    grid.className = 'inn-layout-coord-grid';
    const COORD_LABELS = { x: 'X', y: 'Y', w: 'Šířka', h: 'Výška' };
    Object.keys(COORD_LABELS).forEach(key => {
        const g = document.createElement('div');
        g.className = 'inn-field-group';
        g.innerHTML = `<label for="layoutFxCoord_${key}">${COORD_LABELS[key]}</label>`;
        const inp = document.createElement('input');
        inp.type = 'number';
        inp.step = '10';
        inp.id = `layoutFxCoord_${key}`;
        inp.value = String(Math.round(fx[key]));
        inp.addEventListener('change', () => {
            const v = parseFloat(inp.value);
            if (!Number.isFinite(v)) { inp.value = String(Math.round(fx[key])); return; }
            const isSize = key === 'w' || key === 'h';
            const snapped = isSize ? Math.max(10, FloorPlan.snapToGrid(v, 10)) : FloorPlan.snapToGrid(v, 10);
            fx[key] = snapped;
            inp.value = String(snapped);
            markLayoutDirty();
            renderLayoutCanvas();
        });
        g.appendChild(inp);
        grid.appendChild(g);
    });
    box.appendChild(grid);

    const delBtn = document.createElement('button');
    delBtn.className = 'inn-btn danger small';
    delBtn.style.marginTop = '10px';
    delBtn.textContent = 'Smazat prvek';
    delBtn.addEventListener('click', () => {
        room.fixtures.splice(layoutSelectedFixtureIndex, 1);
        layoutSelectedFixtureIndex = null;
        markLayoutDirty();
        renderLayoutCanvas();
        renderLayoutSidePanel();
    });
    box.appendChild(delBtn);

    panel.appendChild(box);
}

// ── Unplaced tables tray — drag onto the canvas to place (design §6.4) ────

function renderLayoutTray() {
    const host = document.getElementById('layoutTrayHost');
    if (!host) return;
    host.innerHTML = '';

    const unplaced = Object.keys(layoutWorkingTables)
        .filter(n => !layoutWorkingTables[n].layout)
        .sort((a, b) => a.localeCompare(b, 'cs'));

    const label = document.createElement('div');
    label.className = 'inn-oc-upcoming-label';
    label.textContent = 'Nezařazené stoly';
    host.appendChild(label);

    if (unplaced.length === 0) {
        const p = document.createElement('p');
        p.style.cssText = 'color:var(--muted); font-size:0.85em;';
        p.textContent = 'Všechny stoly jsou umístěny na plánku.';
        host.appendChild(p);
        return;
    }

    const hint = document.createElement('p');
    hint.style.cssText = 'color:var(--muted); font-size:0.8em; margin:2px 0 8px;';
    hint.textContent = 'Přetáhněte stůl na plánek aktivní místnosti, nebo jej vyberte a zvolte místnost v panelu vpravo.';
    host.appendChild(hint);

    // fp-tray / fp-tray__item (floorplan.css) — shipped specifically for
    // this tray so it shares the floorplan's own visual language rather
    // than reusing the unrelated dish-grid card style. See that file's
    // "UNPLACED TABLES TRAY" comment block. Deliberately no draggable="true"
    // here — dragging is implemented with pointer events (startTrayDrag)
    // for touch support, and mixing that with the browser's native
    // HTML5 drag-and-drop on the same element would fight it.
    const grid = document.createElement('div');
    grid.className = 'fp-tray';
    unplaced.forEach(name => {
        const card = document.createElement('div');
        card.className = 'fp-tray__item';
        card.style.touchAction = 'none';
        card.textContent = name;
        card.addEventListener('click', () => {
            layoutSelectedTableName = name;
            layoutSelectedFixtureIndex = null;
            layoutSelectedCornerIndex = null;
            renderLayoutSidePanel();
        });
        card.addEventListener('pointerdown', (e) => startTrayDrag(e, card, name));
        grid.appendChild(card);
    });
    host.appendChild(grid);
}

// Finds the actual percentage-positioned room canvas inside layoutCanvasHost
// — floorplan.js always draws it as .fp-canvas (position:relative, sized to
// the room's aspect ratio — see floorplan.css), regardless of whether the
// room has any tables/fixtures in it yet, so this is exact rather than a
// best-effort guess.
function findLayoutCanvasEl() {
    const host = document.getElementById('layoutCanvasHost');
    if (!host) return null;
    return host.querySelector('.fp-canvas') || host;
}

function startTrayDrag(e, card, name) {
    e.preventDefault();
    const ghost = card.cloneNode(true);
    ghost.style.cssText = `position:fixed; pointer-events:none; opacity:0.85; z-index:9999; width:${card.offsetWidth}px; left:${e.clientX - card.offsetWidth / 2}px; top:${e.clientY - 20}px;`;
    document.body.appendChild(ghost);
    card.setPointerCapture(e.pointerId);

    function onMove(ev) {
        ghost.style.left = (ev.clientX - ghost.offsetWidth / 2) + 'px';
        ghost.style.top = (ev.clientY - 20) + 'px';
    }
    function onUp(ev) {
        card.removeEventListener('pointermove', onMove);
        card.removeEventListener('pointerup', onUp);
        card.removeEventListener('pointercancel', onUp);
        ghost.remove();

        const room = layoutWorkingRooms.find(r => r.id === layoutActiveRoomId);
        const canvasEl = findLayoutCanvasEl();
        if (!room || !canvasEl) return;
        const rect = canvasEl.getBoundingClientRect();
        const inside = ev.clientX >= rect.left && ev.clientX <= rect.right && ev.clientY >= rect.top && ev.clientY <= rect.bottom;
        if (!inside) return;

        const relX = (ev.clientX - rect.left) / rect.width * room.width;
        const relY = (ev.clientY - rect.top) / rect.height * room.height;
        const size = 100; // default footprint for a freshly dropped table — resizable immediately after via the handle or side panel
        const x = clamp(FloorPlan.snapToGrid(relX - size / 2, 10), 0, Math.max(0, room.width - size));
        const y = clamp(FloorPlan.snapToGrid(relY - size / 2, 10), 0, Math.max(0, room.height - size));
        layoutWorkingTables[name].layout = { room: room.id, x, y, w: size, h: size };
        markLayoutDirty();
        layoutSelectedTableName = name;
        layoutSelectedFixtureIndex = null;
        renderLayoutCanvas();
        renderLayoutSidePanel();
        renderLayoutTray();
    }
    card.addEventListener('pointermove', onMove);
    card.addEventListener('pointerup', onUp);
    card.addEventListener('pointercancel', onUp);
}

// Places `name` in `room` using FloorPlan.autoArrange() for a single table
// (reused rather than hand-rolling a default position, so a freshly placed
// table never overlaps whatever auto-arrange would already put there).
// Defensive about the exact shape autoArrange() returns per-table — either
// a `{..., layout: {x,y,w,h}}` entry or a flat `{x,y,w,h}` one — since the
// design doc doesn't pin that down beyond "grid-fills unplaced tables".
function placeTableInRoom(name, room) {
    const w = layoutWorkingTables[name];
    const fakeTable = { name, seats: w.seats, layout: null };
    let placements = null;
    try {
        placements = FloorPlan.autoArrange([fakeTable], room);
    } catch (e) {
        console.error('FloorPlan.autoArrange failed for a single table', e);
    }
    const p = Array.isArray(placements) ? placements[0] : null;
    const src = p && p.layout ? p.layout : p;
    if (src && Number.isFinite(src.x) && Number.isFinite(src.y) && Number.isFinite(src.w) && Number.isFinite(src.h)) {
        w.layout = { room: room.id, x: src.x, y: src.y, w: src.w, h: src.h };
    } else {
        w.layout = { room: room.id, x: 0, y: 0, w: 100, h: 100 }; // last-resort fallback
    }
}

function autoArrangeUnplaced() {
    const room = layoutWorkingRooms.find(r => r.id === layoutActiveRoomId);
    if (!room) { showToast('Nejprve vyberte nebo vytvořte místnost', true); return; }

    const unplacedNames = Object.keys(layoutWorkingTables).filter(n => !layoutWorkingTables[n].layout);
    if (unplacedNames.length === 0) { showToast('Všechny stoly jsou už umístěny'); return; }

    const fakeTables = unplacedNames.map(n => ({ name: n, seats: layoutWorkingTables[n].seats, layout: null }));
    let placements;
    try {
        placements = FloorPlan.autoArrange(fakeTables, room);
    } catch (e) {
        console.error('FloorPlan.autoArrange failed', e);
        showToast('Automatické rozmístění se nezdařilo', true);
        return;
    }

    (placements || []).forEach(p => {
        const pname = p && p.name;
        if (!pname || !layoutWorkingTables[pname]) return;
        const src = p.layout ? p.layout : p;
        if (!Number.isFinite(src.x) || !Number.isFinite(src.y) || !Number.isFinite(src.w) || !Number.isFinite(src.h)) return;
        layoutWorkingTables[pname].layout = { room: room.id, x: src.x, y: src.y, w: src.w, h: src.h };
    });

    markLayoutDirty();
    renderLayoutCanvas();
    renderLayoutTray();
    if (layoutSelectedTableName) renderLayoutSidePanel();
    showToast('Nezařazené stoly rozmístěny do aktivní místnosti');
}

// ── Room CRUD ────────────────────────────────────────────────────────────

function openRoomModalForCreate() {
    document.getElementById('roomModalTitle').textContent = 'Nová místnost';
    document.getElementById('roomModalId').value = '';
    document.getElementById('roomModalName').value = '';
    document.getElementById('roomModalWidth').value = '1000';
    document.getElementById('roomModalHeight').value = '500';
    document.getElementById('roomModal').classList.add('active');
    setTimeout(() => document.getElementById('roomModalName').focus(), 50);
}

function openRoomModalForEdit() {
    const room = layoutWorkingRooms.find(r => r.id === layoutActiveRoomId);
    if (!room) { showToast('Nejprve vyberte místnost', true); return; }
    document.getElementById('roomModalTitle').textContent = 'Upravit místnost';
    document.getElementById('roomModalId').value = room.id;
    document.getElementById('roomModalName').value = room.name;
    document.getElementById('roomModalWidth').value = String(room.width);
    document.getElementById('roomModalHeight').value = String(room.height);
    document.getElementById('roomModal').classList.add('active');
}

document.getElementById('roomModalCancelBtn').addEventListener('click', () => {
    document.getElementById('roomModal').classList.remove('active');
});
document.getElementById('roomModal').addEventListener('click', (e) => {
    if (e.target.id === 'roomModal') document.getElementById('roomModal').classList.remove('active');
});

document.getElementById('roomModalSaveBtn').addEventListener('click', () => {
    const id = document.getElementById('roomModalId').value;
    const name = document.getElementById('roomModalName').value.trim();
    const width = parseFloat(document.getElementById('roomModalWidth').value);
    const height = parseFloat(document.getElementById('roomModalHeight').value);

    if (!name) { showToast('Zadejte název místnosti', true); return; }
    if (!Number.isFinite(width) || width < 1 || !Number.isFinite(height) || height < 1) {
        showToast('Rozměry místnosti musí být kladná čísla', true);
        return;
    }

    if (id) {
        const room = layoutWorkingRooms.find(r => r.id === id);
        if (room) {
            room.name = name; room.width = width; room.height = height;
            // Corners clamp to the width x height box (design §2) — a
            // shrink here can otherwise leave an explicit corners array
            // pointing outside the room it's now attached to. Kept as plain
            // clamping (not re-snapped to the grid) since these values were
            // already grid-aligned before the resize.
            if (Array.isArray(room.corners)) {
                room.corners = room.corners.map(c => ({
                    x: clamp(Number(c.x) || 0, 0, width),
                    y: clamp(Number(c.y) || 0, 0, height),
                }));
            }
        }
    } else {
        const newId = slugifyRoomId(name);
        layoutWorkingRooms.push({ id: newId, name, width, height, fixtures: [] });
        layoutActiveRoomId = newId;
    }

    markLayoutDirty();
    document.getElementById('roomModal').classList.remove('active');
    renderLayoutCanvas();
    renderLayoutSidePanel();
    renderLayoutTray();
});

// Derives a stable room id from its name (Czech diacritics stripped, same
// spirit as a URL slug) — settings.floorplan.rooms[].id is what table
// layouts reference (design §4.1's `layout.room`), so it needs to be a
// short, collision-free machine key, not the display name itself.
function slugifyRoomId(name) {
    const base = name.toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'mistnost';
    let id = base;
    let n = 2;
    while (layoutWorkingRooms.some(r => r.id === id)) { id = `${base}-${n++}`; }
    return id;
}

function deleteActiveRoom() {
    const room = layoutWorkingRooms.find(r => r.id === layoutActiveRoomId);
    if (!room) { showToast('Nejprve vyberte místnost', true); return; }

    const placedCount = Object.values(layoutWorkingTables).filter(w => w.layout && w.layout.room === room.id).length;
    const msg = placedCount > 0
        ? `Smazat místnost „${room.name}“? ${placedCount} stolů v ní umístěných se přesune mezi nezařazené.`
        : `Smazat místnost „${room.name}“?`;
    if (!confirm(msg)) return;

    Object.values(layoutWorkingTables).forEach(w => {
        if (w.layout && w.layout.room === room.id) w.layout = null;
    });
    layoutWorkingRooms = layoutWorkingRooms.filter(r => r.id !== room.id);
    layoutActiveRoomId = layoutWorkingRooms[0] ? layoutWorkingRooms[0].id : null;
    layoutSelectedTableName = null;
    layoutSelectedFixtureIndex = null;
    layoutSelectedCornerIndex = null;

    markLayoutDirty();
    renderLayoutCanvas();
    renderLayoutSidePanel();
    renderLayoutTray();
}

// ── Fixture add ──────────────────────────────────────────────────────────

function addFixture(type) {
    const room = layoutWorkingRooms.find(r => r.id === layoutActiveRoomId);
    if (!room) { showToast('Nejprve vyberte nebo vytvořte místnost', true); return; }

    const fx = type === 'door'
        ? { type: 'door', label: '', x: 0, y: 0, w: 100, h: 100, facing: 'left' }
        : { type: 'block', label: 'NOVÝ PRVEK', x: 0, y: 0, w: 100, h: 100 };
    room.fixtures.push(fx);
    layoutSelectedFixtureIndex = room.fixtures.length - 1;
    layoutSelectedTableName = null;
    layoutSelectedCornerIndex = null;

    markLayoutDirty();
    renderLayoutCanvas();
    renderLayoutSidePanel();
}

// ── Save (design §6.4: explicit save, one PUT /timetables per CHANGED
// table, plus one PUT /settings) ────────────────────────────────────────

async function saveLayoutChanges() {
    if (layoutSaving) return;
    layoutSaving = true;
    const saveBtn = document.getElementById('layoutSaveBtn');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Ukládám…'; }

    try {
        // Only tables whose {seats,layout} actually changed since the editor
        // opened get a network round trip — persistTimetable() (fixed for
        // hazard #2 above) fills in every other field from the live `tables`
        // cache, so this never touches a table's description/bookings/etc.
        const changedNames = Object.keys(layoutWorkingTables).filter(name => {
            const w = layoutWorkingTables[name];
            return layoutOriginalTables[name] !== layoutSnapshotKey(w.seats, w.layout);
        });

        for (const name of changedNames) {
            const w = layoutWorkingTables[name];
            const ok = await persistTimetable(name, { seats: w.seats, layout: w.layout });
            if (!ok) throw new Error(`Uložení stolu „${name}“ se nezdařilo`);
        }

        if (!settingsCache) await fetchSettings();
        const updatedSettings = { ...settingsCache, floorplan: { rooms: layoutWorkingRooms } };
        const res = await apiFetch(`${API_URL}/settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(updatedSettings)
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        settingsCache = data.settings || updatedSettings;

        layoutDirty = false;
        updateLayoutSaveBadge();
        // Re-snapshot so further in-editor edits diff against what's now
        // actually on the server, instead of the pre-save state.
        Object.keys(layoutWorkingTables).forEach(name => {
            const w = layoutWorkingTables[name];
            layoutOriginalTables[name] = layoutSnapshotKey(w.seats, w.layout);
        });

        showToast('Rozložení uloženo');
        await loadAllTables(); // refresh the global `tables` cache with the saved seats/layout
    } catch (e) {
        console.error(e);
        showToast(e.message || 'Uložení rozložení se nezdařilo', true);
    } finally {
        layoutSaving = false;
        if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Uložit rozložení'; }
    }
}

// ════════════════════════════════════════════════════════════════════════
// DAILY MENU (Polední menu) — go-live Task 3, spec §5. Own admin-only tile
// (see inner.html's #viewDailyMenuBtn) rather than folded into Nastavení:
// this is a "the kitchen fills it in every morning" quick-entry panel, not
// an occasional configuration change like the rest of Nastavení — a
// separate tile keeps the daily editing workflow one click away instead of
// buried at the bottom of the settings page. (The one PIECE of this feature
// that genuinely IS a setting — whether/when the daily menu section shows
// up for customers at all — is `settings.dailyMenu.{enabled,from,to}`,
// which already round-trips through the existing Nastavení PUT unchanged
// even though this task doesn't add a form control for it.)
//
// Collection "dailyMenu", one record per calendar date (id "YYYY-MM-DD"),
// shape { date, items: [{id, name, price, vatRate}] }. GET /api/daily-menu
// with ?date= (admin-only, any date, ignores the enabled/from/to window —
// see server.js) is used here so the editor can load/copy any day
// regardless of when it's opened; the customer-facing delivery.js instead
// uses the same route WITHOUT ?date=, which only ever returns TODAY's
// record and only inside the configured window.
// ════════════════════════════════════════════════════════════════════════

let dailyMenuAdminDate = todayISODate();
let dailyMenuAdminItems = []; // [{id, name, price, vatRate}] — working copy, edited in place

async function fetchDailyMenuForDate(dateStr) {
    try {
        const res = await apiFetch(`${API_URL}/daily-menu?date=${encodeURIComponent(dateStr)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        return Array.isArray(data.items) ? data.items : [];
    } catch (e) {
        console.error('Failed to load daily menu:', e);
        showToast('Nepodařilo se načíst polední menu', true);
        return [];
    }
}

function renderDailyMenuRows(container) {
    container.innerHTML = '';
    if (dailyMenuAdminItems.length === 0) {
        const empty = document.createElement('p');
        empty.style.color = 'var(--muted)';
        empty.style.fontSize = '0.85em';
        empty.textContent = 'Žádné položky poledního menu pro tento den.';
        container.appendChild(empty);
    }

    dailyMenuAdminItems.forEach((item, idx) => {
        const row = document.createElement('div');
        row.className = 'inn-daily-item-row';

        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.placeholder = 'Název (např. Svíčková)';
        nameInput.maxLength = 300;
        nameInput.className = 'inn-daily-item-name';
        nameInput.value = item.name || '';
        nameInput.addEventListener('input', () => { item.name = nameInput.value; });

        const priceInput = document.createElement('input');
        priceInput.type = 'number';
        priceInput.min = '0';
        priceInput.step = '0.50';
        priceInput.placeholder = 'Cena';
        priceInput.className = 'inn-daily-item-price';
        priceInput.value = item.price != null ? item.price : '';
        priceInput.addEventListener('input', () => { item.price = parseFloat(priceInput.value) || 0; });

        const vatSelect = document.createElement('select');
        vatSelect.className = 'inn-daily-item-vat';
        [12, 21, 0].forEach(rate => {
            const opt = document.createElement('option');
            opt.value = String(rate);
            opt.textContent = `${rate} %`;
            if (Number(item.vatRate) === rate || (item.vatRate == null && rate === 12)) opt.selected = true;
            vatSelect.appendChild(opt);
        });
        if (item.vatRate == null) item.vatRate = 12;
        vatSelect.addEventListener('change', () => { item.vatRate = Number(vatSelect.value); });

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'inn-btn danger small';
        removeBtn.textContent = 'Odebrat';
        removeBtn.addEventListener('click', () => {
            dailyMenuAdminItems.splice(idx, 1);
            renderDailyMenuRows(container);
        });

        row.appendChild(nameInput);
        row.appendChild(priceInput);
        row.appendChild(vatSelect);
        row.appendChild(removeBtn);
        container.appendChild(row);
    });
}

function shiftDateStr(dateStr, deltaDays) {
    const d = new Date(`${dateStr}T00:00:00`);
    d.setDate(d.getDate() + deltaDays);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function renderDailyMenuView() {
    const container = document.getElementById('dailyMenuView');
    container.innerHTML = '<p style="color:var(--muted);">Načítání…</p>';

    dailyMenuAdminItems = await fetchDailyMenuForDate(dailyMenuAdminDate);

    container.innerHTML = '';
    const header = document.createElement('div');
    header.className = 'inn-menu-header';
    header.innerHTML = '<h2>📆 Polední menu</h2>';
    container.appendChild(header);

    const panel = document.createElement('div');
    panel.className = 'inn-panel';

    const dateGroup = document.createElement('div');
    dateGroup.className = 'inn-field-group';
    const dateLabel = document.createElement('label');
    dateLabel.setAttribute('for', 'dailyMenuDateInput');
    dateLabel.textContent = 'Datum';
    const dateInput = document.createElement('input');
    dateInput.type = 'date';
    dateInput.id = 'dailyMenuDateInput';
    dateInput.value = dailyMenuAdminDate;
    dateGroup.appendChild(dateLabel);
    dateGroup.appendChild(dateInput);
    panel.appendChild(dateGroup);

    const rowsContainer = document.createElement('div');
    rowsContainer.id = 'dailyMenuRows';
    panel.appendChild(rowsContainer);
    renderDailyMenuRows(rowsContainer);

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'inn-btn';
    addBtn.style.marginTop = '10px';
    addBtn.textContent = '+ Přidat položku';
    addBtn.addEventListener('click', () => {
        dailyMenuAdminItems.push({ id: generateFileId(10), name: '', price: 0, vatRate: 12 });
        renderDailyMenuRows(rowsContainer);
    });
    panel.appendChild(addBtn);

    const actions = document.createElement('div');
    actions.className = 'inn-settings-actions';

    const copyYesterdayBtn = document.createElement('button');
    copyYesterdayBtn.type = 'button';
    copyYesterdayBtn.className = 'inn-btn';
    copyYesterdayBtn.textContent = 'Zkopírovat včerejší';
    copyYesterdayBtn.addEventListener('click', async () => {
        const yesterday = shiftDateStr(dailyMenuAdminDate, -1);
        const yItems = await fetchDailyMenuForDate(yesterday);
        if (yItems.length === 0) {
            showToast('Včerejší polední menu je prázdné', true);
            return;
        }
        // Fresh ids — this is a copy into TODAY's (or whichever date is
        // selected) own record, not a reference to yesterday's.
        dailyMenuAdminItems = yItems.map(it => ({
            id: generateFileId(10), name: it.name, price: it.price, vatRate: it.vatRate,
        }));
        renderDailyMenuRows(rowsContainer);
        showToast('Položky zkopírovány — nezapomeňte uložit');
    });
    actions.appendChild(copyYesterdayBtn);

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'inn-btn primary';
    saveBtn.textContent = 'Uložit polední menu';
    saveBtn.addEventListener('click', async () => {
        for (const item of dailyMenuAdminItems) {
            if (!item.name || !item.name.trim()) {
                showToast('Každá položka musí mít název', true);
                return;
            }
            if (!(Number(item.price) >= 0)) {
                showToast('Cena musí být nezáporné číslo', true);
                return;
            }
        }
        saveBtn.disabled = true;
        saveBtn.textContent = 'Ukládám…';
        try {
            const res = await apiFetch(`${API_URL}/daily-menu`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ date: dailyMenuAdminDate, items: dailyMenuAdminItems }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
            dailyMenuAdminItems = (data.dailyMenu && data.dailyMenu.items) || dailyMenuAdminItems;
            renderDailyMenuRows(rowsContainer);
            showToast('Polední menu uloženo');
        } catch (e) {
            console.error('Failed to save daily menu:', e);
            showToast(e.message || 'Nepodařilo se uložit polední menu', true);
        } finally {
            saveBtn.disabled = false;
            saveBtn.textContent = 'Uložit polední menu';
        }
    });
    actions.appendChild(saveBtn);

    panel.appendChild(actions);
    container.appendChild(panel);

    dateInput.addEventListener('change', () => {
        dailyMenuAdminDate = dateInput.value || todayISODate();
        renderDailyMenuView();
    });
}
