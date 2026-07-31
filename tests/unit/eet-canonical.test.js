const test = require("node:test");
const assert = require("node:assert");
const eet = require("../../src/server/eet");

const SALE = {
    uuidZpravy: "8e6a724c-e040-4840-bb01-5e8a64d0c910",
    datOdesl: "2026-07-31T12:00:00+02:00",
    datTrzby: "2026-07-31T11:55:00+02:00",
    prvniZaslani: true,
    eic: "CZ00000019",
    idJednotky: 11,
    idPokl: "INDOOR",
    poradCis: "2026-000001",
    celkTrzba: 349,
};

test("body has no self-closing tags", () => {
    const body = eet.buildTrzbaBody(SALE);
    assert.ok(!/\/>/.test(body), `found a self-closing tag in: ${body}`);
});

test("amounts always carry exactly two decimals", () => {
    assert.match(eet.buildTrzbaBody(SALE), /celk_trzba="349\.00"/);
    assert.match(eet.buildTrzbaBody({ ...SALE, celkTrzba: 12.5 }), /celk_trzba="12\.50"/);
    assert.match(eet.buildTrzbaBody({ ...SALE, celkTrzba: "8" }), /celk_trzba="8\.00"/);
});

test("negative amounts (storno) are supported", () => {
    assert.match(eet.buildTrzbaBody({ ...SALE, celkTrzba: -349 }), /celk_trzba="-349\.00"/);
});

test("Data attributes are sorted alphabetically", () => {
    const body = eet.buildTrzbaBody(SALE);
    const attrs = [...body.matchAll(/(\w+)="[^"]*"/g)]
        .map(m => m[1])
        .filter(n => ["celk_trzba", "dat_trzby", "eic_popl", "id_jednotky", "id_pokl", "porad_cis"].includes(n));
    assert.deepStrictEqual(attrs, [...attrs].sort());
});

test("namespace declarations precede attributes on Body", () => {
    const body = eet.buildTrzbaBody(SALE);
    assert.ok(body.indexOf('xmlns:soapenv') < body.indexOf('wsu:Id'));
    assert.ok(body.indexOf('xmlns:soapenv') < body.indexOf('xmlns:wsu'), "prefixes sort alphabetically");
});

test("overeni attribute appears only when requested", () => {
    assert.ok(!eet.buildTrzbaBody(SALE).includes("overeni"));
    assert.match(eet.buildTrzbaBody({ ...SALE, overeni: true }), /overeni="true"/);
});

test("escapeAttr escapes the C14N set but NOT the greater-than sign", () => {
    assert.strictEqual(eet.escapeAttr(`a&b<c"d>e`), `a&amp;b&lt;c&quot;d>e`);
    assert.strictEqual(eet.escapeAttr("a\tb\nc\rd"), "a&#x9;b&#xA;c&#xD;d");
});

test("no whitespace between elements", () => {
    assert.ok(!/>\s+</.test(eet.buildTrzbaBody(SALE)));
});

// The "Data attributes are sorted alphabetically" test above is vacuous: every
// call site already passes pairs in alphabetical order, so it would pass even
// if attrs() never sorted at all. Exercise attrs() directly with deliberately
// scrambled input so the sort itself is what's under test.
test("attrs() sorts deliberately out-of-order pairs", () => {
    const out = eet.attrs([
        ["porad_cis", "2026-000001"],
        ["eic_popl", "CZ00000019"],
        ["celk_trzba", "349.00"],
        ["id_pokl", "INDOOR"],
        ["id_jednotky", "11"],
        ["dat_trzby", "2026-07-31T11:55:00+02:00"],
    ]);
    const names = [...out.matchAll(/(\w+)="/g)].map(m => m[1]);
    assert.deepStrictEqual(names, [...names].sort());
    assert.deepStrictEqual(names, [
        "celk_trzba", "dat_trzby", "eic_popl", "id_jednotky", "id_pokl", "porad_cis",
    ]);
});

// The XSD's dateTime pattern requires a timezone offset (Z or +hh:mm/-hh:mm)
// and forbids fractional seconds. A naive timestamp or one with milliseconds
// (exactly what `new Date().toISOString()` produces) builds XML that looks
// fine locally but is rejected by the live endpoint with no useful diagnostic.
test("accepts a Z-offset timestamp", () => {
    const sale = { ...SALE, datOdesl: "2026-07-31T12:00:00Z", datTrzby: "2026-07-31T11:55:00Z" };
    assert.doesNotThrow(() => eet.buildTrzbaBody(sale));
});

test("accepts a +02:00-offset timestamp", () => {
    // SALE's own fixture timestamps already carry +02:00 offsets.
    assert.doesNotThrow(() => eet.buildTrzbaBody(SALE));
});

test("rejects a naive timestamp with no timezone offset", () => {
    const sale = { ...SALE, datOdesl: "2026-07-31T12:00:00" };
    assert.throws(() => eet.buildTrzbaBody(sale), /datOdesl/);
});

test("rejects a timestamp with milliseconds (the Date#toISOString() trap)", () => {
    const sale = { ...SALE, datTrzby: "2026-07-31T12:00:00.000Z" };
    assert.throws(() => eet.buildTrzbaBody(sale), /datTrzby/);
});
