// ============================================================================
// sw.js — service worker for the staff till.
//
// Offline-first POS, spec §3.2. Its job is narrow: make inner.html load at
// all when the bar's Wi-Fi is down in the morning. It does NOT queue,
// retry, or otherwise touch sales — pos-sync.js owns that, because only it
// knows about idempotency keys.
//
// ⚠️  This file is NOT served straight off disk. server.js substitutes a
// hash of the shell files into __SHELL_VERSION__ and serves it with
// Cache-Control: no-store. Editing the shell therefore invalidates the
// cache automatically. A hand-maintained version constant is exactly how a
// bar ends up running last month's inner.js after a deploy that looked
// like it worked — and it would interact badly with express.static's
// `immutable, max-age=2592000` and minify.js's own content-hash ETags.
// ============================================================================

const SHELL_VERSION = "__SHELL_VERSION__";
const BASE = "__BASE_PATH__";
const CACHE_NAME = `pos-shell-${SHELL_VERSION}`;

const SHELL_ASSETS = [
    `${BASE}/html/inner.html`,
    `${BASE}/css/design.css`,
    `${BASE}/css/floorplan.css`,
    `${BASE}/css/inner.css`,
    `${BASE}/config.js`,
    `${BASE}/js/qr.js`,
    `${BASE}/js/floorplan.js`,
    `${BASE}/js/pos-db.js`,
    `${BASE}/js/pos-sync.js`,
    `${BASE}/js/inner.js`,
    `${BASE}/js/sales-stats-view.js`,
    `${BASE}/manifest.json`,
];

self.addEventListener("install", event => {
    event.waitUntil((async () => {
        const cache = await caches.open(CACHE_NAME);
        // addAll is all-or-nothing: one 404 and the whole install fails,
        // leaving the old worker in place. That is the right outcome — a
        // half-cached shell is a till that loads a blank screen at 6am —
        // but it means a typo in SHELL_ASSETS is a silent no-update, so the
        // failure is logged rather than swallowed.
        try {
            await cache.addAll(SHELL_ASSETS);
        } catch (e) {
            console.error("[sw] shell precache failed — keeping the previous worker:", e);
            throw e;
        }
        // Take over immediately. Waiting for every tab to close means a
        // tablet that is never closed never gets the fix.
        await self.skipWaiting();
    })());
});

// Deleting every older `pos-shell-*` cache is also what REMOVES the customer
// data already sitting on devices from before finding M2 was fixed. SHELL_VERSION
// is a hash of the shell's own bytes and this file is part of that hash, so
// editing it changes CACHE_NAME — which means the deploy that ships the
// allowlist above is the same deploy that drops the old, PII-bearing cache. With
// skipWaiting() + clients.claim() that happens on the next page load rather than
// whenever the last tab is finally closed. No separate migration, and nothing
// for an owner to remember to run.
self.addEventListener("activate", event => {
    event.waitUntil((async () => {
        const names = await caches.keys();
        await Promise.all(
            names
                .filter(name => name.startsWith("pos-shell-") && name !== CACHE_NAME)
                .map(name => caches.delete(name))
        );
        await self.clients.claim();
    })());
});

function isApiRequest(url) {
    return url.pathname.includes("/api/");
}

// ── WHAT MAY BE WRITTEN TO DISK (finding M2) ────────────────────────────
//
// This worker used to run EVERY same-origin `GET /api/*` through
// networkFirst(), which means every one of those responses was written into
// Cache Storage. Its scope is the whole app base, so that was not only the
// till: the kitchen display and the DRIVER'S OWN PHONE were caching
//
//   GET /api/orders          every delivery customer's name, full address,
//                            PSČ, phone and note
//   GET /api/kitchen/orders  the same, per ticket
//   GET /api/receipts        every receipt the restaurant has issued
//   GET /api/timetables/:name guest names and phones on every booking slot
//
// to disk, indefinitely, with nothing purging it on logout. On a shared bar
// tablet that is personal data outliving the staff member who fetched it,
// readable by anyone holding the device — with no lawful basis and no
// retention period.
//
// The fix is an allowlist, not a purge, because the strongest version of
// "cleared on logout" is still weaker than never having written it down. What
// the till genuinely needs in order to keep SELLING with the Wi-Fi down is the
// menu and the prices — not the customer list.
//
// Everything the offline floor view needs beyond this is persisted by the page
// itself into IndexedDB (POSDB), redacted on the way in: see loadAllTables()
// and fetchIndoorWalkinOrders() in inner.js. That is deliberate rather than
// convenient — the page knows which fields matter, so the decision lives in one
// place next to the code that renders them, instead of being re-derived here
// from URLs by a worker that would silently start caching PII again the day a
// new endpoint is added.
const CACHEABLE_API_ENDPOINTS = new Set([
    "menu",        // dishes and prices — without this the till cannot take an order
    "combos",      // same, for combo deals
    "settings",    // VAT rates, opening hours, payment methods
    "daily-menu",  // today's specials
]);

