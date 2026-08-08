// ============================================================================
// geocode.test.js — the Nominatim client's cache, negative cache, and rate
// limiter. `globalThis.fetch` is stubbed throughout: this file must never
// touch the network, and a test run must never appear in OSM's logs.
// ============================================================================

const test = require("node:test");
const assert = require("node:assert");
const os = require("os");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

// db.js resolves DB_PATH at require time, so this has to be set first —
// same pattern as tests/unit/db-patch.test.js.
const TMP_DB = path.join(os.tmpdir(), `geocode-${process.pid}-${crypto.randomBytes(6).toString("hex")}.db`);
process.env.SQLITE_PATH = TMP_DB;
// Keep the serial queue's spacing testable without 1.1s real waits.
process.env.GEOCODE_MIN_SPACING_MS = "20";
delete process.env.GEOCODE_DISABLED;

const db = require("../../src/server/db");
const geocode = require("../../src/server/geocode");

test.after(() => {
    try { db.getDb().close(); } catch { /* already closed */ }
    for (const suffix of ["", "-wal", "-shm"]) {
        try { fs.unlinkSync(TMP_DB + suffix); } catch { /* never existed */ }
    }
});

const realFetch = globalThis.fetch;
function stubFetch(handler) {
    const calls = [];
    globalThis.fetch = async (url, opts) => {
        calls.push({ url: String(url), opts, at: Date.now() });
        return handler(String(url), opts, calls.length);
    };
    return calls;
}
function restoreFetch() { globalThis.fetch = realFetch; }

function hit(lat, lon) {
    return { ok: true, json: async () => ([{ lat: String(lat), lon: String(lon), addresstype: "building" }]) };
}
function miss() {
    return { ok: true, json: async () => ([]) };
}

function clearCache() {
    for (const rec of db.list(geocode.GEOCACHE_COLLECTION)) {
        db.remove(geocode.GEOCACHE_COLLECTION, rec.id);
    }
}

test("normalizeQuery folds case, diacritics and whitespace", () => {
    const a = geocode.normalizeQuery("  Školní   50 ", "430 01");
    const b = geocode.normalizeQuery("skolni 50", "43001");
    assert.strictEqual(a, b);
    assert.ok(a.includes("43001"));
});

test("cacheKey is stable and differs for different queries", () => {
    assert.strictEqual(geocode.cacheKey("a b"), geocode.cacheKey("a b"));
    assert.notStrictEqual(geocode.cacheKey("a b"), geocode.cacheKey("a c"));
});

test("a successful lookup is cached — the second call makes no request", async () => {
    clearCache();
    const calls = stubFetch(() => hit(50.46, 13.41));
    try {
        const first = await geocode.geocode("Školní 50", "43001");
        assert.ok(Math.abs(first.lat - 50.46) < 1e-9);
        assert.ok(Math.abs(first.lon - 13.41) < 1e-9);
        assert.strictEqual(first.provider, "nominatim");
        assert.strictEqual(calls.length, 1);

        const second = await geocode.geocode("  ŠKOLNÍ  50 ", "430 01");
        assert.ok(Math.abs(second.lat - 50.46) < 1e-9);
        assert.strictEqual(calls.length, 1, "normalized-equal query must hit the cache");
    } finally { restoreFetch(); }
});

test("a miss is negatively cached and not retried inside the retry floor", async () => {
    clearCache();
    const calls = stubFetch(() => miss());
    try {
        assert.strictEqual(await geocode.geocode("Nikde 999", "43001"), null);
        assert.strictEqual(calls.length, 1);
        assert.strictEqual(await geocode.geocode("Nikde 999", "43001"), null);
        assert.strictEqual(calls.length, 1, "must not re-query inside the 1h retry floor");
    } finally { restoreFetch(); }
});

