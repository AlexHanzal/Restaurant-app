// ============================================================================
// verification-codes.js — TTL/attempts/cooldown rules shared by the two SMS
// verification flows (reservation booking and delivery reorder).
//
// Finding M3 (2026-08-11 audit): both flows used to keep their pending code
// (the reservation flow also its server-priced booking payload) in a plain
// module-level Map — pendingVerifications in server.js, pendingCodes in
// reorder.js. A restart or crash dropped every code issued in the previous
// five minutes: those customers hit "Nejprve si vyžádejte ověřovací kód",
// had to request a new one, waited out the 30s resend cooldown, and every
// retry burned budget from smsPhoneLimiter/smscap. Everything else that
// matters in this app is in SQLite; this module is what lets the two
// call sites (server.js for reservations, reorder.js for reorder) store
// their pending-code row there too, while keeping every actual RULE — the
// TTL, the attempt accounting, the resend cooldown — as a pure function with
// no db.js and no express in sight, so it is unit-testable the same way
// reservation-cancel.js and smscap.js already are.
//
// Split deliberately from the storage: this file never calls db.get/set/
// remove itself except inside pruneExpired(), which takes `db` as an
// argument (dependency injection) rather than requiring db.js — same
// pattern reservation-retention.js's prune() and idempotency.js's prune()
// already use. Everything else here is pure: given the same inputs, always
// the same answer, never a side effect.
//
// RETENTION DECISION (step 5 of the M3 fix, spelled out here because it's
// the one design call worth a comment of its own):
//
//   The code itself is stored in PLAINTEXT, not hashed. A hash would look
//   like a security improvement but is not one: the code is 6 decimal
//   digits (10^6 possibilities), so anyone with read access to the SQLite
//   file — which is exactly the threat a hash would be defending against —
//   can precompute the hash of every possible code in well under a second
//   and reverse it instantly. Storing a hash here would spend complexity to
//   buy a false sense of protection rather than a real one, which is worse
//   than being plain about the actual controls:
//     - a 5-minute TTL (unchanged from the in-memory version — this module
//       does not loosen or tighten what was already true and already
//       published in src/html/ochrana-osobnich-udaju.html §5),
//     - the row is deleted the instant it stops being useful: on successful
//       verification, on expiry, and on attempts exhaustion — never left
//       to rot until the next sweep finds it,
//     - AND a sweep that also runs promptly (see pruneExpired's call sites
//       in server.js: once at boot — so a crash-and-restart doesn't leave
//       stale rows sitting for up to an hour before anything notices them —
//       then on a short unref'd interval), so "not retained after
//       expiry or verification" (the exact wording of that privacy-policy
//       clause) stays true even for a phone number that never comes back to
//       finish the flow.
//   The one place this plaintext choice has a real cost is GET /export
//   (admin-only, downloads the whole SQLite file as a backup) — a row that
//   happens to still be live at the moment of that download is included,
//   the same as every other table in the same file. Splitting pending codes
//   into a separate on-disk store to keep them out of that one admin route
//   was judged out of proportion to what a live-for-5-minutes-at-most row
//   actually exposes, given the same download already hands the admin every
//   guest name, phone number and priced order in the system.
// ============================================================================

// Same numbers as SERVER_CONFIG.sms in server.js (codeTtlMs / maxAttempts /
// resendCooldownMs). Both call sites pass their own values through explicitly
// (server.js from SERVER_CONFIG.sms, reorder.js using these defaults directly
// — see that file's header for why it stays independent of server.js's
// config object), so these constants are really only reached when a caller
// omits the option; kept in sync by hand, same as reorder.js's own
// now-removed duplicate literals used to be.
const TTL_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_MS = 30 * 1000;

// Builds a fresh pending-code row. `id` is optional and, when given, is
// embedded in the returned object — both call sites use it as the record's
// primary key (normalized phone / phoneMatchKey), and embedding it here
// (rather than leaving it to the caller) is what lets selectExpiredIds below
// stay a one-line filter+map instead of every caller having to remember to
// stash it themselves.
function buildEntry(code, opts = {}) {
    const now = typeof opts.now === "number" ? opts.now : Date.now();
    const ttlMs = typeof opts.ttlMs === "number" ? opts.ttlMs : TTL_MS;
    const maxAttempts = typeof opts.maxAttempts === "number" ? opts.maxAttempts : MAX_ATTEMPTS;

    const entry = {
        code: String(code),
        expiresAt: now + ttlMs,
        attemptsLeft: maxAttempts,
        lastSentAt: now,
    };
    if (opts.id !== undefined) entry.id = opts.id;
    return entry;
}

