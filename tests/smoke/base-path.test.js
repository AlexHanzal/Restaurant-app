// ============================================================================
// base-path.test.js — proves server.basePath (finding C2) actually works.
//
// {{BASE}} was threaded through the HTML templates and sw.js, but six
// frontend scripts (renderer.js, inner.js, delivery.js, driver.js,
// kitchen.js, table-order.js) still hardcoded "/reservation" when building
// their API_URL. With a configured basePath the server booted clean, pages
// rendered fine, and then every API call 404'd — a broken deploy that looks
// nothing like a config problem. This boots with a non-default basePath and
// proves pages, the API, and the served static JS all agree on it.
//
// NOTE: tests/helpers/harness.js's returned `server.api` hardcodes
// "${baseUrl}/reservation/api" — that constant is useless here on purpose.
// Every URL below is built from server.baseUrl directly.
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
    const file = path.join(os.tmpdir(), `restaurace-config-basepath-${unique}.js`);
    fs.writeFileSync(file, source, "utf8");
    return file;
}

test("server.basePath: pages, API and static assets all resolve under a custom base", async (t) => {
    const configPath = writeTempConfig(`module.exports = {
        brand: { wordmark: "U Kalicha", name: "Restaurace U Kalicha" },
        server: { basePath: "/bistro" },
    };`);

    const server = await harness.start({ env: { RESTAURANT_CONFIG: configPath } });
    t.after(async () => {
        await server.stop();
        try { fs.unlinkSync(configPath); } catch { /* already gone */ }
    });

    const settings = await fetch(`${server.baseUrl}/bistro/api/settings`);
    assert.strictEqual(settings.status, 200, "GET /bistro/api/settings must resolve under the custom base");

    const app = await fetch(`${server.baseUrl}/bistro/app`);
    assert.strictEqual(app.status, 200, "GET /bistro/app must resolve under the custom base");

    // Also regression-guards C1: sw.js's SHELL_ASSETS and manifest.json's
    // start_url both depend on ${BASE}/html/inner.html being fetchable.
    const innerHtml = await fetch(`${server.baseUrl}/bistro/html/inner.html`);
    assert.strictEqual(innerHtml.status, 200, "GET /bistro/html/inner.html must resolve");
    const innerHtmlBody = await innerHtml.text();
    assert.ok(!innerHtmlBody.includes("{{"), "no unrendered token may reach the browser");

    const rendererJs = await fetch(`${server.baseUrl}/bistro/js/renderer.js`);
    assert.strictEqual(rendererJs.status, 200, "GET /bistro/js/renderer.js must resolve");
    const rendererSrc = await rendererJs.text();
    // Checks for the specific hardcoded API_URL construction this finding is
    // about, not a bare "/reservation/" substring — renderer.js legitimately
    // calls the `/kitchen/reservation/pay-online` API route, whose name
    // happens to also contain "/reservation/".
    assert.ok(!rendererSrc.includes("/reservation/api"),
        "the served renderer.js must not hardcode /reservation/api once basePath is configurable");
});
