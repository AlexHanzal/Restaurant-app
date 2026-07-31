// ============================================================================
// reorder.js — "Objednat znovu" (one-tap reorder) black-box module.
//
// See docs/superpowers/specs/2026-07-25-reorder-design.md (design, esp. §5
// security / §6 architecture) and docs/superpowers/plans/2026-07-25-reorder.md
// (Task A) for the full rationale. Self-contained like settings.js/csrf.js/
// validation.js — no DB access, no server.js coupling, easy to unit-test in
// isolation. The one dependency is auth.js, for deriveSecret() (see the
// security note on the token functions below); server.js (owned by a
// different agent while this module was written) is never required here.
//
// Design:
//   - Reorder tokens are signed with a key DERIVED from JWT_SECRET, never
//     JWT_SECRET itself — see signReorderToken/verifyReorderToken below and
//     auth.js's deriveSecret() comment for the full §5 threat model. This is
//     the single most important thing in this file.
//   - Pending SMS codes live in a module-level Map, mirroring the
//     `pendingVerifications` pattern server.js already uses for the
//     reservation flow — but a SEPARATE map, since reorder verification and
//     reservation verification are unrelated actions that happen to share
//     the same SMS-code mechanics.
//   - previewOrder() takes its pricing function as an ARGUMENT rather than
//     importing priceOrderItems from server.js. That's what keeps this
//     module free of DB/server coupling (spec §6) and lets Task D's unit
//     tests exercise it with a stub, no server or SQLite involved.
// ============================================================================

const jwt = require("jsonwebtoken");
const auth = require("./auth");

// ── TOKEN (cookie credential) ────────────────────────────────────────────

const REORDER_COOKIE_NAME = "reorder_token";
const REORDER_TOKEN_TTL = "90d";
const REORDER_TOKEN_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days, matches REORDER_TOKEN_TTL

// SECURITY (spec §5 — read this before touching anything below): signed
// with a key DERIVED from JWT_SECRET via auth.deriveSecret(), never
// JWT_SECRET itself. requireAuth() in auth.js accepts any JWT that verifies
// against JWT_SECRET and then trusts the payload — GET ${api}/orders (the
// entire admin order list) sits behind requireAuth alone. A reorder token
// lives in an ordinary customer's browser; httpOnly stops page JS from
// reading it, but not a person copying the cookie value out of devtools
// into `auth_token`. If this token were signed with JWT_SECRET, that copy-
// paste would be a full privilege escalation to "read every order in the
// system". Because the key here is cryptographically distinct from
// JWT_SECRET, a reorder token fails jwt.verify() outright when presented as
// auth_token — no payload-shape check anywhere has to remember to catch
// this, so a later refactor can't accidentally delete the protection.
const REORDER_JWT_KEY = auth.deriveSecret("reorder-token-v1");

// normalizedPhone -> 90-day token carrying just { phone }. Nothing else goes
// in the payload — this credential proves exactly one thing ("control of
// this phone number"), not identity/role/anything requireAuth-shaped.
function signReorderToken(normalizedPhone) {
    return jwt.sign({ phone: normalizedPhone }, REORDER_JWT_KEY, { expiresIn: REORDER_TOKEN_TTL });
}

// Mirrors auth.verifyToken()'s try/catch shape exactly: NEVER throws.
// Returns null for a garbage string, an expired token, a token signed with
// a different key (including JWT_SECRET or any other deriveSecret(purpose)
// — this is the §5 guarantee in code), or a token whose payload doesn't
// carry a usable phone.
function verifyReorderToken(token) {
    try {
        const payload = jwt.verify(token, REORDER_JWT_KEY);
        if (!payload || typeof payload.phone !== "string" || !payload.phone) return null;
        return { phone: payload.phone };
    } catch {
        return null;
    }
}

// Mirrors auth.js's cookieOptions() attribute-for-attribute (httpOnly/
// sameSite/secure/path — same reasoning as that function's own header
// comment about single-origin same-site strictness), except for maxAge:
// this is a 90-day "remember this browser" credential (spec §7), not a
// 12h staff session. `secure` is gated on NODE_ENV=production the same way
// auth.js's isProd is, so this also works over plain HTTP in local dev.
function reorderCookieOptions() {
    return {
        httpOnly: true,
        sameSite: "strict",
        secure: process.env.NODE_ENV === "production",
        path: "/",
        maxAge: REORDER_TOKEN_MAX_AGE_MS,
    };
}

