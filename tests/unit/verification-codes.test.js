// ============================================================================
// verification-codes.test.js — the pure rules behind M3's fix: TTL, attempt
// accounting, resend cooldown, and the pruning selector. No db, no express.
// ============================================================================

const test = require("node:test");
const assert = require("node:assert");

const vcodes = require("../../src/server/verification-codes");

// Minimal in-memory stand-in for db.js's get/set/list/remove contract, same
// shape idempotency.test.js and eet-queue tests use.
function fakeDb() {
    const store = new Map();
    return {
        get: (c, id) => store.get(`${c}:${id}`) || null,
        set: (c, id, v) => { store.set(`${c}:${id}`, v); return v; },
        list: c => [...store.entries()].filter(([k]) => k.startsWith(`${c}:`)).map(([, v]) => v),
        remove: (c, id) => store.delete(`${c}:${id}`),
    };
}

const COL = "pending_codes";

// ── buildEntry ──────────────────────────────────────────────────────────

test("buildEntry stamps the default 5-minute TTL and 5 attempts", () => {
    const now = 1_000_000;
    const entry = vcodes.buildEntry("123456", { now, id: "+420601000001" });
    assert.strictEqual(entry.code, "123456");
    assert.strictEqual(entry.id, "+420601000001");
    assert.strictEqual(entry.lastSentAt, now);
    assert.strictEqual(entry.attemptsLeft, 5);
    assert.strictEqual(entry.expiresAt, now + 5 * 60 * 1000);
});

test("buildEntry honours explicit ttlMs/maxAttempts overrides", () => {
    const entry = vcodes.buildEntry("1", { now: 0, ttlMs: 1000, maxAttempts: 2 });
    assert.strictEqual(entry.expiresAt, 1000);
    assert.strictEqual(entry.attemptsLeft, 2);
});

test("buildEntry omits `id` entirely when none is given", () => {
    const entry = vcodes.buildEntry("123456", { now: 0 });
    assert.strictEqual("id" in entry, false);
});

// ── checkResendCooldown ─────────────────────────────────────────────────

test("no existing entry is never on cooldown", () => {
    assert.deepStrictEqual(vcodes.checkResendCooldown(null), { ok: true });
    assert.deepStrictEqual(vcodes.checkResendCooldown(undefined), { ok: true });
});

test("a resend inside the cooldown window is refused with the seconds remaining", () => {
    const existing = { lastSentAt: 0 };
    const result = vcodes.checkResendCooldown(existing, { now: 10_000, cooldownMs: 30_000 });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.waitSec, 20);
});

test("a resend exactly at the cooldown boundary is allowed", () => {
    const existing = { lastSentAt: 0 };
    const result = vcodes.checkResendCooldown(existing, { now: 30_000, cooldownMs: 30_000 });
    assert.deepStrictEqual(result, { ok: true });
});

test("a resend past the cooldown window is allowed", () => {
    const existing = { lastSentAt: 0 };
    const result = vcodes.checkResendCooldown(existing, { now: 30_001, cooldownMs: 30_000 });
    assert.deepStrictEqual(result, { ok: true });
});

// ── isExpired / TTL boundary ─────────────────────────────────────────────

test("isExpired is false at the exact expiry instant — only strictly-after expires", () => {
    const entry = { expiresAt: 5000 };
    assert.strictEqual(vcodes.isExpired(entry, 5000), false);
    assert.strictEqual(vcodes.isExpired(entry, 4999), false);
    assert.strictEqual(vcodes.isExpired(entry, 5001), true);
});

test("isExpired treats a missing/corrupt entry as expired, not kept forever", () => {
    assert.strictEqual(vcodes.isExpired(null, 100), true);
    assert.strictEqual(vcodes.isExpired({}, 100), true);
    assert.strictEqual(vcodes.isExpired({ expiresAt: "soon" }, 100), true);
});

// ── evaluateCode ─────────────────────────────────────────────────────────

test("evaluateCode: no pending entry -> missing", () => {
    assert.deepStrictEqual(vcodes.evaluateCode(null, "123456", 0), { outcome: "missing" });
});

