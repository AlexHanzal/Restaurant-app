# Restaurant Config File Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse every non-secret per-restaurant value into one root-level `restaurace.config.js`, so deploying to a new restaurant means filling in one file instead of editing four places.

**Architecture:** A new `src/server/brand.js` loads + validates the optional config file at boot and exposes a frozen object plus an HTML token renderer. `server.js` reads `basePath`, `business` and feature flags from it, renders all 8 HTML pages plus `config.js` and `manifest.json` through the token renderer (generalising the `{{TOKEN}}` machinery the 3 legal pages already use), gates page/API routes on feature flags, and seeds `settings` from `config.defaults` only when the DB has no settings record.

**Tech Stack:** Node 22–26, Express 5, better-sqlite3, `node:test`, no build step, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-06-restaurant-config-file-design.md`

## Global Constraints

- **No new npm dependencies.** Zero. The repo ships without a build step and that must stay true.
- **Absent config file = today's exact behaviour.** Every built-in default in `brand.js` must reproduce the current hardcoded value byte-for-byte. This is the property that keeps existing deploys and the whole existing test suite unaffected. **One intentional exception:** page `<title>`s gain a ` — {{BRAND_NAME}}` suffix for everyone, config file or not (owner decision, 2026-08-06). Nothing else may change.
- **`escapeHtml` lives in exactly one place.** `src/server/html-escape.js`. Never copy it — `server.js` and `brand.js` both require it.
- **No secrets in the config file.** `JWT_SECRET`, Twilio, SMTP, GoPay and EET credentials stay in `.env`. Nothing in `brand.js` may read them.
- **UI text is Czech.** Every user-facing string, every validation error message, and every comment in `restaurace.config.example.js` is Czech. Code comments in `src/` stay English, matching the repo.
- **Classic `<script>` tags share one global lexical environment.** Two files declaring the same top-level `const` is a SyntaxError that silently kills the second file. Anything added to `src/config.js` must not collide with `renderer.js`/`inner.js`/`delivery.js` top-level names.
- **CSP:** `script-src 'self'` + one hash, **no** `'unsafe-inline'`. Never plan an inline `<script>`. `style-src` does include `'unsafe-inline'`, so an inline `<style>` is fine.
- **API rejections for disabled features are 404, never 403.**
- **Tests:** `npm run test:unit` and `npm run test:smoke` (glob form required — bare `node --test <dir>` fails with MODULE_NOT_FOUND on Node 26).
- **Git:** this repo lives in OneDrive; `git config windows.appendAtomically false` is already set locally. Commit author is `Alex Hanzal <alexhanzal@example.com>`, set repo-locally.

## File Structure

| File | Responsibility |
|---|---|
| `restaurace.config.example.js` (new) | The committed, fully-filled template. Czech comments over every field. Never loaded by the app. |
| `src/server/brand.js` (new) | Load → merge → validate → freeze. Exports the config object, `renderTokens(rawHtml)`, `tokenValues()`, `isEnabled(feature)`. Depends only on `settings.mergeDefaults`. |
| `tests/unit/brand.test.js` (new) | Unit tests for merge, every validation rule, freezing, absent file. |
| `tests/smoke/features.test.js` (new) | Boots a real server with a temp config file; asserts disabled features 404 and enabled ones still work. |
| `src/server/server.js` | Consumes brand.js: `basePath`, `business`, one generic page-route factory, feature middleware, settings seeding, `config.js`/`manifest.json` routes. |
| `src/config.js` | Becomes a token template; gains `window.APP_FEATURES` / `window.APP_BRAND`. |
| `src/manifest.json` | Becomes a token template. |
| `src/html/*.html` (8) | Wordmark, `<title>`, `/reservation/` → `{{BASE}}`, `{{BRAND_STYLE}}` in `<head>`. |
| `src/js/inner.js` | Hides `[data-feature]` nav tabs for disabled features. |
| `.gitignore`, `.env.example`, `README.md` | Ignore the real config file; document the move. |

## Task Order Rationale

Task 1 builds `brand.js` standalone with unit tests — nothing else depends on it yet, so it can be reviewed on its own. Task 2 wires branding into HTML (visible, testable, no behaviour change). Task 3 wires the browser channel (`config.js`, `manifest.json`). Task 4 adds feature gating (the only task that changes what the server accepts). Task 5 adds settings seeding. Task 6 writes the example file and docs. Each task ends green.

---

### Task 1: The config loader — `src/server/brand.js`

**Files:**
- Create: `src/server/html-escape.js`
- Create: `src/server/brand.js`
- Modify: `src/server/server.js` (delete its local `escapeHtml`, require the shared one)
- Test: `tests/unit/brand.test.js`

**Interfaces:**
- Consumes: `require("./settings").mergeDefaults(defaults, value)` — already exported from `src/server/settings.js`, deep-merges `value` over `defaults` keeping `defaults`' shape (arrays replaced wholesale, unknown keys dropped).
- Produces, for every later task:
  - `brand.config` — frozen object, shape identical to `BRAND_DEFAULTS` below.
  - `brand.isEnabled(name: string): boolean`
  - `brand.tokenValues(): { [token: string]: string }`
  - `brand.renderTokens(rawHtml: string, extraTokens?: object): string`
  - `brand.isRawToken(name: string): boolean` — true for tokens inserted without HTML escaping (currently only `BRAND_STYLE`).
  - `brand.CONFIG_PATH: string` — resolved absolute path that was attempted.
  - `brand.loaded: boolean` — whether a config file was actually found.

- [ ] **Step 1: Write the failing test file**

Create `tests/unit/brand.test.js`:

```js
// ============================================================================
// brand.test.js — unit tests for src/server/brand.js, the per-restaurant
// config loader. Every test points RESTAURANT_CONFIG at a throwaway file in
// os.tmpdir() and re-requires the module with a cleared require cache, so no
// test can see another's config and none of them touch the real repo root.
// ============================================================================

// REQUIRED: CommonJS modules are sloppy-mode by default, where assigning to
// a frozen property fails SILENTLY instead of throwing. Without this the
// "deeply frozen" test below would pass whether or not anything is frozen.
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const BRAND_PATH = require.resolve("../../src/server/brand.js");

// Writes `source` to a temp .js file, points RESTAURANT_CONFIG at it, and
// loads a FRESH copy of brand.js. Pass null to test the "no config file"
// path. Returns the module.
function loadBrand(source) {
    const unique = `${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    const file = path.join(os.tmpdir(), `brand-test-${unique}.js`);
    if (source === null) {
        // A path that deliberately does not exist.
        process.env.RESTAURANT_CONFIG = file;
    } else {
        fs.writeFileSync(file, source, "utf8");
        process.env.RESTAURANT_CONFIG = file;
    }
    delete require.cache[BRAND_PATH];
    try {
        return require(BRAND_PATH);
    } finally {
        try { fs.unlinkSync(file); } catch { /* never existed */ }
    }
}

test.afterEach(() => {
    delete process.env.RESTAURANT_CONFIG;
    delete require.cache[BRAND_PATH];
});

test("no config file falls back to today's hardcoded values", () => {
    const brand = loadBrand(null);
    assert.strictEqual(brand.loaded, false);
    assert.strictEqual(brand.config.brand.wordmark, "Restaurace");
    assert.strictEqual(brand.config.brand.accent, "#e30613");
    assert.strictEqual(brand.config.server.basePath, "/reservation");
    assert.strictEqual(brand.config.business.name, "Ukázková restaurace s.r.o.");
    assert.strictEqual(brand.config.features.delivery, true);
});

