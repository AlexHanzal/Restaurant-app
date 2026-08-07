// ============================================================================
// preflight.test.js — unit tests for src/server/preflight.js, the startup
// guard for running several restaurants as separate processes out of ONE
// checkout (the "one box, N processes" deployment).
//
// The bug this exists to prevent: SQLITE_PATH, RESTAURANT_CONFIG and the EET
// PEM paths all default to something resolved against process.cwd(), which
// every instance shares. Forget one variable for one restaurant and it
// silently writes into the shared data/app.db — or files sales under another
// restaurant's tax certificate. Nothing throws. This module turns that into
// a refusal to boot.
// ============================================================================

"use strict";

const test = require("node:test");
const assert = require("node:assert");

const preflight = require("../../src/server/preflight");

// A fully-correct multi-instance environment, for tests to break one field of.
function goodEnv(overrides) {
    return {
        RESTAURANT_INSTANCE: "ukalicha",
        SQLITE_PATH: "/var/lib/restaurace/ukalicha/app.db",
        RESTAURANT_CONFIG: "/etc/restaurace/ukalicha/restaurace.config.js",
        ...overrides,
    };
}

// ── WHEN THE GUARD IS OFF ───────────────────────────────────────────────

test("without RESTAURANT_INSTANCE nothing is required", () => {
    // A single-restaurant install has always resolved these from cwd and must
    // keep booting exactly as before. Making the checks unconditional would
    // break every existing deployment on its next restart.
    const result = preflight.checkInstance({});
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.errors, []);
});

test("without RESTAURANT_INSTANCE even a relative SQLITE_PATH is accepted", () => {
    const result = preflight.checkInstance({ SQLITE_PATH: "data/app.db" });
    assert.strictEqual(result.ok, true);
});

// ── WHEN THE GUARD IS ON ────────────────────────────────────────────────

test("a fully configured instance passes", () => {
    const result = preflight.checkInstance(goodEnv());
    assert.deepStrictEqual(result.errors, []);
    assert.strictEqual(result.ok, true);
});

test("a named instance must set SQLITE_PATH", () => {
    const result = preflight.checkInstance(goodEnv({ SQLITE_PATH: undefined }));
    assert.strictEqual(result.ok, false);
    assert.match(result.errors.join("\n"), /SQLITE_PATH/);
});

test("a named instance must set RESTAURANT_CONFIG", () => {
    const result = preflight.checkInstance(goodEnv({ RESTAURANT_CONFIG: undefined }));
    assert.strictEqual(result.ok, false);
    assert.match(result.errors.join("\n"), /RESTAURANT_CONFIG/);
});

test("a relative SQLITE_PATH is rejected — it would resolve against the shared checkout", () => {
    const result = preflight.checkInstance(goodEnv({ SQLITE_PATH: "data/app.db" }));
    assert.strictEqual(result.ok, false);
    assert.match(result.errors.join("\n"), /SQLITE_PATH/);
});

test("a relative RESTAURANT_CONFIG is rejected", () => {
    const result = preflight.checkInstance(goodEnv({ RESTAURANT_CONFIG: "./restaurace.config.js" }));
    assert.strictEqual(result.ok, false);
    assert.match(result.errors.join("\n"), /RESTAURANT_CONFIG/);
});

test("an empty string counts as unset, not as a value", () => {
    const result = preflight.checkInstance(goodEnv({ SQLITE_PATH: "   " }));
    assert.strictEqual(result.ok, false);
    assert.match(result.errors.join("\n"), /SQLITE_PATH/);
});

test("every missing variable is reported at once, not one per restart", () => {
    const result = preflight.checkInstance({ RESTAURANT_INSTANCE: "ukalicha" });
    assert.strictEqual(result.errors.length, 2, "expected both SQLITE_PATH and RESTAURANT_CONFIG");
});

test("the instance name must be a slug safe for a systemd unit and a log line", () => {
    for (const bad of ["U Kalicha", "ukalicha/../etc", "UKALICHA", "u kalicha\nINJECTED"]) {
        const result = preflight.checkInstance(goodEnv({ RESTAURANT_INSTANCE: bad }));
        assert.strictEqual(result.ok, false, `expected ${JSON.stringify(bad)} to be rejected`);
        assert.match(result.errors.join("\n"), /RESTAURANT_INSTANCE/);
    }
});

test("a hyphenated lowercase slug is accepted", () => {
    const result = preflight.checkInstance(goodEnv({ RESTAURANT_INSTANCE: "u-kalicha-2" }));
    assert.strictEqual(result.ok, true);
});

// ── EET PATHS ───────────────────────────────────────────────────────────
// Only required when EET is actually switched on. An instance that does not
// report sales has no certificate to point at, and demanding one would block
// a perfectly valid deployment.

test("EET paths are not required while EET is disabled", () => {
    const result = preflight.checkInstance(goodEnv({ EET_ENABLED: "false" }));
    assert.strictEqual(result.ok, true);
});

