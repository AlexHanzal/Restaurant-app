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

// Network-first with a short timeout, falling back to whatever was cached.
// Used for GET /api/* so a till that just went offline shows the last known
// menu and order list instead of an error page.
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
        event.respondWith(networkFirst(request, 4000));
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