// Pure resend-cooldown check — mirrors POST /reservations/send-code's own
// inline check exactly (Date.now() - existing.lastSentAt < cooldown), just
// extracted so it can be unit-tested without a server. `existing` is
// whatever the caller's store returns for "is there already a pending code
// for this phone" — null/undefined always answers ok:true, since there is
// nothing to be on cooldown FROM.
//
// The reorder flow does NOT use this: POST /reorder/send-code has never had
// a per-phone resend cooldown of its own (only the shared smsIpLimiter/
// smsPhoneLimiter/smscap budgets in front of it) — that is an existing,
// deliberate difference between the two flows, not something this module
// introduces or should paper over.
function checkResendCooldown(existing, opts = {}) {
    const now = typeof opts.now === "number" ? opts.now : Date.now();
    const cooldownMs = typeof opts.cooldownMs === "number" ? opts.cooldownMs : RESEND_COOLDOWN_MS;

    if (!existing || typeof existing.lastSentAt !== "number") return { ok: true };

    const elapsed = now - existing.lastSentAt;
    if (elapsed >= cooldownMs) return { ok: true };
    return { ok: false, waitSec: Math.ceil((cooldownMs - elapsed) / 1000) };
}

// True when `entry` can no longer be used — either it doesn't exist, or its
// TTL has passed. Strictly-greater-than, matching the exact boundary the two
// routes used when this lived in a Map: `now === expiresAt` is still valid,
// only `now > expiresAt` is expired. Used both by evaluateCode (below) and by
// pruneExpired's selector, so the two can never disagree about the boundary.
function isExpired(entry, now = Date.now()) {
    return !entry || typeof entry.expiresAt !== "number" || now > entry.expiresAt;
}

// The whole verify decision, in the same precedence order both routes used:
// missing -> expired -> attempts exhausted -> wrong code -> ok. Pure: never
// mutates `pending`, never touches storage. The caller is responsible for
// acting on the outcome —
//   "missing"/"expired"/"exhausted" -> the pending row is no longer useful
//     and the caller should delete it (expired/exhausted rows are stale on
//     arrival either way; "missing" has nothing to delete);
//   "wrong" -> the caller persists the returned attemptsLeft back onto the
//     stored row (this function does not decrement anything itself, since
//     it has nothing to write back to);
//   "ok" -> the caller deletes the row (one-time use) and proceeds.
//
// code is compared as a trimmed string against the stored code, EXACTLY the
// comparison both routes used (`String(code).trim() !== pending.code`) — not
// hardened into a constant-time compare here, because that was not part of
// the M3 finding this module fixes and changing it would be an unrelated
// behavior change riding along on a persistence fix.
function evaluateCode(pending, code, now = Date.now()) {
    if (!pending) return { outcome: "missing" };
    if (now > pending.expiresAt) return { outcome: "expired" };
    if (!(pending.attemptsLeft > 0)) return { outcome: "exhausted" };

    if (String(code ?? "").trim() !== pending.code) {
        return { outcome: "wrong", attemptsLeft: pending.attemptsLeft - 1 };
    }
    return { outcome: "ok" };
}

// Pure: which stored rows are expired right now. Rows are expected to carry
// the `id` buildEntry() embedded (or whatever the caller's own id field is
// named — reorder.js and server.js's reservation store both use `id`, see
// their own headers), and rows without a numeric expiresAt are treated as
// expired rather than kept forever — a corrupt row is not a reason to leak
// storage, unlike e.g. the login-audit trail where losing evidence is the
// worse failure. There is no evidentiary reason to keep a pending SMS code.
function selectExpiredIds(rows, now = Date.now()) {
    if (!Array.isArray(rows)) return [];
    return rows.filter(r => r && r.id !== undefined && isExpired(r, now)).map(r => r.id);
}

// Applies the rule against real storage. Best-effort, matching every other
// prune in this codebase (reservation-retention.js, idempotency.js,
// security.js's pruneLoginAudit): a prune that throws must never be able to
// take down the SMS verification flow, so failures are swallowed and logged.
//
// `db` is injected (db.js's get/set/list/remove/patch contract), not
// required at the top of this file — this is what keeps the module testable
// against a plain stub, with no SQLite involved.
function pruneExpired(db, collection, opts = {}) {
    try {
        const expired = selectExpiredIds(db.list(collection), opts.now);
        for (const id of expired) db.remove(collection, id);
        return expired.length;
    } catch (e) {
        console.error(`Verification-code prune failed for ${collection}:`, e.message);
        return 0;
    }
}

module.exports = {
    TTL_MS,
    MAX_ATTEMPTS,
    RESEND_COOLDOWN_MS,
    buildEntry,
    checkResendCooldown,
    isExpired,
    evaluateCode,
    selectExpiredIds,
    pruneExpired,
};
