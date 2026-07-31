# EET 2.0 Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Report every confirmed sale to Finanční správa via the EET 2.0 SOAP interface (v4.1), with a persistent retry queue so an outage never loses a sale.

**Architecture:** Two new modules. `eet.js` is pure and stateless — it builds canonical XML, signs it with WS-Security, sends it, and classifies errors. `eet-queue.js` owns persistence and retry. `createReceiptForOrder()` in `server.js` stays synchronous and enqueues; sending is a separate awaited call. The queue is the source of truth; the synchronous send only exists to get a POK onto the receipt before it prints.

**Tech Stack:** Node 22+, Express 5, better-sqlite3, `node:crypto`, built-in `fetch`. **No new npm dependencies.**

**Spec:** `docs/superpowers/specs/2026-07-31-eet2-integration-design.md`

## Global Constraints

- **Zero new npm dependencies.** Project convention (see `gopay.js` header): built-in `fetch`, no SDKs.
- **Interface version v4.1**, namespace `http://fs.gov.cz/eet/schema/v4`.
- Playground endpoint: `https://pg.trzbyeet.gov.cz/eet/services/EETServiceSOAP/v4`
- SOAPAction: `http://fs.gov.cz/eet/OdeslaniTrzby`
- Signature: Exclusive C14N (`http://www.w3.org/2001/10/xml-exc-c14n#`), digest SHA-256 (`http://www.w3.org/2001/04/xmlenc#sha256`), signature RSA-SHA256 (`http://www.w3.org/2001/04/xmldsig-more#rsa-sha256`).
- Sign **exactly one** element: `soap:Body`. No Timestamp, no WS-Addressing — the spec warns extra headers may be treated as an attack.
- `celk_trzba` must serialise with **exactly two decimals**.
- `dat_trzby` / `dat_odesl` must carry a timezone offset (`Z` or `±HH:MM`).
- Czech error texts from EET arrive **without diacritics** (spec §3.1). Never "fix" them.
- Secrets (`secrets/`, `.env`) must never be committed.
- Comment density and style: match the surrounding codebase, which is heavily commented with *why*, not *what*.

### Canonical XML rules (violating any of these breaks the signature)

- **No self-closing tags.** `<eet:Data/>` must be `<eet:Data></eet:Data>`.
- Attribute values escape **only** `&` `<` `"` `#x9` `#xA` `#xD`. **`>` is NOT escaped in attribute values** — escaping it makes the server's re-canonicalisation differ from our bytes and the digest fails.
- Attributes sort by namespace URI, then local name.
- Namespace declarations precede attributes, sorted by prefix.
- No comments, no processing instructions, no whitespace between elements.
- UTF-8, no BOM.

---

### Task 0: Repository and test-environment prerequisites

The project is not a git repo and cannot run from OneDrive. Both must be fixed before any TDD cycle works.

**Files:**
- Create: `.gitignore` entries, `secrets/.gitkeep`

- [ ] **Step 1: Verify what would be committed — do NOT skip this**

```bash
cd "code/restaurace-github-ready"
ls -la data/ 2>/dev/null
ls -la .env 2>/dev/null
ls -la secrets/ 2>/dev/null
```

Expected: `data/app.db` likely exists and contains **real order data**. `.env` may exist with **live GoPay/Twilio credentials**. Neither may ever be committed.

- [ ] **Step 2: Confirm .gitignore already covers the dangerous paths**

Read the existing `.gitignore`. It must contain `node_modules`, `data/`, and `.env`. If any is missing, add it now, before `git init`.

Append the new secrets directory:

```
# EET 2.0 pokladní certifikát (PEM, converted from .p12) — NEVER commit
secrets/
```

- [ ] **Step 3: Initialise the repository**

```bash
git init
git add -A
git status --short
```

Read the `git status` output in full. If `data/`, `.env`, or `secrets/` appear, **stop** and fix `.gitignore` before continuing.

- [ ] **Step 4: First commit**

```bash
git commit -m "chore: initialise repository"
```

- [ ] **Step 5: Create the local working copy for running tests**

OneDrive placeholder files break `npm install` and `node --test` in place. Copy to local disk, excluding `data/`:

```bash
ROBO_SRC="$(pwd)"
mkdir -p /c/dev/restaurace
cp -r src tests package.json package-lock.json docs /c/dev/restaurace/
cd /c/dev/restaurace && npm install
```

- [ ] **Step 6: Verify the existing test suite passes before changing anything**

Run: `cd /c/dev/restaurace && node --test "tests/unit/**/*.test.js"`
Expected: PASS — existing `smscap` and `urlsafe` tests green. If they fail now, fix that before adding EET work on top.

- [ ] **Step 7: Commit**

```bash
git add .gitignore
git commit -m "chore: ignore secrets/ ahead of EET certificate handling"
```

---

### Task 1: Canonical XML body builder

The riskiest part of the whole feature, isolated into a pure function with no crypto and no network.

**Files:**
- Create: `src/server/eet.js`
- Test: `tests/unit/eet-canonical.test.js`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `escapeAttr(value: string) → string`
  - `buildTrzbaBody(sale) → string` where `sale` is
    `{ uuidZpravy, datOdesl, datTrzby, prvniZaslani: boolean, overeni?: boolean, eic, idJednotky, idPokl, poradCis, celkTrzba: number|string }`
  - Constants `EET_NS`, `SOAP_NS`, `WSSE_NS`, `WSU_NS`, `DS_NS`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/eet-canonical.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /c/dev/restaurace && node --test tests/unit/eet-canonical.test.js`
Expected: FAIL — `Cannot find module '../../src/server/eet'`

- [ ] **Step 3: Write the implementation**

Create `src/server/eet.js`:

```js
// ============================================================================
// eet.js — EET 2.0 (Elektronická evidence tržeb) client, datové rozhraní v4.1
// ============================================================================
//
// Talks to Finanční správa's SOAP interface using Node's built-in fetch and
// node:crypto — no SDK, no XML library, per project convention (same as
// gopay.js).
//
// THE CENTRAL IDEA: EET requires an XML-DSig signature over <soap:Body> using
// Exclusive C14N. Rather than build XML and then canonicalise it (which would
// need a full XML stack), we EMIT THE BODY ALREADY IN CANONICAL FORM and
// digest those exact bytes. That is only safe because we author 100% of this
// XML — no user-controlled markup ever reaches it, and every attribute value
// is a UUID, ISO timestamp, EIČ, decimal, or a string the XSD restricts to
// [0-9a-zA-Z.,:;/#\-_ ]. Attribute escaping is implemented regardless, so if
// that assumption ever weakens the code degrades to "still correct".
//
// The canonical-form rules that MUST hold (each has a test in
// tests/unit/eet-canonical.test.js — read them before editing anything here):
//   - no self-closing tags: <x/> must be <x></x>
//   - attribute values escape only & < " #x9 #xA #xD — NOT '>'. Escaping '>'
//     would make the server's re-canonicalisation differ from our bytes and
//     the digest would fail.
//   - attributes sorted by namespace URI then local name
//   - namespace declarations before attributes, sorted by prefix
//   - no comments, no PIs, no inter-element whitespace, UTF-8 without BOM
//
// EET 2.0 vs 1.0: BKP and PKP no longer exist, and neither does the VAT
// breakdown. A sale is just eic_popl + id_jednotky + id_pokl + porad_cis +
// dat_trzby + celk_trzba. Do not port 1.0 receipt-code logic into here.
// ============================================================================

const EET_NS = "http://fs.gov.cz/eet/schema/v4";
const SOAP_NS = "http://schemas.xmlsoap.org/soap/envelope/";
const WSSE_NS = "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd";
const WSU_NS = "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd";
const DS_NS = "http://www.w3.org/2000/09/xmldsig#";

const BODY_ID = "Body";
const TOKEN_ID = "X509Token";

// Canonical XML attribute-value escaping (https://www.w3.org/TR/xml-c14n/
// §Processing Model). Deliberately does NOT escape '>' — see header.
function escapeAttr(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/"/g, "&quot;")
        .replace(/\t/g, "&#x9;")
        .replace(/\n/g, "&#xA;")
        .replace(/\r/g, "&#xD;");
}

// Emits attributes sorted by local name. Every attribute we produce is in no
// namespace (only wsu:Id is namespaced, and it is emitted by hand), so sorting
// by local name alone satisfies C14N's "namespace URI then local name" rule.
function attrs(pairs) {
    return pairs
        .filter(([, v]) => v !== undefined && v !== null && v !== "")
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map(([k, v]) => ` ${k}="${escapeAttr(v)}"`)
        .join("");
}

