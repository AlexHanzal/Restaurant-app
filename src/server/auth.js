// ============================================================================
// auth.js — password hashing + JWT-cookie session middleware
//
// Design:
//   - Passwords hashed with bcryptjs (cost 12) at rest.
//   - On successful login, server issues a signed JWT in an httpOnly cookie
//     ("auth_token"). No server-side session store needed — stateless, and
//     survives Render restarts / multiple instances without Redis.
//   - requireAuth / requireAdmin / requireDriver read + verify that cookie
//     and attach `req.user` = { id, name, isAdmin, isDriver }.
//
// Env vars:
//   JWT_SECRET   — REQUIRED in production (NODE_ENV=production): the server
//                   refuses to start without it rather than run with a
//                   known/guessable secret. In development it's optional —
//                   a random secret is generated per process start instead
//                   (see below), so nothing secret is ever hardcoded.
//   NODE_ENV     — when "production", cookie gets `secure: true` (HTTPS only).
// ============================================================================

const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const BCRYPT_COST = 12;
const TOKEN_TTL = "12h";

const isProd = process.env.NODE_ENV === "production";

// SECURITY (3rd hardening pass — transport/headers/CORS/CSRF): __Host-
// cookie-name prefix hardening. A browser will only ever STORE a cookie
// named "__Host-..." if the response that set it (a) carries the Secure
// attribute, (b) does not set a Domain attribute, and (c) sets Path=/ — see
// cookieOptions() below, which always sets path:"/" and never sets domain.
// This closes a specific gap plain httpOnly+sameSite cookies don't: without
// the prefix, a network attacker (or a malicious/compromised sibling
// subdomain) could set a cookie of the SAME NAME with Domain=example.com
// from plain HTTP or from another subdomain, and — depending on path/
// specificity rules — have it override or shadow the real session cookie in
// ways that enable session-fixation-style attacks. "__Host-" is a hard
// browser-enforced guarantee that this exact cookie could only have been set
// by this exact origin over HTTPS.
//
// Only applied in production: it REQUIRES Secure, and Secure cookies are
// refused by the browser entirely over plain HTTP — which is exactly how
// local `npm start` runs. Gating on isProd keeps local dev working
// unchanged (plain "auth_token", no Secure) while getting the hardened name
// for real on Render (which is HTTPS end-to-end from the browser's
// perspective — see the trust proxy comment above app.set(), and the
// https-redirect middleware in server.js).
const COOKIE_NAME = isProd ? "__Host-auth_token" : "auth_token";

// SECURITY: no hardcoded fallback secret. In production, a missing
// JWT_SECRET is a hard startup failure (see resolveJwtSecret below) —
// the previous behavior of silently falling back to a fixed, publicly
// known string ("dev-only-insecure-secret-change-me") meant anyone could
// forge a valid admin session cookie for a deployment that forgot to set
// the env var. In development, generate a random secret each process
// start: local logins still work end-to-end, but the secret is never a
// known constant and existing tokens simply stop validating (forcing a
// re-login) across restarts, which is a fine trade for local dev.
function resolveJwtSecret() {
    if (process.env.JWT_SECRET) return process.env.JWT_SECRET;

    if (isProd) {
        throw new Error(
            "JWT_SECRET environment variable is required when NODE_ENV=production. " +
            "Generate one with `openssl rand -hex 32` (or equivalent) and set it " +
            "before starting the server — refusing to start with no/guessable secret."
        );
    }

    console.warn(
        "⚠️  JWT_SECRET not set — generating a random development-only secret for this process.\n" +
        "   Sessions will not survive a server restart. Set a real JWT_SECRET env var before deploying to production!"
    );
    return crypto.randomBytes(32).toString("hex");
}

const JWT_SECRET = resolveJwtSecret();

// ── PASSWORD HASHING ────────────────────────────────────────────────────

async function hashPassword(plain) {
    return bcrypt.hash(plain, BCRYPT_COST);
}

