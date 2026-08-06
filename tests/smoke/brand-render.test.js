// ============================================================================
// brand-render.test.js — /reservation/config.js and /reservation/manifest.json
// must reproduce configured brand strings EXACTLY, even when those strings
// contain characters JavaScript's String.prototype.replace() treats as
// special replacement patterns ($$, $`, $', $&, $<n>).
//
// server.js's configJsRoute/manifestRoute build these two responses with
// `.replace(regex, stringValue)` — passing a pre-built STRING as the second
// argument. That is unsafe regardless of whether the regex has capture
// groups: if the replacement string itself contains $$, $`, $' or $&, the
// engine reinterprets them as replacement-pattern syntax instead of literal
// text (see MDN "Specifying a string as a parameter"). A restaurant name
// containing an ampersand-adjacent dollar sign, or a "$$" in a promotional
// wordmark, would then corrupt the served config.js / manifest.json — worst
// case, manifest.json stops being valid JSON and the PWA fails to install.
//
// brand.renderTokens (src/server/brand.js) and renderPage (server.js) both
// already use the safe FUNCTION-replacer form (`.replace(re, () => value)`),
// which sidesteps this entirely. This test exists so configJsRoute/
// manifestRoute can never regress back to the string form.
// ============================================================================

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const harness = require("../helpers/harness");

// Deliberately hostile brand strings: each contains one or more of the
// special replacement patterns ($$, $`, $', $&) that a string-form
// .replace() would misinterpret. Together they cover every pattern named
// in the finding. A plain quote is included too, since these values flow
// through JSON.stringify()/jsonToken() and must still round-trip correctly
// alongside the $ handling.
const BRAND_NAME = 'Re$$staurace "U Fojta" $& & syn';
const BRAND_WORDMARK = "Fojta $` wordmark";
const PWA_NAME = "Pokladna $& $$ název";
const PWA_SHORT_NAME = "Krátký $` a $' název";

function writeTempConfig() {
    const unique = `${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;
    const configPath = path.join(os.tmpdir(), `brand-render-smoke-${unique}.config.js`);
    // module.exports literal — brand.js loads this file via require(). Using
    // JSON.stringify to embed the JS string literals sidesteps any need to
    // hand-escape the hostile characters above.
    const contents = `module.exports = ${JSON.stringify({
        brand: {
            name: BRAND_NAME,
            wordmark: BRAND_WORDMARK,
            pwa: {
                name: PWA_NAME,
                shortName: PWA_SHORT_NAME,
            },
        },
    }, null, 2)};\n`;
    fs.writeFileSync(configPath, contents, "utf8");
    return configPath;
}

describe("config.js and manifest.json render hostile brand strings exactly", () => {
    let h;
    let configPath;

    before(async () => {
        configPath = writeTempConfig();
        h = await harness.start({ env: { RESTAURANT_CONFIG: configPath } });
    });

    after(async () => {
        await h.stop();
        try { fs.unlinkSync(configPath); } catch { /* best-effort */ }
    });

    test("GET /reservation/manifest.json parses as JSON with exact brand strings", async () => {
        const res = await fetch(`${h.baseUrl}/reservation/manifest.json`);
        assert.strictEqual(res.status, 200);
        const rawBody = await res.text();

        let manifest;
        try {
            manifest = JSON.parse(rawBody);
        } catch (e) {
            assert.fail(`manifest.json did not parse as JSON: ${e.message}\n--- body ---\n${rawBody}`);
        }

        assert.strictEqual(manifest.name, PWA_NAME);
        assert.strictEqual(manifest.short_name, PWA_SHORT_NAME);
    });

    test("GET /reservation/config.js contains the configured brand name exactly", async () => {
        const res = await fetch(`${h.baseUrl}/reservation/config.js`);
        assert.strictEqual(res.status, 200);
        const rawBody = await res.text();

        // window.APP_BRAND is a JSON literal embedded in JS source — parse it
        // out the same way a browser evaluating this script would see it,
        // rather than doing a raw substring check that a corrupted-but-
        // still-a-match render could pass by accident.
        const match = rawBody.match(/window\.APP_BRAND = (.*);/);
        assert.ok(match, `window.APP_BRAND assignment not found in config.js\n--- body ---\n${rawBody}`);

        let appBrand;
        try {
            appBrand = JSON.parse(match[1]);
        } catch (e) {
            assert.fail(`window.APP_BRAND literal did not parse as JSON: ${e.message}\n--- literal ---\n${match[1]}`);
        }

        assert.strictEqual(appBrand.name, BRAND_NAME);
        assert.strictEqual(appBrand.wordmark, BRAND_WORDMARK);
    });
});
