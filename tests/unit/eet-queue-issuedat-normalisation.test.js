const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const queue = require("../../src/server/eet-queue");
const eet = require("../../src/server/eet");

// ============================================================================
// Regression coverage for the go-live-blocking bug: every real sale was
// silently rejected before it ever reached the network.
//
// enqueue() froze `datTrzby = receipt.issuedAt` verbatim. Every OTHER test
// file in this suite hand-writes a clean, millisecond-free issuedAt fixture
// (e.g. "2026-07-31T11:55:00+02:00") — which is exactly why 102 passing
// tests never caught this: createReceiptForOrder() in server.js actually
// produces `new Date().toISOString()`, which ALWAYS appends milliseconds
// (".xxxZ"). assertEetDateTime (eet.js) requires
// \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(Z|[+-]\d\d:\d\d) and deliberately REJECTS
// fractional seconds — so buildTrzbaBody throws on every real sale, sendOnce
// swallows that throw into lastError, the record never leaves "pending", and
// the receipt prints "Tržba je evidována v běžném režimu" for a sale that is
// never actually reported. In production this meant zero sales ever get
// through.
//
// This file drives the REAL eet.js client (not a stub), through an injected
// fetchImpl, with an issuedAt produced by an actual `new Date().toISOString()`
// call — not a literal — so it cannot silently regress back to a clean-fixture
// blind spot.
// ============================================================================

function fakeDb() {
    const store = new Map();
    return {
        get: (c, id) => store.get(`${c}:${id}`) || null,
        set: (c, id, v) => { store.set(`${c}:${id}`, v); return v; },
        list: c => [...store.entries()].filter(([k]) => k.startsWith(`${c}:`)).map(([, v]) => v),
        remove: (c, id) => { store.delete(`${c}:${id}`); },
    };
}

const CONFIG = { eic: "CZ00000019", idJednotky: "11", registers: { indoor: "INDOOR" }, playground: true };

// Throwaway keypair so the REAL signing path (buildSignedEnvelope) runs
// end-to-end without needing a real pokladní certifikát — same approach as
// eet-send.test.js.
function makeCreds() {
    const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    return { privateKey, certDer: Buffer.from("dummy-certificate-bytes").toString("base64") };
}

const POK_XML = `<eet:Odpoved xmlns:eet="http://fs.gov.cz/eet/schema/v4"><eet:Potvrzeni pok="4ce219fe-b4ac-441b-83a8-986a62bc653f-ff" test="true"/></eet:Odpoved>`;

test("a receipt with a real new Date().toISOString() issuedAt actually reaches the network client and confirms", async () => {
    const db = fakeDb();
    // NOT a literal — this is exactly what createReceiptForOrder produces.
    const issuedAt = new Date().toISOString();
    const receipt = { id: "real-r1", number: "2026-000099", issuedAt, total: 349 };
    queue.enqueue(db, "eet", { receipt, kind: "indoor", config: CONFIG });

    let fetchCalled = false;
    const fetchImpl = async () => {
        fetchCalled = true;
        return { ok: true, status: 200, text: async () => POK_XML };
    };

    // No `client` override — this exercises the REAL eet.js module (the
    // default parameter of sendOnce), so buildTrzbaBody's assertEetDateTime
    // genuinely runs against the frozen datTrzby.
    const rec = await queue.sendOnce(db, "eet", "real-r1", {
        config: { ...CONFIG, fetchImpl, timeoutMs: 2000 },
        credentials: makeCreds(),
    });

    assert.strictEqual(fetchCalled, true, "the real network client must actually be reached — if this is false, datTrzby failed assertEetDateTime before any request was attempted");
    assert.strictEqual(rec.lastError, null, `sendOnce recorded an error instead of sending: ${rec.lastError}`);
    assert.strictEqual(rec.state, "confirmed");
    assert.strictEqual(rec.pok, "4ce219fe-b4ac-441b-83a8-986a62bc653f-ff");
});

test("enqueue strips milliseconds from a Z-suffixed issuedAt (the exact shape createReceiptForOrder produces)", () => {
    const db = fakeDb();
    const receipt = { id: "r-ms", number: "2026-000051", issuedAt: "2026-08-01T10:00:00.731Z", total: 100 };
    const rec = queue.enqueue(db, "eet", { receipt, kind: "indoor", config: CONFIG });
    assert.strictEqual(rec.datTrzby, "2026-08-01T10:00:00Z");
});

test("enqueue strips milliseconds but preserves a non-UTC offset in datTrzby verbatim", () => {
    const db = fakeDb();
    const receipt = { id: "r-offset", number: "2026-000050", issuedAt: "2026-07-31T11:55:00.123+02:00", total: 100 };
    const rec = queue.enqueue(db, "eet", { receipt, kind: "indoor", config: CONFIG });

    assert.strictEqual(
        rec.datTrzby,
        "2026-07-31T11:55:00+02:00",
        "milliseconds must be stripped, but the +02:00 offset must survive untouched — round-tripping through " +
        "new Date(...).toISOString() would silently rewrite it to a Z-suffixed UTC time instead"
    );

    assert.doesNotThrow(() => eet.buildTrzbaBody({
        datOdesl: "2026-07-31T11:55:00Z",
        datTrzby: rec.datTrzby,
        uuidZpravy: rec.uuidZpravy,
        prvniZaslani: true,
        eic: rec.eic,
        idJednotky: rec.idJednotky,
        idPokl: rec.idPokl,
        poradCis: rec.poradCis,
        celkTrzba: rec.celkTrzba,
    }), "the normalised offset-form datTrzby must pass assertEetDateTime");
});
