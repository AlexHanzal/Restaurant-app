// Live test against Finanční správa's EET 2.0 playground. Opt-in so that
// `npm test` stays offline and fast:
//   EET_LIVE_TEST=1 EET_TEST_CERT=... EET_TEST_KEY=... node --test tests/integration/eet-playground.test.js
//
// Uses the SHARED playground certificates, which every developer testing EET
// right now also holds. Sale uniqueness is (eic_popl, id_jednotky, id_pokl,
// dat_trzby), so id_pokl below is deliberately distinctive to avoid colliding
// with a stranger's test.
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const eet = require("../../src/server/eet");

const LIVE = process.env.EET_LIVE_TEST === "1";
const opts = { skip: LIVE ? false : "set EET_LIVE_TEST=1 to run" };

function config() {
    return {
        playground: true,
        timeoutMs: 15000,
        credentials: eet.loadCredentials({
            certPem: process.env.EET_TEST_CERT,
            keyPem: process.env.EET_TEST_KEY,
        }),
    };
}

function sale(overrides = {}) {
    const now = new Date();
    return {
        uuidZpravy: crypto.randomUUID(),
        datOdesl: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
        datTrzby: new Date(now.getTime() - 60000).toISOString().replace(/\.\d{3}Z$/, "Z"),
        prvniZaslani: true,
        eic: "CZ00000019",
        idJednotky: 11,
        idPokl: "RESTAURACE-CI",
        poradCis: `CI-${Date.now()}`,
        celkTrzba: 349,
        ...overrides,
    };
}

test("ověřovací mód returns error code 0 (success)", opts, async () => {
    const res = await eet.verifyConnection(config(), sale());
    assert.strictEqual(res.errorCode, 0, `unexpected: ${res.errorCode} ${res.errorText}`);
});

test("ostrý mód returns a POK", opts, async () => {
    const res = await eet.sendTrzba(config(), sale());
    assert.strictEqual(res.ok, true, `expected POK, got ${res.errorCode}: ${res.errorText}`);
    assert.match(res.pok, /^[0-9a-f-]{36}-[0-9a-f]{2}$/);
});

test("playground POKs are always marked as test — never let one reach a receipt", opts, async () => {
    const res = await eet.sendTrzba(config(), sale());
    assert.strictEqual(res.test, true);
    assert.ok(res.pok.endsWith("-ff"));
});

test("negative amount (storno) is accepted", opts, async () => {
    const res = await eet.sendTrzba(config(), sale({ celkTrzba: -349 }));
    assert.strictEqual(res.ok, true, `storno rejected: ${res.errorCode} ${res.errorText}`);
});

test("id_jednotky of 1 produces warning 6 but still succeeds", opts, async () => {
    const res = await eet.sendTrzba(config(), sale({ idJednotky: 1 }));
    assert.strictEqual(res.ok, true);
    assert.ok(res.warnings.some(w => w.code === 6));
});
