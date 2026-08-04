// ============================================================================
// security.js — brute-force / abuse hardening shared by server.js
//
// This module is self-contained (only depends on db.js + bcryptjs + express-
// rate-limit) so the two agents working on server.js after this pass can
// treat it as a black box. It provides:
//
//   1. Rate limiters (express-rate-limit instances) — mount as middleware:
//        - apiLimiter        generous backstop for the whole /api surface
//        - loginLimiter      strict, per-IP, for /users/login + /drivers/login
//        - smsIpLimiter      per-IP limiter for /reservations/send-code
//        - smsPhoneLimiter   per-phone-number limiter for the same route
//
//   2. Per-account lockout (in-memory, cross-IP) — a given username/
//      abbreviation gets locked out for a cooldown after too many
//      consecutive bad attempts, independent of which IP is trying.
//      isAccountLocked / recordFailedLogin / clearFailedLogins.
//
//   3. Login audit log — every login attempt (success or failure) is written
//      to the `login_audit` SQLite collection (logLoginAudit /
//      getRecentLoginAudit). Passwords are never logged.
//
//   4. dummyCompare() — runs a real bcrypt comparison against a fixed dummy
//      hash so "account doesn't exist" and "wrong password" take roughly the
//      same amount of time, closing the username-enumeration timing oracle.
//
// Env vars (all optional, sane defaults for local dev):
//   LOGIN_LOCKOUT_THRESHOLD   consecutive failures before lockout (default 6)
//   LOGIN_LOCKOUT_MINUTES     lockout duration in minutes (default 15)
// ============================================================================

const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const db = require("./db");

const LOGIN_AUDIT_COLLECTION = "login_audit";

// ── RATE LIMITERS ───────────────────────────────────────────────────────

// Generous backstop applied to the whole /api surface — catches scripted
// abuse that isn't specifically a login/SMS endpoint (scraping, hammering
// read endpoints, etc). Individual routes below layer stricter limits on
// top of this one.
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Příliš mnoho požadavků z této adresy. Zkuste to prosím později." },
});

// Strict per-IP limiter for the login endpoints. `skipSuccessfulRequests`
// means a run of correct logins doesn't eat into the budget — only failed
// attempts (and the 423 "locked" responses) count, so a legitimate user who
// mistypes a password a couple of times before succeeding isn't punished,
// while a credential-stuffing script is.
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 8,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: { error: "Příliš mnoho pokusů o přihlášení z této adresy. Zkuste to prosím znovu za 15 minut." },
});

// Matches normalizePhone() in server.js — kept as a local copy so this
// module has no dependency on server.js internals.
function normalizePhoneForRateLimit(raw) {
    return (raw || "").toString().trim().replace(/[\s\-().]/g, "");
}

// Per-IP SMS limiter — stops one IP from send-code-bombing many different
// phone numbers (each individually under the per-phone limit below).
const smsIpLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Příliš mnoho žádostí o SMS kód z této adresy. Zkuste to prosím později." },
});

// Per-phone-number SMS limiter — stops one target phone number from being
// SMS-bombed from many different IPs / across many separate reservation
// attempts. This is deliberately separate from (and stricter over a longer
// window than) the existing `resendCooldownMs` 30s cooldown in server.js,
// which just prevents rapid-fire resends of the *same* pending code; this
// caps total codes sent to a number per hour regardless of cooldown resets.
const smsPhoneLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 5,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => normalizePhoneForRateLimit(req.body && req.body.phone) || "unknown-phone",
    message: { error: "Příliš mnoho žádostí o SMS kód pro toto telefonní číslo. Zkuste to prosím později." },
});

// ── TABLE QR SELF-ORDER LIMITERS ────────────────────────────────────────
// Spec 2026-08-04 §6. The signed token stops URL guessing but CANNOT stop
// someone who photographed a real QR code, or a guest firing orders from
// home. These two limiters are what caps the damage in that case.

// Backstop on the work every public table route pays BEFORE it knows the
// token is real — the db.list(timetables) scan inside resolveTableToken().
// That is the only thing an IP budget can usefully bound here.
//
// Sized for a VENUE, not for a person. Every guest in the dining room reaches
// this server from the restaurant's single NAT address, so a per-IP number
// tight enough to constrain one attacker is an outage for the room: at 30 the
// first guest's status screen (up to 60 polls a window, see
// tableStatusLimiter) exhausted the allowance for everyone, and the next
// person to scan a QR code could not even load the menu. This must only ever
// stop a script; the real per-guest limits are the table-keyed ones below.
const tableOrderIpLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 600,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Příliš mnoho požadavků. Zkuste to prosím za chvíli." },
});

// THE ONE THAT MATTERS. Keyed on the RESOLVED table (req.tableFileId, set by
// the route's token-verification step), not on the IP — a leaked QR code
// photo is abused from many phones, which per-IP limiting does not see. A
// real table cannot plausibly place more than a dozen separate orders in a
// quarter of an hour.
//
// MOUNTING CONTRACT: this must run AFTER the middleware that verifies the
// token and assigns req.tableFileId. If it ever runs first, keyGenerator
// falls back to the IP and the protection silently degrades — hence the
// explicit marker rather than a silent `|| req.ip`.
const tableOrderTableLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 12,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.tableFileId || "unresolved-table",
    message: { error: "Z tohoto stolu přišlo příliš mnoho objednávek. Obraťte se prosím na obsluhu." },
});