test("EET paths are required once EET is enabled", () => {
    const result = preflight.checkInstance(goodEnv({ EET_ENABLED: "true" }));
    assert.strictEqual(result.ok, false);
    const joined = result.errors.join("\n");
    assert.match(joined, /EET_CERT_PEM/);
    assert.match(joined, /EET_KEY_PEM/);
});

test("relative EET paths are rejected — they would load another restaurant's certificate", () => {
    const result = preflight.checkInstance(goodEnv({
        EET_ENABLED: "true",
        EET_CERT_PEM: "./secrets/eet-cert.pem",
        EET_KEY_PEM: "./secrets/eet-key.pem",
    }));
    assert.strictEqual(result.ok, false);
    assert.match(result.errors.join("\n"), /EET_CERT_PEM/);
});

test("absolute EET paths pass", () => {
    const result = preflight.checkInstance(goodEnv({
        EET_ENABLED: "true",
        EET_CERT_PEM: "/etc/restaurace/ukalicha/secrets/eet-cert.pem",
        EET_KEY_PEM: "/etc/restaurace/ukalicha/secrets/eet-key.pem",
    }));
    assert.strictEqual(result.ok, true);
});

test("error messages are Czech and name the variable", () => {
    const result = preflight.checkInstance(goodEnv({ SQLITE_PATH: undefined }));
    const joined = result.errors.join("\n");
    assert.match(joined, /SQLITE_PATH/);
    // The operator reading this is Czech and is looking at a systemd journal.
    assert.ok(/[ěščřžýáíéúůňť]/i.test(joined), `expected a Czech message, got: ${joined}`);
});

// ── BOOT SUMMARY ────────────────────────────────────────────────────────
// With 15 processes writing to one journal, "Server running on port 4001"
// identifies nothing. This is also the first thing to read when a customer
// calls, so it must show which config actually took effect.

function summaryArgs(overrides) {
    return {
        instance: "ukalicha",
        brandName: "Restaurace U Kalicha",
        basePath: "/reservation",
        port: 4001,
        dbPath: "/var/lib/restaurace/ukalicha/app.db",
        configPath: "/etc/restaurace/ukalicha/restaurace.config.js",
        configLoaded: true,
        features: { reservations: true, delivery: false, tableOrdering: true,
                    pos: true, dailyMenu: true, eet: false },
        eetEnabled: false,
        eetPlayground: true,
        timezone: "Europe/Prague",
        ...overrides,
    };
}

test("the boot summary names the instance, the restaurant and the port", () => {
    const out = preflight.buildBootSummary(summaryArgs()).join("\n");
    assert.match(out, /ukalicha/);
    assert.match(out, /Restaurace U Kalicha/);
    assert.match(out, /4001/);
});

test("the boot summary shows which database and config actually took effect", () => {
    const out = preflight.buildBootSummary(summaryArgs()).join("\n");
    assert.match(out, /\/var\/lib\/restaurace\/ukalicha\/app\.db/);
    assert.match(out, /\/etc\/restaurace\/ukalicha\/restaurace\.config\.js/);
});

test("the boot summary says plainly when no config file was loaded", () => {
    const out = preflight.buildBootSummary(summaryArgs({ configLoaded: false })).join("\n");
    assert.match(out, /výchozí|nenačten/i);
});

test("the boot summary lists only the enabled features", () => {
    const out = preflight.buildBootSummary(summaryArgs()).join("\n");
    const featureLine = out.split("\n").find(l => /[Ff]unkce/.test(l));
    assert.ok(featureLine, "expected a feature line");
    assert.match(featureLine, /reservations/);
    assert.ok(!featureLine.includes("delivery"),
        `disabled features must not be listed as on: ${featureLine}`);
});

test("the boot summary distinguishes EET playground from live", () => {
    const live = preflight.buildBootSummary(
        summaryArgs({ eetEnabled: true, eetPlayground: false })).join("\n");
    assert.match(live, /OSTRÝ|ostr/i);

    const play = preflight.buildBootSummary(
        summaryArgs({ eetEnabled: true, eetPlayground: true })).join("\n");
    assert.match(play, /playground|testovac/i);
});

test("the boot summary never prints a secret", () => {
    // Guard against someone later adding the Twilio token or JWT secret to
    // this line "for debugging" — the journal is not a secret store.
    const out = preflight.buildBootSummary(summaryArgs({
        // deliberately passing junk that must be ignored, not echoed
        jwtSecret: "super-secret-value",
        twilioAuthToken: "another-secret-value",
    })).join("\n");
    assert.ok(!out.includes("super-secret-value"));
    assert.ok(!out.includes("another-secret-value"));
});

test("the boot summary works for a single-restaurant install with no instance name", () => {
    const out = preflight.buildBootSummary(summaryArgs({ instance: "" })).join("\n");
    assert.match(out, /Restaurace U Kalicha/);
    assert.ok(out.length > 0);
});
