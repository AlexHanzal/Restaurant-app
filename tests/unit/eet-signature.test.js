const test = require("node:test");
const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const eet = require("../../src/server/eet");

// Throwaway self-signed keypairs generated once with openssl, pasted here as
// constants — never written to the repo as .pem (the repo's .gitignore
// excludes *.pem, and loadCredentials only ever sees files under os.tmpdir()
// that these tests create and clean up themselves):
//   openssl req -x509 -newkey rsa:2048 -keyout key1.pem -out cert1.pem \
//     -days 3650 -nodes -subj "/CN=eet-test-leaf"
//   openssl req -x509 -newkey rsa:2048 -keyout key2.pem -out cert2.pem \
//     -days 3650 -nodes -subj "/CN=eet-test-second"
//   openssl rsa -in key1.pem -out key1-enc.pem -aes256 -passout pass:testpass123
const TEST_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIDETCCAfmgAwIBAgIUO5s2PvffK4WzKLH9Bn8e7kFR7pIwDQYJKoZIhvcNAQEL
BQAwGDEWMBQGA1UEAwwNZWV0LXRlc3QtbGVhZjAeFw0yNjA3MzExMTQ1NTRaFw0z
NjA3MjgxMTQ1NTRaMBgxFjAUBgNVBAMMDWVldC10ZXN0LWxlYWYwggEiMA0GCSqG
SIb3DQEBAQUAA4IBDwAwggEKAoIBAQDf0Ld1UTxTP+xlLIM62KrtWR01UJcwPUMu
Ct3yME4pYhdoQLOro7o1IgDK6oP8xzgt6LqRf+OTCN5PqcKHnmLAkRLK+Ti2HIpi
lFvogNzYXoSDEXi6pti02qvrwhBbd+zVndkxhKDBc+la2q/qqETDnGghck0Zh5BS
8GZORguf5cRxdbU+MIp/fCEuHieVMKOKQ6S47d/FRg9JJ9hPopA6SSRxdwoxguH+
Wtp8v3dPGVF9Ple5rvgX2KigrjCQJKLoKGoELja7xOb1AjIZ52f0o3aVEi3mKPts
KVaGiS7VNlZMOSQrxtMj7KmO2OV85ivmQXMD/L6Chc6WrpFZZprjAgMBAAGjUzBR
MB0GA1UdDgQWBBSsbsAdNhdMYzxeZjUiOe2Wl4qrOjAfBgNVHSMEGDAWgBSsbsAd
NhdMYzxeZjUiOe2Wl4qrOjAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUA
A4IBAQDG6Iw1sLe6qh2oPLFbKnQvTkPsyw7qL1K53uONTohv4j8auc+n6oo7IyNh
XEA2pdBsISNQ71MZu4jL6iSsloAy6fKYe/3fjL73YnfMH1hFL35oMyU0DJrhJiJQ
AKID4Hg26RvuPFiImnuSCmgeHlUGzMXPuB4kXCLK0Dgq7TP6b1wORXDm+pYss8zy
9DcJ/xSFohhfFUFx3RXPc0hCFwaCNg3i4TW4OY9dAEpuHH0dC0ZpMHXJCKrfSpSE
k28SINKC5ja39udEYRQhduVuHtTeMCOf040RQqZEy0Ngi7niL8JEoRljS7Z/0HWv
11pdCvRt55g4tmFQw9W6ASLNNRHK
-----END CERTIFICATE-----
`;

const TEST_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDf0Ld1UTxTP+xl
LIM62KrtWR01UJcwPUMuCt3yME4pYhdoQLOro7o1IgDK6oP8xzgt6LqRf+OTCN5P
qcKHnmLAkRLK+Ti2HIpilFvogNzYXoSDEXi6pti02qvrwhBbd+zVndkxhKDBc+la
2q/qqETDnGghck0Zh5BS8GZORguf5cRxdbU+MIp/fCEuHieVMKOKQ6S47d/FRg9J
J9hPopA6SSRxdwoxguH+Wtp8v3dPGVF9Ple5rvgX2KigrjCQJKLoKGoELja7xOb1
AjIZ52f0o3aVEi3mKPtsKVaGiS7VNlZMOSQrxtMj7KmO2OV85ivmQXMD/L6Chc6W
rpFZZprjAgMBAAECggEAFxYIVmmSt2OYlrcIskE3IFRY1u8BKVCoZU9ppVmmNk6P
64kA/2tcAa8INeYKx0AlY1bmJ6vxZXE8vSrdje+gcAyGy7j5SI+ZFqIG+OyR2x+k
u4BJ27bqE32azi6uUUEFhONLS/hKPKogH+b+zk2dCjBP7WNE4KVDFcsGQnynJk7z
lWolO5J7XAEcawKB0OlqBLe10Scwe1q1bN4XdGH2jv/DQ+qwHMNn5QXg5EG1sbj3
TyLTzTPgPeB4R/aTRj56ry174wsbNpJnXgScGqPogsI2B9LyS0aMNc2UgobWM/wg
2Mad7gU/hJnaEB1AZLNR5MhTD+3rJizD/NZAu/oOgQKBgQD2c0M7uf6boOAwuBq1
dl41fxzMwl8eP07HM1DOP5Z/b4FbMi5eOapOWlwaBpClyryE8oDDVqu2hLg/ZZzH
6X2amwheLudqGfB2AQ72Yh5V2jLQIZ0+QPVq7vioLiL4vJAjPTtidNWIY7JaPfyf
qvQSUSWhNsubUciANv+tjmwyawKBgQDofOt7a6qNEj7qPuproPjLbPEfu0qHQkkN
BkGEXT91CPNTj1eqxu+6Zy9N3MmObuc2RUg5MfIVlE++CvDen1CncXlNjh6SZopL
Xr5wKHxNiJ0nvLxaqDL6XBmRj2k2mGjRn4XViMXCWXkSplIaud8RGII5tOsJljvc
ZpD9KC8HaQKBgQDrMutaR9I+ElWDCWCsB5A3O91vaJzAUCjNoSKgAz2M1wy7zPNF
h4EKD+BQEi3fm9E4i/ro8YEkyhrQnhf3DdWKRCTDRb4imyjKZY4zA0byJjBSQ5I+
hF3zNKdoUcecXNCuYNSYzOmwpXzj9L5wXwVZqcngxlugGnfgLRzrNL37iwKBgQDF
EDYOfLmpMEESD1hm+KBK1kIgsoG+2unO13Grf9rtGjQerQ8TW+MSLqqDJlXWnJzx
fJJ2oKZhskBRhzaajZIxDFdU7NVvJOmub1We/kI2+kizySAi/BWR74Vgw53cQB4B
KWWpFXEDhxHARCiuLMUu2YZw4bCkhKqi7HGTlH8gmQKBgHwoNvRLkAiM1s6Yk894
/cBMPHK0rzvY/itPL7bH6Seu2BHijMUXvSF6vwijNUiMpjODEMvDzx9QXEHjxgNc
TAvKzmU2LmSYv2MCg9yDWkV8kdnDt7BrFgRvRm7tpcn02AE7w74Es+3ihFGGACcm
XMalcJmAxmPpU2SLosW/p3Y1
-----END PRIVATE KEY-----
`;

