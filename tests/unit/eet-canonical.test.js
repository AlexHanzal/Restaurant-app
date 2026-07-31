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