test("evaluateCode: past the TTL -> expired, even with a correct code and attempts left", () => {
    const pending = { code: "123456", expiresAt: 100, attemptsLeft: 5 };
    assert.deepStrictEqual(vcodes.evaluateCode(pending, "123456", 101), { outcome: "expired" });
});

test("evaluateCode: at the exact TTL boundary the code is still accepted", () => {
    const pending = { code: "123456", expiresAt: 100, attemptsLeft: 5 };
    assert.deepStrictEqual(vcodes.evaluateCode(pending, "123456", 100), { outcome: "ok" });
});

test("evaluateCode: attemptsLeft <= 0 -> exhausted, even with the correct code", () => {
    const pending = { code: "123456", expiresAt: 999_999, attemptsLeft: 0 };
    assert.deepStrictEqual(vcodes.evaluateCode(pending, "123456", 0), { outcome: "exhausted" });
});

test("evaluateCode: wrong code decrements the returned attemptsLeft by exactly one", () => {
    const pending = { code: "123456", expiresAt: 999_999, attemptsLeft: 3 };
    assert.deepStrictEqual(vcodes.evaluateCode(pending, "000000", 0), { outcome: "wrong", attemptsLeft: 2 });
});

test("evaluateCode: the last attempt, when wrong, reports zero remaining (not exhausted yet)", () => {
    const pending = { code: "123456", expiresAt: 999_999, attemptsLeft: 1 };
    assert.deepStrictEqual(vcodes.evaluateCode(pending, "000000", 0), { outcome: "wrong", attemptsLeft: 0 });
});

test("evaluateCode: a subsequent check against attemptsLeft: 0 is exhausted, not wrong again", () => {
    const pending = { code: "123456", expiresAt: 999_999, attemptsLeft: 0 };
    assert.deepStrictEqual(vcodes.evaluateCode(pending, "000000", 0), { outcome: "exhausted" });
});

test("evaluateCode: the correct code, trimmed, succeeds", () => {
    const pending = { code: "123456", expiresAt: 999_999, attemptsLeft: 5 };
    assert.deepStrictEqual(vcodes.evaluateCode(pending, "  123456  ", 0), { outcome: "ok" });
});

test("evaluateCode: never mutates the pending object handed to it", () => {
    const pending = { code: "123456", expiresAt: 999_999, attemptsLeft: 3 };
    const frozen = Object.freeze({ ...pending });
    assert.doesNotThrow(() => vcodes.evaluateCode(frozen, "000000", 0));
    assert.strictEqual(frozen.attemptsLeft, 3, "the caller, not this function, is responsible for persisting the decrement");
});

// ── selectExpiredIds / pruneExpired ──────────────────────────────────────

test("selectExpiredIds returns only the ids of rows past expiresAt", () => {
    const rows = [
        { id: "a", expiresAt: 100 },
        { id: "b", expiresAt: 200 },
        { id: "c", expiresAt: 300 },
    ];
    assert.deepStrictEqual(vcodes.selectExpiredIds(rows, 150), ["a"]);
    assert.deepStrictEqual(vcodes.selectExpiredIds(rows, 250), ["a", "b"]);
});

test("selectExpiredIds is not thrown off by a non-array input", () => {
    assert.deepStrictEqual(vcodes.selectExpiredIds(null, 0), []);
    assert.deepStrictEqual(vcodes.selectExpiredIds(undefined, 0), []);
});

test("pruneExpired removes only the expired rows and returns the count", () => {
    const db = fakeDb();
    db.set(COL, "a", { id: "a", expiresAt: 100 });
    db.set(COL, "b", { id: "b", expiresAt: 999_999 });

    const removed = vcodes.pruneExpired(db, COL, { now: 500 });
    assert.strictEqual(removed, 1);
    assert.strictEqual(db.get(COL, "a"), null);
    assert.ok(db.get(COL, "b"), "the still-valid row must survive");
});

test("pruneExpired never throws even if the store blows up", () => {
    const db = { list: () => { throw new Error("disk full"); } };
    assert.strictEqual(vcodes.pruneExpired(db, COL), 0);
});
