const test = require("node:test");
const assert = require("node:assert");
const queue = require("../../src/server/eet-queue");

function fakeDb() {
    const store = new Map();
    return {
        get: (c, id) => store.get(`${c}:${id}`) || null,
        set: (c, id, v) => { store.set(`${c}:${id}`, v); return v; },
        list: c => [...store.entries()].filter(([k]) => k.startsWith(`${c}:`)).map(([, v]) => v),
        remove: (c, id) => { store.delete(`${c}:${id}`); },
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

// ----------------------------------------------------------------------------
// An unparseable 200 response (SOAP fault, captive-portal HTML, a truncated
// body from a flaky proxy) has neither <Chyba> nor <Potvrzeni>, so
// parseResponse() returns errorCode: null. classifyError(null) says
// "terminal" — null isn't -1 or 8 — which without a guard permanently kills
// the sale on nothing more than an infrastructure blip that happened to
// return HTTP 200. Terminal must mean "the tax authority looked at this sale
// and rejected it for a reason no retry can fix"; an unparseable body means
// no such verdict ever reached us.
// ----------------------------------------------------------------------------

test("an unparseable 200 response (errorCode null) leaves the record pending, never failed", async () => {
    const db = fakeDb(); seed(db);
    const client = { sendTrzba: async () => ({ ok: false, errorCode: null, errorText: null, warnings: [] }) };
    const rec = await queue.sendOnce(db, "eet", "r1", { config: CONFIG, credentials: CREDS, client });
    assert.strictEqual(rec.state, "pending", "an unparseable response must be treated as retryable infrastructure noise, not a terminal tax-authority rejection");
    assert.match(rec.lastError, /unparseable|no.*Chyba|no.*Potvrzeni/i);
});

// ----------------------------------------------------------------------------
// enqueue()'s supersedesReceiptId path (see eet-queue.js's header comment on
// it) does db.remove(col, supersedesReceiptId) when a lost-receipt-row
// fallback carries a sale's identity over to a replacement receipt. If a
// sendOnce() call for that exact old id is still in flight when that
// happens, it's holding an in-memory `record` object fetched BEFORE the
// remove — and without a re-check, its final db.set(col, id, record) would
// resurrect the row enqueue() just deleted, leaving TWO rows sharing one
// uuidZpravy: the correct one under the new receipt id, and an orphaned one
// under the old id that the retry worker would keep retrying forever.
// ----------------------------------------------------------------------------

test("a record removed by a superseding enqueue while sendOnce is in flight must not be resurrected on persist", async () => {
    const db = fakeDb();
    const lostReceipt = { id: "rcpt-lost", number: "2026-000005", issuedAt: "2026-07-31T09:00:00+02:00", total: 500 };
    const supersedeConfig = { eic: "CZ00000019", idJednotky: "11", registers: { indoor: "INDOOR" } };
    queue.enqueue(db, "eet", { receipt: lostReceipt, kind: "indoor", config: supersedeConfig });

    const client = {
        sendTrzba: async () => {
            // Simulate createReceiptForOrder's lost-receipt fallback racing
            // this in-flight send: while the "network call" is in progress,
            // a replacement receipt gets minted and enqueue() is called with
            // supersedesReceiptId, which removes rcpt-lost out from under us.
            const replacement = { id: "rcpt-new", number: "2026-000042", issuedAt: "2026-07-31T12:00:00+02:00", total: 500 };
            queue.enqueue(db, "eet", {
                receipt: replacement, kind: "indoor", config: supersedeConfig, supersedesReceiptId: "rcpt-lost",
            });
            return { ok: true, pok: "abc-ff", warnings: [] };
        },
    };

    const result = await queue.sendOnce(db, "eet", "rcpt-lost", { config: supersedeConfig, credentials: CREDS, client });

    assert.strictEqual(result, null, "sendOnce must not resurrect a record removed out from under it");
    assert.strictEqual(db.get("eet", "rcpt-lost"), null, "the superseded id must stay gone");
    const survivor = db.get("eet", "rcpt-new");
    assert.ok(survivor, "the superseding record must survive");
    assert.strictEqual(db.list("eet").length, 1, "exactly one row for this sale, never two sharing a uuidZpravy");
});

test("sendOnce never throws for a missing queue record", async () => {
    const db = fakeDb();
    await assert.doesNotReject(
        queue.sendOnce(db, "eet", "does-not-exist", { config: CONFIG, credentials: CREDS, client: { sendTrzba: async () => ({ ok: true }) } }),
        "sendOnce is documented to never throw — a missing record must be logged and swallowed, not thrown"
    );
});