// The XSD pattern for CastkaType demands exactly two decimal places:
// ((0|-?[1-9]\d{0,7})\.\d\d|-0\.(0[1-9]|[1-9]\d)). A total of 349 serialised
// as "349" is rejected outright with error code 3.
function formatAmount(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error(`EET: amount is not a number: ${value}`);
    return n.toFixed(2);
}

// Returns <soapenv:Body> ... </soapenv:Body> already in exclusive-canonical
// form. This exact string is what gets digested AND what gets embedded in the
// envelope — they must never diverge.
function buildTrzbaBody(sale) {
    const hlavicka = attrs([
        ["dat_odesl", sale.datOdesl],
        ["overeni", sale.overeni ? "true" : undefined],
        ["prvni_zaslani", sale.prvniZaslani ? "true" : "false"],
        ["uuid_zpravy", sale.uuidZpravy],
    ]);

    const data = attrs([
        ["celk_trzba", formatAmount(sale.celkTrzba)],
        ["dat_trzby", sale.datTrzby],
        ["eic_popl", sale.eic],
        ["id_jednotky", String(sale.idJednotky)],
        ["id_pokl", sale.idPokl],
        ["porad_cis", sale.poradCis],
    ]);

    return `<soapenv:Body xmlns:soapenv="${SOAP_NS}" xmlns:wsu="${WSU_NS}" wsu:Id="${BODY_ID}">`
        + `<eet:Trzba xmlns:eet="${EET_NS}">`
        + `<eet:Hlavicka${hlavicka}></eet:Hlavicka>`
        + `<eet:Data${data}></eet:Data>`
        + `</eet:Trzba>`
        + `</soapenv:Body>`;
}

module.exports = {
    EET_NS, SOAP_NS, WSSE_NS, WSU_NS, DS_NS, BODY_ID, TOKEN_ID,
    escapeAttr, formatAmount, buildTrzbaBody,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /c/dev/restaurace && node --test tests/unit/eet-canonical.test.js`
Expected: PASS — 8 tests.

- [ ] **Step 5: Copy back to the OneDrive working tree and commit**

```bash
cp /c/dev/restaurace/src/server/eet.js src/server/eet.js
cp /c/dev/restaurace/tests/unit/eet-canonical.test.js tests/unit/eet-canonical.test.js
git add src/server/eet.js tests/unit/eet-canonical.test.js
git commit -m "feat(eet): canonical XML body builder for EET 2.0 v4.1"
```

---

### Task 2: WS-Security signing

**Files:**
- Modify: `src/server/eet.js`
- Test: `tests/unit/eet-signature.test.js`

**Interfaces:**
- Consumes: `buildTrzbaBody`, `escapeAttr`, namespace constants from Task 1
- Produces:
  - `loadCredentials({ certPem, keyPem, keyPassphrase }) → { certDer: string (base64), privateKey: KeyObject }`
  - `buildSignedEnvelope(bodyXml, creds) → string`
  - `signedInfoFor(bodyXml) → string` (exported for tests)

- [ ] **Step 1: Write the failing test**

Create `tests/unit/eet-signature.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const eet = require("../../src/server/eet");

// Self-signed throwaway keypair — this test proves canonicalisation and digest
// wiring, not trust chains, so a real pokladní certifikát is not needed.
function makeCreds() {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    return {
        privateKey,
        publicKey,
        certDer: Buffer.from("dummy-certificate-bytes").toString("base64"),
    };
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

test("digest in SignedInfo is the SHA-256 of the exact body bytes", () => {
    const body = eet.buildTrzbaBody(SALE);
    const expected = crypto.createHash("sha256").update(body, "utf8").digest("base64");
    assert.ok(eet.signedInfoFor(body).includes(`<ds:DigestValue>${expected}</ds:DigestValue>`));
});

test("signature verifies against the public key over canonical SignedInfo", () => {
    const creds = makeCreds();
    const body = eet.buildTrzbaBody(SALE);
    const envelope = eet.buildSignedEnvelope(body, creds);

    const sigValue = envelope.match(/<ds:SignatureValue>([^<]+)<\/ds:SignatureValue>/)[1];
    const ok = crypto.verify(
        "sha256",
        Buffer.from(eet.signedInfoFor(body), "utf8"),
        creds.publicKey,
        Buffer.from(sigValue, "base64"),
    );
    assert.strictEqual(ok, true);
});

test("envelope embeds the body byte-for-byte", () => {
    const creds = makeCreds();
    const body = eet.buildTrzbaBody(SALE);
    assert.ok(eet.buildSignedEnvelope(body, creds).includes(body));
});

test("SignedInfo declares its own ds namespace", () => {
    assert.match(eet.signedInfoFor(eet.buildTrzbaBody(SALE)), /<ds:SignedInfo xmlns:ds="/);
});

test("envelope carries the certificate as a BinarySecurityToken", () => {
    const creds = makeCreds();
    const envelope = eet.buildSignedEnvelope(eet.buildTrzbaBody(SALE), creds);
    assert.ok(envelope.includes(creds.certDer));
    assert.match(envelope, /wsu:Id="X509Token"/);
    assert.match(envelope, /URI="#X509Token"/);
});

test("no self-closing tags anywhere in the envelope", () => {
    const creds = makeCreds();
    assert.ok(!/\/>/.test(eet.buildSignedEnvelope(eet.buildTrzbaBody(SALE), creds)));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /c/dev/restaurace && node --test tests/unit/eet-signature.test.js`
Expected: FAIL — `eet.signedInfoFor is not a function`

- [ ] **Step 3: Write the implementation**

Add to `src/server/eet.js` (before `module.exports`, and extend the exports):

```js
const crypto = require("node:crypto");
const fs = require("node:fs");

// WHY SignedInfo declares xmlns:ds itself: when the server verifies, it
// canonicalises the SignedInfo SUBTREE. In subtree canonicalisation
// SignedInfo is the apex, so exc-c14n always renders the ds declaration on it
// regardless of where the document declared it. Emitting it here makes our
// bytes identical to the server's canonical form. Omit it and the signature
// fails with error code 4 — with no clue as to why.
function signedInfoFor(bodyXml) {
    const digest = crypto.createHash("sha256").update(bodyXml, "utf8").digest("base64");
    return `<ds:SignedInfo xmlns:ds="${DS_NS}">`
        + `<ds:CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"></ds:CanonicalizationMethod>`
        + `<ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"></ds:SignatureMethod>`
        + `<ds:Reference URI="#${BODY_ID}">`
        + `<ds:Transforms>`
        + `<ds:Transform Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"></ds:Transform>`
        + `</ds:Transforms>`
        + `<ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"></ds:DigestMethod>`
        + `<ds:DigestValue>${digest}</ds:DigestValue>`
        + `</ds:Reference>`
        + `</ds:SignedInfo>`;
}

// node:crypto has NO PKCS#12 support — createPrivateKey accepts PEM/DER only.
// The pokladní certifikát from MOJE daně arrives as .p12 and must be converted
// once at deploy time:
//   openssl pkcs12 -in pokladni.p12 -clcerts -nokeys -out secrets/eet-cert.pem
//   openssl pkcs12 -in pokladni.p12 -nocerts -nodes -out secrets/eet-key.pem
function loadCredentials({ certPem, keyPem, keyPassphrase }) {
    const certText = fs.readFileSync(certPem, "utf8");
    const match = certText.match(/-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/);
    if (!match) throw new Error(`EET: no PEM certificate found in ${certPem}`);

    const privateKey = crypto.createPrivateKey({
        key: fs.readFileSync(keyPem, "utf8"),
        ...(keyPassphrase ? { passphrase: keyPassphrase } : {}),
    });

    // BinarySecurityToken carries the DER bytes base64'd on a single line.
    return { certDer: match[1].replace(/\s+/g, ""), privateKey };
}

function buildSignedEnvelope(bodyXml, creds) {
    const signedInfo = signedInfoFor(bodyXml);
    const signature = crypto
        .sign("sha256", Buffer.from(signedInfo, "utf8"), creds.privateKey)
        .toString("base64");

    return `<?xml version="1.0" encoding="UTF-8"?>`
        + `<soapenv:Envelope xmlns:soapenv="${SOAP_NS}">`
        + `<soapenv:Header>`
        + `<wsse:Security xmlns:wsse="${WSSE_NS}" xmlns:wsu="${WSU_NS}" soapenv:mustUnderstand="1">`
        + `<wsse:BinarySecurityToken`
        + ` EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary"`
        + ` ValueType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-x509-token-profile-1.0#X509v3"`
        + ` wsu:Id="${TOKEN_ID}">${creds.certDer}</wsse:BinarySecurityToken>`
        + `<ds:Signature xmlns:ds="${DS_NS}">`
        + signedInfo
        + `<ds:SignatureValue>${signature}</ds:SignatureValue>`
        + `<ds:KeyInfo>`
        + `<wsse:SecurityTokenReference>`
        + `<wsse:Reference URI="#${TOKEN_ID}"`
        + ` ValueType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-x509-token-profile-1.0#X509v3"></wsse:Reference>`
        + `</wsse:SecurityTokenReference>`
        + `</ds:KeyInfo>`
        + `</ds:Signature>`
        + `</wsse:Security>`
        + `</soapenv:Header>`
        + bodyXml
        + `</soapenv:Envelope>`;
}
```

Extend `module.exports` with `signedInfoFor, loadCredentials, buildSignedEnvelope`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /c/dev/restaurace && node --test tests/unit/eet-signature.test.js`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
cp /c/dev/restaurace/src/server/eet.js src/server/eet.js
cp /c/dev/restaurace/tests/unit/eet-signature.test.js tests/unit/eet-signature.test.js
git add src/server/eet.js tests/unit/eet-signature.test.js
git commit -m "feat(eet): WS-Security XML-DSig signing over soap:Body"
```

---

### Task 3: Send, parse response, classify errors

**Files:**
- Modify: `src/server/eet.js`
- Test: `tests/unit/eet-send.test.js`

**Interfaces:**
- Consumes: `buildTrzbaBody`, `buildSignedEnvelope` from Tasks 1–2
- Produces:
  - `classifyError(code: number) → "retry" | "terminal"`
  - `parseResponse(xml: string) → { pok, uuidZpravy, datPrij, datOdmit, errorCode, errorText, test, warnings: [{ code, text }] }`
  - `sendTrzba(config, sale) → { ok, pok, warnings, errorCode, errorText, raw }`
  - `PLAYGROUND_URL`, `PRODUCTION_URL`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/eet-send.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /c/dev/restaurace && node --test tests/unit/eet-send.test.js`
Expected: FAIL — `eet.classifyError is not a function`

- [ ] **Step 3: Write the implementation**

Add to `src/server/eet.js`:

```js
const PLAYGROUND_URL = "https://pg.trzbyeet.gov.cz/eet/services/EETServiceSOAP/v4";
const PRODUCTION_URL = "https://trzbyeet.gov.cz/eet/services/EETServiceSOAP/v4";
const SOAP_ACTION = "http://fs.gov.cz/eet/OdeslaniTrzby";

// Spec §3.5.4. Only -1 ("dočasná technická chyba") and 8 ("nebyla zpracována
// kvůli technické chybě") describe a condition that a later identical retry
// could resolve. Everything else — bad encoding, failed XSD, bad signature,
// malformed EIČ, oversized message — will fail identically forever, so
// retrying wastes 48 hours and hides the fault from staff. Codes reserved for
// future use are treated as terminal-but-loud rather than silently retried.
function classifyError(code) {
    return code === -1 || code === 8 ? "retry" : "terminal";
}

function attrOf(xml, tag, attr) {
    const el = xml.match(new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*`));
    if (!el) return null;
    const m = el[0].match(new RegExp(`\\b${attr}="([^"]*)"`));
    return m ? m[1] : null;
}

// Regex parsing is acceptable here ONLY because the payload is a tiny, fixed
// server-generated structure with no mixed content beyond the error/warning
// text. Do not grow this into a general XML parser.
function parseResponse(xml) {
    const errRaw = attrOf(xml, "Chyba", "kod");
    const errBody = xml.match(/<(?:\w+:)?Chyba\b[^>]*>([\s\S]*?)<\/(?:\w+:)?Chyba>/);
    const warnings = [...xml.matchAll(/<(?:\w+:)?Varovani\b[^>]*kod_varov="(\d+)"[^>]*>([\s\S]*?)<\/(?:\w+:)?Varovani>/g)]
        .map(m => ({ code: Number(m[1]), text: m[2].trim() }));

    return {
        pok: attrOf(xml, "Potvrzeni", "pok"),
        uuidZpravy: attrOf(xml, "Hlavicka", "uuid_zpravy"),
        datPrij: attrOf(xml, "Hlavicka", "dat_prij"),
        datOdmit: attrOf(xml, "Hlavicka", "dat_odmit"),
        errorCode: errRaw === null ? null : Number(errRaw),
        errorText: errBody ? errBody[1].trim() : null,
        test: attrOf(xml, "Potvrzeni", "test") === "true" || attrOf(xml, "Chyba", "test") === "true",
        warnings,
    };
}

// Sends one sale. Never throws for an EET-level rejection — those come back as
// { ok: false, errorCode } so the caller can classify. Only genuine transport
// failures throw, and the caller treats those as retryable.
async function sendTrzba(config, sale) {
    const body = buildTrzbaBody(sale);
    const envelope = buildSignedEnvelope(body, config.credentials);
    const url = config.playground ? PLAYGROUND_URL : PRODUCTION_URL;

    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: SOAP_ACTION },
        body: Buffer.from(envelope, "utf8"),
        signal: AbortSignal.timeout(config.timeoutMs || 5000),
    });

    const text = await res.text();
    if (!res.ok) {
        const err = new Error(`EET HTTP ${res.status}`);
        err.retryable = true;
        throw err;
    }

    const parsed = parseResponse(text);
    return {
        ok: !!parsed.pok,
        pok: parsed.pok,
        warnings: parsed.warnings,
        errorCode: parsed.errorCode,
        errorText: parsed.errorText,
        test: parsed.test,
        raw: text,
    };
}

