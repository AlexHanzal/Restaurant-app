// ============================================================================
// brand.js — loads the optional per-restaurant config file
// (restaurace.config.js at the repo root) and turns it into one frozen
// object plus an HTML token renderer.
//
// See docs/superpowers/specs/2026-08-06-restaurant-config-file-design.md.
//
// THE LOAD-BEARING PROPERTY: when no config file exists, BRAND_DEFAULTS
// below reproduces the values that used to be hardcoded in server.js,
// src/html/*.html, src/css/design.css and src/manifest.json — byte for
// byte. That is what lets an existing installation upgrade to this release
// without a config file and notice nothing, and what lets the whole
// existing test suite keep passing untouched. If you change a default here,
// you are changing behaviour for every install that has no config file.
//
// Same "black box" module pattern as settings.js/validation.js: the only
// thing it requires from the rest of the app is settings.mergeDefaults.
// ============================================================================

const path = require("path");
const { mergeDefaults } = require("./settings");
// Shared with server.js. brand.js must stay loadable without pulling in the
// whole server (unit tests require it directly, and server.js requires
// brand.js — importing back would be a cycle), so the escaper lives in its
// own tiny module rather than being copied into both.
const { escapeHtml } = require("./html-escape");

// Absolute path of the config file. RESTAURANT_CONFIG exists so smoke tests
// can point at a temp file instead of writing into the real repo root (the
// harness spawns the server with cwd = repo root), and so one machine can
// host several instances from one checkout.
const CONFIG_PATH = process.env.RESTAURANT_CONFIG
    ? path.resolve(process.env.RESTAURANT_CONFIG)
    : path.join(process.cwd(), "restaurace.config.js");

// ── DEFAULTS = TODAY'S HARDCODED VALUES ─────────────────────────────────
// `defaults` is deliberately NOT a copy of settings.js's DEFAULT_SETTINGS.
// It holds only the subset an installer would plausibly want to preset;
// anything absent here falls through to settings.js's own defaults when the
// seed happens (see server.js initializeData). Duplicating the full
// settings shape in two files is exactly how the two drift apart.
const BRAND_DEFAULTS = {
    brand: {
        name: "Restaurace",
        wordmark: "Restaurace",
        accent: "#e30613",
        accentHover: "#c00511",
        accentSoft: "#fdeaea",
        pwa: {
            name: "Pokladna — restaurace",
            shortName: "Pokladna",
            themeColor: "#111111",
            iconLetter: "č",
        },
    },
    business: {
        name: "Ukázková restaurace s.r.o.",
        ico: "12345678",
        dic: "CZ12345678",
        address: "Náměstí Svobody 1, 602 00 Brno",
        email: "",
        phone: "",
        vatPayer: false,
        termsEffectiveDate: "",
    },
    features: {
        reservations: true,
        delivery: true,
        tableOrdering: true,
        pos: true,
        dailyMenu: true,
        eet: true,
    },
    defaults: {
        delivery: {
            fee: 49,
            minOrder: 200,
            freeAbove: 600,
            pscWhitelist: ["12000", "12800"],
            etaMinutes: 60,
        },
        dailyMenu: { from: "11:00", to: "14:00" },
    },
    server: { basePath: "/reservation" },
};

// ── LOAD ─────────────────────────────────────────────────────────────────

let loaded = false;
let raw = {};
try {
    raw = require(CONFIG_PATH);
    loaded = true;
} catch (err) {
    // MODULE_NOT_FOUND for THIS path means "no config file", which is a
    // supported state. Anything else — a syntax error, a throw inside the
    // file, a missing require of its own — is a real problem the operator
    // must see, not something to swallow into silent defaults.
    //
    // Checking `err.message.includes(CONFIG_PATH)` is NOT enough: Node's
    // MODULE_NOT_FOUND message ends with a "Require stack:" trailer that
    // lists every file in the chain, INCLUDING the file that did the
    // (failing) require. So when CONFIG_PATH exists and itself does
    // `require("./something-missing")`, CONFIG_PATH still appears in that
    // trailer and the substring check would wrongly classify a broken
    // config as "no config file", silently booting on hardcoded defaults.
    //
    // `err.requireStack` is the fix: it lists only modules that were
    // successfully RESOLVED and had already started executing before the
    // failing require call — the module that itself failed to resolve is
    // never a member of that array (confirmed against Node 26 directly: a
    // missing CONFIG_PATH produces requireStack = [callers of brand.js],
    // never containing CONFIG_PATH; a missing require INSIDE an existing
    // CONFIG_PATH produces requireStack = [CONFIG_PATH, ...], since
    // CONFIG_PATH had already been entered). So "no config file" is
    // precisely: CONFIG_PATH does NOT appear anywhere in requireStack.
    const missing = err && err.code === "MODULE_NOT_FOUND"
        && Array.isArray(err.requireStack)
        && !err.requireStack.includes(CONFIG_PATH);
    if (!missing) {
        throw new Error(
            `Konfigurační soubor restaurace se nepodařilo načíst (${CONFIG_PATH}): ${err.message}`
        );
    }
}

