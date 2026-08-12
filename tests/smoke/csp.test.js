// ============================================================================
// csp.test.js — which pages still allow inline styles, and which no longer do.
//
// Finding L2. `style-src 'unsafe-inline'` was consciously accepted in the
// 2026-08-08 review on the grounds that the blast radius for styles is small
// and the alternative was rewriting every page. Re-measured, that was only true
// of ONE page: the admin panel carries 92 inline style="…" attributes and every
// other surface carries none, so the strict policy is free everywhere else.
//
// These assertions are against the REAL headers a browser receives, not against
// the directives object — a policy that is correct in a variable and wrong on
// the wire protects nobody. The hash cases matter most: get a single byte of
// the hashed CSS wrong and the page renders unstyled, which on the receipt a
// customer opens from an SMS looks like a broken business.
// ============================================================================

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert");

const harness = require("../helpers/harness");

const COL = harness.COL;

function parseCsp(header) {
    const out = {};
    for (const part of (header || "").split(";")) {
        const [name, ...values] = part.trim().split(/\s+/);
        if (name) out[name] = values;
    }
    return out;
}

// `expectStatus` because the receipt not-found page correctly answers 404 —
// and it still has to carry a policy, since it is a real HTML page a customer
// reaches from a stale SMS link.
async function styleSrcOf(url, expectStatus = 200) {
    const res = await fetch(url);
    assert.strictEqual(res.status, expectStatus, `${url} should answer ${expectStatus}`);
    const csp = parseCsp(res.headers.get("content-security-policy"));
    assert.ok(csp["style-src"], `${url} sent no style-src at all: ${res.headers.get("content-security-policy")}`);
    return { styleSrc: csp["style-src"], csp, body: await res.text() };
}

