const test = require("node:test");
const assert = require("node:assert");
const { safeReturnUrl } = require("../../src/server/urlsafe");

const OWN = "https://restaurace.example";

test("accepts an absolute URL on the same origin", () => {
    assert.equal(safeReturnUrl(OWN, `${OWN}/reservation/delivery`), `${OWN}/reservation/delivery`);
});

test("accepts a relative path (resolves onto own origin)", () => {
    assert.equal(safeReturnUrl(OWN, "/reservation/app"), "/reservation/app");
});

test("rejects a foreign origin", () => {
    assert.equal(safeReturnUrl(OWN, "https://evil.example/platba"), null);
});

test("rejects a protocol-relative URL pointing off-origin", () => {
    // "//evil.example/x" resolves against the base's scheme -> https://evil.example/x
    assert.equal(safeReturnUrl(OWN, "//evil.example/x"), null);
});

test("rejects the javascript: scheme", () => {
    assert.equal(safeReturnUrl(OWN, "javascript:alert(1)"), null);
});

test("rejects a same-host URL on a different port", () => {
    assert.equal(safeReturnUrl(OWN, "https://restaurace.example:8443/x"), null);
});

test("rejects a same-host URL over plain http when own origin is https", () => {
    assert.equal(safeReturnUrl(OWN, "http://restaurace.example/x"), null);
});

test("rejects a host that merely starts with the own host", () => {
    assert.equal(safeReturnUrl(OWN, "https://restaurace.example.evil.test/x"), null);
});

test("returns null for missing / empty / non-string input", () => {
    assert.equal(safeReturnUrl(OWN, undefined), null);
    assert.equal(safeReturnUrl(OWN, null), null);
    assert.equal(safeReturnUrl(OWN, ""), null);
    assert.equal(safeReturnUrl(OWN, 42), null);
    assert.equal(safeReturnUrl(OWN, { toString: () => `${OWN}/x` }), null);
});

test("returns null when own origin is itself missing or unparseable", () => {
    assert.equal(safeReturnUrl("", `${OWN}/x`), null);
    assert.equal(safeReturnUrl("not a url", `${OWN}/x`), null);
});

test("does not throw on malformed candidates", () => {
    assert.equal(safeReturnUrl(OWN, "http://["), null);       // invalid IPv6 host
    assert.equal(safeReturnUrl(OWN, "https://exa mple.com"), null); // space in host
    assert.equal(safeReturnUrl(OWN, "http://"), null);        // no host at all
});

// Documents a deliberate behaviour that is easy to mistake for a bug: "%%%"
// LOOKS malformed but is a perfectly legal relative path to the WHATWG URL
// parser (a percent sign not followed by valid hex is kept literally, not
// rejected). It therefore resolves onto our own origin and is accepted, via
// exactly the same code path as the ordinary "/reservation/app" case above.
// That is correct — a relative path cannot navigate the user off-origin,
// which is the only thing this function exists to prevent.
test("accepts an odd but valid relative path", () => {
    assert.equal(safeReturnUrl(OWN, "%%%"), "%%%");
});