if (raw && typeof raw !== "object") {
    throw new Error(`Konfigurační soubor restaurace musí exportovat objekt (${CONFIG_PATH}).`);
}

// `brand`, `business`, `features` and `server` are merged against the fixed
// shape above — an unknown key there is a typo and dropping it is right.
//
// `defaults` is merged PERMISSIVELY (unknown keys kept), because it is not
// this module's shape to police: it is an overlay onto settings.js's
// DEFAULT_SETTINGS, which is much larger than the handful of fields worth
// pre-filling here. An installer who wants to preset reservations.days or
// notifications must be able to, and settings.js's own mergeDefaults drops
// anything genuinely bogus at seed time (see initializeData in server.js).
// Merging it against BRAND_DEFAULTS.defaults instead would silently discard
// those keys, and a silently discarded setting is the worst outcome of all.
function deepMergePermissive(base, overlay) {
    if (!overlay || typeof overlay !== "object" || Array.isArray(overlay)) {
        return overlay === undefined ? base : overlay;
    }
    const out = { ...base };
    for (const [key, value] of Object.entries(overlay)) {
        const prev = out[key];
        out[key] = (prev && typeof prev === "object" && !Array.isArray(prev))
            ? deepMergePermissive(prev, value)
            : value;
    }
    return out;
}

const { defaults: rawDefaults, ...rawRest } = raw || {};
const config = mergeDefaults(BRAND_DEFAULTS, rawRest);
config.defaults = deepMergePermissive(BRAND_DEFAULTS.defaults, rawDefaults);

// ── VALIDATION ───────────────────────────────────────────────────────────
// Every failure aborts the boot. A restaurant discovering a typo'd hex
// colour at 19:00 on a Friday is worse than a server that refuses to start
// at deploy time with the field name in the message.

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const ICO_RE = /^\d{8}$/;
const DIC_RE = /^CZ\d{8,10}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PSC_RE = /^\d{5}$/;

function fail(field, expectation, got) {
    throw new Error(
        `Chyba v konfiguračním souboru restaurace (${CONFIG_PATH}):\n` +
        `  pole "${field}" — ${expectation}\n` +
        `  nalezeno: ${JSON.stringify(got)}`
    );
}

function requireHex(field, value) {
    if (typeof value !== "string" || !HEX_RE.test(value)) {
        fail(field, "očekává barvu ve tvaru #rgb nebo #rrggbb", value);
    }
}

function requireNonEmpty(field, value) {
    if (typeof value !== "string" || value.trim() === "") {
        fail(field, "nesmí být prázdné", value);
    }
}

function requireWholeNonNegative(field, value) {
    if (!Number.isInteger(value) || value < 0) {
        fail(field, "očekává celé nezáporné číslo", value);
    }
}

requireNonEmpty("brand.name", config.brand.name);
requireNonEmpty("brand.wordmark", config.brand.wordmark);
requireHex("brand.accent", config.brand.accent);
requireHex("brand.accentHover", config.brand.accentHover);
requireHex("brand.accentSoft", config.brand.accentSoft);
requireHex("brand.pwa.themeColor", config.brand.pwa.themeColor);
requireNonEmpty("brand.pwa.name", config.brand.pwa.name);
requireNonEmpty("brand.pwa.shortName", config.brand.pwa.shortName);
if (typeof config.brand.pwa.iconLetter !== "string"
    || [...config.brand.pwa.iconLetter].length !== 1) {
    fail("brand.pwa.iconLetter", "očekává právě jeden znak", config.brand.pwa.iconLetter);
}

const basePath = config.server.basePath;
if (typeof basePath !== "string" || !basePath.startsWith("/")) {
    fail("server.basePath", "musí začínat lomítkem (např. \"/reservation\")", basePath);
}
if (basePath.length > 1 && basePath.endsWith("/")) {
    fail("server.basePath", "nesmí končit lomítkem", basePath);
}

requireNonEmpty("business.name", config.business.name);
requireNonEmpty("business.address", config.business.address);
if (!ICO_RE.test(String(config.business.ico))) {
    fail("business.ico", "očekává 8 číslic", config.business.ico);
}
if (config.business.dic !== "" && !DIC_RE.test(String(config.business.dic))) {
    fail("business.dic", "očekává prázdný řetězec nebo CZ + 8 až 10 číslic", config.business.dic);
}
if (config.business.termsEffectiveDate !== ""
    && !DATE_RE.test(String(config.business.termsEffectiveDate))) {
    fail("business.termsEffectiveDate", "očekává prázdný řetězec nebo datum RRRR-MM-DD",
        config.business.termsEffectiveDate);
}
if (typeof config.business.vatPayer !== "boolean") {
    fail("business.vatPayer", "očekává true nebo false", config.business.vatPayer);
}

