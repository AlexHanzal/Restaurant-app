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
            id: key, query, lat: null, lon: null, quality: "", provider: "nominatim",
            at, failCount: (cached && cached.failCount ? cached.failCount : 0) + 1,
        });
        return null;
    }

    const record = { id: key, query, lat: found.lat, lon: found.lon, quality: found.quality, provider: "nominatim", at, failCount: 0 };
    db.set(GEOCACHE_COLLECTION, key, record);
    return { lat: found.lat, lon: found.lon, quality: found.quality, provider: "nominatim", at };
}

module.exports = { isEnabled, normalizeQuery, cacheKey, geocode, GEOCACHE_COLLECTION };
