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

module.exports = {
    EET_NS, SOAP_NS, WSSE_NS, WSU_NS, DS_NS, BODY_ID, TOKEN_ID,
    escapeAttr, formatAmount, attrs, buildTrzbaBody,
};
