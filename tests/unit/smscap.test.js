const test = require("node:test");
const assert = require("node:assert");
const smscap = require("../../src/server/smscap");

function fresh(cap) {
    smscap._resetForTests();
    if (cap === undefined) delete process.env.SMS_DAILY_CAP;
    else process.env.SMS_DAILY_CAP = String(cap);
}

test("defaults to a cap of 200 when SMS_DAILY_CAP is unset", () => {
    fresh(undefined);
    assert.equal(smscap.getCap(), 200);
});

test("reads SMS_DAILY_CAP from the environment", () => {
    fresh(5);
    assert.equal(smscap.getCap(), 5);
});

test("falls back to 200 for a garbage or non-positive SMS_DAILY_CAP", () => {
    fresh("banana");
    assert.equal(smscap.getCap(), 200);
    fresh(0);
    assert.equal(smscap.getCap(), 200);
    fresh(-10);
    assert.equal(smscap.getCap(), 200);
});

test("allows sends up to the cap, then refuses", () => {
    fresh(3);
    const day = new Date("2026-07-29T10:00:00");
    assert.deepEqual(smscap.tryConsume(day), { ok: true, remaining: 2 });
    assert.deepEqual(smscap.tryConsume(day), { ok: true, remaining: 1 });
    assert.deepEqual(smscap.tryConsume(day), { ok: true, remaining: 0 });
    assert.deepEqual(smscap.tryConsume(day), { ok: false, cap: 3 });
    assert.deepEqual(smscap.tryConsume(day), { ok: false, cap: 3 });
});

test("a refused send does not increment the counter past the cap", () => {
    fresh(2);
    const day = new Date("2026-07-29T10:00:00");
    smscap.tryConsume(day);
    smscap.tryConsume(day);
    smscap.tryConsume(day);
    smscap.tryConsume(day);
    assert.equal(smscap.getState(day).sent, 2);
});

test("resets at the local-date rollover", () => {
    fresh(2);
    const late = new Date("2026-07-29T23:59:00");
    assert.equal(smscap.tryConsume(late).ok, true);
    assert.equal(smscap.tryConsume(late).ok, true);
    assert.equal(smscap.tryConsume(late).ok, false);

    const nextDay = new Date("2026-07-30T00:01:00");
    assert.deepEqual(smscap.tryConsume(nextDay), { ok: true, remaining: 1 });
    assert.equal(smscap.getState(nextDay).sent, 1);
});

test("counts a same-day send at a different hour against the same budget", () => {
    fresh(2);
    assert.equal(smscap.tryConsume(new Date("2026-07-29T01:00:00")).ok, true);
    assert.equal(smscap.tryConsume(new Date("2026-07-29T22:00:00")).ok, true);
    assert.equal(smscap.tryConsume(new Date("2026-07-29T22:30:00")).ok, false);
});

test("getState reports the current day without consuming", () => {
    fresh(10);
    const day = new Date("2026-07-29T12:00:00");
    smscap.tryConsume(day);
    const before = smscap.getState(day);
    smscap.getState(day);
    smscap.getState(day);
    assert.deepEqual(smscap.getState(day), before);
    assert.deepEqual(before, { day: "2026-07-29", sent: 1, cap: 10, remaining: 9 });
});

test("picks up a cap change mid-day without a restart", () => {
    fresh(2);
    const day = new Date("2026-07-29T12:00:00");
    smscap.tryConsume(day);
    smscap.tryConsume(day);
    assert.equal(smscap.tryConsume(day).ok, false);
    process.env.SMS_DAILY_CAP = "4";
    assert.deepEqual(smscap.tryConsume(day), { ok: true, remaining: 1 });
});
