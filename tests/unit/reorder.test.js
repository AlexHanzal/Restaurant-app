// ============================================================================
// reorder.test.js — unit coverage for reorder.js's DB-backed pending-code
// functions (finding M3, 2026-08-11). No express, no SQLite: a plain stub
// standing in for db.js's get/set/patch/list/remove contract, same shape
// idempotency.test.js and verification-codes.test.js already use.
// ============================================================================

const test = require("node:test");
const assert = require("node:assert");

const reorder = require("../../src/server/reorder");

function fakeDb() {
    const store = new Map();
    return {
        get: (c, id) => store.get(`${c}:${id}`) || null,
        set: (c, id, v) => { store.set(`${c}:${id}`, v); return v; },
        patch: (c, id, changes) => {
            const key = `${c}:${id}`;
            const current = store.get(key);
            if (!current) return null;
            const merged = { ...current, ...changes };
            store.set(key, merged);
            return merged;
        },
        remove: (c, id) => store.delete(`${c}:${id}`),
        list: c => [...store.entries()].filter(([k]) => k.startsWith(`${c}:`)).map(([, v]) => v),
    };
}

const COL = "reorder_pending_codes";
const PHONE = "+420601000001";

test("putPendingCode stores a code retrievable via checkPendingCode", () => {
    const db = fakeDb();
    reorder.putPendingCode(db, COL, PHONE, "123456");
    const result = reorder.checkPendingCode(db, COL, PHONE, "123456");
    assert.deepStrictEqual(result, { ok: true });
});

test("checkPendingCode with no prior send-code answers 'Nejprve si vyžádejte ověřovací kód'", () => {
    const db = fakeDb();
    const result = reorder.checkPendingCode(db, COL, PHONE, "123456");
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, "Nejprve si vyžádejte ověřovací kód");
});

test("a wrong code decrements attemptsLeft and is reported in the result", () => {
    const db = fakeDb();
    reorder.putPendingCode(db, COL, PHONE, "123456");

    const first = reorder.checkPendingCode(db, COL, PHONE, "000000");
    assert.strictEqual(first.ok, false);
    assert.strictEqual(first.reason, "Nesprávný kód");
    assert.strictEqual(first.attemptsLeft, 4);

    // The decrement was persisted, not just returned once.
    const second = reorder.checkPendingCode(db, COL, PHONE, "000000");
    assert.strictEqual(second.attemptsLeft, 3);
});

test("attempts exhaust after 5 wrong guesses, then the row is gone", () => {
    const db = fakeDb();
    reorder.putPendingCode(db, COL, PHONE, "123456");

    for (let i = 0; i < 5; i++) {
        const r = reorder.checkPendingCode(db, COL, PHONE, "000000");
        assert.strictEqual(r.reason, "Nesprávný kód", `attempt ${i}`);
    }

    const exhausted = reorder.checkPendingCode(db, COL, PHONE, "123456");
    assert.strictEqual(exhausted.ok, false);
    assert.strictEqual(exhausted.reason, "Příliš mnoho pokusů, vyžádejte si nový kód");
    assert.strictEqual(db.get(COL, PHONE), null, "the exhausted row must be removed, not left behind");
});

test("an expired code is refused and removed, even if it would have matched", () => {
    const db = fakeDb();
    reorder.putPendingCode(db, COL, PHONE, "123456");

    // Force it into the past directly in storage — cheaper and less flaky
    // than a real 5-minute wait. Rows are keyed by phoneMatchKey(), NOT the
    // raw phone string (that's the whole point of that function — see
    // reorder.js's header on it), so the override has to go through the
    // same key or it silently writes a second, unrelated row.
    const key = reorder.phoneMatchKey(PHONE);
    const stored = db.get(COL, key);
    db.set(COL, key, { ...stored, expiresAt: Date.now() - 1 });

    const result = reorder.checkPendingCode(db, COL, PHONE, "123456");
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, "Kód vypršel, vyžádejte si nový");
    assert.strictEqual(db.get(COL, key), null);
});

test("success consumes the code — replaying the same code a second time fails", () => {
    const db = fakeDb();
    reorder.putPendingCode(db, COL, PHONE, "123456");

    assert.deepStrictEqual(reorder.checkPendingCode(db, COL, PHONE, "123456"), { ok: true });

    const replay = reorder.checkPendingCode(db, COL, PHONE, "123456");
    assert.strictEqual(replay.ok, false);
    assert.strictEqual(replay.reason, "Nejprve si vyžádejte ověřovací kód");
});

test("keys via phoneMatchKey — a customer typing the number differently still matches", () => {
    const db = fakeDb();
    reorder.putPendingCode(db, COL, "+420 601 000 001", "654321");
    const result = reorder.checkPendingCode(db, COL, "601000001", "654321");
    assert.deepStrictEqual(result, { ok: true });
});

test("putPendingCode overwrites a still-pending code for the same phone with a fresh one", () => {
    const db = fakeDb();
    reorder.putPendingCode(db, COL, PHONE, "111111");
    reorder.putPendingCode(db, COL, PHONE, "222222");

    // The old code no longer works.
    assert.strictEqual(reorder.checkPendingCode(db, COL, PHONE, "111111").ok, false);
});

test("distinct phone numbers stay independent", () => {
    const db = fakeDb();
    reorder.putPendingCode(db, COL, "+420601000001", "111111");
    reorder.putPendingCode(db, COL, "+420601000002", "222222");

    assert.deepStrictEqual(reorder.checkPendingCode(db, COL, "+420601000001", "111111"), { ok: true });
    assert.deepStrictEqual(reorder.checkPendingCode(db, COL, "+420601000002", "222222"), { ok: true });
});