// A second, unrelated self-signed certificate — concatenated after
// TEST_CERT_PEM this simulates a PEM that (incorrectly) holds a chain, so
// the "count the blocks and warn" behaviour has something to count.
const TEST_CERT2_PEM = `-----BEGIN CERTIFICATE-----
MIIDFTCCAf2gAwIBAgIUGGDilgGV1lmQP/W0hxYp8AU1VPUwDQYJKoZIhvcNAQEL
BQAwGjEYMBYGA1UEAwwPZWV0LXRlc3Qtc2Vjb25kMB4XDTI2MDczMTExNDU1NFoX
DTM2MDcyODExNDU1NFowGjEYMBYGA1UEAwwPZWV0LXRlc3Qtc2Vjb25kMIIBIjAN
BgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArqRD+eLlDU7Cy4x97vYFq4GAgglS
u7bD1/EhOWeEA98KJMsqNxRYTMMvHtUoSnxv7j8u0z6yhQsdSZhll26zknYQlIT9
OxnAkzIph6W/i0CkCLmWXV2k8OtZ8J0Lpe9Vw8UvySZDJnlVAQptXt4wxlvNv9z5
J0zzmayzFJ7CWvvA4pFB8/aOBpz32XWcf4AS5YbDRZr6Y+VDSeJE55WU01dKuWFf
KMhVW5gUjgyJt3aWbvjFYg3xqrcRMTu/Q3O3/e3URzoemZCrw34/okquVsW4BrVW
ldjPZPJsSlfc9ONjPBcpM53AvjZaTP9/y5UxjuEWWOXTYIGS5WsFA7BXiwIDAQAB
o1MwUTAdBgNVHQ4EFgQUjopUBta9VgHavC4PhYBmN+gxP28wHwYDVR0jBBgwFoAU
jopUBta9VgHavC4PhYBmN+gxP28wDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0B
AQsFAAOCAQEAevTeqgDidBCuGKGwiQa5jHf/iSL/dl5uMbASSylTBGOBjBbTAv6J
kCtwFupPO7K9pBbznVX2jqWqKUr0ICPcR8PMG6vUfr9IETEKjAl/cXaaD7FsCLBl
SNVdH1hzvd9O8js/eRRzCWlSKpHdbPwbuZTQwrAko6BXk+jKCoZmPBJHdGTLoxPl
VGmNt+yTzNHzLZfq5PcM3KdlAe/yjNVQcvMWZl/uFAaTZ3JYQ5kieAoN8NVa1hnp
kzbdKnPDTgt70latm7xctImbrT4+XHoZ8h/JOs9etjM5OHRZXqBYFnHpPL5eIK5K
xPRRYbQRbCUHdUll8uPL39+TEMCAPgqP7g==
-----END CERTIFICATE-----
`;