// ── PENDING SMS CODES ────────────────────────────────────────────────────
// Module-level Map keyed by normalised phone, entries { code, expiresAt,
// attemptsLeft }. TTL/attempt-count numbers below are the SAME numbers as
// SERVER_CONFIG.sms in server.js (codeTtlMs: 5 min, maxAttempts: 5) —
// duplicated here as literals rather than imported, so this module stays
// dependency-free of server.js (same "coordinate rather than import"
// convention validation.js already uses for its own duplicated constants,
// e.g. the VAT-rate unions). If SERVER_CONFIG.sms ever changes these
// numbers, update the literals below to match.
const PENDING_CODE_TTL_MS = 5 * 60 * 1000; // SERVER_CONFIG.sms.codeTtlMs
const PENDING_CODE_MAX_ATTEMPTS = 5;       // SERVER_CONFIG.sms.maxAttempts

const pendingCodes = new Map();

// Sweeps expired entries. Called on every write (putPendingCode) rather
// than via a separate setInterval/timer — this module owns no timers of
// its own, and a sweep-on-write is enough to guarantee the map can never
// grow past "one entry per phone number that has sent a code in the last
// 5 minutes plus however long ago its last write was", which bounds it
// just fine for this traffic pattern.
function sweepExpiredCodes() {
    const now = Date.now();
    for (const [phone, entry] of pendingCodes) {
        if (now > entry.expiresAt) pendingCodes.delete(phone);
    }
}

// Keyed by phoneMatchKey(), not by the raw normalised string: a customer who
// requests the code as "+420 601 000 001" and then types "601000001" into the
// verify field is the same person and must not be told "Nejprve si vyžádejte
// ověřovací kód". Both entry points below key identically, so the pair can
// never disagree.
function putPendingCode(normalizedPhone, code) {
    sweepExpiredCodes();
    pendingCodes.set(phoneMatchKey(normalizedPhone), {
        code,
        expiresAt: Date.now() + PENDING_CODE_TTL_MS,
        attemptsLeft: PENDING_CODE_MAX_ATTEMPTS,
    });
}

// Mirrors POST ${api}/reservations/verify-and-book's failure messages AND
// their order of precedence EXACTLY (server.js) — a customer bouncing
// between the reservation flow and this one should never see different
// wording for the same underlying failure. Consumes the entry on success
// (one-time use, matching verify-and-book's pendingVerifications.delete on
// success); decrements attemptsLeft on a wrong code and deletes the entry
// once attempts are exhausted (also matching verify-and-book).
function checkPendingCode(normalizedPhone, code) {
    const key = phoneMatchKey(normalizedPhone);
    const pending = pendingCodes.get(key);
    if (!pending) {
        return { ok: false, reason: "Nejprve si vyžádejte ověřovací kód" };
    }

    if (Date.now() > pending.expiresAt) {
        pendingCodes.delete(key);
        return { ok: false, reason: "Kód vypršel, vyžádejte si nový" };
    }

    if (pending.attemptsLeft <= 0) {
        pendingCodes.delete(key);
        return { ok: false, reason: "Příliš mnoho pokusů, vyžádejte si nový kód" };
    }

    if (String(code).trim() !== pending.code) {
        pending.attemptsLeft -= 1;
        return { ok: false, reason: "Nesprávný kód", attemptsLeft: pending.attemptsLeft };
    }

    pendingCodes.delete(key);
    return { ok: true };
}

// ── RECENT ORDERS (phone-scoped history) ─────────────────────────────────

const RECENT_LIMIT = 3;

// Same normalisation rule normalizePhone() in server.js uses (strip spaces/
// dashes/dots/parens). Re-implemented locally rather than imported — server
// doesn't export it (and per the task brief, shouldn't gain a new export
// for it: server.js is a different agent's file, edited concurrently with
// this one). Kept as a tiny, obviously-correct one-liner so the two copies
// can't silently drift in a way that matters.
function normalizePhoneLocal(raw) {
    return (raw || "").trim().replace(/[\s\-().]/g, "");
}

