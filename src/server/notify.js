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

// sendSms(phone, text) -> Promise<{ ok, simulated, error? }> — never rejects.
async function sendSms(phone, text) {
    try {
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

// sendEmail(to, subject, html, text?) -> Promise<{ ok, simulated, error? }> — never rejects.
async function sendEmail(to, subject, html, text) {
    try {
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
};
