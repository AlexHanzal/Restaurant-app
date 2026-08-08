// ============================================================================
// notify.js — customer notifications: SMS (Twilio) + optional e-mail
// (nodemailer). Go-live Task 4, spec §6.
//
// Design:
//   - Both sendSms() and sendEmail() NEVER throw/reject — every failure path
//     (missing package, bad credentials, network error, provider rejection)
//     is caught internally and logged with console.error, then a
//     `{ ok: false, ... }` result is resolved. Callers wiring the four
//     notification events (order confirmed, driver claim, reservation
//     booked, reservation reminder) can fire-and-forget these calls without
//     any risk of an unhandled rejection or a notification failure turning
//     into a failed HTTP response for the customer.
//   - Twilio wiring here is the SAME client/credentials/fallback pattern
//     server.js used to own directly (getTwilioClient/smsIsConfigured) —
//     extracted to this module so there is exactly one copy. server.js's
//     /reservations/send-code verification-code path now calls sendSms()
//     too, but keeps its own throwing behavior by checking `result.ok`
//     itself (see sendVerificationSms in server.js) — this module's job is
//     only to send + log, never to decide whether the caller should treat a
//     failure as fatal.
//   - E-mail is a new dependency (nodemailer, go-live Task 4) — required
//     lazily (like `twilio` already was) so a missing/not-yet-installed
//     package degrades to the console fallback instead of crashing the
//     server at require() time.
// ============================================================================

const SMS_CONFIG = {
    accountSid: process.env.TWILIO_ACCOUNT_SID || "",
    authToken: process.env.TWILIO_AUTH_TOKEN || "",
    fromNumber: process.env.TWILIO_FROM_NUMBER || "",
};

const EMAIL_CONFIG = {
    host: process.env.SMTP_HOST || "",
    port: parseInt(process.env.SMTP_PORT, 10) || 587,
    secure: process.env.SMTP_SECURE === "true",
    user: process.env.SMTP_USER || "",
    pass: process.env.SMTP_PASS || "",
    from: process.env.SMTP_FROM || "",
};

// ── MAY THIS DEPLOYMENT FALL BACK? ──────────────────────────────────────────
//
// SECURITY / CORRECTNESS. The console fallback below exists so a laptop works
// without a Twilio account: sendSms() prints the message — verification code
// included — to stdout and reports success.
//
// On a public host that is a dead end wearing a success response. The customer
// is shown "the code is in the server console", which they cannot read, so the
// reservation and reorder flows reach the code-entry step and stop. Because
// the fallback returned `{ ok: true }`, nothing upstream could tell: the route
// answered 200, the global daily SMS budget (smscap) and the per-phone limiter
// were both spent on a code that was never sent, and the code itself landed in
// plaintext in a journal that gets pasted into chats and bug reports.
//
// This is the same hazard gopay.paymentMode() was written to close, and it
// takes the same shape — with one extra input. THREE independent things put a
// deployment on the fallback path, and all three look identical from outside:
//
//   - TWILIO_* not set (.env.example ships them empty, so this is the default
//     state of a fresh deploy);
//   - the `twilio` package not installed — the require() below is lazy, so a
//     missing dependency degrades silently rather than failing at boot;
//   - both.
//
// Hence `packageAvailable` alongside `configured`. Missing either one in
// production must REFUSE, which is a materially different outcome from
// simulating: an unavailable SMS is a customer told to phone the restaurant,
// a simulated one is a customer stranded mid-booking holding a code that
// exists only in a log file.
//
// Pure and exported so the decision is testable without standing up a server
// or a Twilio account — see tests/unit/sms-mode.test.js.
//
//   "live"        — real Twilio call.
//   "simulated"   — dev fallback, console-logged, no SMS sent.
//   "unavailable" — refuse; callers surface it to the customer.
function smsMode({ configured, packageAvailable, isProd }) {
    if (configured && packageAvailable) return "live";
    return isProd ? "unavailable" : "simulated";
}

// Same three states for e-mail, DELIBERATELY not the same consequence.
// Confirmation e-mails are fire-and-forget alongside an order that has already
// succeeded (see server.js's order route), so refusing buys the customer
// nothing and risks a route that currently cannot fail. "unavailable" here
// means only: sendEmail() reports `{ ok: false }` rather than claiming a
// message was sent, and boot says so out loud. Nobody is made to wait.
function emailMode({ configured, packageAvailable, isProd }) {
    if (configured && packageAvailable) return "live";
    return isProd ? "unavailable" : "simulated";
}

// `packageAvailable` must be answerable at BOOT — before any credentials
// exist, and without side effects — because preflight.js asks it to decide
// whether to let the process start. require.resolve() does exactly that: it
// runs module resolution and throws MODULE_NOT_FOUND without executing the
// package or constructing a client.
function moduleIsInstalled(name) {
    try {
        require.resolve(name);
        return true;
    } catch (e) {
        return false;
    }
}

function smsPackageAvailable() {
    return moduleIsInstalled("twilio");
}

function emailPackageAvailable() {
    return moduleIsInstalled("nodemailer");
}

// The live answers, read from the actual environment. Kept separate from the
// pure predicates above so the predicates stay testable.
function getSmsMode() {
    return smsMode({
        configured: isSmsConfigured(),
        packageAvailable: smsPackageAvailable(),
        isProd: process.env.NODE_ENV === "production",
    });
}