// Same key as TEST_KEY_PEM, re-exported AES-256 encrypted with passphrase
// "testpass123" — used to exercise the missing/wrong-passphrase error path.
const TEST_KEY_PEM_ENCRYPTED = `-----BEGIN ENCRYPTED PRIVATE KEY-----
MIIFNTBfBgkqhkiG9w0BBQ0wUjAxBgkqhkiG9w0BBQwwJAQQFeDi66WJ9DHs6BOm
9cRNaAICCAAwDAYIKoZIhvcNAgkFADAdBglghkgBZQMEASoEEKR2vo1Jog+S6txs
nfg/m/kEggTQrIENvdxlwEO16u7d5+GxZOwq+t6o7VWniiZ/XKh6OJ0RGWY+eyr/
jocOKAYNLlKGJzo2eMqdzrDiWNeKiz54HxzLQj+iWpOw9VbLyHMFbXlbbjmORAB8
ixCk2Hg8wbworrEURBMNYbCsejEoHQ+d8+eQ7okWiR7cRH5q2Q3qZX2rgAtiufc/
hb7S7hMOxTdhzEx+ikuPxdYXPVb6mRqRYNjlxptu13zQTL7DBBJ22HnDIMtPUn9S
gOctFitoKcFXzwS9YGqaR6aQrml7p6QORG6KbQ89njE+Kxu6xFeD1hEjJo+1FZQg
RL3fQeTK3JRIro1Z4uN4A2KkJBaFHuWti9Sm4sALMthi+mdK4k5BNKtBWBpQ8Rou
6mqn7WzUWqGapC6IE+FZs31NzNH/JSdd6ssp1M5EZT0Ez87UCf5NVrS4OxhQ7V2T
I6Mvep+VsorZISAFH+SvmTAU5wAVH4IdEtALBmu+YHXZFXgW87rLx/XuPgzzZsyN
Y1eH91C02TsCSrdGVhdX4H20cm1jCAkV+Lgd4Qk918WK40rTrt0Al2fuM4WBhFR5
epGibb9TRALkDrPDgmphmtpiSOZc/GckxBrT1sYNai3e7tDyfF2Kcwgz8FJbUugC
LXa54w+xmFkOwU83GnykIKohvVP9+DtDdi3SwUyGh0Rbm/48X8W7ccLeomvI2D0+
Ge0pCNvk98I3vnD4tTHfGZfVgP3TneOxXPL+o2nmq0w98MXhzYknlWgNFXmgJhDO
8GuctcQ8qx7Gi6L9NqHpfO00YlghKdfYE0v8vzWPQxMBIOJk2yb54Eo78NZzf9Qj
g1P7dz0GhdcvMbbA3kA9Lm/e5a1gdcD73i+6AOD3NLDdTwPULGi2FgMKfhg/rWbG
8IxvidmnOuIX/BRdIMSQEP75QQxXnopDeBkIeqsVRhDuSvlXxVKcCY3SveoF6tbN
fs40gMH+gRrvNeWN3BT7haoSQmGhVXOalD01C4vklLP83WptXLZju2HBYDLVAqm2
Ux61p0Zh7TRrqysaL7/9O73c5nxK67G+jAniXi+Dpy6ygRTnozGtRmlaUyTabkAp
ZFC+5Y3HP4xPJKuR0Rnkai+eov5c8ipSPFlqRsK2QsHUfSD/sMu6UgCkR4b6WfJk
FmcKTt3xGa6NeAcGiSSZn4MGrs2GrSi11B5GS2ylB72PQFsS3tFxukTSij1NlmT3
qgtbYo/Ttdp7YfrWn7bUvdN+TuBHY5UvFqsUTLAmGLoNl395itRZcdh1dJOSPWWj
mxmpWiR1jVcMsmNfWGvU31gBzjqF+kwUJqMrH1GPk69GddJ2MPubbJnqyYwIPTYG
Jj+p3pXBg3H7q4ffsbJ/kWtvv1ho/YrAOyqQKUKfGt8YWtEozrY/Skhf2Xq90hJ8
unpkRb3THfCcKUSMzc8ZZvOJQ7kRc285u07vQ7A1VG0NVWbnMO4cRA+1UoMTWrcb
pKdGJtrm8eOtUvuuBuDy2p0TZ6Lb9GYF23q5CjSDg4AqPQ8qHhEf034o1ckQUm5s
9wIJYAdaab3m7cPijZ1m8QQJvCI+XcucUdf4vgaK+JsKxZ/NHMllcjCmwVikzojR
6ESLG6rOUgF71bvfWUroO3lKKh6C7d2vpoNFnymxZiPisQ9epqC3/aY=
-----END ENCRYPTED PRIVATE KEY-----
`;
const TEST_KEY_PASSPHRASE = "testpass123";

