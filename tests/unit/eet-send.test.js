const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const eet = require("../../src/server/eet");

// Throwaway keypair — these tests exercise sendTrzba's HTTP/response-handling
// logic (via an injected fetchImpl), not the signature machinery already
// covered in eet-signature.test.js, so a real pokladní certifikát is not
// needed here.
function makeCreds() {
    const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    return { privateKey, certDer: Buffer.from("dummy-certificate-bytes").toString("base64") };
}

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

function fakeResponse(text, { ok = true, status = 200 } = {}) {
    return { ok, status, text: async () => text };
}

const POK_XML = `<eet:Odpoved xmlns:eet="http://fs.gov.cz/eet/schema/v4"><eet:Potvrzeni pok="4ce219fe-b4ac-441b-83a8-986a62bc653f-ff" test="true"/></eet:Odpoved>`;
const VERIFY_SUCCESS_XML = `<eet:Odpoved xmlns:eet="http://fs.gov.cz/eet/schema/v4"><eet:Chyba kod="0" test="true">Datovou zpravu evidovane trzby v overovacim modu se podarilo zpracovat</eet:Chyba></eet:Odpoved>`;
const REJECT_XML = `<eet:Odpoved xmlns:eet="http://fs.gov.cz/eet/schema/v4"><eet:Chyba kod="4" test="true">Neplatny podpis SOAP zpravy</eet:Chyba></eet:Odpoved>`;

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

// ----------------------------------------------------------------------------
// Finding 1 (Critical): verifyConnection's entire job is to send with
// overeni:true and read back the ověřovací-mode success shape — code 0, no
// Potvrzeni/pok at all. sendTrzba computed `ok: !!parsed.pok`, so a healthy
// verification round-trip was reported as ok:false. Cover both shapes that
// must produce ok:true: a real POK, and a code-0 verification response with
// no POK.
// ----------------------------------------------------------------------------

test("sendTrzba: ok is true for a POK response", async () => {
    const fetchImpl = async () => fakeResponse(POK_XML);
    const result = await eet.sendTrzba({ credentials: makeCreds(), fetchImpl }, SALE);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.pok, "4ce219fe-b4ac-441b-83a8-986a62bc653f-ff");
});

test("sendTrzba: ok is true for a code-0 ověřovací-mode success with no POK", async () => {
    const fetchImpl = async () => fakeResponse(VERIFY_SUCCESS_XML);
    const result = await eet.sendTrzba({ credentials: makeCreds(), fetchImpl }, { ...SALE, overeni: true });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.pok, null);
    assert.strictEqual(result.errorCode, 0);
});

test("verifyConnection: ok is true for a code-0 response", async () => {
    const fetchImpl = async () => fakeResponse(VERIFY_SUCCESS_XML);
    const result = await eet.verifyConnection({ credentials: makeCreds(), fetchImpl }, SALE);
    assert.strictEqual(result.ok, true);
});

// ----------------------------------------------------------------------------
// Finding 2 (Critical): AbortSignal.timeout's rejection, and any other
// transport-level rejection (DNS, ECONNRESET, TLS), used to propagate
// uncaught — only the manually-built non-2xx error got err.retryable = true.
// A caller branching on err.retryable would treat a timed-out sale as
// non-retryable and silently fail to report it, which EET requires within 48
// hours. Every transport failure must throw retryable:true.
// ----------------------------------------------------------------------------

