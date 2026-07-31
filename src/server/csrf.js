// ============================================================================
// csrf.js — double-submit-cookie CSRF protection for cookie-authenticated,
// state-changing (POST/PUT/DELETE) staff/admin/driver routes.
//
// THIRD security-hardening pass (transport/headers/CORS/CSRF). Self-
// contained (only depends on Node's own `crypto`), same "black box" pattern
// as security.js and validation.js from the earlier passes.
//
// Why this exists:
//   auth.js's session cookie (`auth_token`) is httpOnly + sameSite:"lax"/
//   "strict" (see auth.js), which already blocks the classic cross-site
//   <form> POST / cross-site fetch-with-credentials CSRF vectors for a
//   same-site cookie. But "lax" alone doesn't defend a hypothetical future
//   sameSite:"none" need, doesn't defend against a subdomain-sourced request
//   under "lax" allowances for top-level navigation, and defense-in-depth
//   against CSRF should never rest on a single cookie attribute — hence a
//   second, independent layer here.
//
// Why hand-rolled instead of a package:
//   - `csurf` is deprecated/unmaintained (the Express docs themselves now
//     point away from it) — not something to add fresh to a public app.
//   - `csrf-csrf` is a fine modern option, but it brings its own session-like
//     configuration surface (secret rotation options, cookie signing modes,
//     etc.) for something this app can implement correctly, with full
//     control and zero new third-party dependencies, in well under 100 lines
//     using Node's built-in `crypto` (HMAC-SHA256 + timingSafeEqual — the
//     same primitives csrf-csrf itself uses under the hood).
//   - The app is single-origin (one Node process serves both the frontend
//     and the API — see configureCors()'s header comment in server.js), so
//     a lightweight double-submit-cookie scheme is the right amount of
//     protection; a full server-side session-bound synchronizer-token store
//     would be solving a problem this architecture doesn't have.
//
// Pattern — SIGNED double-submit cookie:
//   1. `ensureCsrfCookie` (mounted on GET /api/csrf-token ONLY — see the
//      PRIVACY note below) mints a token and sets it as a *readable*
//      (non-httpOnly — the frontend must be able to read/relay it) cookie
//      when that request doesn't already carry a valid one. It also stashes
//      the token on `req.csrfToken` so the route can hand it back in the
//      JSON body too (needed for the rare cross-origin-dev setup — see
//      inner.html's "gateApiInput" — where the frontend document's own
//      origin can't read a cookie that belongs to a different API origin;
//      the JSON body works there because it's just another
//      same-origin-checked fetch response).
//   2. Before any protected mutating request, the frontend reads the token
//      (cached from step 1's response) and sends it back in the
//      `x-csrf-token` request header.
//   3. `requireCsrf` (mounted explicitly on the specific mutating routes that
//      act on the strength of the auth cookie — see server.js call sites)
//      checks that the header value exactly matches the cookie value AND
//      that the token's HMAC signature verifies.
//
// Why this actually stops CSRF: a cross-site attacker page CAN make the
// victim's browser fire a same-origin-looking request (cookies included —
// that's the entire CSRF vector), but it CANNOT (a) read this app's cookies
// to learn the token (browser same-origin policy on cookies) or (b) attach
// a custom `x-csrf-token` header from a bare cross-site <form> submission
// (custom headers require script — and a cross-site XHR/fetch that tries to
// set one is either blocked by CORS preflight, since this app's CORS
// allow-list rejects foreign origins — see configureCors() — or simply can't
// guess the signed token value even if the preflight were somehow bypassed).
//
// The signature (HMAC keyed by CSRF_SECRET) is what stops a "cookie tossing"
// variant of the attack, where an attacker who can set *some* cookie on this
// origin (e.g. via a vulnerable sibling subdomain, or a network attacker on
// plain HTTP in dev) tries to set matching cookie+header values themselves
// without ever needing to read anything — a plain (unsigned) double-submit
// cookie is vulnerable to exactly that; a signed one is not, because forging
// a valid pair requires knowing CSRF_SECRET.
//
// Env vars:
//   CSRF_SECRET — optional. If unset, a random secret is generated per
//                 process start (same fallback pattern as auth.js's
//                 JWT_SECRET, but not a hard-fail in production — a CSRF
//                 token is not a bearer credential; losing it on restart
//                 just means outstanding CSRF cookies stop validating and
//                 the frontend transparently fetches a fresh one on its next
//                 attempt, see ensureCsrfToken() in the frontend JS). Set it
//                 in production so a Render restart/redeploy doesn't cause a
//                 brief wave of "session expired, please retry" 403s for
//                 anyone mid-action.
// ============================================================================

const crypto = require("crypto");

const isProd = process.env.NODE_ENV === "production";

