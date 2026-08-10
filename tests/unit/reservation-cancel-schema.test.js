// ============================================================================
// reservation-cancel-schema.test.js — the shape gate in front of the
// cancellation routes.
//
// Spec: docs/superpowers/specs/2026-08-09-reservation-self-cancellation-design.md
//
// Why this is worth its own file rather than being left to the smoke suite:
// findBooking() walks EVERY timetable record and every date inside each one,
// and both routes carrying these schemas are public. The schema is what turns
// a junk token away before it can buy that scan, so "rejects junk" is a
// load-bearing property here, not input tidiness.
// ============================================================================

const test = require("node:test");
const assert = require("node:assert");

const V = require("../../src/server/validation");

// 16 random bytes as base64url — exactly what reservation-cancel.newToken()
// produces.
const GOOD = "aBcDeFgHiJkLmNoPqRsTuV";

test("a real token is accepted by both schemas", () => {
    assert.strictEqual(GOOD.length, 22, "fixture must match the real token length");
    assert.strictEqual(V.cancelQuerySchema.safeParse({ t: GOOD }).success, true);
    assert.strictEqual(V.cancelBodySchema.safeParse({ token: GOOD }).success, true);
});

test("surrounding whitespace is trimmed rather than rejected", () => {
    // A token pasted out of an SMS often arrives with a trailing space.
    const parsed = V.cancelBodySchema.safeParse({ token: `  ${GOOD}  ` });
    assert.strictEqual(parsed.success, true);
    assert.strictEqual(parsed.data.token, GOOD);
});

test("anything that is not a 22-char base64url token is refused", () => {
    const bad = [
        {},                                   // missing entirely
        { t: "" },
        { t: "short" },
        { t: "a".repeat(21) },                // one too few
        { t: "a".repeat(23) },                // one too many
        { t: "a".repeat(200) },
        { t: "has spaces here!!!!!!" },       // 21 chars, wrong alphabet
        { t: "aBcDeFgHiJkLmNoPqRsTu+" },      // base64, not base64url
        { t: "aBcDeFgHiJkLmNoPqRsTu/" },
        { t: 1234 },                          // a number, not a string
        { t: ["aBcDeFgHiJkLmNoPqRsTuV"] },    // an array, not a string
        { t: null },
    ];
    for (const input of bad) {
        assert.strictEqual(
            V.cancelQuerySchema.safeParse(input).success, false,
            `${JSON.stringify(input)} must be refused`
        );
    }
});

test("unknown fields are refused rather than ignored", () => {
    // .strict() on both: these routes carry one value each, so anything else
    // is a client bug worth hearing about.
    assert.strictEqual(V.cancelQuerySchema.safeParse({ t: GOOD, extra: "x" }).success, false);
    assert.strictEqual(V.cancelBodySchema.safeParse({ token: GOOD, extra: "x" }).success, false);
});

test("the two schemas do not accept each other's field name", () => {
    assert.strictEqual(V.cancelQuerySchema.safeParse({ token: GOOD }).success, false);
    assert.strictEqual(V.cancelBodySchema.safeParse({ t: GOOD }).success, false);
});

test("the refusal message is the Czech one the page shows", () => {
    const parsed = V.cancelQuerySchema.safeParse({ t: "nope" });
    assert.strictEqual(parsed.success, false);
    assert.match(parsed.error.issues[0].message, /Neplatný odkaz na rezervaci/);
});
