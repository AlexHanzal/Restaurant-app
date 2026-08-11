// ════════════════════════════════════════════════════════════════════════
// geocode.js — free-text address -> {lat, lon}, via OpenStreetMap
// Nominatim, cached hard in SQLite.
//
// Self-contained black box, same convention as validation.js/settings.js:
// depends only on db.js, and native fetch (no SDK — same choice gopay.js
// made). Never throws; a failure is `null`.
//
// THREE THINGS HERE ARE LOAD-BEARING, not defensive padding:
//
//  1. NOMINATIM'S USAGE POLICY IS BINDING. It requires a descriptive
//     User-Agent identifying the application and a hard maximum of ONE
//     request per second. Both are implemented below and neither is
//     optional — ignoring them gets the restaurant's IP blocked, and the
//     symptom would be "batching quietly stopped working".
//
//  2. NEGATIVE CACHING. Without it a mistyped address is re-queried on
//     every single board event, forever. Misses are cached, retried no
//     sooner than an hour later, and abandoned after 5 attempts.
//
//  3. THIS IS NEVER ON THE CHECKOUT PATH. POST /orders saves the order and
//     returns; geocoding happens afterwards, in the background. A geocoder
//     outage must never cost the restaurant a sale (spec §14).
//
// Privacy: only the street address and PSČ are ever sent — never a name,
// phone, or e-mail. See spec §17; a street address is still personal data
// under GDPR and the privacy page may need a disclosure line.
// ════════════════════════════════════════════════════════════════════════

const crypto = require("crypto");
const db = require("./db");

const GEOCACHE_COLLECTION = "geocache";
const ENDPOINT = "https://nominatim.openstreetmap.org/search";

// Nominatim's policy floor is 1 req/s. 1100 ms leaves headroom for clock
// jitter. Overridable ONLY so the unit test can run in milliseconds.
const MIN_SPACING_MS = Number(process.env.GEOCODE_MIN_SPACING_MS || 1100);
const REQUEST_TIMEOUT_MS = 8000;
const RETRY_FLOOR_MS = 60 * 60 * 1000; // 1 hour
const MAX_ATTEMPTS = 5;

const DEFAULT_USER_AGENT = "restaurace-app/1.0 (delivery routing)";

function isEnabled() {
    return process.env.GEOCODE_DISABLED !== "1";
}

// Case-folded, diacritic-stripped, whitespace-collapsed. Two addresses that
// differ only in how the customer typed them must produce ONE cache entry —
// otherwise the cache barely hits and the rate limiter becomes the
// bottleneck on a busy night.
//
// NOTE: the U+0300-U+036F range is the Unicode "Combining Diacritical
// Marks" block — exactly what .normalize("NFD") splits accented letters
// into (e.g. "š" -> "s" + U+030C). It MUST be written as the \uXXXX
// escape, not as literal combining characters in the source file: literal
// combining marks in a regex character class are invisible in most editors
// and can silently corrupt into something else on save/copy, which would
// make this whole normalization step quietly stop stripping diacritics.
// (Built via `new RegExp(string)` rather than a `/.../ ` literal for the
// same reason — it keeps the escape as inert text until the regex engine
// itself interprets it.)
//
// The PSČ is cleaned of internal whitespace SEPARATELY, before being
// joined onto the address: Czech postal codes are written both "43001"
// and "430 01" interchangeably, and the general whitespace-collapse below
// only collapses runs of whitespace to a single space — it does not (and,
// for the address part, must not) delete it outright. Two customers typing
// the same PSČ differently must still land on the same cache entry.
function normalizeQuery(address, psc) {
    const cleanPsc = String(psc || "").replace(/\s+/g, "");
    return `${address || ""} ${cleanPsc}`
        .normalize("NFD")
        .replace(new RegExp("[\\u0300-\\u036f]", "g"), "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

function cacheKey(query) {
    return crypto.createHash("sha1").update(query).digest("hex");
}

// ── Rate limiter ─────────────────────────────────────────────────────────
// One global serial queue, not one per caller: the policy limit is per
// application, so parallel callers must still be spaced apart.
let queueTail = Promise.resolve();
let lastCallAt = 0;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function enqueue(fn) {
    const run = queueTail.then(async () => {
        const wait = MIN_SPACING_MS - (Date.now() - lastCallAt);
        if (wait > 0) await sleep(wait);
        lastCallAt = Date.now();
        return fn();
    });
    // Swallow rejections on the CHAIN only — the returned promise still
    // rejects for the caller. Without this one failure poisons the queue
    // and every later lookup rejects forever.
    queueTail = run.then(() => {}, () => {});
    return run;
}

// ── Provider ─────────────────────────────────────────────────────────────

async function queryNominatim(query, userAgent) {
    const url = `${ENDPOINT}?q=${encodeURIComponent(query)}&format=jsonv2&limit=1&countrycodes=cz`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            headers: { "User-Agent": userAgent, "Accept-Language": "cs" },
            signal: controller.signal,
        });
        if (!res.ok) return null;
        const data = await res.json();
        if (!Array.isArray(data) || !data.length) return null;
        const lat = parseFloat(data[0].lat);
        const lon = parseFloat(data[0].lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
        return { lat, lon, quality: data[0].addresstype || data[0].type || "" };
    } catch {
        // Timeout, DNS failure, malformed JSON — all the same to the caller.
        return null;
    } finally {
        clearTimeout(timer);
    }
}