test("a partial config merges over the defaults", () => {
    const brand = loadBrand(`module.exports = {
        brand: { wordmark: "U Kalicha" },
        features: { delivery: false },
    };`);
    assert.strictEqual(brand.loaded, true);
    assert.strictEqual(brand.config.brand.wordmark, "U Kalicha");
    // Untouched keys keep the default.
    assert.strictEqual(brand.config.brand.accent, "#e30613");
    assert.strictEqual(brand.config.features.delivery, false);
    assert.strictEqual(brand.config.features.reservations, true);
});

test("defaults keeps keys brand.js knows nothing about", () => {
    // settings.js owns the full settings shape; brand.js must not silently
    // drop a field an installer legitimately wants to preset.
    const brand = loadBrand(`module.exports = { defaults: {
        reservations: { days: { "0": { open: false, fromHour: 1, toHour: 12 } } },
        notifications: { smsReservationReminder: true },
        delivery: { fee: 59 },
    } };`);
    assert.strictEqual(brand.config.defaults.reservations.days["0"].open, false);
    assert.strictEqual(brand.config.defaults.notifications.smsReservationReminder, true);
    assert.strictEqual(brand.config.defaults.delivery.fee, 59);
    // Siblings the config file said nothing about keep brand.js's defaults.
    assert.strictEqual(brand.config.defaults.delivery.minOrder, 200);
    assert.strictEqual(brand.config.defaults.dailyMenu.from, "11:00");
});

test("the exported config is deeply frozen", () => {
    const brand = loadBrand(null);
    assert.throws(() => { brand.config.brand.wordmark = "x"; }, TypeError);
    assert.throws(() => { brand.config.features.delivery = false; }, TypeError);
});

test("isEnabled reads the feature flags", () => {
    const brand = loadBrand(`module.exports = { features: { delivery: false } };`);
    assert.strictEqual(brand.isEnabled("delivery"), false);
    assert.strictEqual(brand.isEnabled("reservations"), true);
    assert.strictEqual(brand.isEnabled("nonexistent"), false);
});

test("renderTokens substitutes and HTML-escapes values", () => {
    const brand = loadBrand(`module.exports = { brand: { wordmark: "Kalich & Syn" } };`);
    const out = brand.renderTokens(`<span>{{WORDMARK}}</span>`);
    assert.strictEqual(out, `<span>Kalich &amp; Syn</span>`);
});

test("renderTokens leaves BRAND_STYLE unescaped", () => {
    const brand = loadBrand(`module.exports = { brand: { accent: "#1a5c3a" } };`);
    const out = brand.renderTokens(`<head>{{BRAND_STYLE}}</head>`);
    assert.ok(out.includes("<style>"), "expected a real <style> element");
    assert.ok(out.includes("#1a5c3a"), "expected the accent colour inline");
    assert.ok(!out.includes("&lt;style"), "BRAND_STYLE must not be escaped");
});

test("renderTokens leaves an unknown token untouched", () => {
    const brand = loadBrand(null);
    assert.strictEqual(brand.renderTokens("{{NEZNAMY}}"), "{{NEZNAMY}}");
});

test("extraTokens override and extend the built-in set", () => {
    const brand = loadBrand(null);
    const out = brand.renderTokens("{{PAGE_TITLE}}", { PAGE_TITLE: "Rozvoz" });
    assert.strictEqual(out, "Rozvoz");
});

// ── VALIDATION ───────────────────────────────────────────────────────────
// Each bad value must throw, and the message must name the offending field
// so whoever edited the file knows where to look.

const BAD = [
    ["brand.accent", `module.exports = { brand: { accent: "green" } };`],
    ["brand.accentHover", `module.exports = { brand: { accentHover: "#12" } };`],
    ["brand.wordmark", `module.exports = { brand: { wordmark: "   " } };`],
    ["brand.pwa.iconLetter", `module.exports = { brand: { pwa: { iconLetter: "abc" } } };`],
    ["server.basePath", `module.exports = { server: { basePath: "reservation" } };`],
    ["server.basePath", `module.exports = { server: { basePath: "/reservation/" } };`],
    ["business.ico", `module.exports = { business: { ico: "123" } };`],
    ["business.dic", `module.exports = { business: { dic: "12345678" } };`],
    ["business.termsEffectiveDate", `module.exports = { business: { termsEffectiveDate: "1. 9. 2026" } };`],
    ["features", `module.exports = { features: { reservations: false, delivery: false,
        tableOrdering: false, pos: false, dailyMenu: false, eet: false } };`],
    ["defaults.delivery.pscWhitelist", `module.exports = { defaults: { delivery: { pscWhitelist: [12000] } } };`],
    ["defaults.delivery.fee", `module.exports = { defaults: { delivery: { fee: -1 } } };`],
    ["defaults.delivery.etaMinutes", `module.exports = { defaults: { delivery: { etaMinutes: 1.5 } } };`],
];

for (const [field, source] of BAD) {
    test(`rejects a bad ${field}`, () => {
        assert.throws(() => loadBrand(source), (err) => {
            assert.ok(err.message.includes(field.split(".").pop()),
                `message should name "${field}", got: ${err.message}`);
            return true;
        });
    });
}

test("accepts an empty dic and an empty termsEffectiveDate", () => {
    const brand = loadBrand(`module.exports = {
        business: { dic: "", termsEffectiveDate: "" },
    };`);
    assert.strictEqual(brand.config.business.dic, "");
});

test("accepts a 3-digit hex accent", () => {
    const brand = loadBrand(`module.exports = { brand: { accent: "#0a0" } };`);
    assert.strictEqual(brand.config.brand.accent, "#0a0");
});

