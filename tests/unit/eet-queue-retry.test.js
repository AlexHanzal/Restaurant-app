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

// lastAttemptAt that puts a record exactly `waitedMs` in the past relative to NOW.
function agoISO(waitedMs) {
    return new Date(NOW.getTime() - waitedMs).toISOString();
}

test("confirmed and failed records are never retried", () => {
    const db = fakeDb([rec({ id: "a", state: "confirmed" }), rec({ id: "b", state: "failed" })]);
    assert.strictEqual(queue.dueRecords(db, "eet", NOW).length, 0);
});

test("a record past its deadline is still retried, never dropped", () => {
    const db = fakeDb([rec({ deadlineAt: "2026-07-30T00:00:00Z" })]);
    assert.strictEqual(queue.dueRecords(db, "eet", NOW).length, 1);
});

// ----------------------------------------------------------------------------
// Backoff schedule: 1min, 5min, 15min, then hourly — indexed by attempts
// ALREADY MADE (attempts - 1), not by attempts about to be made. A record
// with attempts=1 has been tried exactly once (that attempt happened when
// attempts was still 0, then sendOnce incremented it) — the wait that
// follows THAT attempt is the 1-minute stage, not the 5-minute one.
// ----------------------------------------------------------------------------

const STAGES = [
    { attempts: 1, delayMs: 60_000, label: "1 min" },
    { attempts: 2, delayMs: 300_000, label: "5 min" },
    { attempts: 3, delayMs: 900_000, label: "15 min" },
    { attempts: 4, delayMs: 3_600_000, label: "1 hour (first hourly stage)" },
    { attempts: 10, delayMs: 3_600_000, label: "1 hour (deep into the tail)" },
];

for (const { attempts, delayMs, label } of STAGES) {
    test(`attempts=${attempts}: not yet due just before the ${label} mark`, () => {
        const db = fakeDb([rec({ attempts, lastAttemptAt: agoISO(delayMs - 1000) })]);
        assert.strictEqual(queue.dueRecords(db, "eet", NOW).length, 0);
    });

    test(`attempts=${attempts}: due just after the ${label} mark`, () => {
        const db = fakeDb([rec({ attempts, lastAttemptAt: agoISO(delayMs + 1000) })]);
        assert.strictEqual(queue.dueRecords(db, "eet", NOW).length, 1);
    });
}

test("attempts=0 (never tried) is immediately due regardless of lastAttemptAt", () => {
    // A record that has never been attempted has lastAttemptAt === null, and
    // dueRecords() already special-cases that to "due now" — this test pins
    // that nextAttemptDelay(0) itself doesn't blow up or return something
    // that would make a never-tried record wait.
    const db = fakeDb([rec({ attempts: 0, lastAttemptAt: null })]);
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

// ----------------------------------------------------------------------------
// oldestPending must sort corrupt records LAST, not first. A missing or
// unparseable datTrzby must never win "oldest" purely because Date(0)/NaN
// sorts before a real 2026 timestamp — that would bury the genuinely oldest
// unreported sale (the one actually closest to its 48h deadline) behind a
// data-quality bug.
// ----------------------------------------------------------------------------

test("oldestPending ignores a record with a missing datTrzby", () => {
    const db = fakeDb([
        rec({ id: "corrupt", state: "pending", datTrzby: undefined }),
        rec({ id: "genuine", state: "pending", datTrzby: "2026-07-31T09:00:00Z" }),
    ]);
    assert.strictEqual(queue.healthSummary(db, "eet", NOW).oldestPending, "genuine");
});

// ----------------------------------------------------------------------------
// Tax-authority warnings (Varovani) are stored on records by sendOnce but,
// before this fix, never surfaced anywhere — /api/eet/health hid them
// entirely. warningCount/lastWarning close that gap.
// ----------------------------------------------------------------------------

test("healthSummary surfaces a warning count and the most recent warning", () => {
    const db = fakeDb([
        rec({ id: "a", state: "confirmed", warnings: [{ code: 6, text: "id_jednotky format issue" }] }),
        rec({ id: "b", state: "confirmed", warnings: [] }),
        rec({ id: "c", state: "confirmed", warnings: [{ code: 2, text: "newer warning" }] }),
    ]);
    const h = queue.healthSummary(db, "eet", NOW);
    assert.strictEqual(h.warningCount, 2);
    assert.deepStrictEqual(h.lastWarning, { code: 2, text: "newer warning" });
});

test("healthSummary reports no warnings when none are recorded", () => {
    const db = fakeDb([rec({ id: "a", state: "confirmed", warnings: [] })]);
    const h = queue.healthSummary(db, "eet", NOW);
    assert.strictEqual(h.warningCount, 0);
    assert.strictEqual(h.lastWarning, null);
});

test("oldestPending ignores a record with an unparseable datTrzby", () => {
    const db = fakeDb([
        rec({ id: "corrupt", state: "pending", datTrzby: "not-a-date" }),
        rec({ id: "genuine", state: "pending", datTrzby: "2026-07-31T09:00:00Z" }),
    ]);
    assert.strictEqual(queue.healthSummary(db, "eet", NOW).oldestPending, "genuine");
});
