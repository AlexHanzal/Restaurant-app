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

// Every limit in this module, in one place, so the ONE invariant that ties
// them together can be asserted rather than just commented:
//
//     apiBackstop > every other number here
//
// The backstop is mounted on the whole /api prefix (server.js), so it stacks
// on top of each route's own limiter and the SMALLER of the two is what a
// caller hits. If it ever drops below a per-route limit, that route's
// carefully-keyed budget stops existing and nobody finds out until a service
// falls over. tests/smoke/api-rate-limit.test.js asserts the ordering off
// this object; the individual numbers are free to be retuned.
const RATE_LIMITS = {
    apiBackstop: 3000,
    login: 8,
    smsIp: 20,
    smsPhone: 5,
    tableOrderIp: 600,
    tableOrderPerTable: 12,
    tableStatusPerTable: 240,
};

// Generous backstop applied to the whole /api surface — catches scripted
// abuse that isn't specifically a login/SMS endpoint (scraping, hammering
// read endpoints, etc). Individual routes below layer stricter limits on
// top of this one.
//
// THE NUMBER HERE MUST STAY ABOVE EVERY PER-ROUTE LIMIT BELOW. Two limiters
// on one route do not negotiate — the SMALLER one binds, whichever is
// mounted first. This sat at 300 while the table limiters below were sized
// at 600 and 240, which meant neither of those could ever fire and every
// carefully-keyed number in this file was decoration: the real, only limit
// on the table routes was 300 requests per IP, i.e. 20/minute for an entire
// restaurant sharing one NAT address. Four QR screens open plus a kitchen
// board on its SSE-fallback poll (5s — see startBoardStream() in
// src/js/kitchen.js, 180 requests a window on its own) exhausted that inside
// ten minutes of a normal Friday service, after which the next guest to scan
// a code got "Příliš mnoho požadavků" instead of a menu and staff got 429s
// mid-order. Nothing in the logs said "rate limiter".
//
// So this is deliberately NOT a venue-sized number, and must not be tuned as
// if it were one. It is pure anti-script defence — the ceiling on a bot that
// found the API and is walking it. Every route where "too much" has a
// meaningful, venue-aware value already carries its own limiter keyed on the
// thing that actually identifies the abuser (login 8/IP, SMS 20/IP + 5/phone,
// table orders 12/table, status polls 240/table). Those are the real limits.
// Raise this one freely if a legitimate surface ever approaches it; tighten
// it only after checking it still clears every limit below.
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: RATE_LIMITS.apiBackstop,
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
    limit: RATE_LIMITS.login,
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
    limit: RATE_LIMITS.smsIp,
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
    limit: RATE_LIMITS.smsPhone,
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
    limit: RATE_LIMITS.tableOrderIp,
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
    limit: RATE_LIMITS.tableOrderPerTable,
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
    limit: RATE_LIMITS.tableStatusPerTable,
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

// ── LOGIN AUDIT RETENTION ────────────────────────────────────────────────
//
// Nothing used to remove an audit row, and getRecentLoginAudit() above reads
// the WHOLE collection (db.list parses every row) and sorts it just to return
// the newest 200 — so opening the security page got slower with every login
// the restaurant had ever performed, forever.
//
// Two independent bounds, because they fail in different directions:
//   - AGE covers the ordinary case: years of routine staff logins.
//   - A ROW CAP covers the burst case: a credential-stuffing run writes rows
//     far faster than any sane retention window would ever expire them (the
//     limiters bound the rate, not the total), and all of them are minutes
//     old, so age alone would never touch them.
//
// Fails SAFE, which is the opposite of the kitchen board's rule: a row whose
// timestamp cannot be parsed is KEPT. An audit row is a security record, and
// losing evidence is worse than carrying a stray row. A missing/zero/negative
// option likewise falls back to the default rather than deleting everything —
// the failure mode of a bad config here is an erased audit trail.
const LOGIN_AUDIT_RETENTION_DAYS = parseInt(process.env.LOGIN_AUDIT_RETENTION_DAYS, 10) || 90;
const LOGIN_AUDIT_MAX_ROWS = parseInt(process.env.LOGIN_AUDIT_MAX_ROWS, 10) || 5000;

// Pure: takes rows, returns the ids to delete. Exported for its own sake so
// the retention rule is testable without a database — see
// tests/unit/login-audit-retention.test.js.
function selectExpiredAuditIds(rows, opts = {}) {
    if (!Array.isArray(rows)) return [];

    const now = opts.now instanceof Date ? opts.now : new Date();
    const nowMs = now.getTime();

    const days = Number(opts.retentionDays);
    const retentionDays = Number.isFinite(days) && days > 0 ? days : LOGIN_AUDIT_RETENTION_DAYS;
    const cutoff = nowMs - retentionDays * 24 * 60 * 60 * 1000;

    const cap = Number(opts.maxRows);
    const maxRows = Number.isFinite(cap) && cap > 0 ? cap : LOGIN_AUDIT_MAX_ROWS;

    const doomed = new Set();

    for (const r of rows) {
        const t = r && r.at ? new Date(r.at).getTime() : NaN;
        if (!Number.isFinite(t)) continue; // undateable — keep it, see above
        if (t < cutoff) doomed.add(r.id);
    }

    // Then the cap, over what would survive the age pass. Undateable rows sort
    // last (treated as oldest) so a flood of them can still be trimmed rather
    // than becoming a permanent, unprunable floor.
    const survivors = rows.filter(r => r && !doomed.has(r.id));
    if (survivors.length > maxRows) {
        survivors
            .slice()
            .sort((a, b) => {
                const ta = a.at ? new Date(a.at).getTime() : NaN;
                const tb = b.at ? new Date(b.at).getTime() : NaN;
                return (Number.isFinite(tb) ? tb : -Infinity) - (Number.isFinite(ta) ? ta : -Infinity);
            })
            .slice(maxRows)
            .forEach(r => doomed.add(r.id));
    }

    return [...doomed];
}

// Applies the rule. Best-effort by design: a prune that throws must never be
// able to take down logins, which is why the caller is an unref'd interval
// and every failure is swallowed with a log.
function pruneLoginAudit(now = new Date()) {
    try {
        const expired = selectExpiredAuditIds(db.list(LOGIN_AUDIT_COLLECTION), { now });
        for (const id of expired) db.remove(LOGIN_AUDIT_COLLECTION, id);
        if (expired.length) {
            console.log(`🧹 Login audit: pruned ${expired.length} expired entr${expired.length === 1 ? "y" : "ies"}.`);
        }
        return expired.length;
    } catch (e) {
        console.error("Failed to prune the login audit log:", e.message);
        return 0;
    }
}

// Once at startup (so a long-running deployment that never restarts is not
// the only thing keeping the table trimmed), then hourly. Unref'd so it never
// holds the process open on its own — same pattern as the lockout sweep above.
setTimeout(() => pruneLoginAudit(), 10 * 1000).unref();
setInterval(() => pruneLoginAudit(), 60 * 60 * 1000).unref();

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
    RATE_LIMITS,
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
    selectExpiredAuditIds,
    pruneLoginAudit,
    LOGIN_AUDIT_RETENTION_DAYS,
    LOGIN_AUDIT_MAX_ROWS,
    dummyCompare,
    LOCKOUT_THRESHOLD,
    LOCKOUT_DURATION_MS,
};