async function verifyConnection(config, sale) {
    return sendTrzba(config, { ...sale, overeni: true });
}
```

Extend `module.exports` with `PLAYGROUND_URL, PRODUCTION_URL, classifyError, parseResponse, sendTrzba, verifyConnection`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /c/dev/restaurace && node --test tests/unit/eet-send.test.js`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
cp /c/dev/restaurace/src/server/eet.js src/server/eet.js
cp /c/dev/restaurace/tests/unit/eet-send.test.js tests/unit/eet-send.test.js
git add src/server/eet.js tests/unit/eet-send.test.js
git commit -m "feat(eet): send, response parsing and retryable/terminal error classification"
```

---

### Task 4: Live playground integration test

This is the task that proves canonicalisation is actually correct. Everything before it is self-consistent but unverified against the real service.

**Files:**
- Create: `tests/integration/eet-playground.test.js`
- Create: `secrets/.gitkeep`

**Interfaces:**
- Consumes: `loadCredentials`, `sendTrzba`, `verifyConnection` from Tasks 2–3
- Produces: nothing consumed by later tasks

- [ ] **Step 1: Fetch the playground certificates**

```bash
mkdir -p /c/dev/restaurace/secrets/playground
cd /c/dev/restaurace/secrets/playground
curl -O https://eet.gov.cz/files/CAEET_Playground_2026_v1.zip
unzip -o CAEET_Playground_2026_v1.zip
cat password_pokladni_cert_playground.txt
```

Expected: three `.p12` files (`CZ00000019`, `CZ8551015704`, `CZ683555118`), two CA `.crt` files, and an 8-character password file. **The password ships inside the zip** — no separate request needed.

- [ ] **Step 2: Convert the právnická-osoba certificate to PEM**

```bash
PW=$(cat password_pokladni_cert_playground.txt)
openssl pkcs12 -in CA_EET-Playground-CZ00000019.p12 -clcerts -nokeys -passin "pass:$PW" -out eet-cert.pem
openssl pkcs12 -in CA_EET-Playground-CZ00000019.p12 -nocerts -nodes -passin "pass:$PW" -out eet-key.pem
openssl x509 -in eet-cert.pem -noout -subject
```

Expected: `subject=C = CZ, CN = CZ00000019, description = pravnicka osoba`

- [ ] **Step 3: Write the integration test**

Create `tests/integration/eet-playground.test.js`:

```js
// Live test against Finanční správa's EET 2.0 playground. Opt-in so that
// `npm test` stays offline and fast:
//   EET_LIVE_TEST=1 EET_TEST_CERT=... EET_TEST_KEY=... node --test tests/integration/eet-playground.test.js
//
// Uses the SHARED playground certificates, which every developer testing EET
// right now also holds. Sale uniqueness is (eic_popl, id_jednotky, id_pokl,
// dat_trzby), so id_pokl below is deliberately distinctive to avoid colliding
// with a stranger's test.
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const eet = require("../../src/server/eet");

const LIVE = process.env.EET_LIVE_TEST === "1";
const opts = { skip: LIVE ? false : "set EET_LIVE_TEST=1 to run" };

