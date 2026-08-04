const test = require("node:test");
const assert = require("node:assert");

// JWT_SECRET must be set before auth.js is required — it hard-fails in
// production without one and generates a random per-process secret
// otherwise, which would make these assertions non-deterministic.
process.env.JWT_SECRET = "test-secret-for-table-token-tests";

const tableToken = require("../../src/server/table-token");
const auth = require("../../src/server/auth");

test("mint then verify round-trips the fileId", () => {
    const token = tableToken.mintTableToken("abc123");
    assert.strictEqual(tableToken.verifyTableToken(token), "abc123");
});

test("a tampered signature is rejected", () => {
    const token = tableToken.mintTableToken("abc123");
    const [id, sig] = token.split(".");
    const flipped = sig.slice(0, -1) + (sig.slice(-1) === "A" ? "B" : "A");
    assert.strictEqual(tableToken.verifyTableToken(`${id}.${flipped}`), null);
});

test("a tampered fileId is rejected", () => {
    const token = tableToken.mintTableToken("abc123");
    const sig = token.split(".")[1];
    assert.strictEqual(tableToken.verifyTableToken(`abc124.${sig}`), null);
});

test("malformed input returns null rather than throwing", () => {
    for (const bad of ["", ".", "nodot", "a.b.c", null, undefined, 42, {}, "x".repeat(5000)]) {
        assert.strictEqual(tableToken.verifyTableToken(bad), null, `input: ${String(bad)}`);
    }
});

test("a token minted under a different epoch is rejected", () => {
    const token = tableToken.mintTableToken("abc123");
    delete require.cache[require.resolve("../../src/server/table-token")];
    process.env.TABLE_QR_EPOCH = "2";
    const rotated = require("../../src/server/table-token");
    assert.strictEqual(rotated.verifyTableToken(token), null);
    // …and its own tokens still work under the new epoch.
    assert.strictEqual(rotated.verifyTableToken(rotated.mintTableToken("abc123")), "abc123");
    delete process.env.TABLE_QR_EPOCH;
    delete require.cache[require.resolve("../../src/server/table-token")];
});

// ── KEY SEPARATION ──────────────────────────────────────────────────────
// This is the security property the whole module exists for: a table token
// is handed to anyone who photographs a QR code, so it must be incapable of
// authenticating as staff, and a stolen staff session must be incapable of
// impersonating a table. See src/server/auth.js:192.
//
// DEVIATION FROM PLAN: the plan's draft called these `auth.generateToken`
// and `auth.verifyToken`. auth.js's actual module.exports (checked before
// writing this file) has no `generateToken` — the signing function is
// named `signToken`, and it takes a plain payload object exactly like
// `issueSessionCookie` passes it: `{ id, name, isAdmin, isDriver }`.
// `verifyToken` is exported under that same name, so that half needed no
// change.
test("a staff JWT is not a valid table token", () => {
    const staffJwt = auth.signToken({ id: "u1", name: "AH", isAdmin: true, isDriver: false });
    assert.strictEqual(tableToken.verifyTableToken(staffJwt), null);
});

test("a table token is not a valid staff session", () => {
    const token = tableToken.mintTableToken("abc123");
    assert.strictEqual(auth.verifyToken(token), null);
});