function getEmailMode() {
    return emailMode({
        configured: isEmailConfigured(),
        packageAvailable: emailPackageAvailable(),
        isProd: process.env.NODE_ENV === "production",
    });
}

// Set on the `{ ok: false }` result (and on the Error that server.js's
// sendVerificationSms turns it into) when the refusal is "we will not do
// this", not "the send failed" — so route handlers can answer 503 with
// "phone us" rather than 500 "check your number", exactly as the pay-online
// routes distinguish ONLINE_PAYMENTS_UNAVAILABLE from a gateway error.
const SMS_UNAVAILABLE = "SMS_UNAVAILABLE";

// ── SMS (Twilio) ────────────────────────────────────────────────────────────

let twilioClient = null;

function isSmsConfigured() {
    return !!(SMS_CONFIG.accountSid && SMS_CONFIG.authToken && SMS_CONFIG.fromNumber);
}

function getTwilioClient() {
    if (twilioClient) return twilioClient;
    if (!isSmsConfigured()) return null;
    try {
        const twilio = require("twilio");
        twilioClient = twilio(SMS_CONFIG.accountSid, SMS_CONFIG.authToken);
        return twilioClient;
    } catch (e) {
        console.warn("⚠️  'twilio' package not installed — run `npm install twilio`. Falling back to console-logged SMS.");
        return null;
    }
}

// sendSms(phone, text) -> Promise<{ ok, simulated, unavailable?, error? }>
// — never rejects.
async function sendSms(phone, text) {
    try {
        // Checked BEFORE getTwilioClient() so the console.log below — which
        // prints the full message body, verification code and all — is
        // unreachable in production. See smsMode()'s header.
        if (getSmsMode() === "unavailable") {
            console.error(
                `🛑 SMS refused (not configured, or the 'twilio' package is missing) and NODE_ENV=production — ` +
                `nothing sent to ${phone}. The console fallback is DEVELOPMENT ONLY: it would tell the customer ` +
                `to read a code out of the server log.`
            );
            return { ok: false, simulated: false, unavailable: true, code: SMS_UNAVAILABLE, error: SMS_UNAVAILABLE };
        }
        const client = getTwilioClient();
        if (!client) {
            console.log(`📲 [SMS fallback — not actually sent] To: ${phone} | ${text}`);
            return { ok: true, simulated: true };
        }
        await client.messages.create({ body: text, from: SMS_CONFIG.fromNumber, to: phone });
        return { ok: true, simulated: false };
    } catch (e) {
        console.error("SMS send failed:", e && e.message ? e.message : e);
        return { ok: false, simulated: false, error: e && e.message ? e.message : String(e) };
    }
}

// ── E-MAIL (nodemailer) ─────────────────────────────────────────────────────

let mailTransport = null;

function isEmailConfigured() {
    return !!(EMAIL_CONFIG.host && EMAIL_CONFIG.user && EMAIL_CONFIG.pass && EMAIL_CONFIG.from);
}

function getMailTransport() {
    if (mailTransport) return mailTransport;
    if (!isEmailConfigured()) return null;
    try {
        const nodemailer = require("nodemailer");
        mailTransport = nodemailer.createTransport({
            host: EMAIL_CONFIG.host,
            port: EMAIL_CONFIG.port,
            secure: EMAIL_CONFIG.secure,
            auth: { user: EMAIL_CONFIG.user, pass: EMAIL_CONFIG.pass },
        });
        return mailTransport;
    } catch (e) {
        console.warn("⚠️  'nodemailer' package not installed — run `npm install nodemailer`. Falling back to console-logged e-mails.");
        return null;
    }
}

// sendEmail(to, subject, html, text?) -> Promise<{ ok, simulated, unavailable?, error? }>
// — never rejects.
async function sendEmail(to, subject, html, text) {
    try {
        // Unlike SMS this refuses nothing the customer is waiting on — the
        // order it accompanies has already succeeded and every caller is
        // fire-and-forget. The point is only that a message nobody sent must
        // not be reported as sent. See emailMode()'s header.
        if (getEmailMode() === "unavailable") {
            console.error(
                `🛑 E-mail not sent to ${to} (SMTP not configured, or the 'nodemailer' package is missing) ` +
                `and NODE_ENV=production — subject: ${subject}`
            );
            return { ok: false, simulated: false, unavailable: true, error: "EMAIL_UNAVAILABLE" };
        }
        const transport = getMailTransport();
        if (!transport) {
            console.log(`✉️  [E-mail fallback — not actually sent] To: ${to} | Subject: ${subject}`);
            return { ok: true, simulated: true };
        }
        await transport.sendMail({
            from: EMAIL_CONFIG.from,
            to,
            subject,
            html,
            text: text || undefined,
        });
        return { ok: true, simulated: false };
    } catch (e) {
        console.error("E-mail send failed:", e && e.message ? e.message : e);
        return { ok: false, simulated: false, error: e && e.message ? e.message : String(e) };
    }
}

module.exports = {
    sendSms,
    sendEmail,
    isSmsConfigured,
    isEmailConfigured,
    smsMode,
    emailMode,
    smsPackageAvailable,
    emailPackageAvailable,
    getSmsMode,
    getEmailMode,
    SMS_UNAVAILABLE,
};
