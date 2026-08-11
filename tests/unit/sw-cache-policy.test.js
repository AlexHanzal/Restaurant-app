// ============================================================================
// sw-cache-policy.test.js — what the service worker is allowed to write to disk.
//
// Finding M2, docs/2026-08-08-architecture-dataflow-security-review.md.
//
// The worker used to run every same-origin GET /api/* through networkFirst(),
// which cache.put()s the response. Its scope is the whole app base, so that was
// not only the till: the kitchen display and the driver's own phone were writing
// customer names, full addresses and phone numbers to disk indefinitely, with
// nothing clearing them on logout.
//
// The property under test is therefore not "is the right thing cached" but "is
// the wrong thing NEVER cached". That is worth a real test rather than a reading
// of the source, because the failure is invisible: caching a PII response works
// perfectly, looks identical to the user, and is only discoverable by opening
// devtools on the tablet.
//
// sw.js cannot be require()d — it is a worker script that registers listeners on
// `self` and is served with its __PLACEHOLDERS__ substituted. So it is loaded
// into a hand-built worker scope below, which is also what lets the fetch
// handler be invoked directly.
// ============================================================================

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SW_SOURCE = fs.readFileSync(path.join(__dirname, "..", "..", "src", "sw.js"), "utf8");
const BASE = "/reservation";

// Minimal Cache Storage double that records every write.
function makeCaches() {
    const stores = new Map();
    const puts = [];
    return {
        puts,
        api: {
            open: async (name) => {
                if (!stores.has(name)) stores.set(name, new Map());
                const store = stores.get(name);
                return {
                    put: async (request, response) => {
                        puts.push(typeof request === "string" ? request : request.url);
                        store.set(typeof request === "string" ? request : request.url, response);
                    },
                    match: async (request) => store.get(typeof request === "string" ? request : request.url) || null,
                    addAll: async () => {},
                };
            },
            keys: async () => [...stores.keys()],
            delete: async (name) => stores.delete(name),
        },
    };
}

// Loads sw.js in a fresh scope and returns the handlers plus the spies.
function loadWorker({ networkFails = false } = {}) {
    const listeners = {};
    const cachesDouble = makeCaches();
    const fetched = [];

    const self = {
        location: { origin: "https://restaurace.example" },
        addEventListener: (type, handler) => { listeners[type] = handler; },
        skipWaiting: async () => {},
        clients: { claim: async () => {}, matchAll: async () => [] },
    };

    const fetchDouble = async (request) => {
        fetched.push(typeof request === "string" ? request : request.url);
        if (networkFails) throw new Error("offline");
        return { ok: true, clone: () => ({ body: "cloned" }) };
    };

    const source = SW_SOURCE
        .replace(/__SHELL_VERSION__/g, "testhash1234")
        .replace(/__BASE_PATH__/g, BASE);

    vm.runInNewContext(source, {
        self,
        caches: cachesDouble.api,
        fetch: fetchDouble,
        console: { log() {}, error() {}, warn() {} },
        URL,
        AbortController,
        setTimeout,
        clearTimeout,
        Promise,
        Set,
        Map,
    });

    return { listeners, cachesDouble, fetched, self };
}

// Drives the fetch handler for one request and resolves whatever it responded
// with — or `null` when it declined to handle the request at all, which is the
// outcome that means "straight to the network, nothing written down".
async function handleFetch(worker, { url, method = "GET", mode = "cors" }) {
    let responded = null;
    const event = {
        request: { url, method, mode },
        respondWith: (p) => { responded = p; },
    };
    worker.listeners.fetch(event);
    if (responded === null) return { handled: false };
    try {
        return { handled: true, response: await responded };
    } catch (e) {
        return { handled: true, error: e };
    }
}

const ORIGIN = "https://restaurace.example";
const api = (p) => `${ORIGIN}${BASE}/api/${p}`;

// ── THE CASE THIS FILE EXISTS FOR ────────────────────────────────────────

test("no PII-bearing API response is ever written to the cache", async () => {
    const worker = loadWorker();

    // Every endpoint the finding named, plus the ones that would obviously be
    // added next. All of them carry customer or staff data.
    const sensitive = [
        "orders",                          // name, full address, PSČ, phone, note
        "kitchen/orders",                  // the same, per ticket
        "receipts",                        // every receipt ever issued
        "receipts/abc123",
        "timetables",                      // table names, and the route below
        "timetables/St%C5%AFl%201",        // guest names + phones on booking slots
        "indoor-orders",
        "stats/sales",
        "users",
        "drivers",
        "security/login-audit",
        "export",
        "csrf-token",                      // not PII, but a token has no business on disk
        "eet/health",
        "table-qr-tokens",
    ];

    for (const endpoint of sensitive) {
        const out = await handleFetch(worker, { url: api(endpoint) });
        assert.strictEqual(out.handled, false,
            `/api/${endpoint} must be handed to the browser untouched, not routed through the cache`);
    }

    assert.deepStrictEqual(worker.cachesDouble.puts, [],
        `nothing may be written to disk for those endpoints, got: ${JSON.stringify(worker.cachesDouble.puts)}`);
});