function config() {
    return {
        playground: true,
        timeoutMs: 15000,
        credentials: eet.loadCredentials({
            certPem: process.env.EET_TEST_CERT,
            keyPem: process.env.EET_TEST_KEY,
        }),
    };
}

function sale(overrides = {}) {
    const now = new Date();
    return {
        uuidZpravy: crypto.randomUUID(),
        datOdesl: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
        datTrzby: new Date(now.getTime() - 60000).toISOString().replace(/\.\d{3}Z$/, "Z"),
        prvniZaslani: true,
        eic: "CZ00000019",
        idJednotky: 11,
        idPokl: "RESTAURACE-CI",
        poradCis: `CI-${Date.now()}`,
        celkTrzba: 349,
        ...overrides,
    };
}

test("ověřovací mód returns error code 0 (success)", opts, async () => {
    const res = await eet.verifyConnection(config(), sale());
    assert.strictEqual(res.errorCode, 0, `unexpected: ${res.errorCode} ${res.errorText}`);
});

test("ostrý mód returns a POK", opts, async () => {
    const res = await eet.sendTrzba(config(), sale());
    assert.strictEqual(res.ok, true, `expected POK, got ${res.errorCode}: ${res.errorText}`);
    assert.match(res.pok, /^[0-9a-f-]{36}-[0-9a-f]{2}$/);
});

test("playground POKs are always marked as test — never let one reach a receipt", opts, async () => {
    const res = await eet.sendTrzba(config(), sale());
    assert.strictEqual(res.test, true);
    assert.ok(res.pok.endsWith("-ff"));
});

test("negative amount (storno) is accepted", opts, async () => {
    const res = await eet.sendTrzba(config(), sale({ celkTrzba: -349 }));
    assert.strictEqual(res.ok, true, `storno rejected: ${res.errorCode} ${res.errorText}`);
});

test("id_jednotky of 1 produces warning 6 but still succeeds", opts, async () => {
    const res = await eet.sendTrzba(config(), sale({ idJednotky: 1 }));
    assert.strictEqual(res.ok, true);
    assert.ok(res.warnings.some(w => w.code === 6));
});
```

- [ ] **Step 4: Run the live test**

```bash
cd /c/dev/restaurace
EET_LIVE_TEST=1 \
  EET_TEST_CERT=secrets/playground/eet-cert.pem \
  EET_TEST_KEY=secrets/playground/eet-key.pem \
  node --test tests/integration/eet-playground.test.js
```

Expected: PASS — 5 tests.

**If "ostrý mód returns a POK" fails with error code 4 (`Neplatny podpis SOAP zpravy`), the canonicalisation is wrong.** Debug in this order: (1) a self-closing tag crept in, (2) attributes not sorted, (3) `SignedInfo` missing its own `xmlns:ds`, (4) the body string embedded in the envelope differs from the digested one.

- [ ] **Step 5: Confirm the run is offline by default**

Run: `cd /c/dev/restaurace && node --test "tests/unit/**/*.test.js"`
Expected: PASS, with the integration tests not executed at all.

- [ ] **Step 6: Commit**

```bash
mkdir -p secrets && touch secrets/.gitkeep
cp /c/dev/restaurace/tests/integration/eet-playground.test.js tests/integration/eet-playground.test.js
git add tests/integration/eet-playground.test.js secrets/.gitkeep
git status --short   # secrets/playground/* must NOT appear
git commit -m "test(eet): live playground integration tests, opt-in via EET_LIVE_TEST"
```

---

### Task 5: Server configuration and collection

**Files:**
- Modify: `src/server/server.js` (SERVER_CONFIG block ~line 64–90, collections ~line 28–49)
- Modify: `.env.example`

**Interfaces:**
- Consumes: `eet.loadCredentials` from Task 2
- Produces: `SERVER_CONFIG.eet`, `COL.eetRecords`, `eetCredentials()` helper

- [ ] **Step 1: Add the collection**

In the `collections` block of `SERVER_CONFIG` (alongside `receipts`/`receiptCounters`):

```js
        // EET 2.0 — one record per reported sale, keyed by the receipt id so
        // idempotency comes free from the receipt system. See
        // docs/superpowers/specs/2026-07-31-eet2-integration-design.md
        eetRecords: "eet_records",
```

- [ ] **Step 2: Add the config block**

After the PAYMENTS block, following the identical dev-fallback pattern:

```js
    // ── EET 2.0 (elektronická evidence tržeb) ────────────────────────────
    // Same dev-fallback pattern as Twilio/GoPay above: until EET_ENABLED is
    // "true" AND both PEM files exist, nothing is transmitted — sales are
    // logged to the console and their queue records go straight to a
    // "disabled" state, so `npm start` works with no certificate present.
    //
    // The pokladní certifikát arrives from MOJE daně as .p12, which
    // node:crypto cannot read. Convert once at deploy:
    //   openssl pkcs12 -in pokladni.p12 -clcerts -nokeys -out secrets/eet-cert.pem
    //   openssl pkcs12 -in pokladni.p12 -nocerts -nodes  -out secrets/eet-key.pem
    eet: {
        enabled: process.env.EET_ENABLED === "true",
        playground: process.env.EET_PLAYGROUND !== "false", // safe default
        eic: process.env.EET_EIC || process.env.BUSINESS_DIC || "",
        idJednotky: process.env.EET_ID_JEDNOTKY || "",
        certPem: process.env.EET_CERT_PEM || "./secrets/eet-cert.pem",
        keyPem: process.env.EET_KEY_PEM || "./secrets/eet-key.pem",
        keyPassphrase: process.env.EET_KEY_PASSPHRASE || "",
        timeoutMs: Number(process.env.EET_TIMEOUT_MS) || 5000,
        retryIntervalMs: Number(process.env.EET_RETRY_INTERVAL_MS) || 60000,
        registers: {
            delivery: process.env.EET_POKL_DELIVERY || "DELIVERY",
            indoor: process.env.EET_POKL_INDOOR || "INDOOR",
            reservation: process.env.EET_POKL_RESERVATION || "RESERVATION",
        },
    },
```

- [ ] **Step 3: Add lazy credential loading**

Near the `gopay` require:

```js
const eet = require("./eet");

