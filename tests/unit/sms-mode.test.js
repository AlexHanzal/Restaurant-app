// ============================================================================
// sms-mode.test.js — may this deployment fall back to console-logged SMS?
//
// The console fallback exists so local development works without a Twilio
// account: sendSms() prints the message (verification code and all) to stdout
// and reports success. That is correct for a laptop and a dead end on a public
// host — the customer is told "the code is in the server console", which they
// cannot read, so reservations and reorder simply stop working. Worse, the
// route answers 200 {success:true}, so nothing anywhere reports a failure:
// the daily SMS budget and the per-phone limiter are both spent on codes that
// were never sent, and every code lands in plaintext in the journal.
//
// Three separate things can put a deployment on that path — no credentials,
// no `twilio` package (it is a real dependency that `npm ci` must install),
// or both — and all three produce the identical fake success. This is the
// predicate that decides, mirroring gopay.paymentMode() exactly.
// ============================================================================

const test = require("node:test");
const assert = require("node:assert");

const notify = require("../../src/server/notify");

test("credentials plus the package mean real SMS, in production or not", () => {
    assert.strictEqual(notify.smsMode({ configured: true, packageAvailable: true, isProd: true }), "live");
    assert.strictEqual(notify.smsMode({ configured: true, packageAvailable: true, isProd: false }), "live");
});

test("a laptop with neither credentials nor package still simulates", () => {
    assert.strictEqual(notify.smsMode({ configured: false, packageAvailable: false, isProd: false }), "simulated");
    assert.strictEqual(notify.smsMode({ configured: false, packageAvailable: true, isProd: false }), "simulated");
    assert.strictEqual(notify.smsMode({ configured: true, packageAvailable: false, isProd: false }), "simulated");
});

// THE ONE THAT MATTERS. All three broken combinations must refuse in
// production, not simulate: an unavailable SMS is a customer who is told to
// phone the restaurant, a simulated one is a customer stranded mid-booking
// holding a code that exists only in a log file.
test("missing credentials in production refuses rather than simulating", () => {
    assert.strictEqual(notify.smsMode({ configured: false, packageAvailable: true, isProd: true }), "unavailable");
});

// The npm-ci case: credentials are wired, the operator believes SMS works,
// and the package the lazy require() needs was never in `dependencies`.
test("configured credentials with the package missing refuses in production", () => {
    assert.strictEqual(notify.smsMode({ configured: true, packageAvailable: false, isProd: true }), "unavailable");
});

test("neither credentials nor package refuses in production", () => {
    assert.strictEqual(notify.smsMode({ configured: false, packageAvailable: false, isProd: true }), "unavailable");
});

// ── E-MAIL ──────────────────────────────────────────────────────────────────
//
// Same three-state predicate, DELIBERATELY not the same consequence. A
// confirmation e-mail is fire-and-forget alongside an order that has already
// succeeded (server.js's order route), so "unavailable" here must not refuse
// anything the customer is waiting on — it exists so sendEmail() reports
// { ok: false } instead of claiming a message was sent, and so boot can say
// so out loud. See emailMode()'s header in notify.js.

test("e-mail resolves the same three states as SMS", () => {
    assert.strictEqual(notify.emailMode({ configured: true, packageAvailable: true, isProd: true }), "live");
    assert.strictEqual(notify.emailMode({ configured: false, packageAvailable: true, isProd: false }), "simulated");
    assert.strictEqual(notify.emailMode({ configured: true, packageAvailable: false, isProd: true }), "unavailable");
});

// ── THE PACKAGE PROBE ───────────────────────────────────────────────────────
//
// smsMode() is pure so it can be tested like this, which leaves the question
// of where `packageAvailable` comes from. It must not be answered by building
// a client — preflight has to ask at boot, before any credentials exist and
// without side effects — so it is a require.resolve() probe.

test("the package probes answer without constructing a client", () => {
    assert.strictEqual(typeof notify.smsPackageAvailable(), "boolean");
    assert.strictEqual(typeof notify.emailPackageAvailable(), "boolean");
});

// Both packages are declared in `dependencies`. If this fails, either the
// declaration was dropped or `npm install` has not run — which is exactly the
// production hazard above, caught here instead of at 19:00 on a Friday.
test("twilio and nodemailer are actually installed", () => {
    assert.strictEqual(notify.smsPackageAvailable(), true,
        "`twilio` must be installed — it is a real dependency, not an optional extra");
    assert.strictEqual(notify.emailPackageAvailable(), true,
        "`nodemailer` must be installed — it is a real dependency, not an optional extra");
});
