const test = require("node:test");
const assert = require("node:assert");
const queue = require("../../src/server/eet-queue");

function fakeDb(records = []) {
    const store = new Map(records.map(r => [`eet:${r.id}`, r]));
    return {
        get: (c, id) => store.get(`${c}:${id}`) || null,
        set: (c, id, v) => { store.set(`${c}:${id}`, v); return v; },
        list: c => [...store.entries()].filter(([k]) => k.startsWith(`${c}:`)).map(([, v]) => v),
    };
}

const NOW = new Date("2026-07-31T12:00:00Z");
function rec(over = {}) {
    return {
        id: "a", state: "pending", attempts: 1,
        lastAttemptAt: "2026-07-31T11:00:00Z",
        deadlineAt: "2026-08-02T11:00:00Z",
        receiptNumber: "2026-000001", lastError: null, ...over,
    };
}

test("confirmed and failed records are never retried", () => {
    const db = fakeDb([rec({ id: "a", state: "confirmed" }), rec({ id: "b", state: "failed" })]);
    assert.strictEqual(queue.dueRecords(db, "eet", NOW).length, 0);
});

test("a pending record past its backoff is due", () => {
    const db = fakeDb([rec()]);   // 60 min since last attempt, backoff for attempts=1 is 5 min
    assert.strictEqual(queue.dueRecords(db, "eet", NOW).length, 1);
});

test("a pending record still inside its backoff is not due", () => {
    const db = fakeDb([rec({ lastAttemptAt: "2026-07-31T11:58:00Z" })]);  // 2 min ago
    assert.strictEqual(queue.dueRecords(db, "eet", NOW).length, 0);
});

test("a record past its deadline is still retried, never dropped", () => {
    const db = fakeDb([rec({ deadlineAt: "2026-07-30T00:00:00Z" })]);
    assert.strictEqual(queue.dueRecords(db, "eet", NOW).length, 1);
});

test("health summary counts by state and finds the oldest pending", () => {
    const db = fakeDb([
        rec({ id: "a", state: "pending", datTrzby: "2026-07-31T09:00:00Z" }),
        rec({ id: "b", state: "confirmed" }),
        rec({ id: "c", state: "failed", lastError: "EET 4: Neplatny podpis SOAP zpravy" }),
    ]);
    const h = queue.healthSummary(db, "eet", NOW);
    assert.strictEqual(h.pending, 1);
    assert.strictEqual(h.confirmed, 1);
    assert.strictEqual(h.failed, 1);
    assert.strictEqual(h.oldestPending, "a");
});

test("overdue counts pending records past their deadline", () => {
    const db = fakeDb([rec({ id: "a", deadlineAt: "2026-07-30T00:00:00Z" })]);
    assert.strictEqual(queue.healthSummary(db, "eet", NOW).overdue, 1);
});
