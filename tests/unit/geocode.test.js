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

// ── PRIVACY / RETENTION (finding N1(c)) ─────────────────────────────────

test("a cached row never carries the street address", async () => {
    // The rows used to store `query` — the normalized address — even though
    // nothing ever read it back, since the cache is keyed by its hash. That
    // made this table a permanent register of everywhere the restaurant has
    // delivered. It must stay unwritten on BOTH the hit and the miss path.
    clearCache();
    const restore = stubFetch((url) => (url.includes("nenalezena") ? miss() : hit(50.1, 14.4)));
    try {
        await geocode.geocode("Školní 50", "43001");
        await geocode.geocode("Adresa nenalezena", "43001");
    } finally { restoreFetch(); void restore; }

    const rows = db.list(geocode.GEOCACHE_COLLECTION);
    assert.strictEqual(rows.length, 2, "one hit, one miss");
    for (const row of rows) {
        assert.ok(!("query" in row), `row must not carry the address: ${JSON.stringify(row)}`);
        const serialized = JSON.stringify(row);
        assert.ok(!/skolni|Školní|nenalezena/i.test(serialized), `no address text anywhere in the row: ${serialized}`);
        assert.ok(row.id, "still keyed by the hash");
    }
});

test("expired rows are selected, fresh ones are not", () => {
    const now = new Date("2026-08-10T12:00:00Z");
    const at = (daysAgo) => new Date(now.getTime() - daysAgo * 86400000).toISOString();

    const ids = geocode.selectExpiredCacheIds([
        { id: "fresh", at: at(10) },
        { id: "old", at: at(200) },
        { id: "exactly-inside", at: at(179) },
    ], { now });

    assert.deepStrictEqual(ids, ["old"]);
});

test("a row with no usable timestamp is deleted, not kept", () => {
    // The opposite of the login audit's rule, and deliberately so: an audit row
    // is evidence and losing it is the harm; a cache row is personal data whose
    // loss costs one HTTP request.
    const now = new Date();
    for (const bad of [undefined, null, "", "not-a-date"]) {
        assert.deepStrictEqual(
            geocode.selectExpiredCacheIds([{ id: "x", at: bad }], { now }), ["x"],
            `at=${JSON.stringify(bad)} must expire`
        );
    }
});

test("a legacy row carrying an address is deleted whatever its age", () => {
    const now = new Date();
    assert.deepStrictEqual(
        geocode.selectExpiredCacheIds([{ id: "legacy", at: now.toISOString(), query: "skolni 50 43001" }], { now }),
        ["legacy"],
        "rows written before the address was dropped must not survive on freshness"
    );
});

test("the retention window is configurable and refuses nonsense", () => {
    const now = new Date("2026-08-10T12:00:00Z");
    const row = { id: "r", at: new Date(now.getTime() - 40 * 86400000).toISOString() };

    assert.deepStrictEqual(geocode.selectExpiredCacheIds([row], { now, retentionDays: 30 }), ["r"]);
    assert.deepStrictEqual(geocode.selectExpiredCacheIds([row], { now, retentionDays: 90 }), []);
    for (const bad of [0, -5, NaN, "soon"]) {
        assert.deepStrictEqual(geocode.selectExpiredCacheIds([row], { now, retentionDays: bad }), [],
            `retentionDays=${JSON.stringify(bad)} must fall back to the 180-day default`);
    }
    assert.deepStrictEqual(geocode.selectExpiredCacheIds(null), []);
});

test("prune actually deletes from the database", async () => {
    clearCache();
    const restore = stubFetch(() => hit(50.2, 14.5));
    try {
        await geocode.geocode("Dlouhá 1", "11000");
    } finally { restoreFetch(); void restore; }

    assert.strictEqual(db.list(geocode.GEOCACHE_COLLECTION).length, 1);

    // Nothing to do today...
    assert.strictEqual(geocode.prune(new Date()), 0);
    assert.strictEqual(db.list(geocode.GEOCACHE_COLLECTION).length, 1);

    // ...and gone once the clock has moved past the window.
    const later = new Date(Date.now() + (geocode.CACHE_RETENTION_DAYS + 1) * 86400000);
    assert.strictEqual(geocode.prune(later), 1);
    assert.strictEqual(db.list(geocode.GEOCACHE_COLLECTION).length, 0);
});