// ── Public entry point ───────────────────────────────────────────────────

async function geocode(address, psc, opts = {}) {
    if (!isEnabled()) return null;

    const query = normalizeQuery(address, psc);
    if (!query) return null;

    const key = cacheKey(query);
    const cached = db.get(GEOCACHE_COLLECTION, key);

    if (cached && Number.isFinite(cached.lat) && Number.isFinite(cached.lon)) {
        return { lat: cached.lat, lon: cached.lon, quality: cached.quality || "", provider: cached.provider || "nominatim", at: cached.at };
    }

    if (cached) {
        const failCount = cached.failCount || 0;
        if (failCount >= MAX_ATTEMPTS) return null;
        const age = Date.now() - new Date(cached.at).getTime();
        if (Number.isFinite(age) && age < RETRY_FLOOR_MS) return null;
    }

    const userAgent = opts.userAgent || DEFAULT_USER_AGENT;
    // Nominatim wants a country hint in the query text too, not just the
    // countrycodes filter — CZ street names are not globally unique.
    const found = await enqueue(() => queryNominatim(`${address || ""}, ${psc || ""}, Czechia`, userAgent));
    const at = new Date().toISOString();

    if (!found) {
        db.set(GEOCACHE_COLLECTION, key, {
            id: key, lat: null, lon: null, quality: "", provider: "nominatim",
            at, failCount: (cached && cached.failCount ? cached.failCount : 0) + 1,
        });
        return null;
    }

    const record = { id: key, lat: found.lat, lon: found.lon, quality: found.quality, provider: "nominatim", at, failCount: 0 };
    db.set(GEOCACHE_COLLECTION, key, record);
    return { lat: found.lat, lon: found.lon, quality: found.quality, provider: "nominatim", at };
}

// ── RETENTION ────────────────────────────────────────────────────────────
// Review 2026-08-10, finding N1(c). Two problems, and the first one is the
// interesting one:
//
//  1. THE ROWS USED TO CARRY THE ADDRESS IN PLAINTEXT. Every record stored
//     `query` — the normalized street address and PSČ — even though nothing
//     ever read it back: the cache is keyed by its SHA-1, so lookups never
//     need the original text. It was there for debugging and cost a permanent,
//     unpruned register of everywhere this restaurant has ever delivered. It
//     is now simply not written. `failCount` and the hash are enough to debug
//     a persistently failing address, and the surviving row is a hash plus
//     coordinates rather than a customer's home address.
//
//     Rows written before this change still hold `query`. Rather than a
//     migration, prune() below deletes any row that has one, on the next
//     sweep, whatever its age — the cache is a cache, so losing an entry costs
//     one re-lookup and nothing else.
//
//  2. NOTHING EVER DELETED A ROW. An address the restaurant delivered to once,
//     two years ago, stayed forever.
//
// Deliberately age-since-WRITE, not age-since-last-use: implementing LRU would
// mean writing to the row on every cache hit, which turns a read-mostly table
// into a write-mostly one for no benefit a restaurant would notice. A street
// that is still being delivered to simply gets re-geocoded once every
// GEOCODE_CACHE_DAYS.
const CACHE_RETENTION_DAYS = Number(process.env.GEOCODE_CACHE_DAYS) > 0
    ? Number(process.env.GEOCODE_CACHE_DAYS)
    : 180;

// Pure: takes rows, returns the ids to delete. Exported for its own sake so the
// rule is testable without a database — same shape as security.js's
// selectExpiredAuditIds.
//
// Fails toward DELETING, which is the opposite of the login audit's rule and
// correct for the opposite reason: an audit row is evidence and losing it is
// the harm, whereas a cache row is personal data whose loss costs one HTTP
// request. So an unparseable/absent timestamp is treated as expired.
function selectExpiredCacheIds(rows, opts = {}) {
    if (!Array.isArray(rows)) return [];

    const now = opts.now instanceof Date ? opts.now : new Date();
    const days = Number(opts.retentionDays);
    const retentionDays = Number.isFinite(days) && days > 0 ? days : CACHE_RETENTION_DAYS;
    const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;

    const doomed = [];
    for (const row of rows) {
        if (!row || !row.id) continue;
        if ("query" in row) { doomed.push(row.id); continue; } // legacy row carrying an address
        const t = row.at ? new Date(row.at).getTime() : NaN;
        if (!Number.isFinite(t) || t < cutoff) doomed.push(row.id);
    }
    return doomed;
}

// Applies the rule. Best-effort by design — a failing prune must never be able
// to stop the restaurant taking orders, which is why every caller is an
// unref'd interval and every failure is swallowed with a log.
function prune(now = new Date()) {
    try {
        const expired = selectExpiredCacheIds(db.list(GEOCACHE_COLLECTION), { now });
        for (const id of expired) db.remove(GEOCACHE_COLLECTION, id);
        return expired.length;
    } catch (e) {
        console.error("Geocode cache prune failed:", e.message);
        return 0;
    }
}

module.exports = {
    isEnabled,
    normalizeQuery,
    cacheKey,
    geocode,
    GEOCACHE_COLLECTION,
    CACHE_RETENTION_DAYS,
    selectExpiredCacheIds,
    prune,
};
