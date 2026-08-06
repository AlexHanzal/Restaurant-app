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
