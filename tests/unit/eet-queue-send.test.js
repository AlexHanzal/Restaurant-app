const test = require("node:test");
const assert = require("node:assert");
const queue = require("../../src/server/eet-queue");

function fakeDb() {
    const store = new Map();
    return {
        get: (c, id) => store.get(`${c}:${id}`) || null,
        set: (c, id, v) => { store.set(`${c}:${id}`, v); return v; },
        list: c => [...store.entries()].filter(([k]) => k.startsWith(`${c}:`)).map(([, v]) => v),
    };
}

const CONFIG = { eic: "CZ00000019", idJednotky: "11", registers: { indoor: "INDOOR" } };
const RECEIPT = { id: "r1", number: "2026-000001", issuedAt: "2026-07-31T11:55:00+02:00", total: 349 };
const CREDS = { certDer: "x", privateKey: "y" };

function seed(db) {
    return queue.enqueue(db, "eet", { receipt: RECEIPT, kind: "indoor", config: CONFIG });
}

test("a POK confirms the record", async () => {
    const db = fakeDb(); seed(db);
    const client = { sendTrzba: async () => ({ ok: true, pok: "abc-ff", warnings: [], test: true }) };
    const rec = await queue.sendOnce(db, "eet", "r1", { config: CONFIG, credentials: CREDS, client });
    assert.strictEqual(rec.state, "confirmed");
    assert.strictEqual(rec.pok, "abc-ff");
    assert.strictEqual(rec.attempts, 1);
});

test("a terminal error code stops retrying", async () => {
    const db = fakeDb(); seed(db);
    const client = { sendTrzba: async () => ({ ok: false, errorCode: 4, errorText: "Neplatny podpis SOAP zpravy", warnings: [] }) };
    const rec = await queue.sendOnce(db, "eet", "r1", { config: CONFIG, credentials: CREDS, client });
    assert.strictEqual(rec.state, "failed");
    assert.match(rec.lastError, /Neplatny podpis/);
});

test("a retryable error code leaves the record pending", async () => {
    const db = fakeDb(); seed(db);
    const client = { sendTrzba: async () => ({ ok: false, errorCode: -1, errorText: "Docasna technicka chyba", warnings: [] }) };
    const rec = await queue.sendOnce(db, "eet", "r1", { config: CONFIG, credentials: CREDS, client });
    assert.strictEqual(rec.state, "pending");
});

test("a transport failure leaves the record pending", async () => {
    const db = fakeDb(); seed(db);
    const client = { sendTrzba: async () => { throw new Error("network down"); } };
    const rec = await queue.sendOnce(db, "eet", "r1", { config: CONFIG, credentials: CREDS, client });
    assert.strictEqual(rec.state, "pending");
    assert.match(rec.lastError, /network down/);
});

test("uuid_zpravy is stable and prvni_zaslani flips false on retry", async () => {
    const db = fakeDb();
    const original = seed(db).uuidZpravy;
    const sent = [];
    const client = { sendTrzba: async (_c, sale) => { sent.push(sale); throw new Error("down"); } };
    await queue.sendOnce(db, "eet", "r1", { config: CONFIG, credentials: CREDS, client });
    await queue.sendOnce(db, "eet", "r1", { config: CONFIG, credentials: CREDS, client });

    assert.strictEqual(sent[0].uuidZpravy, original);
    assert.strictEqual(sent[1].uuidZpravy, original, "a new UUID would duplicate the sale");
    assert.strictEqual(sent[0].prvniZaslani, true);
    assert.strictEqual(sent[1].prvniZaslani, false);
    assert.strictEqual(sent[0].datTrzby, sent[1].datTrzby, "dat_trzby must stay frozen");
});

test("warnings are stored alongside a successful POK", async () => {
    const db = fakeDb(); seed(db);
    const client = { sendTrzba: async () => ({ ok: true, pok: "x-ff", warnings: [{ code: 6, text: "id_jednotky..." }] }) };
    const rec = await queue.sendOnce(db, "eet", "r1", { config: CONFIG, credentials: CREDS, client });
    assert.strictEqual(rec.state, "confirmed");
    assert.strictEqual(rec.warnings.length, 1);
});

test("a confirmed record is never re-sent", async () => {
    const db = fakeDb(); seed(db);
    let calls = 0;
    const client = { sendTrzba: async () => { calls++; return { ok: true, pok: "x-ff", warnings: [] }; } };
    await queue.sendOnce(db, "eet", "r1", { config: CONFIG, credentials: CREDS, client });
    await queue.sendOnce(db, "eet", "r1", { config: CONFIG, credentials: CREDS, client });
    assert.strictEqual(calls, 1);
});

test("a failed (terminal) record is never re-sent", async () => {
    const db = fakeDb(); seed(db);
    let calls = 0;
    const client = { sendTrzba: async () => { calls++; return { ok: false, errorCode: 4, errorText: "Neplatny podpis SOAP zpravy", warnings: [] }; } };
    const first = await queue.sendOnce(db, "eet", "r1", { config: CONFIG, credentials: CREDS, client });
    assert.strictEqual(first.state, "failed");
    assert.strictEqual(calls, 1);

    const second = await queue.sendOnce(db, "eet", "r1", { config: CONFIG, credentials: CREDS, client });
    assert.strictEqual(calls, 1, "a terminal failure must never be retried — it would fail identically forever");
    assert.strictEqual(second.state, "failed");
});

test("sendOnce never throws even when the final persist fails", async () => {
    const db = fakeDb();
    seed(db);
    const originalSet = db.set;
    db.set = (c, id, v) => { throw new Error("disk full"); };
    const client = { sendTrzba: async () => ({ ok: true, pok: "abc-ff", warnings: [] }) };

    await assert.doesNotReject(
        queue.sendOnce(db, "eet", "r1", { config: CONFIG, credentials: CREDS, client }),
        "sendOnce is documented to never throw, even if the storage write fails"
    );

    db.set = originalSet;
});

test("sendOnce never throws for a missing queue record", async () => {
    const db = fakeDb();
    await assert.doesNotReject(
        queue.sendOnce(db, "eet", "does-not-exist", { config: CONFIG, credentials: CREDS, client: { sendTrzba: async () => ({ ok: true }) } }),
        "sendOnce is documented to never throw — a missing record must be logged and swallowed, not thrown"
    );
});
