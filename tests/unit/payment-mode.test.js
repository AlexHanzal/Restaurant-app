// ============================================================================
// payment-mode.test.js — may this deployment fall back to fake payments?
//
// The simulated-payment path exists so local development works without GoPay
// credentials: initiateGatewayPayment() mints a SIMULATED-<id> transaction and
// the webhook treats any notification for it as PAID, because there is no real
// gateway to ask. That is correct for a laptop and catastrophic on a public
// host — the client is handed its own gatewayTransactionId in the pay-online
// response, and the webhook is unauthenticated, so a guest who reads their own
// JSON response can confirm their own order and eat for free.
//
// Nothing used to prevent a production deploy from landing in that state; the
// only guard was a console.warn at boot. This is the predicate that decides.
// ============================================================================

const test = require("node:test");
const assert = require("node:assert");

const gopay = require("../../src/server/gopay");

test("configured credentials mean the real gateway, in production or not", () => {
    assert.strictEqual(gopay.paymentMode({ configured: true, isProd: true }), "live");
    assert.strictEqual(gopay.paymentMode({ configured: true, isProd: false }), "live");
});

test("no credentials in development simulates, so local work needs no GoPay account", () => {
    assert.strictEqual(gopay.paymentMode({ configured: false, isProd: false }), "simulated");
});

// THE ONE THAT MATTERS. Refusing outright is deliberately not the same as
// falling back: an unavailable online payment is a customer paying another
// way, whereas a simulated one is an order marked paid that nobody paid for.
test("no credentials in production refuses rather than simulating", () => {
    assert.strictEqual(gopay.paymentMode({ configured: false, isProd: true }), "unavailable");
});