for (const [name, value] of Object.entries(config.features)) {
    if (typeof value !== "boolean") {
        fail(`features.${name}`, "očekává true nebo false", value);
    }
}
if (!Object.values(config.features).some(Boolean)) {
    fail("features", "aspoň jedna funkce musí být zapnutá", config.features);
}

const dd = config.defaults.delivery;
requireWholeNonNegative("defaults.delivery.fee", dd.fee);
requireWholeNonNegative("defaults.delivery.minOrder", dd.minOrder);
requireWholeNonNegative("defaults.delivery.freeAbove", dd.freeAbove);
requireWholeNonNegative("defaults.delivery.etaMinutes", dd.etaMinutes);
if (!Array.isArray(dd.pscWhitelist) || dd.pscWhitelist.some(p => typeof p !== "string" || !PSC_RE.test(p))) {
    fail("defaults.delivery.pscWhitelist", "očekává pole PSČ jako řetězců o 5 číslicích", dd.pscWhitelist);
}

// ── FREEZE ───────────────────────────────────────────────────────────────
// Deep, so a route handler cannot mutate shared config for every later
// request. Frozen AFTER validation so validation reads a plain object.

function deepFreeze(obj) {
    for (const value of Object.values(obj)) {
        if (value && typeof value === "object" && !Object.isFrozen(value)) deepFreeze(value);
    }
    return Object.freeze(obj);
}
deepFreeze(config);

// ── TOKENS ───────────────────────────────────────────────────────────────

// Tokens inserted verbatim, without HTML escaping. BRAND_STYLE is the only
// one: it IS markup by construction, and every value interpolated into it
// has already been validated against HEX_RE above, so nothing attacker- or
// even typo-controlled can reach it.
//
// Kept module-private and exposed only through isRawToken() below rather
// than exported directly: a Set is mutable even when the module that owns
// it is not, and Object.freeze() on a Set does not stop .add()/.delete()
// anyway. Exporting it live would let any later consumer add a name to the
// unescaped list and silently change HTML escaping for the whole process.
const RAW_TOKEN_NAMES = new Set(["BRAND_STYLE"]);

function isRawToken(name) {
    return RAW_TOKEN_NAMES.has(name);
}

function brandStyleTag() {
    return `<style>:root{`
        + `--ds-accent:${config.brand.accent};`
        + `--ds-accent-hover:${config.brand.accentHover};`
        + `--ds-accent-soft:${config.brand.accentSoft};`
        + `--ds-warn-ink:${config.brand.accent};`
        + `--ds-danger:${config.brand.accent};`
        + `}</style>`;
}

// The page a "back to the app" link should point at, given which features
// are on. Used by {{HOME}} in the three legal templates, whose links used
// to hardcode /reservation/app — a 404 when reservations are switched off.
function homePath() {
    if (config.features.reservations) return `${basePath}/app`;
    if (config.features.delivery) return `${basePath}/delivery`;
    return `${basePath}/admin`;
}

function tokenValues() {
    return {
        BRAND_NAME: config.brand.name,
        WORDMARK: config.brand.wordmark,
        BASE: basePath,
        HOME: homePath(),
        BRAND_STYLE: brandStyleTag(),
        PWA_NAME: config.brand.pwa.name,
        PWA_SHORT_NAME: config.brand.pwa.shortName,
        PWA_THEME_COLOR: config.brand.pwa.themeColor,
        PWA_ICON_LETTER: config.brand.pwa.iconLetter,
    };
}

// Replaces {{TOKEN}} occurrences. An unknown token is left EXACTLY as it
// was rather than blanked — that can only come from a typo in a template,
// and a visible "{{NEZNAMY}}" makes the bug obvious instead of hiding it.
// Same convention as renderLegalTemplate() in server.js.
function renderTokens(rawHtml, extraTokens) {
    const tokens = { ...tokenValues(), ...(extraTokens || {}) };
    return String(rawHtml).replace(/\{\{(\w+)\}\}/g, (match, key) => {
        if (!Object.prototype.hasOwnProperty.call(tokens, key)) return match;
        return isRawToken(key) ? tokens[key] : escapeHtml(tokens[key]);
    });
}

function isEnabled(name) {
    return config.features[name] === true;
}

module.exports = {
    config,
    loaded,
    CONFIG_PATH,
    isRawToken,
    isEnabled,
    tokenValues,
    renderTokens,
    homePath,
};
