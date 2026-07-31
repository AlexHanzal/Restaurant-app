// Live test against Finanční správa's EET 2.0 playground. Opt-in so that
// `npm test` stays offline and fast:
//   EET_LIVE_TEST=1 EET_TEST_CERT=... EET_TEST_KEY=... node --test tests/integration/eet-playground.test.js
//
// Uses the SHARED playground certificates, which every developer testing EET
// right now also holds. Sale uniqueness is (eic_popl, id_jednotky, id_pokl,
// dat_trzby) — NOTE porad_cis is NOT part of that key, so randomising it (as
// we already do, via `Date.now()`) buys no protection at all. Two tests only
// avoided being treated as duplicates of each other by accident, because each
// round-trip happened to take ~2s and pushed dat_trzby into a different
// second. A faster connection, or a re-run within the same second, collides.
// So every test below gets its OWN distinct id_pokl. Do not "simplify" this
// back to a shared id_pokl — that reintroduces the collision.
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

// Pulls an attribute off the response's OWN <Hlavicka> element (as opposed to
// the one we sent) — the server's echo of uuid_zpravy, plus its own
// dat_prij/dat_odmit receipt timestamp. Neither of these could come from a
// local stub without the stub deliberately reimplementing "echo the request
// UUID and mint a plausible current timestamp" — which is exactly the kind of
// thing this check exists to rule out. Same tiny regex-on-a-fixed-payload
// approach as eet.js's own attrOf; see the comment there for why that's fine.
function responseHlavickaAttr(raw, attr) {
    const el = raw.match(/<(?:\w+:)?Hlavicka\b[^>]*/);
    if (!el) return null;
    const m = el[0].match(new RegExp(`\\b${attr}="([^"]*)"`));
    return m ? m[1] : null;
}

// Finding 2 (timing anomaly investigation): a prior run reported ~2.2s for
// the first three tests but ~23ms for the last two — for supposedly
// identical live round-trips against the same playground endpoint. Rather
// than guess, every live call below logs its elapsed time AND asserts on a
// field that only the real service can produce: the echoed uuid_zpravy (must
// match what we sent — a genuine echo, not a coincidence) together with a
// server-minted dat_prij/dat_odmit receipt timestamp. If a test were somehow
// not reaching the network, these assertions would fail (no response body to
// parse the fields out of, or no match), turning "suspiciously fast" into a
// hard failure instead of a silent false pass.
function assertGenuineNetworkRoundTrip(label, t0, sentUuid, raw) {
    const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
    console.log(`[timing] ${label}: ${elapsedMs.toFixed(1)}ms`);

    const echoedUuid = responseHlavickaAttr(raw, "uuid_zpravy");
    assert.strictEqual(
        echoedUuid,
        sentUuid,
        "response Hlavicka must echo the uuid_zpravy we sent — this can only come from the live " +
        "service actually parsing our request, not from a local stub"
    );

    const datPrij = responseHlavickaAttr(raw, "dat_prij");
    const datOdmit = responseHlavickaAttr(raw, "dat_odmit");
    assert.ok(
        datPrij || datOdmit,
        "response Hlavicka must carry a server-generated dat_prij or dat_odmit timestamp"
    );
}

test("ověřovací mód returns error code 0 (success)", opts, async () => {
    const s = sale({ idPokl: "CI-VERIFY" });
    const t0 = process.hrtime.bigint();
    const res = await eet.verifyConnection(config(), s);
    assert.strictEqual(res.errorCode, 0, `unexpected: ${res.errorCode} ${res.errorText}`);
    assertGenuineNetworkRoundTrip("ověřovací mód", t0, s.uuidZpravy, res.raw);
});

test("ostrý mód returns a POK", opts, async () => {
    const s = sale({ idPokl: "CI-OSTRY" });
    const t0 = process.hrtime.bigint();
    const res = await eet.sendTrzba(config(), s);
    assert.strictEqual(res.ok, true, `expected POK, got ${res.errorCode}: ${res.errorText}`);
    assert.match(
        res.pok,
        /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}-[0-9a-fA-F]{2}$/
    );
    assertGenuineNetworkRoundTrip("ostrý mód", t0, s.uuidZpravy, res.raw);
});

test("playground POKs are always marked as test — never let one reach a receipt", opts, async () => {
    const s = sale({ idPokl: "CI-POKFMT" });
    const t0 = process.hrtime.bigint();
    const res = await eet.sendTrzba(config(), s);
    assert.strictEqual(res.test, true);
    assert.ok(res.pok.endsWith("-ff"));
    assertGenuineNetworkRoundTrip("POK test-marker", t0, s.uuidZpravy, res.raw);
});

test("negative amount (storno) is accepted", opts, async () => {
    const s = sale({ idPokl: "CI-STORNO", celkTrzba: -349 });
    const t0 = process.hrtime.bigint();
    const res = await eet.sendTrzba(config(), s);
    assert.strictEqual(res.ok, true, `storno rejected: ${res.errorCode} ${res.errorText}`);
    assertGenuineNetworkRoundTrip("storno", t0, s.uuidZpravy, res.raw);
});

test("id_jednotky of 1 produces warning 6 but still succeeds", opts, async () => {
    const s = sale({ idPokl: "CI-WARN6", idJednotky: 1 });
    const t0 = process.hrtime.bigint();
    const res = await eet.sendTrzba(config(), s);
    assert.strictEqual(res.ok, true);
    assert.ok(res.warnings.some(w => w.code === 6));
    assertGenuineNetworkRoundTrip("warning 6", t0, s.uuidZpravy, res.raw);
});