async function comparePassword(plain, hash) {
    if (!hash) return false;
    return bcrypt.compare(plain, hash);
}

// Detects an existing bcrypt hash (all bcryptjs/bcrypt variants) so the
// migration script can skip already-hashed rows safely.
function looksLikeBcryptHash(str) {
    return typeof str === "string" && /^\$2[aby]\$\d{2}\$/.test(str);
}

// ── TOKEN ────────────────────────────────────────────────────────────────

function signToken(payload) {
    return jwt.sign(payload, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

function verifyToken(token) {
    try {
        return jwt.verify(token, JWT_SECRET);
    } catch {
        return null;
    }
}

// SECURITY (3rd hardening pass): moved from sameSite:"lax" to "strict".
// Reasoning, worked through explicitly because getting this wrong breaks
// logins in a way that's easy to miss in testing:
//
//   - This app is single-origin (frontend + API served by the same Node
//     process — see configureCors()'s header comment in server.js), so
//     there is no legitimate SAME-SITE cross-origin flow that needs this
//     cookie attached to a "sub-request" from another site. "strict" only
//     removes the one thing "lax" still allowed beyond that: attaching the
//     cookie to a top-level GET navigation that was *initiated from another
//     site* (e.g. clicking a link to /reservation/admin in an email or on
//     another website). Direct navigation (typed URL, existing bookmark) is
//     unaffected — SameSite only restricts cross-site-INITIATED requests.
//   - The one cross-site top-level navigation this app actually depends on
//     is the GoPay return redirect (customer pays on gate.gopay.cz, GoPay
//     redirects the browser back to our /reservation/... return URL as a
//     top-level GET). That customer is, by construction, an *unauthenticated
//     guest* at that point — nothing on the return-URL page requires
//     req.user / the auth_token cookie to be present (see GET
//     /api/payments/:orderId/status and the reservation/order flows, which
//     are all public routes). So auth_token being withheld on that
//     navigation is a no-op: there was no valid staff/driver session to send
//     in the first place for that browser tab.
//   - Net effect of "strict" here: a staff/driver member who follows an
//     external link straight into /admin (rare) sees the login gate once
//     instead of being auto-recognized, then everything works normally for
//     the rest of the 12h session (all subsequent same-origin fetch/XHR
//     calls are unaffected by SameSite=Strict — it only ever restricts
//     cross-site-INITIATED requests, and once the page itself has loaded
//     from this origin, its own API calls are same-site by definition).
//     That's a strictly better trade than "lax" for an app with no genuine
//     cross-site entry point that needs the cookie.
function cookieOptions() {
    return {
        httpOnly: true,
        sameSite: "strict",
        secure: isProd,
        maxAge: 12 * 60 * 60 * 1000, // 12h, matches TOKEN_TTL
        path: "/", // required for the __Host- cookie-name prefix above; also just correct or the cookie only remembers login on the router's request path prefix.
    };
}

// Call after successful login to issue the session cookie.
function issueSessionCookie(res, user) {
    const token = signToken({
        id: user.id,
        name: user.name,
        isAdmin: !!user.isAdmin,
        isDriver: !!user.isDriver,
    });
    res.cookie(COOKIE_NAME, token, cookieOptions());
}

function clearSessionCookie(res) {
    // clearCookie needs the same attributes (minus maxAge) used when setting it,
    // or some browsers won't remove it.
    const { maxAge, ...opts } = cookieOptions();
    res.clearCookie(COOKIE_NAME, opts);
}

// ── KEY DERIVATION (cryptographic audience separation) ──────────────────
// SECURITY (reorder feature, docs/superpowers/specs/2026-07-25-reorder-
// design.md §5): requireAuth() above accepts ANY JWT that verifies against
// JWT_SECRET — it checks the signature and then trusts whatever is in the
// payload. GET ${api}/orders (the entire admin order list) is guarded by
// requireAuth alone.
//
// The reorder feature hands a long-lived (90-day) JWT to ordinary
// customers, stored in their own browser as a cookie. httpOnly stops page
// JavaScript from reading that cookie, but it does NOT stop the person
// sitting at the keyboard from copying the value out of devtools and
// pasting it in as the `auth_token` cookie instead. If a reorder token were
// signed with this same JWT_SECRET, it would verify successfully against
// requireAuth() and hand that customer's browser full admin-equivalent
// access — a straightforward privilege escalation to "read every order in
// the system".
//
// The fix is a DIFFERENT signing key per "purpose"/audience, derived from
// JWT_SECRET via HMAC-SHA256 rather than reusing JWT_SECRET verbatim. A
// reorder token signed with deriveSecret("reorder-token-v1") fails
// jwt.verify() outright when presented against JWT_SECRET (and vice versa)
// — the two keys are cryptographically unrelated strings as far as any
// verifier is concerned, even though both are ultimately derived from the
// same root secret. This is deliberate: a payload-shape check (e.g. `if
// (payload.kind !== "reorder") reject` inside requireAuth) is a single line
// of code a later refactor could delete without understanding why it was
// there. A different key cannot be "refactored away" by accident — the
// verification simply fails at the signature level, before any payload
// field is ever inspected.
//
// JWT_SECRET itself is deliberately NOT exported (see module.exports below)
// — only this derivation function is, so no caller anywhere in the
// codebase can accidentally mint (or be tricked into minting) a token that
// verifies as a real staff session.
//
// Reusable beyond reorder: any future "give an unprivileged, narrowly-
// scoped, long-lived token to an untrusted party" need (e.g. a delivery-
// tracking link) should derive its own purpose string here rather than
// touching JWT_SECRET or this function.
function deriveSecret(purpose) {
    return crypto.createHmac("sha256", JWT_SECRET).update(purpose).digest("hex");
}

// ── MIDDLEWARE ───────────────────────────────────────────────────────────

function requireAuth(req, res, next) {
    const token = req.cookies?.[COOKIE_NAME];
    const user = token && verifyToken(token);
    if (!user) return res.status(401).json({ error: "Přihlášení je vyžadováno" });
    req.user = user;
    next();
}

function requireAdmin(req, res, next) {
    requireAuth(req, res, () => {
        if (!req.user.isAdmin) return res.status(403).json({ error: "Vyžadována administrátorská oprávnění" });
        next();
    });
}

function requireDriver(req, res, next) {
    requireAuth(req, res, () => {
        if (!req.user.isDriver) return res.status(403).json({ error: "Vyžadována oprávnění řidiče" });
        next();
    });
}

// SECURITY (audit 2026-07-29, finding F2): "logged in" is not the same as
// "trusted with the whole restaurant". requireAuth accepts ANY valid session,
// including a driver's — and drivers are the lowest-trust accounts here: the
// session lives on a personal phone that travels around town all shift.
//
// Before this, a driver session could DELETE any delivery order and any
// walk-in table order. Neither is anything a driver's job requires; both are
// destructive and unlogged.
//
// requireAdmin would be the obvious guard and is the WRONG one — the kitchen
// page's delete button (src/js/kitchen.js, deleteOrder) is used by ordinary
// non-admin kitchen staff, so requiring admin would break real daily work.
// The actual boundary being drawn is "everyone except drivers", which is what
// this expresses: admins always pass; a session that is a driver and nothing
// else does not.
//
// Deliberately NOT applied to GET ${api}/orders — driver.js needs the order
// list (names, addresses) to actually deliver. That route stays requireAuth.
function requireStaff(req, res, next) {
    requireAuth(req, res, () => {
        if (req.user.isAdmin || !req.user.isDriver) return next();
        return res.status(403).json({ error: "Vyžadována oprávnění personálu" });
    });
}

module.exports = {
    hashPassword,
    comparePassword,
    looksLikeBcryptHash,
    signToken,
    verifyToken,
    issueSessionCookie,
    clearSessionCookie,
    requireAuth,
    requireAdmin,
    requireDriver,
    requireStaff,
    COOKIE_NAME,
    deriveSecret,
};
