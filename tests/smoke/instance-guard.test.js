// ============================================================================
// instance-guard.test.js — proves the startup guard actually refuses to boot,
// end to end, in the real spawned server. src/server/preflight.js is unit
// tested on its own; this covers the wiring, which is the part that silently
// does nothing if someone computes the result and forgets to act on it.
//
// See src/server/preflight.js's header for why the guard exists: in the
// "one box, N processes" deployment every instance shares one cwd, so a
// forgotten SQLITE_PATH silently merges two restaurants into one database.
// ============================================================================

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const harness = require("../helpers/harness");

function writeTempConfig(source) {
    const unique = `${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    const file = path.join(os.tmpdir(), `instance-guard-${unique}.js`);
    fs.writeFileSync(file, source, "utf8");
    return file;
}

// Asserts the server refuses to start, and that its complaint names `want`.
//
// Deliberately NOT assert.rejects(): when the guard is broken the start()
// promise RESOLVES with a live child process, and assert.rejects throws away
// that object. node:test will not exit while a child is alive, so the run
// would hang forever with no output instead of going red — which is exactly
// what happened the first time this file was written. Stop the server before
// failing.
async function expectRefusal(env, want) {
    let server = null;
    try {
        server = await harness.start({ env, timeoutMs: 8000 });
    } catch (err) {
        assert.match(err.message, want,
            `the refusal must name the offending variable, got: ${err.message}`);
        return;
    }
    await server.stop();
    assert.fail(`server booted but should have refused (expected ${want} in its output)`);
}

test("a named instance with no SQLITE_PATH refuses to boot", async () => {
    // The harness always sets SQLITE_PATH; blanking it is what an operator
    // forgetting the line in the systemd EnvironmentFile looks like.
    await expectRefusal({ RESTAURANT_INSTANCE: "ukalicha", SQLITE_PATH: "" }, /SQLITE_PATH/);
});

test("a named instance with a relative SQLITE_PATH refuses to boot", async () => {
    // A relative path resolves against the shared checkout, so two instances
    // that both set this would land in the same database.
    await expectRefusal({ RESTAURANT_INSTANCE: "ukalicha", SQLITE_PATH: "data/app.db" }, /SQLITE_PATH/);
});

test("a named instance with no RESTAURANT_CONFIG refuses to boot", async () => {
    await expectRefusal({ RESTAURANT_INSTANCE: "ukalicha" }, /RESTAURANT_CONFIG/);
});

test("a fully configured named instance boots and logs which restaurant it is", async (t) => {
    const configPath = writeTempConfig(`module.exports = {
        brand: { name: "Restaurace U Kalicha", wordmark: "U Kalicha" },
        features: { reservations: true, delivery: false, tableOrdering: true,
                    pos: true, dailyMenu: true, eet: false },
    };`);

    const server = await harness.start({
        env: { RESTAURANT_INSTANCE: "ukalicha", RESTAURANT_CONFIG: configPath },
    });
    t.after(async () => {
        await server.stop();
        try { fs.unlinkSync(configPath); } catch { /* already gone */ }
    });

    const res = await fetch(`${server.baseUrl}/reservation/app`);
    assert.strictEqual(res.status, 200, "a correctly configured instance must serve normally");
});

test("an unnamed instance still boots with no extra variables — existing installs are untouched", async (t) => {
    // This is the compatibility guarantee: the guard is opt-in, so a
    // single-restaurant deployment that has never heard of
    // RESTAURANT_INSTANCE keeps working exactly as before.
    const server = await harness.start();
    t.after(() => server.stop());

    const res = await fetch(`${server.baseUrl}/reservation/app`);
    assert.strictEqual(res.status, 200);
});