// Credentials are loaded once, lazily, and cached — reading and parsing PEM on
// every sale would be pointless I/O on the payment hot path. Returns null when
// EET is disabled or the certificate is absent, which is the dev-fallback
// signal every caller checks.
let eetCredentialsCache;
function eetCredentials() {
    if (eetCredentialsCache !== undefined) return eetCredentialsCache;
    const cfg = SERVER_CONFIG.eet;
    if (!cfg.enabled) { eetCredentialsCache = null; return null; }
    try {
        eetCredentialsCache = eet.loadCredentials(cfg);
    } catch (e) {
        // Never crash the server over EET config — sales still get queued and
        // the health endpoint surfaces the problem.
        console.error(`❌ EET: certificate could not be loaded (${e.message}) — sales will queue unsent`);
        eetCredentialsCache = null;
    }
    return eetCredentialsCache;
}
```

- [ ] **Step 4: Document the environment variables**

Append to `.env.example` after the BUSINESS IDENTITY block:

```
# ── EET 2.0 (elektronická evidence tržeb) ───────────────────────────────
# Leave EET_ENABLED=false for local development: sales are logged, not sent.
EET_ENABLED=false
# true = playground (pg.trzbyeet.gov.cz), false = production. Default: true.
EET_PLAYGROUND=true
# Falls back to BUSINESS_DIC when empty. Format: CZ + 8-10 digits.
EET_EIC=
# Assigned to you in MOJE daně / DIS+. At least 2 digits, last digit 1-4.
EET_ID_JEDNOTKY=
# PEM files converted from the .p12 issued by MOJE daně — see README.
EET_CERT_PEM=./secrets/eet-cert.pem
EET_KEY_PEM=./secrets/eet-key.pem
EET_KEY_PASSPHRASE=
# Mezní doba odezvy in ms. Legal minimum 2000; this restaurant uses 5000.
EET_TIMEOUT_MS=5000
EET_RETRY_INTERVAL_MS=60000
# One EET cash register per sales channel.
EET_POKL_DELIVERY=DELIVERY
EET_POKL_INDOOR=INDOOR
EET_POKL_RESERVATION=RESERVATION
```

- [ ] **Step 5: Verify the server still boots**

Run: `cd /c/dev/restaurace && timeout 10 node src/server/server.js`
Expected: starts normally, no EET errors (EET_ENABLED unset → disabled).

- [ ] **Step 6: Commit**

```bash
git add src/server/server.js .env.example
git commit -m "feat(eet): server configuration, credential loading and eet_records collection"
```

---

### Task 6: Enqueue on receipt creation

**Files:**
- Create: `src/server/eet-queue.js`
- Modify: `src/server/server.js` (`createReceiptForOrder`, ~line 1070–1133)
- Test: `tests/unit/eet-queue.test.js`

**Interfaces:**
- Consumes: `COL.eetRecords`, `SERVER_CONFIG.eet` from Task 5; `eet.classifyError`, `eet.sendTrzba` from Task 3
- Produces:
  - `enqueue(db, col, { receipt, kind, config }) → record`
  - `isEvidovanaTrzba(paymentMethod, gopayInstrument) → boolean`
  - `registerFor(config, kind) → string`
  - `DEADLINE_MS = 48 * 3600 * 1000`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/eet-queue.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert");
const queue = require("../../src/server/eet-queue");

// Minimal in-memory stand-in for db.js's get/set/list contract.
function fakeDb() {
    const store = new Map();
    return {
        get: (c, id) => store.get(`${c}:${id}`) || null,
        set: (c, id, v) => { store.set(`${c}:${id}`, v); return v; },
        list: c => [...store.entries()].filter(([k]) => k.startsWith(`${c}:`)).map(([, v]) => v),
    };
}

const CONFIG = {
    eic: "CZ00000019",
    idJednotky: "11",
    registers: { delivery: "DELIVERY", indoor: "INDOOR", reservation: "RESERVATION" },
};

const RECEIPT = { id: "rcpt1", number: "2026-000001", issuedAt: "2026-07-31T11:55:00+02:00", total: 349 };

test("every payment method is reported (owner decision 2026-07-31)", () => {
    for (const m of ["cash", "card_on_delivery", "online_card"]) {
        assert.strictEqual(queue.isEvidovanaTrzba(m, null), true);
    }
    assert.strictEqual(queue.isEvidovanaTrzba("online_card", "BANK_ACCOUNT"), true);
});

test("enqueue creates a pending record keyed by receipt id", () => {
    const db = fakeDb();
    const rec = queue.enqueue(db, "eet_records", { receipt: RECEIPT, kind: "indoor", config: CONFIG });
    assert.strictEqual(rec.id, "rcpt1");
    assert.strictEqual(rec.state, "pending");
    assert.strictEqual(rec.prvniZaslani, true);
    assert.strictEqual(rec.idPokl, "INDOOR");
    assert.strictEqual(rec.poradCis, "2026-000001");
    assert.strictEqual(rec.celkTrzba, 349);
    assert.strictEqual(rec.attempts, 0);
});

test("enqueue is idempotent — a second call never mints a second record", () => {
    const db = fakeDb();
    const a = queue.enqueue(db, "eet_records", { receipt: RECEIPT, kind: "indoor", config: CONFIG });
    const b = queue.enqueue(db, "eet_records", { receipt: RECEIPT, kind: "indoor", config: CONFIG });
    assert.strictEqual(a.uuidZpravy, b.uuidZpravy, "UUID must not be regenerated");
    assert.strictEqual(db.list("eet_records").length, 1);
});

test("dat_trzby is frozen from the receipt, never regenerated", () => {
    const db = fakeDb();
    const rec = queue.enqueue(db, "eet_records", { receipt: RECEIPT, kind: "indoor", config: CONFIG });
    assert.strictEqual(rec.datTrzby, "2026-07-31T11:55:00+02:00");
});

test("deadline is 48h after the sale", () => {
    const db = fakeDb();
    const rec = queue.enqueue(db, "eet_records", { receipt: RECEIPT, kind: "indoor", config: CONFIG });
    const delta = new Date(rec.deadlineAt) - new Date(rec.datTrzby);
    assert.strictEqual(delta, queue.DEADLINE_MS);
});

test("register is chosen per channel", () => {
    assert.strictEqual(queue.registerFor(CONFIG, "delivery"), "DELIVERY");
    assert.strictEqual(queue.registerFor(CONFIG, "reservation"), "RESERVATION");
});

test("a refund uses the register of the channel it refunds", () => {
    assert.strictEqual(queue.registerFor(CONFIG, "refund", "delivery"), "DELIVERY");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /c/dev/restaurace && node --test tests/unit/eet-queue.test.js`
Expected: FAIL — `Cannot find module '../../src/server/eet-queue'`

- [ ] **Step 3: Write the implementation**

Create `src/server/eet-queue.js`:

```js
// ============================================================================
// eet-queue.js — persistence and retry for EET 2.0 sale reporting
// ============================================================================
//
// THE QUEUE IS THE SOURCE OF TRUTH. createReceiptForOrder() enqueues
// synchronously; the immediate send is only an optimisation to get a POK onto
// the receipt before it prints. If a call site ever forgets to await the send,
// the background worker still reports the sale — a forgotten await is a
// latency bug, never a compliance failure.
//
// Kept separate from eet.js (which stays pure and stateless) and from
// server.js (already 200 kB+). Takes `db` as a parameter rather than requiring
// it, so the state machine is testable against a plain Map.
// ============================================================================

const crypto = require("node:crypto");
const eet = require("./eet");

// ZoET allows 48 hours to get a sale through after a failed first attempt.
const DEADLINE_MS = 48 * 60 * 60 * 1000;

// Backoff from lastAttemptAt: 1min, 5min, 15min, then hourly. Bounded and
// predictable — a full 48h outage produces ~50 attempts, not thousands.
const BACKOFF_MS = [60_000, 300_000, 900_000];
const BACKOFF_TAIL_MS = 3_600_000;

// Owner's decision (2026-07-31): report every confirmed payment regardless of
// instrument, including GoPay BANK_ACCOUNT transfers. The arguments this would
// need are taken deliberately, so narrowing it later (e.g. if the restaurant's
// accountant rules bank transfers out as not being evidované tržby) is a
// one-line change with a test already pointing here.
function isEvidovanaTrzba(paymentMethod, gopayInstrument) {
    return true;
}

// A refund reports against the register of the sale it reverses, so a storno
// never lands in a different EET register than its original.
function registerFor(config, kind, originalKind) {
    const key = kind === "refund" ? originalKind : kind;
    return config.registers[key] || config.registers.indoor;
}

function nextAttemptDelay(attempts) {
    return BACKOFF_MS[attempts] !== undefined ? BACKOFF_MS[attempts] : BACKOFF_TAIL_MS;
}

// Creates the pending record. Idempotent on receipt.id: calling twice returns
// the first record untouched, which matters because uuidZpravy and datTrzby
// must never change once assigned (see sendOnce).
function enqueue(db, col, { receipt, kind, originalKind, config }) {
    const existing = db.get(col, receipt.id);
    if (existing) return existing;

    const datTrzby = receipt.issuedAt;
    const record = {
        id: receipt.id,
        receiptId: receipt.id,
        receiptNumber: receipt.number,
        kind,
        originalKind: originalKind || null,
        uuidZpravy: crypto.randomUUID(),
        eic: config.eic,
        idJednotky: config.idJednotky,
        idPokl: registerFor(config, kind, originalKind),
        poradCis: receipt.number,
        datTrzby,
        celkTrzba: receipt.total,
        prvniZaslani: true,
        state: "pending",
        pok: null,
        warnings: [],
        attempts: 0,
        lastAttemptAt: null,
        lastError: null,
        sentAt: null,
        deadlineAt: new Date(new Date(datTrzby).getTime() + DEADLINE_MS).toISOString(),
    };
    return db.set(col, receipt.id, record);
}

module.exports = { DEADLINE_MS, BACKOFF_MS, BACKOFF_TAIL_MS, isEvidovanaTrzba, registerFor, nextAttemptDelay, enqueue };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /c/dev/restaurace && node --test tests/unit/eet-queue.test.js`
Expected: PASS — 7 tests.

- [ ] **Step 5: Wire enqueue into createReceiptForOrder**

In `src/server/server.js`, immediately before `return receipt;` at the end of `createReceiptForOrder()`:

```js
    // EET 2.0: enqueue synchronously, in the same breath as the receipt. This
    // function stays sync on purpose — it has five call sites and runs inside
    // applyGatewayPaymentState, so making it async would ripple everywhere.
    // Sending is a separate awaited step; see sendEetForReceipt().
    if (eetQueue.isEvidovanaTrzba(paymentMethod, gopayInstrument)) {
        eetQueue.enqueue(db, COL.eetRecords, {
            receipt,
            kind,
            originalKind: originalKind || null,
            config: SERVER_CONFIG.eet,
        });
    }
```