// Fresh temp dir per test so parallel test files never collide on filenames,
// and everything is cleaned up afterwards — nothing lingers under
// os.tmpdir() once the suite exits.
function tmpFile(name, contents) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eet-creds-test-"));
    const filePath = path.join(dir, name);
    fs.writeFileSync(filePath, contents);
    return filePath;
}

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

// ----------------------------------------------------------------------------
// Finding 1: crypto.sign/verify above use a hardcoded "sha256" completely
// independent of the Algorithm="..." URI strings baked into the XML. A typo
// in any of those three URIs would still produce XML that verifies with the
// tests above and still fails against the live endpoint as an opaque error
// code 4. Assert on the exact, complete attribute — `Algorithm="..."` up to
// the closing quote and immediately followed by `>` — so a truncated or
// subtly-wrong URI (e.g. a dropped trailing '#') cannot slip past a loose
// substring match.
// ----------------------------------------------------------------------------

test("CanonicalizationMethod and the Reference Transform use the exact exc-c14n URI", () => {
    const signedInfo = eet.signedInfoFor(eet.buildTrzbaBody(SALE));
    const exact = 'Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"';
    assert.match(signedInfo, /<ds:CanonicalizationMethod Algorithm="http:\/\/www\.w3\.org\/2001\/10\/xml-exc-c14n#"><\/ds:CanonicalizationMethod>/);
    assert.match(signedInfo, /<ds:Transform Algorithm="http:\/\/www\.w3\.org\/2001\/10\/xml-exc-c14n#"><\/ds:Transform>/);
    // Belt-and-braces: both sites use the literal same string, not two URIs
    // that happen to both match a looser pattern.
    assert.strictEqual((signedInfo.match(new RegExp(exact.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length, 2);
});

test("SignatureMethod uses the exact rsa-sha256 URI", () => {
    const signedInfo = eet.signedInfoFor(eet.buildTrzbaBody(SALE));
    assert.match(signedInfo, /<ds:SignatureMethod Algorithm="http:\/\/www\.w3\.org\/2001\/04\/xmldsig-more#rsa-sha256"><\/ds:SignatureMethod>/);
});

test("DigestMethod uses the exact sha256 URI", () => {
    const signedInfo = eet.signedInfoFor(eet.buildTrzbaBody(SALE));
    assert.match(signedInfo, /<ds:DigestMethod Algorithm="http:\/\/www\.w3\.org\/2001\/04\/xmlenc#sha256"><\/ds:DigestMethod>/);
});

// ----------------------------------------------------------------------------
// Finding 2: loadCredentials had zero test coverage. Use a throwaway
// self-signed cert/key (constants above, generated once with openssl —
// never written to the repo as .pem) written under os.tmpdir() to exercise
// the real file-reading, PEM-parsing, and crypto.createPrivateKey path.
// ----------------------------------------------------------------------------

test("loadCredentials returns a usable privateKey and a single-line base64 certDer", () => {
    const certPath = tmpFile("cert.pem", TEST_CERT_PEM);
    const keyPath = tmpFile("key.pem", TEST_KEY_PEM);

    const creds = eet.loadCredentials({ certPem: certPath, keyPem: keyPath });

    assert.strictEqual(creds.privateKey.asymmetricKeyType, "rsa");
    // "usable" means it actually signs, not just that createPrivateKey didn't throw.
    const sig = crypto.sign("sha256", Buffer.from("probe"), creds.privateKey);
    assert.ok(sig.length > 0);

    assert.ok(!/\s/.test(creds.certDer), `certDer must have no whitespace, got: ${creds.certDer}`);
    assert.match(creds.certDer, /^[A-Za-z0-9+/]+=*$/, "certDer must be plain base64");
});

// ----------------------------------------------------------------------------
// Finding 3: loadCredentials silently took whatever CERTIFICATE block its
// regex found first. If a PEM holds a chain, that's the leaf by convention —
// correct behaviour — but with no count and no warning a misordered chain
// (leaf not first) would silently embed the wrong certificate with no way to
// diagnose it after the fact. Cover both the plain single-cert case (no
// warning) and the chain case (warning naming the file and the count).
// ----------------------------------------------------------------------------

test("loadCredentials does not warn for a single-certificate PEM", () => {
    const certPath = tmpFile("cert-single.pem", TEST_CERT_PEM);
    const keyPath = tmpFile("key.pem", TEST_KEY_PEM);

    const warnCalls = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnCalls.push(args.join(" "));
    try {
        eet.loadCredentials({ certPem: certPath, keyPem: keyPath });
    } finally {
        console.warn = originalWarn;
    }
    assert.deepStrictEqual(warnCalls, []);
});

test("loadCredentials keeps the leaf (first) certificate and warns on a two-certificate PEM", () => {
    const chainPath = tmpFile("chain.pem", TEST_CERT_PEM + TEST_CERT2_PEM);
    const leafOnlyPath = tmpFile("leaf-only.pem", TEST_CERT_PEM);
    const keyPath = tmpFile("key.pem", TEST_KEY_PEM);

    const warnCalls = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnCalls.push(args.join(" "));
    let creds;
    try {
        creds = eet.loadCredentials({ certPem: chainPath, keyPem: keyPath });
    } finally {
        console.warn = originalWarn;
    }

    // Same certDer as loading the leaf alone — proves the FIRST block won,
    // not the second.
    const leafOnly = eet.loadCredentials({ certPem: leafOnlyPath, keyPem: keyPath });
    assert.strictEqual(creds.certDer, leafOnly.certDer);

    assert.strictEqual(warnCalls.length, 1, `expected exactly one warning, got: ${JSON.stringify(warnCalls)}`);
    assert.match(warnCalls[0], /chain\.pem/, "warning must name the file");
    assert.match(warnCalls[0], /\b2\b/, "warning must state the block count");
});

// ----------------------------------------------------------------------------
// Finding 4: an encrypted private key with no (or the wrong) passphrase used
// to fail with a raw OpenSSL error ("bad decrypt" / "interrupted or
// cancelled") that names neither the file nor the actual problem. Wrap it.
// ----------------------------------------------------------------------------

test("loadCredentials names the key file and demands a passphrase for an encrypted key given none", () => {
    const certPath = tmpFile("cert.pem", TEST_CERT_PEM);
    const keyPath = tmpFile("key-encrypted.pem", TEST_KEY_PEM_ENCRYPTED);

    assert.throws(
        () => eet.loadCredentials({ certPem: certPath, keyPem: keyPath }),
        (err) => {
            assert.match(err.message, /key-encrypted\.pem/, "error must name the key file");
            assert.match(err.message, /passphrase/i, "error must say a passphrase is required");
            return true;
        },
    );
});

test("loadCredentials succeeds on an encrypted key when the correct passphrase is supplied", () => {
    const certPath = tmpFile("cert.pem", TEST_CERT_PEM);
    const keyPath = tmpFile("key-encrypted.pem", TEST_KEY_PEM_ENCRYPTED);

    const creds = eet.loadCredentials({ certPem: certPath, keyPem: keyPath, keyPassphrase: TEST_KEY_PASSPHRASE });
    assert.strictEqual(creds.privateKey.asymmetricKeyType, "rsa");
    const sig = crypto.sign("sha256", Buffer.from("probe"), creds.privateKey);
    assert.ok(sig.length > 0);
});