// First path segment after /api/. Query strings are excluded by `pathname`,
// so `/api/daily-menu?date=` matches "daily-menu" — deliberate: the admin's
// date override is the same non-PII payload.
function apiEndpoint(url) {
    const match = url.pathname.match(/\/api\/([^/?]+)/);
    return match ? match[1] : null;
}

function isCacheableApi(url) {
    const endpoint = apiEndpoint(url);
    return endpoint !== null && CACHEABLE_API_ENDPOINTS.has(endpoint);
}

// Network-first with a short timeout, falling back to whatever was cached.
//
// Used ONLY for the allowlisted config endpoints (see CACHEABLE_API_ENDPOINTS),
// so a till that just went offline still has a menu and prices to sell from.
// It used to be used for every GET /api/*, which is how customer data ended up
// on disk (finding M2). The order list is no longer served from here — the page
// keeps its own redacted copy in IndexedDB.
async function networkFirst(request, timeoutMs) {
    const cache = await caches.open(CACHE_NAME);
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const response = await fetch(request, { signal: controller.signal });
        clearTimeout(timer);
        if (response && response.ok) cache.put(request, response.clone());
        return response;
    } catch (e) {
        const cached = await cache.match(request);
        if (cached) return cached;
        throw e;
    }
}

async function cacheFirst(request) {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    if (response && response.ok) cache.put(request, response.clone());
    return response;
}

self.addEventListener("fetch", event => {
    const request = event.request;
    const url = new URL(request.url);

    // ── The rule that matters most in this file ─────────────────────────
    //
    // Any non-GET request goes straight to the network, untouched. This is
    // not an optimisation — it is the boundary that keeps payments away
    // from cache-replay logic. POST /indoor-orders and /mark-paid are
    // money; the ONLY thing allowed to retry them is pos-sync.js, because
    // it is the only thing that attaches an Idempotency-Key. A service
    // worker replaying a POST from a cache or a queue it does not
    // understand would report a sale twice to the tax authority.
    if (request.method !== "GET") return;

    // Cross-origin (fonts, anything else) — leave it to the browser.
    if (url.origin !== self.location.origin) return;

    if (isApiRequest(url)) {
        // Allowlisted, non-PII config: network-first, so the till still has a
        // menu when the Wi-Fi drops. See CACHEABLE_API_ENDPOINTS.
        if (isCacheableApi(url)) {
            event.respondWith(networkFirst(request, 4000));
        }
        // Everything else: NOT handled here at all. Returning without calling
        // respondWith hands the request back to the browser untouched, so it
        // goes to the network and nothing is written to disk. Deliberately not
        // `respondWith(fetch(request))` — that would be an identical outcome
        // today and a place for a cache.put to be added back tomorrow.
        return;
    }

    if (request.mode === "navigate") {
        // A navigation that cannot reach the network falls back to the
        // cached shell, which is the whole point of this worker.
        event.respondWith((async () => {
            try {
                return await fetch(request);
            } catch (e) {
                const cache = await caches.open(CACHE_NAME);
                const shell = await cache.match(`${BASE}/html/inner.html`);
                if (shell) return shell;
                throw e;
            }
        })());
        return;
    }

    event.respondWith(cacheFirst(request));
});

// Background Sync — Chrome fires this when connectivity returns, even with
// the app closed. The page owns the queue, so the worker's job is simply to
// wake any open client and let pos-sync.js do the work. When no client is
// open there is nothing to wake, and the drain happens on next launch;
// draining from here would mean duplicating the entire idempotency-aware
// client in worker scope, which is precisely the second path to money this
// design exists to avoid.
self.addEventListener("sync", event => {
    if (event.tag !== "pos-drain") return;
    event.waitUntil((async () => {
        const clients = await self.clients.matchAll({ includeUncontrolled: true, type: "window" });
        for (const client of clients) client.postMessage({ type: "pos-drain" });
    })());
});
