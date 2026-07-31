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

const crypto = require("node:crypto");
const fs = require("node:fs");

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

// The XSD's dateTime restriction (used by dat_odesl and dat_trzby) requires a
// timezone offset and forbids fractional seconds:
// \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(Z|[+\-]\d\d:\d\d). Node's own
// `new Date().toISOString()` fails this (it appends ".000Z"), and a naive
// local timestamp with no offset fails it too — both build XML that looks
// fine here but is rejected only once it reaches the live endpoint, as an
// opaque "invalid signature" error (the digest was computed over bytes the
// server never re-derives the same way). Catch it here instead, with a
// message that names the field.
const EET_DATETIME_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(Z|[+\-]\d\d:\d\d)$/;

function assertEetDateTime(fieldName, value) {
    if (!EET_DATETIME_RE.test(String(value))) {
        throw new Error(
            `EET: ${fieldName} must match \\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d(Z|[+-]\\d\\d:\\d\\d) `
            + `(a timezone offset, no fractional seconds) — got: ${value}`
        );
    }
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
    assertEetDateTime("datOdesl", sale.datOdesl);
    assertEetDateTime("datTrzby", sale.datTrzby);

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

    // MOJE daně issues a single leaf certificate, but a PEM assembled by hand
    // (or exported from some other tool) can hold a whole chain. We only ever
    // want the leaf — by convention the FIRST block — and using anything else
    // produces a BinarySecurityToken the server can't validate, which again
    // surfaces only as the opaque error code 4. Rather than silently trusting
    // "first block found" when there might be several, count them and warn:
    // a misordered chain is now diagnosable from the log instead of invisible.
    const certBlocks = certText.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
    if (!certBlocks || certBlocks.length === 0) throw new Error(`EET: no PEM certificate found in ${certPem}`);
    if (certBlocks.length > 1) {
        console.warn(
            `EET: ${certPem} contains ${certBlocks.length} CERTIFICATE blocks; using the first as the leaf. `
            + `If this is a chain and the leaf is not listed first, the wrong certificate will be embedded.`
        );
    }
    const [, certBody] = certBlocks[0].match(/-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/);

    let privateKey;
    try {
        privateKey = crypto.createPrivateKey({
            key: fs.readFileSync(keyPem, "utf8"),
            ...(keyPassphrase ? { passphrase: keyPassphrase } : {}),
        });
    } catch (err) {
        // An encrypted key with no (or the wrong) passphrase fails inside OpenSSL
        // with a message like "error:1C800064:Provider routines::bad decrypt" or
        // "error:07880109:...::interrupted or cancelled" — neither names the key
        // file nor says what's actually wrong. Since this is deploy-time
        // configuration (a wrong keyPassphrase env var), name the file and state
        // the fix so it isn't re-diagnosed from an OpenSSL string every time.
        if (!keyPassphrase && /bad decrypt|interrupted or cancelled|bad password/i.test(err.message)) {
            throw new Error(
                `EET: ${keyPem} is an encrypted private key but no passphrase was supplied `
                + `(pass keyPassphrase to loadCredentials). Original error: ${err.message}`
            );
        }
        throw err;
    }

    // BinarySecurityToken carries the DER bytes base64'd on a single line.
    return { certDer: certBody.replace(/\s+/g, ""), privateKey };
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

module.exports = {
    EET_NS, SOAP_NS, WSSE_NS, WSU_NS, DS_NS, BODY_ID, TOKEN_ID,
    escapeAttr, formatAmount, attrs, buildTrzbaBody,
    signedInfoFor, loadCredentials, buildSignedEnvelope,
    PLAYGROUND_URL, PRODUCTION_URL, classifyError, parseResponse, sendTrzba, verifyConnection,
};