test("a config file that throws on require is reported with its path", () => {
    assert.throws(
        () => loadBrand(`throw new Error("boom");`),
        (err) => {
            assert.ok(err.message.includes("restaurace"), "should name the config file");
            return true;
        }
    );
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm run test:unit
```

Expected: FAIL — `Cannot find module '../../src/server/brand.js'`.

- [ ] **Step 3: Extract the shared HTML escaper**

Create `src/server/html-escape.js`, moving the function **verbatim** from `src/server/server.js:1681` — do not retype it, do not "improve" it, and do not change its null handling:

```js
// ============================================================================
// html-escape.js — the one HTML escaper this app uses.
//
// Lived inline in server.js until brand.js needed it too. brand.js cannot
// require server.js (server.js requires brand.js — that's a cycle) and unit
// tests require brand.js directly without booting a server, so the function
// moved into its own zero-dependency module rather than being copied into
// both and left to drift.
// ============================================================================

function escapeHtml(str) {
    return String(str == null ? "" : str).replace(/[&<>"']/g, ch => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[ch]));
}

module.exports = { escapeHtml };
```

In `src/server/server.js`, delete the local `function escapeHtml(str) {...}` (line ~1681) and add to the require block near the top:

```js
const { escapeHtml } = require("./html-escape");
```

Every existing call site keeps working unchanged — same name, same signature, same behaviour.

- [ ] **Step 4: Write `src/server/brand.js`**

```js
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
    const missing = err && err.code === "MODULE_NOT_FOUND" && err.message.includes(CONFIG_PATH);
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
const RAW_TOKENS = new Set(["BRAND_STYLE"]);

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
        return RAW_TOKENS.has(key) ? tokens[key] : escapeHtml(tokens[key]);
    });
}

function isEnabled(name) {
    return config.features[name] === true;
}

module.exports = {
    config,
    loaded,
    CONFIG_PATH,
    RAW_TOKENS,
    isEnabled,
    tokenValues,
    renderTokens,
    homePath,
};
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
npm run test:unit
```

Expected: PASS — all existing unit tests plus the ~26 new `brand.test.js` cases.

- [ ] **Step 6: Confirm the rest of the suite is untouched**

```bash
npm run test:smoke
```

Expected: PASS, unchanged. `brand.js` is not required by anything yet; the escaper move is behaviour-neutral.

- [ ] **Step 7: Commit**

```bash
git add src/server/html-escape.js src/server/brand.js src/server/server.js tests/unit/brand.test.js
git commit -m "feat(config): load and validate an optional per-restaurant config file"
```

---

### Task 2: Render branding into the 8 HTML pages

**Files:**
- Modify: `src/server/server.js` (page route factory, static block list, `SERVER_CONFIG.basePath`, `SERVER_CONFIG.business`)
- Modify: `src/html/index.html`, `delivery.html`, `driver.html`, `kitchen.html`, `inner.html`, `table.html`, `obchodni-podminky.html`, `ochrana-osobnich-udaju.html`, `reklamace.html`

**Interfaces:**
- Consumes: `brand.renderTokens`, `brand.config.server.basePath`, `brand.config.business` from Task 1.
- Produces: `makePageRoute(filename, extraTokens?)` inside `setupFrontendRoutes()`, replacing the five near-identical `*HtmlRoute` handlers and `makeLegalPageRoute`.

**Context you need:** `src/server/server.js` already has this machinery for the 3 legal pages — `loadLegalTemplate()` (caches the raw file read), `renderLegalTemplate()` (regex `{{TOKEN}}` replace, escapes values, leaves unknown tokens alone), `makeLegalPageRoute()`, and `blockRawLegalTemplate` (404s the raw template at `${base}/html/<file>` so `express.static` cannot serve an un-rendered page). This task generalises all four to cover every page. Do not invent a second mechanism.

- [ ] **Step 1: Point `SERVER_CONFIG` at brand.js**

Near the top of `src/server/server.js`, after the `timezone` require (~line 22), add:

```js
// Per-restaurant config file (docs/superpowers/specs/
// 2026-08-06-restaurant-config-file-design.md). Absent file = the values
// that used to be hardcoded right here, so this require changes nothing for
// an installation that has no restaurace.config.js.
const brand = require("./brand");
```

Then change `SERVER_CONFIG.basePath` (~line 26) from:

```js
    basePath: "/reservation",
```

to:

```js
    basePath: brand.config.server.basePath,
```

And change the `business` block (~lines 108-114) from the `process.env.BUSINESS_* || "literal"` form to config-with-env-override:

```js
    // The literals that used to sit here now live in brand.js's
    // BRAND_DEFAULTS, so an installation with a restaurace.config.js sets
    // them there. BUSINESS_* env vars still win when present — existing
    // deploys that set them keep working unchanged.
    business: {
        name: process.env.BUSINESS_NAME || brand.config.business.name,
        ico: process.env.BUSINESS_ICO || brand.config.business.ico,
        dic: process.env.BUSINESS_DIC || brand.config.business.dic,
        address: process.env.BUSINESS_ADDRESS || brand.config.business.address,
        vatPayer: process.env.BUSINESS_VAT_PAYER
            ? process.env.BUSINESS_VAT_PAYER === "true"
            : brand.config.business.vatPayer,
    },
```

- [ ] **Step 2: Generalise the template machinery in `setupFrontendRoutes()`**

Rename `legalTemplateCache` → `htmlTemplateCache` and `loadLegalTemplate` → `loadHtmlTemplate` (body unchanged — it already probes both `frontendPath/<file>` and `frontendPath/html/<file>`).

Replace `renderLegalTemplate()` and `makeLegalPageRoute()` with:

```js
    // One renderer for every page. Brand tokens (WORDMARK, BASE,
    // BRAND_STYLE, …) come from brand.js and are fixed for the process
    // lifetime; the business tokens below are read from settings PER
    // REQUEST, because the owner can change them in admin Nastavení and the
    // legal pages must reflect that immediately with no restart. That's why
    // the rendered output is never cached — only the raw file read is.
    function renderPage(rawHtml, extraTokens) {
        const biz = settingsStore.getSettings().business || {};
        const effectiveDate = (biz.termsEffectiveDate && String(biz.termsEffectiveDate).trim())
            || new Date().toLocaleDateString("cs-CZ", { day: "numeric", month: "numeric", year: "numeric" });
        return brand.renderTokens(rawHtml, {
            NAZEV: biz.name || "",
            ICO: biz.ico || "",
            DIC: biz.dic || "",
            ADRESA: biz.address || "",
            EMAIL: biz.email || "",
            TELEFON: biz.phone || "",
            EFFECTIVE_DATE: effectiveDate,
            ...(extraTokens || {}),
        });
    }

    function makePageRoute(filename, extraTokens) {
        return async (req, res) => {
            const rawHtml = await loadHtmlTemplate(filename);
            if (rawHtml == null) return res.status(404).send("Stránka nenalezena");
            res.set("Content-Type", "text/html; charset=utf-8");
            res.send(renderPage(rawHtml, extraTokens));
        };
    }
```

Delete `innerHtmlRoute`, `deliveryHtmlRoute`, `tableHtmlRoute`, `driverHtmlRoute` and `kitchenHtmlRoute` (five ~9-line functions that differed only by filename) and replace their declarations with:

```js
    const innerHtmlRoute = makePageRoute("inner.html");
    const deliveryHtmlRoute = makePageRoute("delivery.html");
    const tableHtmlRoute = makePageRoute("table.html");
    const driverHtmlRoute = makePageRoute("driver.html");
    const kitchenHtmlRoute = makePageRoute("kitchen.html");
    const indexHtmlRoute = makePageRoute("index.html");
```

- [ ] **Step 3: Route `/app` through the renderer and widen the raw-template block**

Both branches of the `if (SERVER_CONFIG.serveFrontend)` block near the end of `setupFrontendRoutes()` currently do:

```js
        app.get(`${base}/app`, (req, res) => res.sendFile(path.join(frontendPath, "html", "index.html")));
```

Change both to:

```js
        app.get(`${base}/app`, indexHtmlRoute);
```

(the second branch, with no base prefix, becomes `app.get("/app", indexHtmlRoute);`)

Then widen the block list. Change:

```js
    const legalTemplateFileNames = ["obchodni-podminky.html", "ochrana-osobnich-udaju.html", "reklamace.html"];
    const blockRawLegalTemplate = (req, res) => res.status(404).send("Stránka nenalezena");
```

to:

```js
    // Every page is now a {{TOKEN}} template, and src/html/ is served
    // wholesale by express.static below — so without this block the RAW,
    // un-rendered page (literal "{{WORDMARK}}" on screen) would be
    // reachable at .../html/<file> alongside the real rendered route.
    // Registered before express.static, so it wins.
    const templateFileNames = [
        "index.html", "inner.html", "delivery.html", "driver.html",
        "kitchen.html", "table.html",
        "obchodni-podminky.html", "ochrana-osobnich-udaju.html", "reklamace.html",
    ];
    const blockRawTemplate = (req, res) => res.status(404).send("Stránka nenalezena");
```

and update both `for (const filename of legalTemplateFileNames)` loops to iterate `templateFileNames` and use `blockRawTemplate`.

Update `legalPageRoutesByPath` to use the new factory:

```js
    const legalPageRoutesByPath = {
        "/obchodni-podminky": makePageRoute("obchodni-podminky.html"),
        "/ochrana-osobnich-udaju": makePageRoute("ochrana-osobnich-udaju.html"),
        "/reklamace": makePageRoute("reklamace.html"),
    };
```

- [ ] **Step 4: Tokenise the 8 HTML files**

In **every** file under `src/html/`, make these four replacements:

1. `<span class="ds-wordmark">Restaurace</span>` → `<span class="ds-wordmark">{{WORDMARK}}</span>` (present in all but `inner.html`; `driver.html` has it **twice**, at lines 16 and 33)
2. Every `/reservation/` in an `href`/`src` attribute → `{{BASE}}/` (e.g. `href="/reservation/css/design.css"` → `href="{{BASE}}/css/design.css"`)
3. Insert `{{BRAND_STYLE}}` as the **last** element inside `<head>`, so it overrides `design.css`'s `:root` block
4. Append the brand name to `<title>`

The `<title>` replacements, exactly:

| File | From | To |
|---|---|---|
| `index.html` | `<title>Rezervace stolu</title>` | `<title>Rezervace stolu — {{BRAND_NAME}}</title>` |
| `delivery.html` | `<title>Rozvoz — Jídelní lístek</title>` | `<title>Rozvoz — {{BRAND_NAME}}</title>` |
| `driver.html` | `<title>Rozvoz — Řidiči</title>` | `<title>Rozvoz — Řidiči — {{BRAND_NAME}}</title>` |
| `kitchen.html` | `<title>Kuchyně — Objednávky</title>` | `<title>Kuchyně — {{BRAND_NAME}}</title>` |
| `inner.html` | `<title>Správa stolů — Přehled</title>` | `<title>Správa stolů — {{BRAND_NAME}}</title>` |
| `table.html` | `<title>Objednávka u stolu</title>` | `<title>Objednávka u stolu — {{BRAND_NAME}}</title>` |
| `obchodni-podminky.html` | `<title>Obchodní podmínky</title>` | `<title>Obchodní podmínky — {{BRAND_NAME}}</title>` |
| `ochrana-osobnich-udaju.html` | `<title>Ochrana osobních údajů</title>` | `<title>Ochrana osobních údajů — {{BRAND_NAME}}</title>` |
| `reklamace.html` | `<title>Reklamační řád</title>` | `<title>Reklamační řád — {{BRAND_NAME}}</title>` |

For `index.html` the head becomes:

```html
    <title>Rezervace stolu — {{BRAND_NAME}}</title>
    <link rel="icon" href="data:,">
    <link rel="stylesheet" href="{{BASE}}/css/design.css">
    <link rel="stylesheet" href="{{BASE}}/css/reservation.css">
    <!-- Floorplan table picking (docs/superpowers/specs/2026-07-27-floorplan-
         table-picking-design.md §5.1/§6.1) — shared module, also loaded by
         inner.html for the admin surfaces. -->
    <link rel="stylesheet" href="{{BASE}}/css/floorplan.css">
    {{BRAND_STYLE}}
</head>
```

- [ ] **Step 5: Fix the legal pages' home links**

In `obchodni-podminky.html`, `ochrana-osobnich-udaju.html` and `reklamace.html`, both `href="/reservation/app"` occurrences per file (lines ~16 and ~165/183/109) become `href="{{HOME}}"` — **not** `{{BASE}}/app`, so the link follows the feature flags added in Task 4.

- [ ] **Step 6: Run the full suite**

```bash
npm run test:unit && npm run test:smoke
```

Expected: PASS. No config file exists, so `{{WORDMARK}}` renders as `Restaurace` and `{{BASE}}` as `/reservation` — byte-identical output to before.

- [ ] **Step 7: Verify by eye**

```bash
node src/server/server.js
```

Open `http://localhost:3000/reservation/app` and confirm: wordmark reads `Restaurace`, the page is styled (CSS loaded via `{{BASE}}`), no literal `{{` anywhere. Then confirm `http://localhost:3000/reservation/html/index.html` returns **404** — the raw template must not be reachable. Stop the server.

- [ ] **Step 8: Commit**

```bash
git add src/server/server.js src/html
git commit -m "feat(config): render every page through the brand token renderer"
```

---

### Task 3: Reach the browser — `config.js` and `manifest.json`

**Files:**
- Modify: `src/config.js`
- Modify: `src/manifest.json`
- Modify: `src/server/server.js` (two new routes, mounted before the minify middleware)

**Interfaces:**
- Consumes: `brand.renderTokens`, `brand.config.features` from Task 1.
- Produces: `window.APP_FEATURES` (`{ reservations, delivery, tableOrdering, pos, dailyMenu, eet }` — all booleans) and `window.APP_BRAND` (`{ name, wordmark }`), available to every page's scripts. Task 4 consumes these in `inner.js`.

**Context you need:** the CSP is `script-src 'self'` plus one hash, with **no** `'unsafe-inline'` — so an inline `<script>` carrying the flags would be blocked by the browser. `src/config.js` is already loaded first by `index.html`, `delivery.html`, `driver.html`, `inner.html`, `kitchen.html` and `table.html`, which makes it the natural carrier. Route ordering matters: `app.use(base, minify.createMinifyMiddleware(frontendPath))` handles every `.js`, so the new `config.js` route must be registered **before** it or the raw template gets served with literal `{{...}}`.

- [ ] **Step 1: Add the feature block to `src/config.js`**

Append to the end of `src/config.js`:

```js
// ============================================================================
// PER-RESTAURANT CONFIG (server-rendered)
// ============================================================================
// The {{TOKEN}} values below are substituted by server.js before this file
// is sent — see src/server/brand.js. This file is NOT loaded from disk by
// the browser as-is; it always goes through the render route.
//
// Why a served file instead of an inline <script>: the CSP is
// script-src 'self' with no 'unsafe-inline', so an inline block carrying
// these values would be blocked. Same reason sw.js gets its __BASE_PATH__
// substituted server-side.
//
// window.* rather than top-level const: classic <script> tags share ONE
// global lexical environment, so a top-level `const APP_FEATURES` here
// would collide with any same-named declaration in renderer.js/inner.js and
// silently kill whichever file loaded second.
window.APP_FEATURES = {{APP_FEATURES_JSON}};
window.APP_BRAND = {{APP_BRAND_JSON}};
```

- [ ] **Step 2: Tokenise `src/manifest.json`**

```json
{
  "name": "{{PWA_NAME}}",
  "short_name": "{{PWA_SHORT_NAME}}",
  "description": "Obsluha stolů a účtenek, funguje i bez připojení k internetu.",
  "start_url": "html/inner.html",
  "scope": "./",
  "display": "standalone",
  "orientation": "any",
  "background_color": "{{PWA_THEME_COLOR}}",
  "theme_color": "{{PWA_THEME_COLOR}}",
  "icons": [
    {
      "src": "{{PWA_ICON_SVG}}",
      "sizes": "any",
      "type": "image/svg+xml",
      "purpose": "any"
    }
  ]
}
```

- [ ] **Step 3: Add both routes in `setupFrontendRoutes()`, before the minify middleware**

Insert immediately before `app.use(base, minify.createMinifyMiddleware(frontendPath));` in **both** branches of the `serveFrontend` block (the second branch drops the `${base}` prefix):

```js
        app.get(`${base}/config.js`, configJsRoute);
        app.get(`${base}/manifest.json`, manifestRoute);
```

and declare them alongside the other page routes:

```js
    // config.js and manifest.json are {{TOKEN}} templates like the HTML
    // pages, but they are not HTML — so they get their own routes with
    // their own Content-Type, mounted BEFORE the minify middleware (which
    // otherwise claims every .js) and before express.static (which
    // otherwise claims manifest.json). Both are rendered once at boot: the
    // tokens they use all come from brand.js, which is fixed for the
    // process lifetime — unlike the HTML pages, which also carry
    // settings-derived business tokens that can change at runtime.
    const featuresJson = JSON.stringify(brand.config.features);
    const appBrandJson = JSON.stringify({
        name: brand.config.brand.name,
        wordmark: brand.config.brand.wordmark,
    });

    let renderedConfigJs = null;
    const configJsRoute = async (req, res) => {
        if (renderedConfigJs == null) {
            const rawJs = await loadHtmlTemplate("config.js");
            if (rawJs == null) return res.status(404).send("// config.js not found");
            // JSON literals, not HTML — brand.renderTokens would escape the
            // quotes into &quot; and produce a syntax error, so these two
            // tokens are substituted directly.
            //
            // SECURITY: the replacement must be a FUNCTION, not a string.
            // String.prototype.replace(regex, stringValue) treats $$, $`,
            // $', $& (and $<n>) inside stringValue as special replacement
            // patterns — regardless of whether the regex has capture groups
            // — so a brand name containing e.g. "$&" would splice the whole
            // match back into the output instead of being inserted literally.
            // A function replacer sidesteps that interpretation entirely.
            // Same pattern as brand.renderTokens / renderPage above.
            renderedConfigJs = rawJs
                .replace(/\{\{APP_FEATURES_JSON\}\}/g, () => featuresJson)
                .replace(/\{\{APP_BRAND_JSON\}\}/g, () => appBrandJson);
        }
        res.set("Content-Type", "application/javascript; charset=utf-8");
        res.set("Cache-Control", "no-cache");
        res.send(renderedConfigJs);
    };

    // The PWA icon is a data: URI holding an SVG with one letter in it, so
    // the letter has to be percent-encoded into the URI rather than dropped
    // in as a token — hence building the whole src here.
    function pwaIconDataUri() {
        const letter = brand.config.brand.pwa.iconLetter;
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">`
            + `<rect width="512" height="512" rx="96" fill="${brand.config.brand.pwa.themeColor}"/>`
            + `<text x="256" y="340" font-size="260" text-anchor="middle" fill="#fff" `
            + `font-family="sans-serif">${letter}</text></svg>`;
        return `data:image/svg+xml,${encodeURIComponent(svg)}`;
    }

    let renderedManifest = null;
    const manifestRoute = async (req, res) => {
        if (renderedManifest == null) {
            const rawJson = await loadHtmlTemplate("manifest.json");
            if (rawJson == null) return res.status(404).json({ error: "manifest not found" });
            // JSON string values, so escape for JSON rather than for HTML.
            const jsonToken = (value) => JSON.stringify(String(value)).slice(1, -1);
            // SECURITY: function replacer, not a string — see the identical
            // note in configJsRoute above. jsonToken()'s output can itself
            // contain "$&" etc. (e.g. a brand name with a literal ampersand
            // preceded by a dollar sign), so passing it as a plain string
            // replacement is exactly as unsafe here as it is for config.js.
            renderedManifest = rawJson
                .replace(/\{\{PWA_NAME\}\}/g, () => jsonToken(brand.config.brand.pwa.name))
                .replace(/\{\{PWA_SHORT_NAME\}\}/g, () => jsonToken(brand.config.brand.pwa.shortName))
                .replace(/\{\{PWA_THEME_COLOR\}\}/g, () => jsonToken(brand.config.brand.pwa.themeColor))
                .replace(/\{\{PWA_ICON_SVG\}\}/g, () => jsonToken(pwaIconDataUri()));
        }
        res.set("Content-Type", "application/manifest+json; charset=utf-8");
        res.send(renderedManifest);
    };