// Status polling (GET /table-orders/:id/status), keyed on the resolved table
// for the same reason the order limiter above is — and specifically NOT on
// the IP. This is the highest-volume traffic these routes see: a guest's
// status screen polls for the whole time their food is being cooked, which is
// up to 60 requests a window on its own. An IP budget that survives a full
// dining room is therefore no limit at all for one attacker, and one tight
// enough for a single phone cuts off the second guest to sit down. The table
// is the only key on which "too much" has a meaningful value.
//
// Budget: the client escalates 15s -> 30s -> 60s as the wait grows
// (STATUS_POLL_STEPS in src/js/table-order.js), so one screen costs ~31 a
// window. 240 leaves room for four order screens open at one table, plus
// refreshes and the extra immediate poll each tab-focus fires — while still
// bounding a photographed QR code to something a real table cannot exceed.
//
// MOUNTING CONTRACT: identical to tableOrderTableLimiter above — this must
// run AFTER the middleware that verifies the token and assigns
// req.tableFileId, or keyGenerator collapses every table onto one bucket.
const tableStatusLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 240,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.tableFileId || "unresolved-table",
    message: { error: "Příliš mnoho požadavků. Zkuste to prosím za chvíli." },
});

// ── PER-ACCOUNT LOCKOUT (in-memory, cross-IP) ───────────────────────────
//
// Keyed by "scope:identifier" (scope = "user" | "driver", identifier =
// abbreviation/username, lowercased) so a distributed attacker hammering
// one account from many IPs still gets locked out — the per-IP rate
// limiters above wouldn't catch that case alone.
//
// Deliberately applies to nonexistent accounts too (see call sites in
// server.js) so the "account locked" response doesn't itself become a new
// username-enumeration oracle — enough bad attempts against a made-up
// username locks that (nonexistent) key exactly the same way.

const LOCKOUT_THRESHOLD = parseInt(process.env.LOGIN_LOCKOUT_THRESHOLD, 10) || 6;
const LOCKOUT_DURATION_MS = (parseInt(process.env.LOGIN_LOCKOUT_MINUTES, 10) || 15) * 60 * 1000;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000; // failures older than this stop counting toward the threshold

const failedAttempts = new Map(); // key -> { count, firstAt, lockedUntil }

function accountKey(scope, identifier) {
    return `${scope}:${String(identifier || "").toLowerCase()}`;
}

function isAccountLocked(scope, identifier) {
    const entry = failedAttempts.get(accountKey(scope, identifier));
    if (!entry || !entry.lockedUntil) return false;
    if (Date.now() > entry.lockedUntil) {
        failedAttempts.delete(accountKey(scope, identifier));
        return false;
    }
    return true;
}

function recordFailedLogin(scope, identifier) {
    const key = accountKey(scope, identifier);
    const now = Date.now();
    let entry = failedAttempts.get(key);
    if (!entry || (now - entry.firstAt) > ATTEMPT_WINDOW_MS) {
        entry = { count: 0, firstAt: now, lockedUntil: 0 };
    }
    entry.count += 1;
    if (entry.count >= LOCKOUT_THRESHOLD) {
        entry.lockedUntil = now + LOCKOUT_DURATION_MS;
    }
    failedAttempts.set(key, entry);
}

// Call on every successful login so a legitimate user isn't stuck behind a
// stale failure count from earlier mistyped attempts.
function clearFailedLogins(scope, identifier) {
    failedAttempts.delete(accountKey(scope, identifier));
}

// Periodic sweep so the map doesn't grow unbounded under sustained scanning
// (entries that are both unlocked and outside the attempt window are dead
// weight). Unref'd so it never keeps the process alive on its own.
setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of failedAttempts) {
        const stillLocked = entry.lockedUntil && now < entry.lockedUntil;
        const withinWindow = (now - entry.firstAt) <= ATTEMPT_WINDOW_MS;
        if (!stillLocked && !withinWindow) failedAttempts.delete(key);
    }
}, 5 * 60 * 1000).unref();

// ── LOGIN AUDIT LOG ──────────────────────────────────────────────────────
// Persisted to SQLite (survives restarts) so break-in attempts are visible
// via GET /api/security/login-audit. Never logs the password itself —
// only the identifier that was *attempted*, success/fail, IP, and a short
// machine-readable reason code.

function logLoginAudit({ scope, identifier, success, ip, reason }) {
    try {
        const id = `${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;
        db.set(LOGIN_AUDIT_COLLECTION, id, {
            id,
            scope: scope || null,
            identifier: identifier ? String(identifier).slice(0, 100) : null,
            success: !!success,
            ip: ip || null,
            reason: reason || null,
            at: new Date().toISOString(),
        });
    } catch (e) {
        // Audit logging must never take down the login flow itself.
        console.error("Failed to write login audit entry:", e.message);
    }
}

function getRecentLoginAudit(limit = 200) {
    const rows = db.list(LOGIN_AUDIT_COLLECTION);
    rows.sort((a, b) => new Date(b.at) - new Date(a.at));
    return rows.slice(0, Math.max(1, Math.min(limit, 1000)));
}

// ── TIMING-SAFE "ACCOUNT NOT FOUND" HANDLING ────────────────────────────
// A fixed bcrypt hash of a random value nobody knows, computed once at
// startup. When the looked-up account doesn't exist, compare the submitted
// password against this instead of short-circuiting — so both branches of
// "user found" vs "user not found" pay the same bcrypt cost, and a network
// timing side-channel can't be used to enumerate valid usernames.
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(24).toString("hex"), 12);

async function dummyCompare(plain) {
    return bcrypt.compare(plain || "x", DUMMY_HASH);
}

module.exports = {
    apiLimiter,
    loginLimiter,
    smsIpLimiter,
    smsPhoneLimiter,
    tableOrderIpLimiter,
    tableOrderTableLimiter,
    tableStatusLimiter,
    isAccountLocked,
    recordFailedLogin,
    clearFailedLogins,
    logLoginAudit,
    getRecentLoginAudit,
    dummyCompare,
    LOCKOUT_THRESHOLD,
    LOCKOUT_DURATION_MS,
};