test("a miss IS retried once the retry floor has elapsed", async () => {
    clearCache();
    const calls = stubFetch(() => miss());
    try {
        await geocode.geocode("Nikde 998", "43001");
        assert.strictEqual(calls.length, 1);
        // Age the cache record past the 1h floor.
        const key = geocode.cacheKey(geocode.normalizeQuery("Nikde 998", "43001"));
        const rec = db.get(geocode.GEOCACHE_COLLECTION, key);
        rec.at = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
        db.set(geocode.GEOCACHE_COLLECTION, key, rec);

        await geocode.geocode("Nikde 998", "43001");
        assert.strictEqual(calls.length, 2);
    } finally { restoreFetch(); }
});

test("a permanently bad address stops being retried after 5 attempts", async () => {
    clearCache();
    const calls = stubFetch(() => miss());
    try {
        const key = geocode.cacheKey(geocode.normalizeQuery("Nikde 997", "43001"));
        for (let i = 0; i < 6; i++) {
            await geocode.geocode("Nikde 997", "43001");
            const rec = db.get(geocode.GEOCACHE_COLLECTION, key);
            if (rec) { rec.at = new Date(Date.now() - 2 * 3600 * 1000).toISOString(); db.set(geocode.GEOCACHE_COLLECTION, key, rec); }
        }
        assert.strictEqual(calls.length, 5, `expected the 5-attempt ceiling, got ${calls.length}`);
    } finally { restoreFetch(); }
});

test("a non-ok HTTP response is a failure, not a crash", async () => {
    clearCache();
    stubFetch(() => ({ ok: false, status: 429, json: async () => ({}) }));
    try {
        assert.strictEqual(await geocode.geocode("Cokoliv 1", "43001"), null);
    } finally { restoreFetch(); }
});

test("a thrown fetch is a failure, not a crash", async () => {
    clearCache();
    stubFetch(() => { throw new Error("ENOTFOUND"); });
    try {
        assert.strictEqual(await geocode.geocode("Cokoliv 2", "43001"), null);
    } finally { restoreFetch(); }
});

test("requests are serialized with at least the configured spacing", async () => {
    clearCache();
    const calls = stubFetch(() => hit(50, 14));
    try {
        await Promise.all([
            geocode.geocode("Ulice 1", "43001"),
            geocode.geocode("Ulice 2", "43001"),
            geocode.geocode("Ulice 3", "43001"),
        ]);
        assert.strictEqual(calls.length, 3);
        for (let i = 1; i < calls.length; i++) {
            const gap = calls[i].at - calls[i - 1].at;
            assert.ok(gap >= 15, `calls ${i - 1}->${i} only ${gap}ms apart`);
        }
    } finally { restoreFetch(); }
});

test("the request carries a descriptive User-Agent and restricts to CZ", async () => {
    clearCache();
    const calls = stubFetch(() => hit(50, 14));
    try {
        await geocode.geocode("Ulice 9", "43001", { userAgent: "Testovaci restaurace (test@example.com)" });
        assert.match(calls[0].url, /countrycodes=cz/);
        assert.strictEqual(calls[0].opts.headers["User-Agent"], "Testovaci restaurace (test@example.com)");
    } finally { restoreFetch(); }
});

test("GEOCODE_DISABLED short-circuits without touching fetch or the cache", async () => {
    clearCache();
    process.env.GEOCODE_DISABLED = "1";
    const calls = stubFetch(() => hit(50, 14));
    try {
        assert.strictEqual(geocode.isEnabled(), false);
        assert.strictEqual(await geocode.geocode("Školní 50", "43001"), null);
        assert.strictEqual(calls.length, 0);
    } finally {
        restoreFetch();
        delete process.env.GEOCODE_DISABLED;
    }
});

test("an empty address never becomes a request", async () => {
    clearCache();
    const calls = stubFetch(() => hit(50, 14));
    try {
        assert.strictEqual(await geocode.geocode("", ""), null);
        assert.strictEqual(calls.length, 0);
    } finally { restoreFetch(); }
});