```

- [ ] **Step 4: Point `inner.html`'s manifest link at the token base**

`src/html/inner.html:21` — `<link rel="manifest" href="/reservation/manifest.json">` becomes `<link rel="manifest" href="{{BASE}}/manifest.json">` (Task 2 step 4 rule 2 already covers this if it was applied; verify it landed).

- [ ] **Step 5: Run the full suite**

```bash
npm run test:unit && npm run test:smoke
```

Expected: PASS.

- [ ] **Step 6: Verify by eye**

```bash
node src/server/server.js
```

- `curl http://localhost:3000/reservation/config.js` → ends with `window.APP_FEATURES = {"reservations":true,...};`, no literal `{{`.
- `curl http://localhost:3000/reservation/manifest.json` → valid JSON, `"name": "Pokladna — restaurace"`.
- Open `/reservation/admin`, check the browser console is free of CSP violations.

Stop the server.

- [ ] **Step 7: Commit**

```bash
git add src/config.js src/manifest.json src/server/server.js src/html/inner.html
git commit -m "feat(config): serve config.js and manifest.json from the config file"
```

---

### Task 4: Feature flags gate pages and routes

**Files:**
- Modify: `src/server/server.js` (feature middleware + conditional route registration)
- Modify: `src/js/inner.js` (hide nav tabs)
- Modify: `src/html/inner.html` (tag nav tabs with `data-feature`)
- Test: `tests/smoke/features.test.js` (create)