// Canonical key for "is this the same phone number?", used BOTH for the
// pending-code map and for matching stored orders.
//
// Why normalizePhoneLocal() alone is not enough (found in review, 2026-07-25):
// it strips spaces/dashes/dots/parens but NOT a leading "+" or a country
// code. So the same customer typing "601 000 001" at checkout and
// "+420 601 000 001" on the reorder screen produces two different keys, and
// the reorder list comes back EMPTY — indistinguishable, from the customer's
// side, from "you have never ordered here". People do not type their own
// number consistently, so this is an everyday case, not an edge case.
//
// The rule below is deliberately narrow rather than "just compare the last 9
// digits". Comparing trailing digits would also collapse genuinely different
// international numbers onto one key, and the consequence of a false match
// here is showing one person's name/address/order history to another. Instead
// only the two unambiguous Czech spellings of a country code are removed:
//   "00420xxxxxxxxx" -> "420xxxxxxxxx" (international access code)
//   "420xxxxxxxxx"   -> "xxxxxxxxx"    (only when exactly 12 digits, i.e. a
//                                       CZ country code + 9-digit subscriber)
// A 13-digit foreign number is left completely alone, so it can never be
// folded onto a Czech one.
function phoneMatchKey(raw) {
    let digits = String(raw || "").replace(/\D/g, "");
    if (digits.startsWith("00")) digits = digits.slice(2);
    if (digits.length === 12 && digits.startsWith("420")) digits = digits.slice(3);
    return digits;
}

// allOrders: every record from the `orders` collection (delivery orders
// only — this feature never reorders indoor/reservation-attached orders,
// spec §3). normalizedPhone: already-normalised lookup key (from a verified
// reorder token's payload). limit: RECENT_LIMIT in real use, parameterized
// for testability.
//
// spec §6.2: orders persist `phone` as `(phone || "").trim()` — raw, NOT
// normalised (see POST ${api}/orders in server.js) — while the lookup key
// here IS normalised. Comparing a normalised key straight against that raw
// stored value would silently return an empty list for any customer whose
// stored phone has spaces/dashes/dots/parens (i.e. most real phone numbers
// as typed at checkout), which looks exactly like "this customer has no
// orders" rather than like a bug. So BOTH sides are run through
// normalizePhoneLocal() here before comparing.
function selectRecentOrders(allOrders, normalizedPhone, limit) {
    const list = Array.isArray(allOrders) ? allOrders : [];
    const wanted = phoneMatchKey(normalizedPhone);
    if (!wanted) return [];
    return list
        .filter(order => order && Array.isArray(order.items) && order.items.length > 0)
        .filter(order => phoneMatchKey(order.phone) === wanted)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(0, limit);
}

// ── PER-ORDER PREVIEW (re-price every line individually) ─────────────────

// Mirrors server.js's own DAILY_ITEM_ID_PREFIX constant. Duplicated rather
// than imported for the same "stay server.js-free" reason as everything
// else in this file — this is a stable, long-lived id-namespacing
// convention, not something expected to change independently in the two
// places it's used.
const DAILY_ITEM_ID_PREFIX = "daily:";