Add `const eetQueue = require("./eet-queue");` next to the other requires, and add `gopayInstrument` and `originalKind` to the destructured parameter list of `createReceiptForOrder`, both defaulting to `null`.

- [ ] **Step 6: Verify the server still boots and receipts still work**

Run: `cd /c/dev/restaurace && node --test "tests/unit/**/*.test.js"`
Expected: PASS — all suites green.

- [ ] **Step 7: Commit**

```bash
cp /c/dev/restaurace/src/server/eet-queue.js src/server/eet-queue.js
cp /c/dev/restaurace/tests/unit/eet-queue.test.js tests/unit/eet-queue.test.js
git add src/server/eet-queue.js tests/unit/eet-queue.test.js src/server/server.js
git commit -m "feat(eet): enqueue every paid receipt for EET reporting"
```

---

### Task 7: Send with the 5-second budget

**Files:**
- Modify: `src/server/eet-queue.js`
- Modify: `src/server/server.js` (three mark-paid routes + `applyGatewayPaymentState`)
- Test: `tests/unit/eet-queue-send.test.js`

**Interfaces:**
- Consumes: `enqueue`, `nextAttemptDelay` from Task 6; `eet.sendTrzba`, `eet.classifyError` from Task 3
- Produces: `sendOnce(db, col, id, { config, credentials, client }) → record`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/eet-queue-send.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert");
const queue = require("../../src/server/eet-queue");

function fakeDb() {
    const store = new Map();
    return {
        get: (c, id) => store.get(`${c}:${id}`) || null,
        set: (c, id, v) => { store.set(`${c}:${id}`, v); return v; },
        list: c => [...store.entries()].filter(([k]) => k.startsWith(`${c}:`)).map(([, v]) => v),
    };
}

const CONFIG = { eic: "CZ00000019", idJednotky: "11", registers: { indoor: "INDOOR" } };
const RECEIPT = { id: "r1", number: "2026-000001", issuedAt: "2026-07-31T11:55:00+02:00", total: 349 };
const CREDS = { certDer: "x", privateKey: "y" };

function seed(db) {
    return queue.enqueue(db, "eet", { receipt: RECEIPT, kind: "indoor", config: CONFIG });
}

test("a POK confirms the record", async () => {
    const db = fakeDb(); seed(db);
    const client = { sendTrzba: async () => ({ ok: true, pok: "abc-ff", warnings: [], test: true }) };
    const rec = await queue.sendOnce(db, "eet", "r1", { config: CONFIG, credentials: CREDS, client });
    assert.strictEqual(rec.state, "confirmed");
    assert.strictEqual(rec.pok, "abc-ff");
    assert.strictEqual(rec.attempts, 1);
});

test("a terminal error code stops retrying", async () => {
    const db = fakeDb(); seed(db);
    const client = { sendTrzba: async () => ({ ok: false, errorCode: 4, errorText: "Neplatny podpis SOAP zpravy", warnings: [] }) };
    const rec = await queue.sendOnce(db, "eet", "r1", { config: CONFIG, credentials: CREDS, client });
    assert.strictEqual(rec.state, "failed");
    assert.match(rec.lastError, /Neplatny podpis/);
});

test("a retryable error code leaves the record pending", async () => {
    const db = fakeDb(); seed(db);
    const client = { sendTrzba: async () => ({ ok: false, errorCode: -1, errorText: "Docasna technicka chyba", warnings: [] }) };
    const rec = await queue.sendOnce(db, "eet", "r1", { config: CONFIG, credentials: CREDS, client });
    assert.strictEqual(rec.state, "pending");
});

test("a transport failure leaves the record pending", async () => {
    const db = fakeDb(); seed(db);
    const client = { sendTrzba: async () => { throw new Error("network down"); } };
    const rec = await queue.sendOnce(db, "eet", "r1", { config: CONFIG, credentials: CREDS, client });
    assert.strictEqual(rec.state, "pending");
    assert.match(rec.lastError, /network down/);
});

test("uuid_zpravy is stable and prvni_zaslani flips false on retry", async () => {
    const db = fakeDb();
    const original = seed(db).uuidZpravy;
    const sent = [];
    const client = { sendTrzba: async (_c, sale) => { sent.push(sale); throw new Error("down"); } };
    await queue.sendOnce(db, "eet", "r1", { config: CONFIG, credentials: CREDS, client });
    await queue.sendOnce(db, "eet", "r1", { config: CONFIG, credentials: CREDS, client });

    assert.strictEqual(sent[0].uuidZpravy, original);
    assert.strictEqual(sent[1].uuidZpravy, original, "a new UUID would duplicate the sale");
    assert.strictEqual(sent[0].prvniZaslani, true);
    assert.strictEqual(sent[1].prvniZaslani, false);
    assert.strictEqual(sent[0].datTrzby, sent[1].datTrzby, "dat_trzby must stay frozen");
});

test("warnings are stored alongside a successful POK", async () => {
    const db = fakeDb(); seed(db);
    const client = { sendTrzba: async () => ({ ok: true, pok: "x-ff", warnings: [{ code: 6, text: "id_jednotky..." }] }) };
    const rec = await queue.sendOnce(db, "eet", "r1", { config: CONFIG, credentials: CREDS, client });
    assert.strictEqual(rec.state, "confirmed");
    assert.strictEqual(rec.warnings.length, 1);
});