**Interfaces:**
- Consumes: `brand.isEnabled(name)` from Task 1; `window.APP_FEATURES` from Task 3.
- Produces: `requireFeature(...names)` Express middleware — passes when **at least one** named feature is on, otherwise `res.status(404)`.

**Context you need:** the kitchen board (`GET /kitchen/orders`, `kitchen-board.js`) serves table orders **and** delivery orders, so it must not be gated on `pos` alone — gate it on `pos`, `delivery` or `tableOrdering`. And `inner.html` is both the POS and the admin panel (menu, users, settings), so `pos: false` hides tabs but must never 404 the page.

- [ ] **Step 1: Write the failing smoke test**

Create `tests/smoke/features.test.js`:

```js
// ============================================================================
// features.test.js — boots a real server with a temp restaurace.config.js
// that switches delivery off, and proves the switch reaches both the page
// routes and the API. The config file is written to os.tmpdir() and passed
// via RESTAURANT_CONFIG, so this never writes into the repo root (where the
// harness sets the child's cwd) and never disturbs a parallel test run.
// ============================================================================

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const harness = require("../helpers/harness");

function writeTempConfig(source) {
    const unique = `${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    const file = path.join(os.tmpdir(), `restaurace-config-${unique}.js`);
    fs.writeFileSync(file, source, "utf8");
    return file;
}