// order: one record from the `orders` collection. priceLine: injected
// function, rawItem -> priceOrderItems([rawItem])'s result shape, i.e.
// { items: [resolved], total } on success or { error } on failure (spec
// §6.1) — injected rather than imported so this module never touches the
// DB/menu directly and stays unit-testable with a stub, exactly like
// settings.js's pure helpers.
//
// Per spec §6.3:
//   - "daily:"-prefixed lines are skipped ENTIRELY — never emitted as a
//     line at all, available or not. They're keyed by calendar date, so a
//     daily-menu line from a past order is unavailable essentially by
//     definition; showing it would mean every past order containing a
//     lunch special permanently displays a warning.
//   - every other line (regular dish or "combo:"-prefixed) is re-priced
//     via priceLine(). A `{error}` result becomes an unavailable line
//     carrying that error verbatim as `reason` (it's already a ready-to-
//     show Czech message — the same one checkout itself would show). A
//     success result's name/price are taken from the RESOLVED server item
//     (priced.items[0]), never from the stored raw line — that's the whole
//     point of re-pricing per line instead of trusting what was persisted.
function previewOrder(order, priceLine) {
    const rawItems = Array.isArray(order && order.items) ? order.items : [];

    const lines = [];
    let availableTotal = 0;
    let unavailableCount = 0;

    for (const raw of rawItems) {
        if (!raw || typeof raw !== "object") continue;

        const identifier = raw.id ?? raw.item ?? raw.name;
        const identifierStr = identifier == null ? "" : String(identifier);

        if (identifierStr.startsWith(DAILY_ITEM_ID_PREFIX)) continue;

        const storedQty = Number(raw.qty) || 0;
        const storedName = raw.name || raw.item || identifierStr;
        const priced = priceLine(raw);

        if (!priced || priced.error) {
            unavailableCount += 1;
            lines.push({
                id: identifierStr,
                name: storedName,
                qty: storedQty,
                available: false,
                // Falls back to a generic Czech message only in the
                // defensive case where priceLine() returns neither
                // {error} nor a usable {items:[...]} — priceOrderItems()
                // itself never actually does this, but previewOrder must
                // not crash or fabricate a price if some future priceLine
                // implementation ever did.
                reason: (priced && priced.error) || "Položku se nepodařilo znovu ocenit",
            });
            continue;
        }

        const resolved = Array.isArray(priced.items) ? priced.items[0] : null;
        if (!resolved) {
            unavailableCount += 1;
            lines.push({
                id: identifierStr,
                name: storedName,
                qty: storedQty,
                available: false,
                reason: "Položku se nepodařilo znovu ocenit",
            });
            continue;
        }

        const price = Number(resolved.price) || 0;
        const qty = Number(resolved.qty) || storedQty;
        const lineTotal = Math.round(price * qty * 100) / 100;

        const line = {
            id: identifierStr,
            name: resolved.name || resolved.item || storedName,
            qty,
            price,
            lineTotal,
            available: true,
        };

        // Combo lines must carry their stored `comboConfig` (removed slots,
        // swapped dishes, paid extras, free-text note) back to the client, or
        // reordering a CUSTOMIZED combo silently restores the DEFAULT one.
        // That failure mode is nastier than it first looks: `price` and `name`
        // above come from the resolved server item, so the cart would show the
        // customized name and the customized price while holding an empty
        // config — and checkout, re-pricing from that empty config, would then
        // charge for (and send the kitchen) the default combo. The customer
        // gets the wrong food AND a total that disagrees with the cart.
        //
        // Forwarded verbatim and only on an AVAILABLE line: `priceLine`
        // already re-validated this exact config against the live combo
        // (slots still exist and are removable, swap targets still allowed and
        // in stock, extras still offered) and accepted it, so it is known-good
        // at this moment. It is echoed back purely so the client can rebuild
        // an identical cart line; checkout re-validates it from scratch again
        // anyway, so nothing here is trusted downstream.
        if (raw.comboConfig && typeof raw.comboConfig === "object" && !Array.isArray(raw.comboConfig)) {
            line.comboConfig = raw.comboConfig;
        }

        lines.push(line);
        availableTotal += lineTotal;
    }

    return {
        id: order.id,
        createdAt: order.createdAt,
        lines,
        availableTotal: Math.round(availableTotal * 100) / 100,
        unavailableCount,
        // Delivery details from the original order, echoed back so the client
        // can prefill checkout. Without these, "one-tap reorder" still made
        // the customer retype name + address + PSČ every time, which is most
        // of the typing the feature exists to remove.
        //
        // Disclosure note: this is the customer's OWN name/address, released
        // only to a browser that has already proved control of the phone
        // number those orders were placed under (GET /reorder/recent is
        // gated on a verified reorder token — spec §7). It is not a wider
        // disclosure than the order lines already in this same response.
        // `phone` is deliberately NOT included: the client already knows the
        // number it just verified, so echoing it adds nothing and would put
        // another copy of it in a cache-able response body.
        customer: {
            customerName: order.customerName || "",
            address: order.address || "",
            psc: order.psc || "",
            email: order.email || "",
        },
    };
}

module.exports = {
    phoneMatchKey, // exported for tests / reuse, not part of the route-facing surface
    REORDER_COOKIE_NAME,
    reorderCookieOptions,
    signReorderToken,
    verifyReorderToken,
    putPendingCode,
    checkPendingCode,
    selectRecentOrders,
    previewOrder,
    RECENT_LIMIT,
};
