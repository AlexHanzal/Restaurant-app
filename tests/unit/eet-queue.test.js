const test = require("node:test");
const assert = require("node:assert");
const queue = require("../../src/server/eet-queue");

// Minimal in-memory stand-in for db.js's get/set/list contract.
function fakeDb() {
    const store = new Map();
    return {
        get: (c, id) => store.get(`${c}:${id}`) || null,
        set: (c, id, v) => { store.set(`${c}:${id}`, v); return v; },
        list: c => [...store.entries()].filter(([k]) => k.startsWith(`${c}:`)).map(([, v]) => v),
    };
}

const CONFIG = {
    eic: "CZ00000019",
    idJednotky: "11",
    registers: { delivery: "DELIVERY", indoor: "INDOOR", reservation: "RESERVATION" },
};

const RECEIPT = { id: "rcpt1", number: "2026-000001", issuedAt: "2026-07-31T11:55:00+02:00", total: 349 };

test("every payment method is reported (owner decision 2026-07-31)", () => {
    for (const m of ["cash", "card_on_delivery", "online_card"]) {
        assert.strictEqual(queue.isEvidovanaTrzba(m, null), true);
    }
    assert.strictEqual(queue.isEvidovanaTrzba("online_card", "BANK_ACCOUNT"), true);
});

test("enqueue creates a pending record keyed by receipt id", () => {
    const db = fakeDb();
    const rec = queue.enqueue(db, "eet_records", { receipt: RECEIPT, kind: "indoor", config: CONFIG });
    assert.strictEqual(rec.id, "rcpt1");
    assert.strictEqual(rec.state, "pending");
    assert.strictEqual(rec.prvniZaslani, true);
    assert.strictEqual(rec.idPokl, "INDOOR");
    assert.strictEqual(rec.poradCis, "2026-000001");
    assert.strictEqual(rec.celkTrzba, 349);
    assert.strictEqual(rec.attempts, 0);
});

test("enqueue is idempotent — a second call never mints a second record", () => {
    const db = fakeDb();
    const a = queue.enqueue(db, "eet_records", { receipt: RECEIPT, kind: "indoor", config: CONFIG });
    const b = queue.enqueue(db, "eet_records", { receipt: RECEIPT, kind: "indoor", config: CONFIG });
    assert.strictEqual(a.uuidZpravy, b.uuidZpravy, "UUID must not be regenerated");
    assert.strictEqual(db.list("eet_records").length, 1);
});

test("dat_trzby is frozen from the receipt, never regenerated", () => {
    const db = fakeDb();
    const rec = queue.enqueue(db, "eet_records", { receipt: RECEIPT, kind: "indoor", config: CONFIG });
    assert.strictEqual(rec.datTrzby, "2026-07-31T11:55:00+02:00");
});

test("deadline is 48h after the sale", () => {
    const db = fakeDb();
    const rec = queue.enqueue(db, "eet_records", { receipt: RECEIPT, kind: "indoor", config: CONFIG });
    const delta = new Date(rec.deadlineAt) - new Date(rec.datTrzby);
    assert.strictEqual(delta, queue.DEADLINE_MS);
});

test("register is chosen per channel", () => {
    assert.strictEqual(queue.registerFor(CONFIG, "delivery"), "DELIVERY");
    assert.strictEqual(queue.registerFor(CONFIG, "reservation"), "RESERVATION");
});

test("a refund uses the register of the channel it refunds", () => {
    assert.strictEqual(queue.registerFor(CONFIG, "refund", "delivery"), "DELIVERY");
});
