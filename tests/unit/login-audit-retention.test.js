// ============================================================================
// login-audit-retention.test.js — which login-audit rows are still worth keeping.
//
// Every login attempt, success or failure, writes a row to the `login_audit`
// SQLite collection, and nothing ever removed one. getRecentLoginAudit() then
// reads the WHOLE collection (db.list parses every row) and sorts it just to
// return the newest 200. So the cost of opening the security page grew with
// every login the restaurant had ever performed, and the file grew forever.
//
// Two independent bounds, because they fail in different directions:
//   - age, for the ordinary case (years of normal staff logins),
//   - a hard row cap, for the burst case (a credential-stuffing run can write
//     thousands of rows in an afternoon, all of them well inside any sane
//     retention window).
// ============================================================================

const test = require("node:test");
const assert = require("node:assert");

const security = require("../../src/server/security");

const NOW = new Date("2026-08-05T12:00:00Z");
const DAY = 24 * 3600 * 1000;

function row(id, ageDays) {
    return { id, at: new Date(NOW.getTime() - ageDays * DAY).toISOString() };
}

// selectExpiredAuditIds returns ID STRINGS, not rows — sorted here only so
// assertions do not depend on the order the implementation happens to emit.
function sorted(idList) {
    return idList.slice().sort();
}

test("rows inside the retention window are kept", () => {
    const expired = security.selectExpiredAuditIds(
        [row("a", 1), row("b", 10), row("c", 89)],
        { now: NOW, retentionDays: 90, maxRows: 1000 }
    );
    assert.deepStrictEqual(expired, []);
});

test("rows past the retention window are selected for deletion", () => {
    const expired = security.selectExpiredAuditIds(
        [row("fresh", 1), row("stale", 120)],
        { now: NOW, retentionDays: 90, maxRows: 1000 }
    );
    assert.deepStrictEqual(expired, ["stale"]);
});

// The burst case: a stuffing run writes far more rows than the cap, all of
// them minutes old, so age alone would never touch them.
test("the row cap trims the oldest even when everything is recent", () => {
    const rows = [row("r1", 0.1), row("r2", 0.2), row("r3", 0.3), row("r4", 0.4), row("r5", 0.5)];
    const expired = security.selectExpiredAuditIds(rows, { now: NOW, retentionDays: 90, maxRows: 2 });

    // Keeps the two newest (r1, r2); the three oldest go.
    assert.deepStrictEqual(sorted(expired), ["r3", "r4", "r5"]);
});

test("age and the cap compose without double-counting a row", () => {
    const rows = [row("new1", 0.1), row("new2", 0.2), row("old1", 200), row("old2", 300)];
    const expired = security.selectExpiredAuditIds(rows, { now: NOW, retentionDays: 90, maxRows: 1 });
    assert.deepStrictEqual(sorted(expired), ["new2", "old1", "old2"]);
    assert.strictEqual(new Set(expired).size, expired.length, "an id was listed twice");
});

// Fail SAFE here, which is the opposite direction from the kitchen board: an
// audit row is a security record, so anything we cannot confidently date is
// KEPT rather than deleted. Losing evidence is worse than keeping a stray row.
test("a row with an unusable timestamp is never deleted by age", () => {
    const rows = [{ id: "no-date" }, { id: "junk", at: "not a date" }, { id: "null", at: null }];
    const expired = security.selectExpiredAuditIds(rows, { now: NOW, retentionDays: 90, maxRows: 1000 });
    assert.deepStrictEqual(expired, []);
});

test("bad or missing options fall back to defaults instead of deleting everything", () => {
    const rows = [row("a", 1), row("b", 2)];
    assert.deepStrictEqual(security.selectExpiredAuditIds(rows, { now: NOW, retentionDays: 0, maxRows: 0 }), []);
    assert.deepStrictEqual(security.selectExpiredAuditIds(rows, { now: NOW, retentionDays: -5 }), []);
    assert.deepStrictEqual(security.selectExpiredAuditIds(rows, {}), []);
});

test("a non-array input yields nothing to delete rather than throwing", () => {
    assert.deepStrictEqual(security.selectExpiredAuditIds(null, { now: NOW }), []);
    assert.deepStrictEqual(security.selectExpiredAuditIds(undefined, { now: NOW }), []);
});
