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
        remove: (c, id) => { store.delete(`${c}:${id}`); },
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

// --- supersedesReceiptId: a lost receipt row must not duplicate a sale -----
//
// createReceiptForOrder() has a fallback: if existingReceiptId points at a
// receipt row that's gone missing, it mints a brand new receipt (new id,
// new issuedAt) rather than losing the receipt entirely. But the SALE this
// receipt represents already has an eet_records row under the OLD receipt
// id, with its own uuidZpravy/datTrzby/poradCis already assigned (possibly
// already sent to the tax authority). Minting an independent eet_records
// row for the new receipt would report that one sale twice. enqueue()'s
// supersedesReceiptId option is how the fallback tells the queue "this new
// receipt stands in for that old, lost one — don't open a second case file."

test("enqueue with supersedesReceiptId preserves the sale's frozen EET identity when a prior record exists", () => {
    const db = fakeDb();
    const lostReceipt = { id: "rcpt-lost", number: "2026-000005", issuedAt: "2026-07-31T09:00:00+02:00", total: 500 };
    const prior = queue.enqueue(db, "eet_records", { receipt: lostReceipt, kind: "indoor", config: CONFIG });

    const replacementReceipt = { id: "rcpt-new", number: "2026-000042", issuedAt: "2026-07-31T12:00:00+02:00", total: 500 };
    const rec = queue.enqueue(db, "eet_records", {
        receipt: replacementReceipt,
        kind: "indoor",
        config: CONFIG,
        supersedesReceiptId: "rcpt-lost",
    });

    // Frozen identity: exactly what was first assigned to the SALE, never
    // re-derived from the replacement receipt.
    assert.strictEqual(rec.uuidZpravy, prior.uuidZpravy, "uuidZpravy must not be regenerated");
    assert.strictEqual(rec.datTrzby, prior.datTrzby, "datTrzby must not be regenerated");
    assert.strictEqual(rec.poradCis, prior.poradCis, "poradCis must not be regenerated");
    assert.strictEqual(rec.poradCis, "2026-000005", "poradCis must stay the number the sale was reported under, not the new receipt's number");
    assert.strictEqual(rec.celkTrzba, prior.celkTrzba);
    assert.strictEqual(rec.state, prior.state);

    // Pointers move to the new receipt — that's just where to find the
    // printable copy, not part of the sale's tax identity.
    assert.strictEqual(rec.receiptId, "rcpt-new");
    assert.strictEqual(rec.receiptNumber, "2026-000042");

    // No second row: the sale gets exactly ONE eet_records row, ever.
    assert.strictEqual(db.list("eet_records").length, 1);
});

test("enqueue with supersedesReceiptId creates a normal new record when no prior record exists", () => {
    const db = fakeDb();
    const rec = queue.enqueue(db, "eet_records", {
        receipt: RECEIPT,
        kind: "indoor",
        config: CONFIG,
        supersedesReceiptId: "rcpt-never-existed",
    });

    assert.strictEqual(rec.id, "rcpt1");
    assert.strictEqual(rec.receiptId, "rcpt1");
    assert.strictEqual(rec.receiptNumber, "2026-000001");
    assert.strictEqual(rec.poradCis, "2026-000001");
    assert.strictEqual(rec.state, "pending");
    assert.strictEqual(db.list("eet_records").length, 1);
});