// __Host- prefix hardening (see auth.js's matching COOKIE_NAME comment) —
// only valid when Secure is always set, which is only true in production
// here (dev runs over plain http, where a Secure cookie wouldn't be stored
// by the browser at all, breaking local `npm start`).
const CSRF_COOKIE_NAME = isProd ? "__Host-csrf_token" : "csrf_token";
const CSRF_HEADER_NAME = "x-csrf-token";

function resolveCsrfSecret() {
    if (process.env.CSRF_SECRET) return process.env.CSRF_SECRET;
    console.warn(
        "⚠️  CSRF_SECRET not set — generating a random per-process secret. " +
        "Every outstanding CSRF cookie becomes invalid on process restart " +
        "(the frontend recovers automatically by fetching a fresh token — " +
        "see ensureCsrfToken() — but anyone mid-action gets one retried " +
        "request). Set CSRF_SECRET in production for stability across " +
        "restarts/redeploys."
    );
    return crypto.randomBytes(32).toString("hex");
}

const CSRF_SECRET = resolveCsrfSecret();

function sign(raw) {
    return crypto.createHmac("sha256", CSRF_SECRET).update(raw).digest("hex");
}

function generateToken() {
    const raw = crypto.randomBytes(24).toString("hex");
    return `${raw}.${sign(raw)}`;
}

function isValidToken(token) {
    if (!token || typeof token !== "string") return false;
    const dot = token.indexOf(".");
    if (dot < 1) return false;
    const raw = token.slice(0, dot);
    const mac = token.slice(dot + 1);
    if (!/^[0-9a-f]+$/i.test(mac)) return false;

    const expected = sign(raw);
    let macBuf, expBuf;
    try {
        macBuf = Buffer.from(mac, "hex");
        expBuf = Buffer.from(expected, "hex");
    } catch {
        return false;
    }
    if (macBuf.length !== expBuf.length) return false;
    return crypto.timingSafeEqual(macBuf, expBuf);
}

function csrfCookieOptions() {
    return {
        httpOnly: false, // must be readable by frontend JS to echo into the request header
        sameSite: "lax", // needs to survive the GoPay top-level return redirect (see auth.js)
        secure: isProd,
        maxAge: 12 * 60 * 60 * 1000, // matches the session TTL
        path: "/",
    };
}

// PRIVACY — mount this on GET /api/csrf-token and NOWHERE ELSE.
//
// It was originally global (right after cookie-parser, before routes and
// statics), which meant the first response to ANY visitor carried a 12h
// cookie — including a customer who opened the public rozvoz/rezervace page
// and left without touching a form. That customer can never use the token:
// requireCsrf below guards only staff/admin/driver routes, and every public
// flow is exempt from it (see the exemption reasoning on requireCsrf).
// Under ePrivacy as implemented by § 89 odst. 3 zák. č. 127/2005 Sb.,
// storing anything on a visitor's device without consent is lawful only
// where it is strictly necessary for the service that visitor actually
// requested — which a cookie that does nothing for them is not. Scoping
// issuance to the one endpoint the staff frontend calls keeps the app in
// the "no consent needed, no cookie banner needed" position.
//
// Minting stays lazy and self-healing: it sets a valid signed token when the
// request has none (or a tampered/secret-mismatched one) and exposes it on
// req.csrfToken for the route to hand back in the JSON body. If you need a
// new surface to have a token, have its frontend call GET /api/csrf-token —
// do not re-mount this middleware more widely.
function ensureCsrfCookie(req, res, next) {
    const existing = req.cookies && req.cookies[CSRF_COOKIE_NAME];
    if (isValidToken(existing)) {
        req.csrfToken = existing;
        return next();
    }
    const token = generateToken();
    res.cookie(CSRF_COOKIE_NAME, token, csrfCookieOptions());
    req.csrfToken = token;
    next();
}

// Mount explicitly on the specific state-changing routes that act on the
// strength of the auth cookie (admin/staff/driver actions — see the call
// sites in server.js for the full list + reasoning on what's exempt and
// why). Deliberately NOT a blanket "every POST/PUT/DELETE" filter — the
// public unauthenticated flows (order creation, SMS verification, GoPay
// webhook/pay-online/return) have no session to forge in the first place,
// and requiring a CSRF header from them would just be friction with no
// security benefit.
function requireCsrf(req, res, next) {
    const cookieToken = req.cookies && req.cookies[CSRF_COOKIE_NAME];
    const headerToken = req.get(CSRF_HEADER_NAME);

    if (!isValidToken(cookieToken) || !headerToken || headerToken !== cookieToken) {
        return res.status(403).json({ error: "Neplatný nebo chybějící CSRF token. Obnovte prosím stránku a zkuste to znovu." });
    }
    next();
}

module.exports = {
    ensureCsrfCookie,
    requireCsrf,
    CSRF_COOKIE_NAME,
    CSRF_HEADER_NAME,
};