describe("content security policy", () => {
    let server;

    before(async () => {
        server = await harness.start();
        // A real receipt, so /uctenka/:id renders its styled page rather than
        // the not-found one.
        harness.seedRecord(server.dbPath, COL.receipts, "rcpt1", {
            id: "rcpt1", number: "2026-000001", issuedAt: new Date().toISOString(),
            kind: "indoor", total: 250, paymentMethodLabel: "Hotově",
            items: [{ item: "Svíčková", qty: 1, price: 250, vatRate: 12 }],
            vatPayer: false,
        });
    });

    after(async () => { if (server) await server.stop(); });

    // ── the pages that no longer allow inline styles ────────────────────

    const strictPages = [
        ["/reservation/app", "the public reservation page"],
        ["/reservation/delivery", "the delivery page"],
        ["/reservation/zrusit?t=aBcDeFgHiJkLmNoPqRsTuV", "the cancellation page"],
        ["/reservation/kitchen", "the kitchen board"],
        ["/reservation/driver", "the driver app"],
        ["/reservation/obchodni-podminky", "the terms page"],
        ["/reservation/ochrana-osobnich-udaju", "the privacy page"],
        ["/reservation/reklamace", "the complaints page"],
        ["/reservation/uctenka/rcpt1", "the printable receipt — opened from a customer's SMS"],
        ["/reservation/uctenka/nosuchreceipt", "the receipt not-found page", 404],
    ];

    test("no customer- or staff-facing page allows inline styles any more", async () => {
        for (const [path, what, status] of strictPages) {
            const { styleSrc } = await styleSrcOf(`${server.baseUrl}${path}`, status);
            assert.ok(!styleSrc.includes("'unsafe-inline'"),
                `${what} (${path}) must not allow inline styles — got: ${styleSrc.join(" ")}`);
            assert.ok(styleSrc.some(v => v.startsWith("'sha256-")),
                `${what} must carry the style hashes instead — got: ${styleSrc.join(" ")}`);
        }
    });

    test("the brand style block on those pages matches a hash in their own policy", async () => {
        // The failure this catches is silent: a mismatched hash does not error,
        // it just leaves the page unstyled.
        const { styleSrc, body } = await styleSrcOf(`${server.baseUrl}/reservation/app`);
        const block = /<style>([\s\S]*?)<\/style>/.exec(body);
        assert.ok(block, "the page should carry the brand style block");

        const crypto = require("node:crypto");
        const actual = `'sha256-${crypto.createHash("sha256").update(block[1], "utf8").digest("base64")}'`;
        assert.ok(styleSrc.includes(actual),
            `the served <style> block hashes to ${actual}, which is not in style-src: ${styleSrc.join(" ")}`);
    });

    test("the receipt's own stylesheet matches a hash too", async () => {
        const { styleSrc, body } = await styleSrcOf(`${server.baseUrl}/reservation/uctenka/rcpt1`);
        const crypto = require("node:crypto");
        const blocks = [...body.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(m => m[1]);
        assert.ok(blocks.length > 0, "the receipt should carry at least one style block");

        for (const css of blocks) {
            const actual = `'sha256-${crypto.createHash("sha256").update(css, "utf8").digest("base64")}'`;
            assert.ok(styleSrc.includes(actual),
                `a receipt <style> block hashes to ${actual}, absent from style-src: ${styleSrc.join(" ")}`);
        }
    });

    test("no page that dropped unsafe-inline still emits a style attribute", async () => {
        // Belt and braces on the measurement this whole change rests on: if one
        // of these pages ever grows an inline attribute, it stops rendering
        // correctly and this says so before a customer finds out.
        for (const [path, what, status] of strictPages) {
            const { body } = await styleSrcOf(`${server.baseUrl}${path}`, status);
            const attrs = body.match(/<[^>]+\sstyle="/g) || [];
            assert.deepStrictEqual(attrs, [], `${what} (${path}) emits ${attrs.length} inline style attribute(s)`);
        }
    });

    // ── the one page that still needs them ──────────────────────────────

    test("the admin panel keeps unsafe-inline, and only the admin panel", async () => {
        for (const path of ["/reservation/admin", "/reservation/inner.html", "/reservation/html/inner.html"]) {
            const { styleSrc } = await styleSrcOf(`${server.baseUrl}${path}`);
            assert.ok(styleSrc.includes("'unsafe-inline'"),
                `${path} still has 92 inline attributes and must keep unsafe-inline — got: ${styleSrc.join(" ")}`);
            // Mutually exclusive by spec: a hash present makes the browser
            // IGNORE unsafe-inline, which would break all 92 at once.
            assert.ok(!styleSrc.some(v => v.startsWith("'sha256-")),
                `${path} must not mix a hash with unsafe-inline — the hash silently wins: ${styleSrc.join(" ")}`);
        }
    });

    // ── the rest of the policy must be unchanged ────────────────────────

    test("splitting style-src did not disturb any other directive", async () => {
        // The admin header is rebuilt by hand rather than by helmet, so this is
        // the check that the hand-rolled serialiser produces the same policy.
        const strict = (await styleSrcOf(`${server.baseUrl}/reservation/app`)).csp;
        const admin = (await styleSrcOf(`${server.baseUrl}/reservation/admin`)).csp;

        for (const directive of Object.keys(strict)) {
            if (directive === "style-src") continue;
            assert.deepStrictEqual(admin[directive], strict[directive],
                `${directive} differs between the two policies and should not`);
        }
        assert.deepStrictEqual(Object.keys(admin).sort(), Object.keys(strict).sort(),
            "both policies must carry the same set of directives");

        // And the ones that matter are still what they were.
        assert.deepStrictEqual(strict["default-src"], ["'self'"]);
        assert.deepStrictEqual(strict["object-src"], ["'none'"]);
        assert.deepStrictEqual(strict["frame-ancestors"], ["'none'"]);
        assert.deepStrictEqual(strict["connect-src"], ["'self'"]);
        assert.ok(strict["script-src"].includes("'self'"));
        assert.ok(strict["script-src"].some(v => v.startsWith("'sha256-")), "the receipt print script stays hashed");
        assert.ok(!strict["script-src"].includes("'unsafe-inline'"), "scripts never allowed inline");
    });
});
