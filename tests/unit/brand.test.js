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
    // Third-level nesting (brand.pwa.*) — a deepFreeze that only walks one
    // or two levels deep would miss this and this assignment would fail
    // silently instead of throwing.
    assert.throws(() => { brand.config.brand.pwa.iconLetter = "x"; }, TypeError);
    // Arrays are objects too, but Object.freeze() on an array still allows
    // Array.prototype methods that mutate in place (push/pop/splice) unless
    // deepFreeze actually recurses into array values, not just plain-object
    // values. Cover that separately from the plain-object cases above.
    assert.throws(() => { brand.config.defaults.delivery.pscWhitelist.push("99999"); }, TypeError);
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

// Regression test for a bug where a REAL config file that itself requires a
// missing module was misdiagnosed as "no config file present". Node's
// MODULE_NOT_FOUND error message includes a "Require stack:" trailer that
// lists every file in the chain — INCLUDING the config file that did the
// (failing) requiring. A naive `err.message.includes(CONFIG_PATH)` check is
// true in that trailer even though CONFIG_PATH itself was found and loaded
// just fine; the actually-missing module is something CONFIG_PATH required.
// That must throw and name the config file — not be swallowed into silent
// defaults, which would boot the server on hardcoded values with nobody told
// the operator's config was ignored.
test("a config file that exists but itself requires a missing module is not swallowed as 'no config'", () => {
    assert.throws(
        () => loadBrand(`module.exports = require("./this-helper-does-not-exist");`),
        (err) => {
            assert.ok(err.message.includes("restaurace"), "should name the config file");
            return true;
        }
    );
});