test("a timeout throws a retryable error naming the duration", async () => {
    // Mirrors what Node/undici actually does when AbortSignal.timeout fires:
    // the fetch promise rejects with a DOMException named "TimeoutError" once
    // the signal aborts. Driving it off the real signal (rather than
    // rejecting immediately) exercises the real timeoutMs wiring.
    //
    // AbortSignal.timeout()'s own internal timer is deliberately unref'd (per
    // Node's docs), so nothing here would otherwise keep the event loop open
    // long enough for it to fire — a real deployment always has other refd
    // handles around (an HTTP server, etc.), a bare unit test does not. Hold
    // the loop open ourselves and release it the moment the real abort fires.
    const fetchImpl = (url, opts) => new Promise((resolve, reject) => {
        const keepAlive = setTimeout(() => {}, 5000);
        opts.signal.addEventListener("abort", () => {
            clearTimeout(keepAlive);
            reject(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
        });
    });

    await assert.rejects(
        () => eet.sendTrzba({ credentials: makeCreds(), fetchImpl, timeoutMs: 10 }, SALE),
        (err) => {
            assert.strictEqual(err.retryable, true, "timeout errors must be retryable");
            assert.match(err.message, /timed out/i);
            assert.match(err.message, /10/, "message should name the timeout duration");
            return true;
        },
    );
});

test("a generic network rejection (DNS/ECONNRESET/TLS) is retryable and keeps its message", async () => {
    const fetchImpl = async () => { throw new Error("getaddrinfo ENOTFOUND pg.trzbyeet.gov.cz"); };

    await assert.rejects(
        () => eet.sendTrzba({ credentials: makeCreds(), fetchImpl }, SALE),
        (err) => {
            assert.strictEqual(err.retryable, true);
            assert.strictEqual(err.message, "getaddrinfo ENOTFOUND pg.trzbyeet.gov.cz");
            return true;
        },
    );
});

// ----------------------------------------------------------------------------
// Finding 3 (Important): sendTrzba itself had zero test coverage — only
// parseResponse/classifyError were exercised. fetchImpl makes it testable
// without network. Cover: an EET-level rejection does not throw and reports
// ok:false with the right errorCode; a non-2xx HTTP status throws retryable;
// the playground/production URL choice; and the exact SOAPAction/Content-Type
// headers the live endpoint actually requires.
// ----------------------------------------------------------------------------

test("sendTrzba: a <Chyba kod=4> EET rejection does not throw and reports ok:false", async () => {
    const fetchImpl = async () => fakeResponse(REJECT_XML);
    const result = await eet.sendTrzba({ credentials: makeCreds(), fetchImpl }, SALE);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, 4);
    assert.strictEqual(result.errorText, "Neplatny podpis SOAP zpravy");
});

test("sendTrzba: a non-2xx HTTP status throws with retryable:true", async () => {
    const fetchImpl = async () => fakeResponse("", { ok: false, status: 500 });
    await assert.rejects(
        () => eet.sendTrzba({ credentials: makeCreds(), fetchImpl }, SALE),
        (err) => {
            assert.strictEqual(err.retryable, true);
            assert.match(err.message, /500/);
            return true;
        },
    );
});

test("sendTrzba: uses the playground URL when playground:true", async () => {
    let calledUrl;
    const fetchImpl = async (url) => { calledUrl = url; return fakeResponse(POK_XML); };
    await eet.sendTrzba({ credentials: makeCreds(), fetchImpl, playground: true }, SALE);
    assert.strictEqual(calledUrl, eet.PLAYGROUND_URL);
});

test("sendTrzba: uses the production URL when playground is false/omitted", async () => {
    let calledUrl;
    const fetchImpl = async (url) => { calledUrl = url; return fakeResponse(POK_XML); };
    await eet.sendTrzba({ credentials: makeCreds(), fetchImpl, playground: false }, SALE);
    assert.strictEqual(calledUrl, eet.PRODUCTION_URL);
});

test("sendTrzba: sends the exact SOAPAction and Content-Type headers", async () => {
    let calledOpts;
    const fetchImpl = async (url, opts) => { calledOpts = opts; return fakeResponse(POK_XML); };
    await eet.sendTrzba({ credentials: makeCreds(), fetchImpl }, SALE);
    assert.strictEqual(calledOpts.headers["Content-Type"], "text/xml; charset=utf-8");
    assert.strictEqual(calledOpts.headers.SOAPAction, "http://fs.gov.cz/eet/OdeslaniTrzby");
});
