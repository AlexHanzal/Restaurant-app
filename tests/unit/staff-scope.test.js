// ============================================================================
// staff-scope.test.js — how much history a non-admin may read, and what never
// goes on the wire.
//
// Finding M4, docs/2026-08-08-architecture-dataflow-security-review.md.
//
// Two properties, and they fail in opposite directions, which is why both are
// tested rather than just the tightening:
//
//   too loose — a leaked waiter password reads the whole archive again, which
//               is the finding.
//   too tight — the floor loses the sales screen or cannot reprint today's
//               receipt, which is an outage. The July audit already learned
//               this once: requireStaff exists because requireAdmin broke the
//               kitchen's delete button.
// ============================================================================

const test = require("node:test");
const assert = require("node:assert");

const scope = require("../../src/server/staff-scope");

const ADMIN = { id: "u1", name: "Šéf", isAdmin: true, isDriver: false };
const WAITER = { id: "u2", name: "Jan", isAdmin: false, isDriver: false };
const DRIVER = { id: "u3", name: "Petr", isAdmin: false, isDriver: true };
const NOW = new Date("2026-08-11T18:00:00.000Z");

// ── who counts as admin ──────────────────────────────────────────────────

test("only an admin session is unlimited", () => {
    assert.strictEqual(scope.historyLimitDays(ADMIN), null);
    assert.strictEqual(scope.historyLimitDays(WAITER), scope.STAFF_HISTORY_DAYS);
    assert.strictEqual(scope.historyLimitDays(DRIVER), scope.STAFF_HISTORY_DAYS);
    // A missing or empty session is treated as least-privileged, never as admin.
    for (const bad of [null, undefined, {}, { isAdmin: 0 }, { isAdmin: "" }, { isAdmin: null }]) {
        assert.strictEqual(scope.historyLimitDays(bad), scope.STAFF_HISTORY_DAYS,
            `${JSON.stringify(bad)} must not be treated as an admin`);
    }
});

test("isAdmin is read with !!, and that is sound because the claim is minted here", () => {
    // Worth pinning rather than leaving implicit: a TRUTHY non-boolean would
    // pass. That is safe only because this field never comes from a client —
    // issueSessionCookie() in auth.js writes `isAdmin: !!user.isAdmin` into a
    // JWT this server signs, and requireAuth then rebuilds req.user from the
    // stored account record, not from the claim. Forging `isAdmin: "yes"`
    // therefore requires JWT_SECRET, at which point the attacker can simply
    // write `true`. If a future change ever lets this value originate outside
    // auth.js, it needs a real boolean check and this test should fail.
    assert.strictEqual(scope.isAdminSession({ isAdmin: "yes" }), true, "truthy passes — see above");
    assert.strictEqual(scope.isAdminSession({ isAdmin: true }), true);
    assert.strictEqual(scope.isAdminSession({ isAdmin: false }), false);
    assert.strictEqual(scope.isAdminSession({}), false);
});

// ── clampDays (GET /stats/sales) ─────────────────────────────────────────

test("an admin gets the window they asked for", () => {
    for (const days of [1, 7, 30, 90]) {
        const out = scope.clampDays(days, ADMIN);
        assert.strictEqual(out.days, days);
        assert.strictEqual(out.limited, false);
    }
});

test("staff keep the short windows untouched — the floor must not lose its screen", () => {
    for (const days of [1, 7]) {
        const out = scope.clampDays(days, WAITER);
        assert.strictEqual(out.days, days, `${days} days is a shift question and must be answered in full`);
        assert.strictEqual(out.limited, false, "and must not be flagged as limited");
    }
});

test("staff asking for a quarter get a week, and are told so", () => {
    for (const days of [30, 90]) {
        const out = scope.clampDays(days, WAITER);
        assert.strictEqual(out.days, scope.STAFF_HISTORY_DAYS);
        assert.strictEqual(out.limited, true, "the route needs this to explain the smaller number");
        assert.strictEqual(out.limitDays, scope.STAFF_HISTORY_DAYS);
    }
});

test("a nonsense window becomes the limit rather than everything", () => {
    for (const bad of [NaN, undefined, null, Infinity]) {
        const out = scope.clampDays(bad, WAITER);
        assert.strictEqual(out.days, scope.STAFF_HISTORY_DAYS, `${bad} must clamp, not open up`);
        assert.strictEqual(out.limited, true);
    }
});

// ── clampRange (GET /receipts) ───────────────────────────────────────────

test("an admin range passes through untouched, including no range at all", () => {
    const out = scope.clampRange("2020-01-01", "2026-08-11", ADMIN, NOW);
    assert.strictEqual(out.from, "2020-01-01");
    assert.strictEqual(out.to, "2026-08-11");
    assert.strictEqual(out.limited, false);

    const open = scope.clampRange(undefined, undefined, ADMIN, NOW);
    assert.strictEqual(open.from, undefined, "an admin with no range still means the whole archive");
    assert.strictEqual(open.limited, false);
});

