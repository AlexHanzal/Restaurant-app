const test = require("node:test");
const assert = require("node:assert");
const eet = require("../../src/server/eet");

test("only -1 and 8 are retryable", () => {
    assert.strictEqual(eet.classifyError(-1), "retry");
    assert.strictEqual(eet.classifyError(8), "retry");
    for (const code of [2, 3, 4, 6, 7]) {
        assert.strictEqual(eet.classifyError(code), "terminal", `code ${code}`);
    }
});

test("unknown/reserved codes are terminal, never silently retried", () => {
    for (const code of [-999, -2, 1, 5, 9, 999]) {
        assert.strictEqual(eet.classifyError(code), "terminal", `code ${code}`);
    }
});

test("parses a confirmation with POK", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:eet="http://fs.gov.cz/eet/schema/v4"><soapenv:Body><eet:Odpoved><eet:Hlavicka uuid_zpravy="abc" dat_prij="2026-07-31T12:06:12+02:00"/><eet:Potvrzeni pok="4ce219fe-b4ac-441b-83a8-986a62bc653f-ff" test="true"/></eet:Odpoved></soapenv:Body></soapenv:Envelope>`;
    const parsed = eet.parseResponse(xml);
    assert.strictEqual(parsed.pok, "4ce219fe-b4ac-441b-83a8-986a62bc653f-ff");
    assert.strictEqual(parsed.test, true);
    assert.strictEqual(parsed.errorCode, null);
});

test("parses an error response including its code and text", () => {
    const xml = `<eet:Odpoved xmlns:eet="http://fs.gov.cz/eet/schema/v4"><eet:Hlavicka uuid_zpravy="abc" dat_odmit="2026-07-31T12:06:12+02:00"/><eet:Chyba kod="4" test="true">Neplatny podpis SOAP zpravy</eet:Chyba></eet:Odpoved>`;
    const parsed = eet.parseResponse(xml);
    assert.strictEqual(parsed.errorCode, 4);
    assert.strictEqual(parsed.errorText, "Neplatny podpis SOAP zpravy");
    assert.strictEqual(parsed.pok, null);
});

test("parses warnings alongside a confirmation", () => {
    const xml = `<eet:Odpoved xmlns:eet="http://fs.gov.cz/eet/schema/v4"><eet:Potvrzeni pok="x-ff" test="true"/><eet:Varovani kod_varov="6">id_jednotky neodpovida formatem pridelenemu c. evidencni jednotky</eet:Varovani></eet:Odpoved>`;
    const parsed = eet.parseResponse(xml);
    assert.strictEqual(parsed.warnings.length, 1);
    assert.strictEqual(parsed.warnings[0].code, 6);
});

test("error code 0 in ověřovací mód is success, not failure", () => {
    const xml = `<eet:Odpoved xmlns:eet="http://fs.gov.cz/eet/schema/v4"><eet:Chyba kod="0" test="true">Datovou zpravu evidovane trzby v overovacim modu se podarilo zpracovat</eet:Chyba></eet:Odpoved>`;
    assert.strictEqual(eet.parseResponse(xml).errorCode, 0);
});