test("features: delivery off 404s its page and its API, reservations stay up", async (t) => {
    const configPath = writeTempConfig(`module.exports = {
        brand: { wordmark: "U Kalicha", name: "Restaurace U Kalicha" },
        features: { reservations: true, delivery: false, tableOrdering: true,
                    pos: true, dailyMenu: true, eet: false },
    };`);

    const server = await harness.start({ env: { RESTAURANT_CONFIG: configPath } });
    t.after(async () => {
        await server.stop();
        try { fs.unlinkSync(configPath); } catch { /* already gone */ }
    });

    const del = await fetch(`${server.baseUrl}/reservation/delivery`);
    assert.strictEqual(del.status, 404, "the delivery page must 404 when the feature is off");

    const driver = await fetch(`${server.baseUrl}/reservation/driver`);
    assert.strictEqual(driver.status, 404, "the driver page must 404 with delivery off");

    const order = await fetch(`${server.api}/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: [] }),
    });
    assert.strictEqual(order.status, 404,
        "POST /orders must 404 (not 403 — a disabled feature does not announce itself)");

    const app = await fetch(`${server.baseUrl}/reservation/app`);
    assert.strictEqual(app.status, 200, "reservations are on, so /app must still work");

    const html = await app.text();
    assert.ok(html.includes("U Kalicha"), "the configured wordmark must reach the page");
    assert.ok(!html.includes("{{"), "no unrendered token may reach the browser");
});

test("features: with no config file every feature is on", async (t) => {
    const server = await harness.start();
    t.after(() => server.stop());

    for (const route of ["/reservation/app", "/reservation/delivery", "/reservation/kitchen"]) {
        const res = await fetch(`${server.baseUrl}${route}`);
        assert.strictEqual(res.status, 200, `${route} must be reachable by default`);
    }
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npm run test:smoke
```

Expected: FAIL — the delivery page returns 200 because nothing gates it yet.

- [ ] **Step 3: Add the middleware and gate the routes**

In `src/server/server.js`, next to the other middleware helpers (near `requireAuth`/`requireAdmin`), add:

```js
// Feature gate. Passes when AT LEAST ONE of the named features is on — the
// kitchen board needs that, since GET /kitchen/orders serves table orders
// and delivery orders alike and must survive `pos: false`.
//
// 404, deliberately, not 403: a feature this installation did not buy
// should not announce that it exists.
function requireFeature(...names) {
    return (req, res, next) => {
        if (names.some(name => brand.isEnabled(name))) return next();
        res.status(404).json({ error: "Nenalezeno" });
    };
}
```

Gate the API route groups in `setupAPIRoutes()` by inserting `requireFeature(...)` as the **first** middleware on each — before `csrf.requireCsrf` and before any auth middleware, so a disabled feature answers 404 rather than leaking a 401/403 that confirms it exists. Worked example, the delivery order route:

```js
    // before
    app.post(`${api}/orders`, csrf.requireCsrf, V.validate(V.createOrderSchema), async (req, res) => {

    // after
    app.post(`${api}/orders`, requireFeature("delivery"), csrf.requireCsrf, V.validate(V.createOrderSchema), async (req, res) => {
```

Apply the same shape to every route in this table:

| Routes | Gate |
|---|---|
| `POST ${api}/orders`, `GET ${api}/orders`, all `${api}/reorder/*`, all `${api}/drivers*` | `requireFeature("delivery")` |
| `POST ${api}/table-orders`, `GET ${api}/table-session/:token`, table-QR admin routes | `requireFeature("tableOrdering")` |
| all `${api}/daily-menu*` | `requireFeature("dailyMenu")` |
| all `${api}/kitchen/*` | `requireFeature("pos", "delivery", "tableOrdering")` |
| all `${api}/offline-sale*` | `requireFeature("pos")` |
| `GET ${api}/eet/health` | `requireFeature("eet")` |

In `setupFrontendRoutes()`, register the page routes conditionally. Both branches become (base-prefixed branch shown; the other drops `${base}`):

```js
        if (brand.isEnabled("reservations")) app.get(`${base}/app`, indexHtmlRoute);
        app.get(`${base}/inner.html`, innerHtmlRoute);   // always: also the admin panel
        app.get(`${base}/admin`, innerHtmlRoute);        // always: also the admin panel
        if (brand.isEnabled("delivery")) {
            app.get(`${base}/delivery`, deliveryHtmlRoute);
            app.get(`${base}/driver`, driverHtmlRoute);
        }
        if (brand.isEnabled("tableOrdering")) app.get(`${base}/stul/:token`, tableHtmlRoute);
        if (brand.isEnabled("pos") || brand.isEnabled("delivery") || brand.isEnabled("tableOrdering")) {
            app.get(`${base}/kitchen`, kitchenHtmlRoute);
        }
```

- [ ] **Step 4: Force EET off when the feature is off**

In `SERVER_CONFIG.eet`, change:

```js
        enabled: process.env.EET_ENABLED === "true",
```

to:

```js
        // The config file's feature switch is a hard override: a restaurant
        // that did not buy EET must not report sales even if a stray
        // EET_ENABLED=true is left in its .env.
        enabled: brand.isEnabled("eet") && process.env.EET_ENABLED === "true",
```

- [ ] **Step 5: Run the smoke test to verify it passes**

```bash
npm run test:smoke
```

Expected: PASS, both new tests plus every pre-existing smoke test.

- [ ] **Step 6: Hide the nav tabs client-side**

In `src/html/inner.html`, tag the feature-specific nav buttons:

- `#viewWaiterBtn` → add `data-feature="pos"`
- `#viewSalesBtn` → add `data-feature="pos"`
- `#viewDetailBtn` → add `data-feature="pos"`
- `#viewDailyMenuBtn` → add `data-feature="dailyMenu"`

In `src/js/inner.js`, next to the existing `.admin-only` handling at ~line 285, add:

```js
// Hide anything belonging to a feature this installation did not buy.
// window.APP_FEATURES is set by the server-rendered config.js (see
// src/server/brand.js). Cosmetic only — the server 404s the matching
// routes regardless, so a hidden tab is not the security boundary.
document.querySelectorAll('[data-feature]').forEach(el => {
    const feature = el.getAttribute('data-feature');
    if (!(window.APP_FEATURES && window.APP_FEATURES[feature])) {
        el.style.display = 'none';
    }
});
```

- [ ] **Step 7: Verify by eye**

Write a temp config with `pos: false` and start the server against it:

```bash
RESTAURANT_CONFIG=/tmp/test-config.js node src/server/server.js
```

(PowerShell: `$env:RESTAURANT_CONFIG='C:\tmp\test-config.js'; node src/server/server.js`)

Open `/reservation/admin` and confirm the Detail stolu / Objednat ke stolu / Prodeje tabs are gone while Menu, Uživatelé and Nastavení remain. Stop the server and unset the variable.

- [ ] **Step 8: Commit**

```bash
git add src/server/server.js src/js/inner.js src/html/inner.html tests/smoke/features.test.js
git commit -m "feat(config): gate pages and API routes on the feature flags"
```

---

### Task 5: Seed settings from the config file on a fresh install

**Files:**
- Modify: `src/server/server.js` (`initializeData()`, ~line 2126)
- Test: `tests/smoke/features.test.js` (add one case)

**Interfaces:**
- Consumes: `brand.config.defaults` from Task 1; `settingsStore.saveSettings(obj)` and `settingsStore.getSettings()` from `settings.js`; `db.get(COL.settings, SETTINGS_ID)`.

**Context you need:** the settings singleton is at `db.get("settings", "restaurant")` — the record id is **`"restaurant"`, not `"settings"`**. Writing to `settings/settings` silently creates a second, unused record while the app keeps serving the real one, which looks exactly like a bug in your feature. `settings.js` exports `SETTINGS_ID`? No — it does **not**; use the literal `"restaurant"` with a comment, exactly as `tests/helpers/harness.js` does.

Also: `validation.js`'s `settingsSchema` is `.strict()`. This task writes only keys that already exist in `DEFAULT_SETTINGS`, so no schema change is needed — but if you add a key that isn't in the schema, `PUT /api/settings` will start returning 400 as soon as the admin panel round-trips.

- [ ] **Step 1: Add the failing test case**

Append to `tests/smoke/features.test.js`:

```js
test("seeding: a fresh DB takes its starting values from the config file", async (t) => {
    const configPath = writeTempConfig(`module.exports = {
        defaults: {
            delivery: { fee: 59, minOrder: 250, freeAbove: 700,
                        pscWhitelist: ["11000"], etaMinutes: 45 },
            dailyMenu: { from: "10:30", to: "13:30" },
        },
        business: { name: "U Kalicha s.r.o.", ico: "87654321",
                    dic: "CZ87654321", address: "Na Bojišti 12, 128 00 Praha 2",
                    email: "info@ukalicha.cz", phone: "+420 601 234 567" },
    };`);

    const server = await harness.start({ env: { RESTAURANT_CONFIG: configPath } });
    t.after(async () => {
        await server.stop();
        try { fs.unlinkSync(configPath); } catch { /* already gone */ }
    });

    const stored = harness.readRecord(server.dbPath, harness.COL.settings, harness.SETTINGS_ID);
    assert.ok(stored, "a fresh DB must get a seeded settings record");
    assert.strictEqual(stored.delivery.fee, 59);
    assert.strictEqual(stored.delivery.minOrder, 250);
    assert.deepStrictEqual(stored.delivery.pscWhitelist, ["11000"]);
    assert.strictEqual(stored.dailyMenu.from, "10:30");
    assert.strictEqual(stored.business.ico, "87654321");
    assert.strictEqual(stored.business.phone, "+420 601 234 567");

    // Values the config file said nothing about keep settings.js's defaults.
    assert.strictEqual(stored.reservations.paused, false);
    assert.strictEqual(stored.tableOrdering.enabled, false);
    // …including the ones one level below something the config DID set.
    assert.strictEqual(stored.delivery.days["0"].from, "10:30");
});

test("seeding: a nested preset reaches the settings record", async (t) => {
    const configPath = writeTempConfig(`module.exports = {
        defaults: {
            reservations: { days: { "6": { open: false, fromHour: 1, toHour: 12 } } },
            notifications: { smsReservationReminder: true },
        },
    };`);

    const server = await harness.start({ env: { RESTAURANT_CONFIG: configPath } });
    t.after(async () => {
        await server.stop();
        try { fs.unlinkSync(configPath); } catch { /* already gone */ }
    });

    const stored = harness.readRecord(server.dbPath, harness.COL.settings, harness.SETTINGS_ID);
    assert.strictEqual(stored.reservations.days["6"].open, false, "Sunday must be seeded closed");
    assert.strictEqual(stored.reservations.days["0"].open, true, "other days keep the default");
    assert.strictEqual(stored.notifications.smsReservationReminder, true);
});

test("seeding: an existing settings record is never overwritten", async (t) => {
    const configPath = writeTempConfig(`module.exports = {
        defaults: { delivery: { fee: 59 } },
    };`);

    // First boot seeds fee = 59.
    const first = await harness.start({ env: { RESTAURANT_CONFIG: configPath } });
    const dbPath = first.dbPath;
    assert.strictEqual(
        harness.readRecord(dbPath, harness.COL.settings, harness.SETTINGS_ID).delivery.fee, 59);

    // The owner changes it in the panel.
    const settings = harness.readRecord(dbPath, harness.COL.settings, harness.SETTINGS_ID);
    settings.delivery.fee = 65;
    harness.seedRecord(dbPath, harness.COL.settings, harness.SETTINGS_ID, settings);
    await first.stop();

    // A redeploy must NOT revert it. Reuse the same DB file by pointing a
    // fresh server at it.
    const second = await harness.start({
        env: { RESTAURANT_CONFIG: configPath, SQLITE_PATH: dbPath },
    });
    t.after(async () => {
        await second.stop();
        try { fs.unlinkSync(configPath); } catch { /* already gone */ }
    });

    assert.strictEqual(
        harness.readRecord(dbPath, harness.COL.settings, harness.SETTINGS_ID).delivery.fee, 65,
        "a redeploy must not clobber the owner's own panel edit");
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
npm run test:smoke
```

Expected: FAIL — no settings record exists on a fresh DB (`assert.ok(stored)` fails).

- [ ] **Step 3: Seed in `initializeData()`**

In `src/server/server.js`, inside `initializeData()`, after the combos seed:

```js
    // Per-restaurant starting values (docs/superpowers/specs/
    // 2026-08-06-restaurant-config-file-design.md §3). ONLY on a DB that has
    // no settings record at all — i.e. a brand-new installation. An existing
    // install already has one, and the owner's own edits in admin Nastavení
    // are the truth from then on; re-applying the config file on every boot
    // would silently revert their changes on the next redeploy and look
    // exactly like a bug.
    //
    // The record id is "restaurant", NOT "settings" — writing to
    // settings/settings creates a second, unused record while the app keeps
    // serving the real one. See settings.js's SETTINGS_ID.
    if (!db.get(COL.settings, "restaurant")) {
        const seed = settingsStore.getSettings(); // full canonical shape
        // mergeDefaults(defaults, value) returns something shaped exactly
        // like `defaults` with `value`'s values filled in, recursively —
        // so nested presets like defaults.reservations.days land correctly,
        // fields the config file never mentions keep settings.js's own
        // default, and anything bogus is dropped by settings.js, which is
        // the module that actually owns this shape. A shallow spread here
        // would silently drop one level down (e.g. delivery.days).
        const overlay = { ...brand.config.defaults, business: brand.config.business };
        settingsStore.saveSettings(settingsStore.mergeDefaults(seed, overlay));
        console.log("Nastavení restaurace inicializováno z konfiguračního souboru.");
    }
```

Check that `COL.settings` exists in `SERVER_CONFIG.collections`; if it does not, add `settings: "settings",` to that block.

Note `brand.config.business` carries a `vatPayer` key that `settings.business` does not have — `mergeDefaults` keeps only keys present in the canonical shape, so it is discarded harmlessly. `vatPayer` reaches receipts through `SERVER_CONFIG.business` (Task 2), which is its only consumer.

- [ ] **Step 4: Run it to verify it passes**

```bash
npm run test:smoke
```

Expected: PASS.

- [ ] **Step 5: Confirm nothing else moved**

```bash
npm run test:unit
```

Expected: PASS, unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/server/server.js tests/smoke/features.test.js
git commit -m "feat(config): seed settings from the config file on a fresh install"
```

---

### Task 6: The example file and the docs

**Files:**
- Create: `restaurace.config.example.js`
- Modify: `.gitignore`, `.env.example`, `README.md`

**Interfaces:**
- Consumes: the full validated shape from Task 1.
- Produces: nothing consumed by code. This is the artefact the owner actually edits.

- [ ] **Step 1: Write `restaurace.config.example.js`**

Every field, Czech comments, real-looking values, and the manual checklist at the bottom:

```js
// ============================================================================
// restaurace.config.js — VŠECHNO, co se liší restauraci od restaurace
// ============================================================================
//
// JAK TO POUŽÍT
//   1. Zkopíruj tenhle soubor:  cp restaurace.config.example.js restaurace.config.js
//   2. Vyplň hodnoty níž.
//   3. Restartuj server.
//
// Tenhle soubor NENÍ v gitu (viz .gitignore) — každá restaurace má svůj.
//
// CO TU NENÍ: hesla a klíče. JWT_SECRET, Twilio, SMTP, GoPay a EET
// certifikáty patří do souboru `.env` (vzor je v `.env.example`). Díky tomu
// se tenhle soubor dá poslat mailem nebo ukázat zákazníkovi, aniž by na tom
// cokoli záviselo.
//
// KDYŽ TENHLE SOUBOR NEEXISTUJE, aplikace jede na výchozích hodnotách a
// funguje úplně normálně. Nic se nerozbije.
//
// KDYŽ V NĚM UDĚLÁŠ CHYBU (třeba barvu "zelená" místo "#1a5c3a"), server
// odmítne nastartovat a napíše, které pole je špatně. To je záměr — lepší
// spadnout při nasazení než v pátek večer.
// ============================================================================

module.exports = {

    // ── 1. VZHLED ───────────────────────────────────────────────────────
    brand: {
        // Celý název. Objevuje se v titulku okna na každé stránce.
        name: "Restaurace U Kalicha",

        // Krátký název vlevo nahoře na každé stránce. Držte se ~15 znaků,
        // delší se na mobilu láme.
        wordmark: "U Kalicha",

        // Hlavní barva: tlačítka, ceny, zvýraznění. Musí být #rgb nebo
        // #rrggbb — jiný zápis server odmítne.
        accent: "#1a5c3a",
        // Tmavší odstín téhle barvy, použije se při najetí myší.
        accentHover: "#14472c",
        // Velmi světlý tón téže barvy, použije se jako pozadí zvýrazněných
        // bloků. Musí být světlý, jinak na něm nebude vidět text.
        accentSoft: "#e8f1ec",

        // Aplikace pro personál (přidá se na plochu tabletu v provozovně).
        pwa: {
            name: "Pokladna — U Kalicha",
            shortName: "Pokladna",      // pod ikonou na ploše, ~12 znaků
            themeColor: "#111111",      // barva pozadí ikony a lišty
            iconLetter: "K",            // právě JEDEN znak uvnitř ikony
        },
    },

    // ── 2. ÚDAJE O FIRMĚ ────────────────────────────────────────────────
    // Tiskne se na účtenky a doplňuje se do tří právních stránek
    // (obchodní podmínky, ochrana osobních údajů, reklamační řád).
    // Majitel je pak může měnit i v admin panelu → Nastavení.
    business: {
        name: "U Kalicha s.r.o.",
        ico: "12345678",                 // přesně 8 číslic
        dic: "CZ12345678",               // "CZ" + 8 až 10 číslic, nebo "" když není plátce
        address: "Na Bojišti 12, 128 00 Praha 2",
        email: "info@ukalicha.cz",
        phone: "+420 601 234 567",

        // true = plátce DPH (na účtence bude rozpis DPH).
        // false = na účtence bude "Nejsme plátci DPH" a žádný rozpis.
        vatPayer: true,

        // Datum účinnosti právních stránek, "RRRR-MM-DD". Nech "" a doplní
        // se dnešní datum — jenže pak se každý den mění. Až text projde
        // právník, nastav sem pevné datum.
        termsEffectiveDate: "2026-09-01",
    },

    // ── 3. CO SI TAHLE RESTAURACE KOUPILA ───────────────────────────────
    // false = stránka vrací 404, API odmítá, záložka v panelu zmizí.
    // Aspoň jedna musí být true.
    features: {
        reservations:  true,   // rezervace stolů na webu
        delivery:      true,   // rozvoz + stránka pro řidiče
        tableOrdering: true,   // QR kódy na stolech, host si objedná sám
        pos:           true,   // pokladna, obsluha stolů, přehled prodejů
        dailyMenu:     true,   // polední menu
        eet:           false,  // hlášení tržeb finanční správě
    },

    // ── 4. VÝCHOZÍ HODNOTY ──────────────────────────────────────────────
    // POZOR: tohle se použije JEN při úplně prvním spuštění na prázdné
    // databázi. Jakmile majitel něco změní v panelu → Nastavení, platí jeho
    // hodnota a tenhle soubor už do toho nemluví — ani po aktualizaci.
    //
    // Otevírací doba, svátky, půdorys místností a SMS přepínače se nastavují
    // v panelu, ne tady.
    defaults: {
        delivery: {
            fee: 59,                      // poplatek za dovoz v Kč
            minOrder: 250,                // pod tuhle částku objednávku nevezme
            freeAbove: 700,               // nad tuhle částku je dovoz zdarma (0 = nikdy)
            pscWhitelist: ["12000", "12800"], // kam rozvážíme; prázdné pole = všude
            etaMinutes: 45,               // orientační doba doručení
        },
        dailyMenu: {
            from: "11:00",
            to: "14:00",
        },
    },

    // ── 5. TECHNICKÉ ────────────────────────────────────────────────────
    server: {
        // Cesta, pod kterou aplikace běží. Měň jen když víš proč — musí
        // začínat lomítkem a nesmí jím končit.
        basePath: "/reservation",
    },
};

// ============================================================================
// CO TENHLE SOUBOR UDĚLAT NEMŮŽE — projdi po nasazení ručně
// ============================================================================
//
//   1. Vytvořit přihlášení pro majitele:  node deploy/create-admin.js
//   2. Naimportovat jídelní lístek:       panel → Menu
//   3. Nakreslit rozložení stolů:         panel → Rozložení
//   4. Převést EET certifikát .p12 → PEM: viz PRED-NAHRANIM.md
//   5. Vytisknout QR kódy ke stolům:      panel → (jen když tableOrdering: true)
//   6. Projít go-live kontrolu:           PRED-NAHRANIM.md
//
// ============================================================================
```

- [ ] **Step 2: Ignore the real config file**

Append to `.gitignore`:

```gitignore

# Per-restaurant config — one per customer, never shared.
# The committed template is restaurace.config.example.js.
restaurace.config.js
```

- [ ] **Step 3: Point `.env.example` at the new home**

Replace the `── BUSINESS IDENTITY (receipts + legal pages) ──` block with:

```
# ── BUSINESS IDENTITY (receipts + legal pages) ──────────────────────────
# MOVED. These now live in restaurace.config.js under `business:` — see
# restaurace.config.example.js. The variables below still work and still
# override the config file when set, so an existing deployment keeps
# running unchanged; for a new one, leave them out and use the config file.
# BUSINESS_NAME=
# BUSINESS_ICO=
# BUSINESS_DIC=
# BUSINESS_ADDRESS=
# BUSINESS_VAT_PAYER=false

# Absolute path to restaurace.config.js. Defaults to <cwd>/restaurace.config.js.
# Only needed when one machine runs several restaurants from one checkout.
# RESTAURANT_CONFIG=
```

- [ ] **Step 4: Document it in `README.md`**

Add a section after the installation instructions:

```markdown
## Nasazení pro další restauraci

Všechno, co se liší restauraci od restaurace, je v jednom souboru:

```bash
cp restaurace.config.example.js restaurace.config.js
```

Vyplň ho (název, barvy, IČO, co si zákazník koupil, výchozí ceny za rozvoz)
a restartuj server. Soubor je okomentovaný a na konci má seznam šesti věcí,
které se musí udělat ručně — vytvořit přihlášení, naimportovat menu, nakreslit
rozložení stolů a tak dál.

Hesla a klíče do něj nepatří — ty zůstávají v `.env` (vzor v `.env.example`).

Když soubor neexistuje, aplikace jede na výchozích hodnotách.
```

- [ ] **Step 5: Prove the example file is valid**

```bash
RESTAURANT_CONFIG=restaurace.config.example.js node -e "const b=require('./src/server/brand'); console.log('OK', b.config.brand.wordmark, b.config.features)"
```

(PowerShell: `$env:RESTAURANT_CONFIG='restaurace.config.example.js'; node -e "..."; Remove-Item Env:RESTAURANT_CONFIG`)

Expected: `OK U Kalicha { reservations: true, delivery: true, ... }`. A validation error here means the example file contradicts its own rules — fix the example.

- [ ] **Step 6: Run everything one last time**

```bash
npm run test:unit && npm run test:smoke
```

Expected: PASS.

- [ ] **Step 7: Confirm the real config file is ignored**

```bash
cp restaurace.config.example.js restaurace.config.js && git status --porcelain | grep restaurace.config.js
```

Expected: only `?? restaurace.config.example.js` appears (or nothing, if already committed) — `restaurace.config.js` must **not** be listed. Then `rm restaurace.config.js`.

- [ ] **Step 8: Commit**

```bash
git add restaurace.config.example.js .gitignore .env.example README.md
git commit -m "docs(config): add the per-restaurant config template and document it"
```

---

## Done When

- `npm run test:unit` and `npm run test:smoke` pass with and without a config file present.
- `cp restaurace.config.example.js restaurace.config.js`, edit four values, restart → wordmark, colour, title and delivery pricing all follow, with no other file touched.
- `features: { delivery: false }` → `/delivery` and `/driver` 404, `POST /api/orders` 404, `/app` still 200.
- An owner's panel edit survives a restart.
- `git status` never shows `restaurace.config.js`.