test("THE FINDING: staff with no range do not get the whole archive", () => {
    // The unbounded default was the exposure. "No from" must mean "as far back
    // as you may see", not "everything ever issued".
    const out = scope.clampRange(undefined, undefined, WAITER, NOW);
    assert.strictEqual(out.limited, true);
    const from = new Date(out.from);
    const expected = new Date(NOW.getTime() - scope.STAFF_HISTORY_DAYS * 86400000);
    assert.strictEqual(from.getTime(), expected.getTime());
});

test("staff reaching further back are pulled forward to their limit", () => {
    const out = scope.clampRange("2020-01-01", null, WAITER, NOW);
    assert.strictEqual(out.limited, true);
    assert.ok(new Date(out.from) > new Date("2026-08-01"), `expected a clamp, got ${out.from}`);
});

test("a range inside the window is left exactly alone", () => {
    // Reprinting today's receipt, or a complaint about the weekend, must not be
    // flagged or altered.
    const yesterday = new Date(NOW.getTime() - 86400000).toISOString();
    const out = scope.clampRange(yesterday, null, WAITER, NOW);
    assert.strictEqual(out.from, yesterday, "an in-window request is not rewritten");
    assert.strictEqual(out.limited, false);
});

test("an unparseable from is clamped, not trusted", () => {
    // The route's own filter ignores an unreadable date. "Ignored" must not
    // become "unbounded" for a non-admin.
    for (const bad of ["not-a-date", "", "yesterday"]) {
        const out = scope.clampRange(bad, null, WAITER, NOW);
        assert.strictEqual(out.limited, true, `${JSON.stringify(bad)} must clamp`);
        assert.ok(new Date(out.from).getTime() > 0);
    }
});

test("`to` is never clamped — a future end date reveals nothing", () => {
    const out = scope.clampRange(undefined, "2099-01-01", WAITER, NOW);
    assert.strictEqual(out.to, "2099-01-01");
});

// ── secret stripping ─────────────────────────────────────────────────────

function slot(extra = {}) {
    return {
        content: "Jan Novák", abbreviation: "JN", isPermanent: false,
        phone: "+420600111222", guests: 2, cancelToken: "aBcDeFgHiJkLmNoPqRsTuV",
        ...extra,
    };
}

test("a slot loses its cancelToken and keeps everything else", () => {
    const cleaned = scope.stripSlotSecrets(slot({ order: [{ item: "Svíčková" }], isPaid: true }));
    assert.ok(!("cancelToken" in cleaned), "the guest's credential must not go on the wire");
    assert.strictEqual(cleaned.content, "Jan Novák");
    assert.strictEqual(cleaned.phone, "+420600111222", "staff legitimately see this");
    assert.strictEqual(cleaned.isPaid, true);
    assert.deepStrictEqual(cleaned.order, [{ item: "Svíčková" }]);
});

test("stripping does not mutate the stored record", () => {
    // The record handed in comes straight from db.list — mutating it would
    // corrupt whatever the caller writes back next.
    const original = slot();
    const record = { className: "Stůl 1", fileId: "t1", data: { "2026-09-14": [{ 5: original }] } };
    const cleaned = scope.stripTimetableSecrets(record);

    assert.ok(!("cancelToken" in cleaned.data["2026-09-14"][0][5]), "the copy is stripped");
    assert.strictEqual(original.cancelToken, "aBcDeFgHiJkLmNoPqRsTuV", "the original is untouched");
    assert.notStrictEqual(cleaned, record, "a new object is returned when something was stripped");
});

test("both grid shapes are handled — arrays and weekday-keyed objects", () => {
    // applyBookingToTimetable writes an array; PUT /timetables/:name accepts an
    // object. Missing one would leak through whichever was forgotten.
    const asArray = { fileId: "t1", data: { "2026-09-14": [{ 5: slot() }] } };
    const asObject = { fileId: "t2", data: { "2026-09-14": { "3": { 5: slot() } } } };

    assert.ok(!("cancelToken" in scope.stripTimetableSecrets(asArray).data["2026-09-14"][0][5]));
    assert.ok(!("cancelToken" in scope.stripTimetableSecrets(asObject).data["2026-09-14"]["3"][5]));
});

test("a record with nothing to strip is returned unchanged, by reference", () => {
    const clean = { fileId: "t1", data: { "2026-09-14": [{ 5: { content: "Host", isPermanent: false } }] } };
    assert.strictEqual(scope.stripTimetableSecrets(clean), clean, "the common path should allocate nothing");
});

test("malformed grids do not throw", () => {
    for (const record of [
        {}, { data: null }, { data: {} }, { data: { d: null } }, { data: { d: [null] } },
        { data: { d: [{ 5: null }] } }, { data: { d: "nonsense" } }, { data: { d: [{ 5: 42 }] } },
    ]) {
        assert.doesNotThrow(() => scope.stripTimetableSecrets(record), JSON.stringify(record));
    }
    assert.strictEqual(scope.stripTimetableSecrets(null), null);
});

test("only the listed secrets are stripped", () => {
    // A guard against this quietly becoming a general-purpose redactor: the
    // admin panel needs phone and guests to do its job.
    assert.deepStrictEqual(scope.SLOT_SECRETS, ["cancelToken"]);
});