test("a confirmed record is never re-sent", async () => {
    const db = fakeDb(); seed(db);
    let calls = 0;
    const client = { sendTrzba: async () => { calls++; return { ok: true, pok: "x-ff", warnings: [] }; } };
    await queue.sendOnce(db, "eet", "r1", { config: CONFIG, credentials: CREDS, client });
    await queue.sendOnce(db, "eet", "r1", { config: CONFIG, credentials: CREDS, client });
    assert.strictEqual(calls, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /c/dev/restaurace && node --test tests/unit/eet-queue-send.test.js`
Expected: FAIL — `queue.sendOnce is not a function`

- [ ] **Step 3: Write the implementation**

Add to `src/server/eet-queue.js` (and export `sendOnce`):

```js
// One send attempt against an existing record. Never throws — a transport
// failure is recorded and left pending, because a thrown error on the payment
// hot path would break marking an order paid.
//
// `client` is injected so tests can drive the state machine without a network;
// production passes the eet module itself.
async function sendOnce(db, col, id, { config, credentials, client = eet }) {
    const record = db.get(col, id);
    if (!record) throw new Error(`EET: no queue record ${id}`);
    if (record.state === "confirmed") return record;

    // These three fields are what make a retry a RETRY rather than a second
    // sale. uuidZpravy and datTrzby come straight off the stored record and
    // are never regenerated; prvniZaslani is true only while no attempt has
    // been made yet.
    const sale = {
        uuidZpravy: record.uuidZpravy,
        datOdesl: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        datTrzby: record.datTrzby,
        prvniZaslani: record.attempts === 0,
        eic: record.eic,
        idJednotky: record.idJednotky,
        idPokl: record.idPokl,
        poradCis: record.poradCis,
        celkTrzba: record.celkTrzba,
    };

    record.attempts += 1;
    record.lastAttemptAt = new Date().toISOString();
    record.prvniZaslani = false;

    try {
        const res = await client.sendTrzba({ ...config, credentials }, sale);
        record.warnings = res.warnings || [];

        if (res.ok) {
            record.state = "confirmed";
            record.pok = res.pok;
            record.sentAt = record.lastAttemptAt;
            record.lastError = null;
        } else if (eet.classifyError(res.errorCode) === "terminal") {
            record.state = "failed";
            record.lastError = `EET ${res.errorCode}: ${res.errorText}`;
            console.error(`❌ EET terminal error on receipt ${record.receiptNumber} — ${record.lastError}`);
        } else {
            record.lastError = `EET ${res.errorCode}: ${res.errorText}`;
        }
    } catch (e) {
        // Transport-level failure (timeout, DNS, TLS, 5xx) — always retryable.
        record.lastError = e.message;
    }

    return db.set(col, id, record);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /c/dev/restaurace && node --test tests/unit/eet-queue-send.test.js`
Expected: PASS — 7 tests.

- [ ] **Step 5: Add the server-side wrapper**

In `src/server/server.js`, after `createReceiptForOrder`:

```js
// Best-effort immediate send, bounded by the configured mezní doba odezvy
// (5s). Deliberately swallows every error: the queue record already exists, so
// a failure here just means the receipt prints without a POK and the retry
// worker picks it up. Marking an order paid must never fail because EET is
// having a bad day.
async function sendEetForReceipt(receiptId) {
    const creds = eetCredentials();
    if (!creds) {
        console.log(`🧾 [EET disabled] receipt ${receiptId} queued but not transmitted`);
        return null;
    }
    try {
        return await eetQueue.sendOnce(db, COL.eetRecords, receiptId, {
            config: SERVER_CONFIG.eet,
            credentials: creds,
        });
    } catch (e) {
        console.error(`EET send failed for receipt ${receiptId}:`, e.message);
        return null;
    }
}
```

- [ ] **Step 6: Await it at all five call sites**

Each site already has the receipt in hand. Add immediately after the `createReceiptForOrder(...)` call:

```js
        if (receipt) await sendEetForReceipt(receipt.id);
```

The three mark-paid route handlers must have `async` added to their callback signature. `applyGatewayPaymentState` is already async. Sites (post-Task-6 line numbers will have shifted — locate by the `createReceiptForOrder` calls):

1. `applyGatewayPaymentState` — delivery/indoor branch
2. `applyGatewayPaymentState` — reservation branch (`receiptCreated`)
3. `POST /orders/:id/mark-paid`
4. `POST /kitchen/reservation/mark-paid`
5. `POST /indoor-orders/:id/mark-paid`

- [ ] **Step 7: Verify**

Run: `cd /c/dev/restaurace && node --test "tests/unit/**/*.test.js" && timeout 10 node src/server/server.js`
Expected: tests PASS, server boots.

- [ ] **Step 8: Commit**

```bash
cp /c/dev/restaurace/src/server/eet-queue.js src/server/eet-queue.js
cp /c/dev/restaurace/tests/unit/eet-queue-send.test.js tests/unit/eet-queue-send.test.js
git add src/server/eet-queue.js tests/unit/eet-queue-send.test.js src/server/server.js
git commit -m "feat(eet): send on payment with bounded mezni doba odezvy"
```

---

### Task 8: Retry worker and health endpoint

**Files:**
- Modify: `src/server/eet-queue.js`
- Modify: `src/server/server.js`
- Test: `tests/unit/eet-queue-retry.test.js`

**Interfaces:**
- Consumes: `sendOnce`, `nextAttemptDelay`, `DEADLINE_MS` from Tasks 6–7
- Produces:
  - `dueRecords(db, col, now) → record[]`
  - `healthSummary(db, col, now) → { pending, confirmed, failed, overdue, oldestPending, lastError }`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/eet-queue-retry.test.js`:

```js
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

test("confirmed and failed records are never retried", () => {
    const db = fakeDb([rec({ id: "a", state: "confirmed" }), rec({ id: "b", state: "failed" })]);
    assert.strictEqual(queue.dueRecords(db, "eet", NOW).length, 0);
});

test("a pending record past its backoff is due", () => {
    const db = fakeDb([rec()]);   // 60 min since last attempt, backoff for attempts=1 is 5 min
    assert.strictEqual(queue.dueRecords(db, "eet", NOW).length, 1);
});

test("a pending record still inside its backoff is not due", () => {
    const db = fakeDb([rec({ lastAttemptAt: "2026-07-31T11:58:00Z" })]);  // 2 min ago
    assert.strictEqual(queue.dueRecords(db, "eet", NOW).length, 0);
});

test("a record past its deadline is still retried, never dropped", () => {
    const db = fakeDb([rec({ deadlineAt: "2026-07-30T00:00:00Z" })]);
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /c/dev/restaurace && node --test tests/unit/eet-queue-retry.test.js`
Expected: FAIL — `queue.dueRecords is not a function`

- [ ] **Step 3: Write the implementation**

Add to `src/server/eet-queue.js` (and export both):

```js
// Records eligible for another attempt right now. Deliberately does NOT filter
// out records past their deadline: blowing 48 hours is a compliance problem to
// be surfaced and fixed, not a reason to stop trying.
function dueRecords(db, col, now = new Date()) {
    return db.list(col).filter(r => {
        if (r.state !== "pending") return false;
        if (!r.lastAttemptAt) return true;
        const waited = now.getTime() - new Date(r.lastAttemptAt).getTime();
        return waited >= nextAttemptDelay(r.attempts);
    });
}

function healthSummary(db, col, now = new Date()) {
    const all = db.list(col);
    const pending = all.filter(r => r.state === "pending");
    const oldest = pending
        .slice()
        .sort((a, b) => new Date(a.datTrzby || 0) - new Date(b.datTrzby || 0))[0];
    const lastFailed = all.filter(r => r.lastError).slice(-1)[0];

    return {
        pending: pending.length,
        confirmed: all.filter(r => r.state === "confirmed").length,
        failed: all.filter(r => r.state === "failed").length,
        overdue: pending.filter(r => new Date(r.deadlineAt) < now).length,
        oldestPending: oldest ? oldest.id : null,
        lastError: lastFailed ? lastFailed.lastError : null,
    };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /c/dev/restaurace && node --test tests/unit/eet-queue-retry.test.js`
Expected: PASS — 6 tests.

- [ ] **Step 5: Start the worker and add the health route**

In `src/server/server.js`, near the existing reservation reminder scanner:

```js
// EET retry worker. Same shape as the reservation reminder scanner above.
// Runs regardless of how the immediate send went — this is what guarantees a
// sale still reaches Finanční správa after an outage.
const ESCALATE_BEFORE_DEADLINE_MS = 6 * 60 * 60 * 1000;

if (SERVER_CONFIG.eet.enabled) {
    setInterval(async () => {
        const creds = eetCredentials();
        if (!creds) return;
        const now = new Date();
        for (const record of eetQueue.dueRecords(db, COL.eetRecords, now)) {
            if (new Date(record.deadlineAt) - now < ESCALATE_BEFORE_DEADLINE_MS) {
                console.error(
                    `⚠️  EET: receipt ${record.receiptNumber} still unreported, `
                    + `deadline ${record.deadlineAt} (${record.attempts} attempts, last: ${record.lastError})`
                );
            }
            await sendEetForReceipt(record.id);
        }
    }, SERVER_CONFIG.eet.retryIntervalMs).unref();
}
```

Add the staff-authenticated route alongside the other `/api` routes:

```js
    // GET — EET queue health. Staff-only: exposes revenue-shaped counts.
    app.get(`${api}/eet/health`, requireAuth, (req, res) => {
        res.json({
            enabled: SERVER_CONFIG.eet.enabled,
            mode: SERVER_CONFIG.eet.playground ? "playground" : "production",
            ...eetQueue.healthSummary(db, COL.eetRecords),
        });
    });
```

- [ ] **Step 6: Verify**

Run: `cd /c/dev/restaurace && node --test "tests/unit/**/*.test.js" && timeout 10 node src/server/server.js`
Expected: tests PASS, server boots with no interval errors.

- [ ] **Step 7: Commit**

```bash
cp /c/dev/restaurace/src/server/eet-queue.js src/server/eet-queue.js
cp /c/dev/restaurace/tests/unit/eet-queue-retry.test.js tests/unit/eet-queue-retry.test.js
git add src/server/eet-queue.js tests/unit/eet-queue-retry.test.js src/server/server.js
git commit -m "feat(eet): retry worker with backoff, deadline escalation and health endpoint"
```

---

### Task 9: Receipt display

**Files:**
- Modify: `src/server/server.js` (`createReceiptForOrder`, `renderReceiptHtml`)

**Interfaces:**
- Consumes: the `eet_records` record produced by Tasks 6–7
- Produces: `receipt.eet` block; `RECEIPT_EET_PENDING_NOTICE` constant

- [ ] **Step 1: Read the CSP constraint before touching this file**

`RECEIPT_PRINT_SCRIPT` is allow-listed in helmet's CSP by its exact SHA-256 hash, computed at startup from that constant. **Adding EET fields to receipt markup is safe. Changing `RECEIPT_PRINT_SCRIPT` is not.** Do not touch that constant in this task.

- [ ] **Step 2: Add the pending-notice constant**

Near `PAYMENT_METHOD_LABELS`:

```js
// §2.1 of the design spec — EET 2.0 removed BKP/PKP, so there is no fallback
// code to print when a sale could not be reported before the receipt was
// issued. What ZoET §20 requires in that situation is a question for the
// restaurant's accountant, NOT something to invent here. This constant is that
// answer's only home; change it here and nowhere else.
//
// PROVISIONAL DEFAULT — must be confirmed before go-live.
const RECEIPT_EET_PENDING_NOTICE = "Tržba je evidována v běžném režimu.";
```

- [ ] **Step 3: Attach the EET block to the receipt after sending**

`createReceiptForOrder` runs before the send, so the receipt is persisted without a POK and updated afterwards.

Task 7's `sendEetForReceipt` returns `sendOnce`'s result directly. Replace its `try` block so the result is bound before returning:

```js
    try {
        const record = await eetQueue.sendOnce(db, COL.eetRecords, receiptId, {
            config: SERVER_CONFIG.eet,
            credentials: creds,
        });

        // Mirror the outcome onto the receipt so the printable page and the
        // receipts API need no knowledge of the eet_records collection.
        const receipt = db.get(COL.receipts, receiptId);
        if (receipt && record) {
            receipt.eet = {
                pok: record.pok,
                uuidZpravy: record.uuidZpravy,
                datTrzby: record.datTrzby,
                mode: SERVER_CONFIG.eet.playground ? "playground" : "production",
                state: record.state,
            };
            db.set(COL.receipts, receiptId, receipt);
        }
        return record;
    } catch (e) {
        console.error(`EET send failed for receipt ${receiptId}:`, e.message);
        return null;
    }
```

- [ ] **Step 4: Render it**

In `renderReceiptHtml()`, after the payment-method row:

```js
    const eetHtml = !receipt.eet
        ? ""
        : receipt.eet.pok
            ? `<p class="eet"><strong>POK:</strong> ${escapeHtml(receipt.eet.pok)}<br>
               <span class="eet-mode">${receipt.eet.mode === "playground" ? "TESTOVACÍ PROSTŘEDÍ — NEPLATNÁ ÚČTENKA" : "Tržba evidována"}</span></p>`
            : `<p class="eet">${escapeHtml(RECEIPT_EET_PENDING_NOTICE)}</p>`;
```

Insert `${eetHtml}` into the template. A playground POK must be visibly marked so a test receipt can never be mistaken for a real one.

- [ ] **Step 5: Verify**

Run: `cd /c/dev/restaurace && node --test "tests/unit/**/*.test.js" && timeout 10 node src/server/server.js`
Expected: PASS, server boots.

- [ ] **Step 6: Commit**

```bash
git add src/server/server.js
git commit -m "feat(eet): show POK on receipts, mark playground receipts as invalid"
```

---

### Task 10: Refunds as negative tržby

**Files:**
- Modify: `src/server/server.js` (`applyGatewayPaymentState` refund branch)

**Interfaces:**
- Consumes: `createReceiptForOrder` (Task 6 signature), `sendEetForReceipt` (Task 7)
- Produces: refund receipts with `kind: "refund"` and `refundOf`

- [ ] **Step 1: Audit every consumer of `kind` first**

```bash
cd /c/dev/restaurace
grep -n 'kind' src/server/server.js | grep -iE 'delivery|indoor|reservation'
```

`kind` becomes a **four**-value field (`delivery | indoor | reservation | refund`) where existing code assumes three. Every switch, comparison and label map found here must handle `"refund"` before proceeding. Record what you changed in the commit message.

- [ ] **Step 2: Create the refund receipt**

In `applyGatewayPaymentState`, in the branch where `newStatus === "refunded"`:

```js
            // A storno is an evidovaná tržba with a negative amount
            // (CastkaType permits it). It gets a full receipt of its own —
            // same funnel, same idempotency — so porad_cis stays unique with
            // no second numbering scheme.
            if (newStatus === "refunded" && order.receiptId && !order.refundReceiptId) {
                const original = db.get(COL.receipts, order.receiptId);
                if (original) {
                    const refund = createReceiptForOrder({
                        kind: "refund",
                        originalKind: record.kind,
                        items: original.items.map(it => ({
                            ...it, price: -it.unitPrice, qty: it.qty, name: it.name,
                        })),
                        total: -original.total,
                        paymentMethod: original.paymentMethod,
                        existingReceiptId: null,
                        description: `Storno účtenky ${original.number}`,
                    });
                    refund.refundOf = order.receiptId;
                    db.set(COL.receipts, refund.id, refund);
                    order.refundReceiptId = refund.id;
                    await sendEetForReceipt(refund.id);
                }
            }
```

- [ ] **Step 3: Verify the negative amount serialises correctly**

Run: `cd /c/dev/restaurace && node --test tests/unit/eet-canonical.test.js`
Expected: PASS — the "negative amounts (storno) are supported" test from Task 1 already covers `celk_trzba="-349.00"`.

- [ ] **Step 4: Verify against the live playground**

```bash
EET_LIVE_TEST=1 EET_TEST_CERT=secrets/playground/eet-cert.pem \
  EET_TEST_KEY=secrets/playground/eet-key.pem \
  node --test tests/integration/eet-playground.test.js
```

Expected: PASS — including "negative amount (storno) is accepted".

- [ ] **Step 5: Commit**

```bash
git add src/server/server.js
git commit -m "feat(eet): report refunds as negative trzby with their own receipts"
```

---

### Task 11: Operator documentation

**Files:**
- Modify: `README.md`
- Modify: `PRED-NAHRANIM.md`

- [ ] **Step 1: Add the EET go-live section to README.md**

````markdown
## EET 2.0 — elektronická evidence tržeb

Every confirmed sale is reported to Finanční správa. Implementation:
`src/server/eet.js` (protocol) and `src/server/eet-queue.js` (retry).
Design: `docs/superpowers/specs/2026-07-31-eet2-integration-design.md`.

### Certificate setup

Node cannot read `.p12`, so convert the pokladní certifikát once:

```bash
mkdir -p secrets
openssl pkcs12 -in pokladni.p12 -clcerts -nokeys -out secrets/eet-cert.pem
openssl pkcs12 -in pokladni.p12 -nocerts -nodes  -out secrets/eet-key.pem
chmod 600 secrets/*.pem
```

`secrets/` is gitignored. Never commit these files.

### Testing against the playground

Certificates (password included in the zip) come from
<https://eet.gov.cz/pro-vyvojare/> as `CAEET_Playground_2026_v1.zip`.

```bash
EET_LIVE_TEST=1 EET_TEST_CERT=secrets/playground/eet-cert.pem \
  EET_TEST_KEY=secrets/playground/eet-key.pem \
  node --test tests/integration/eet-playground.test.js
```

Playground POKs end in `-ff` and carry `test="true"`; receipts print a visible
"TESTOVACÍ PROSTŘEDÍ" marker in that mode.

### Monitoring

`GET /api/eet/health` (staff auth) returns counts by state, the oldest pending
sale, and the last error. **`overdue > 0` means a sale has missed its 48-hour
reporting deadline and needs manual attention.**
````

- [ ] **Step 2: Add the go-live checklist to PRED-NAHRANIM.md**

```markdown
## EET 2.0 před spuštěním

- [ ] Pokladní certifikát vydán v MOJE daně, převeden do `secrets/*.pem`
- [ ] `EET_ID_JEDNOTKY` vyplněno hodnotou z DIS+ (min. 2 číslice, poslední 1–4)
- [ ] `EET_EIC` odpovídá EIČ v certifikátu
- [ ] `EET_PLAYGROUND=false` a `EET_ENABLED=true`
- [ ] Testovací tržba v produkci v ověřovacím módu proběhla
- [ ] **Text účtenky při nedostupnosti EET potvrzen účetní**
      (`RECEIPT_EET_PENDING_NOTICE` — viz §2.1 spec; EET 2.0 zrušilo BKP/PKP,
      takže co se má na účtenku vytisknout, plyne ze ZoET §20, ne z rozhraní)
- [ ] `GET /api/eet/health` hlídán (alert při `overdue > 0`)
```

- [ ] **Step 3: Commit**

```bash
git add README.md PRED-NAHRANIM.md
git commit -m "docs(eet): certificate setup, playground testing and go-live checklist"
```

---

## Verification

Full suite, offline:

```bash
cd /c/dev/restaurace && node --test "tests/unit/**/*.test.js"
```

Live playground:

```bash
EET_LIVE_TEST=1 EET_TEST_CERT=secrets/playground/eet-cert.pem \
  EET_TEST_KEY=secrets/playground/eet-key.pem \
  node --test tests/integration/eet-playground.test.js
```

Copy everything back to the OneDrive tree and confirm nothing secret is staged:

```bash
git status --short
```

`secrets/` and `data/` must not appear.

## Known gaps at plan completion

1. **`RECEIPT_EET_PENDING_NOTICE` is a provisional string** awaiting the
   accountant's confirmation (spec §2.1). Blocks go-live, not implementation.
2. **`isEvidovanaTrzba` reports everything**, per the owner's decision of
   2026-07-31, including GoPay bank transfers. One-line change if narrowed.
3. **No staff UI for failed records** — `GET /api/eet/health` is JSON only.
   Adding a panel to the admin interface is deliberately out of scope here.