test("the allowlisted config endpoints ARE cached, so the till can still sell offline", async () => {
    const worker = loadWorker();

    for (const endpoint of ["menu", "combos", "settings", "daily-menu"]) {
        const out = await handleFetch(worker, { url: api(endpoint) });
        assert.strictEqual(out.handled, true, `/api/${endpoint} should be served network-first`);
    }

    const cached = worker.cachesDouble.puts.map(u => u.replace(`${ORIGIN}${BASE}/api/`, ""));
    assert.deepStrictEqual(cached.sort(), ["combos", "daily-menu", "menu", "settings"]);
});

test("a query string does not smuggle an endpoint past the allowlist", async () => {
    const worker = loadWorker();
    // The admin's date override on daily-menu is the same non-PII payload...
    assert.strictEqual((await handleFetch(worker, { url: api("daily-menu?date=2026-09-01") })).handled, true);
    // ...while a query string cannot make a sensitive endpoint look allowlisted.
    assert.strictEqual((await handleFetch(worker, { url: api("orders?from=x&menu=1") })).handled, false);
    assert.strictEqual((await handleFetch(worker, { url: api("receipts?menu") })).handled, false);

    const cached = worker.cachesDouble.puts.map(u => u.replace(`${ORIGIN}${BASE}/api/`, ""));
    assert.deepStrictEqual(cached, ["daily-menu?date=2026-09-01"]);
});

test("a path that merely contains an allowlisted word is not allowlisted", async () => {
    const worker = loadWorker();
    // Only the first segment after /api/ counts. A future /api/orders/menu or
    // /api/menu-audit must not inherit the menu's permission.
    for (const endpoint of ["orders/menu", "menu-audit", "settings-history", "combos-report"]) {
        assert.strictEqual((await handleFetch(worker, { url: api(endpoint) })).handled, false,
            `/api/${endpoint} must not be treated as allowlisted`);
    }
    assert.deepStrictEqual(worker.cachesDouble.puts, []);
});

// ── the rules that were already right, and must stay right ───────────────

test("a non-GET request is never touched", async () => {
    const worker = loadWorker();
    // The boundary that keeps payments away from cache-replay logic: only
    // pos-sync.js may retry a POST, because only it attaches an
    // Idempotency-Key. A replayed POST is a sale reported twice.
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
        for (const endpoint of ["indoor-orders", "menu", "orders"]) {
            const out = await handleFetch(worker, { url: api(endpoint), method });
            assert.strictEqual(out.handled, false, `${method} /api/${endpoint} must go straight to the network`);
        }
    }
    assert.deepStrictEqual(worker.cachesDouble.puts, []);
});

test("cross-origin requests are left to the browser", async () => {
    const worker = loadWorker();
    const out = await handleFetch(worker, { url: "https://fonts.example/inter.woff2" });
    assert.strictEqual(out.handled, false);
    assert.deepStrictEqual(worker.cachesDouble.puts, []);
});

test("shell assets are still cached, so the till boots with the Wi-Fi down", async () => {
    const worker = loadWorker();
    const out = await handleFetch(worker, { url: `${ORIGIN}${BASE}/js/inner.js` });
    assert.strictEqual(out.handled, true, "non-API same-origin assets go through cacheFirst");
    assert.deepStrictEqual(worker.cachesDouble.puts, [`${ORIGIN}${BASE}/js/inner.js`]);
});

test("an offline menu request falls back to the cache rather than erroring", async () => {
    // Populate, then go offline and ask again — the whole point of caching it.
    const online = loadWorker();
    await handleFetch(online, { url: api("menu") });

    const offline = loadWorker({ networkFails: true });
    const out = await handleFetch(offline, { url: api("menu") });
    assert.strictEqual(out.handled, true);
    // Nothing was cached in THIS worker instance, so it surfaces the failure
    // rather than inventing an empty menu.
    assert.ok(out.error, "with an empty cache the failure must propagate, not be swallowed");
});

test("activate deletes every older shell cache — which is what removes the old PII", async () => {
    const worker = loadWorker();

    // Simulate a device upgrading from a pre-fix worker: an old cache exists,
    // holding whatever that version had written.
    const old = await worker.cachesDouble.api.open("pos-shell-oldversion");
    await old.put(api("orders"), { body: "every customer's address" });
    await worker.cachesDouble.api.open("pos-shell-testhash1234");
    await worker.cachesDouble.api.open("some-unrelated-cache");

    let waited;
    worker.listeners.activate({ waitUntil: (p) => { waited = p; } });
    await waited;

    const remaining = await worker.cachesDouble.api.keys();
    assert.ok(!remaining.includes("pos-shell-oldversion"), "the pre-fix cache, and the PII in it, must be gone");
    assert.ok(remaining.includes("pos-shell-testhash1234"), "the current one stays");
    assert.ok(remaining.includes("some-unrelated-cache"), "and caches this worker does not own are left alone");
});
