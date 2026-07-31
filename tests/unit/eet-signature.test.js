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
