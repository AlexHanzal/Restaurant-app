// ============================================================================
// smscap.js — hard global daily ceiling on outbound SMS.
//
// Zero dependencies, same self-contained module pattern as urlsafe.js /
// settings.js / csrf.js. Kept OUT of security.js deliberately: that module
// requires express-rate-limit and db.js, and this is a different concern
// anyway — security.js limits WHO may call a route, this limits HOW MUCH
// money the account can spend in a day regardless of who is calling.
//
// Why this exists (audit 2026-07-29, finding F5):
//   Two unauthenticated routes send a real Twilio SMS on every call:
//     POST ${api}/reservations/send-code
//     POST ${api}/reorder/send-code
//   Both are already well defended against a single abuser — smsIpLimiter
//   (20/hour/IP), smsPhoneLimiter (5/hour/phone, deliberately SHARED between
//   the two routes so one can't top up the other's budget), a 30s per-phone
//   resend cooldown, and the 300/15min apiLimiter backstop.
//
//   Every one of those is per-IP or per-phone. None of them bounds the TOTAL.
//   An attacker with a pool of N addresses multiplies straight through at
//   20 SMS/hour each, and the only thing that eventually stops it is the
//   Twilio balance running out. This module is the missing ceiling: one
//   counter for the whole process, so the worst case is a known number
//   instead of an open-ended bill.
//
// Env:
//   SMS_DAILY_CAP — max SMS per calendar day (local time). Default 200.
//                   Re-read on every call, so it can be changed without a
//                   restart (on hosts where env vars can be edited live).
//                   A non-numeric or non-positive value falls back to 200
//                   rather than disabling the cap — a typo must never
//                   silently remove the protection.
//
// KNOWN LIMITATION — in-process only. State is a module-level counter, so
// each instance gets its own budget; running N instances means an effective
// cap of N × SMS_DAILY_CAP. That matches how security.js's existing
// per-account lockout map already works, and is the right trade for this
// deployment (single Render instance). If this app is ever scaled
// horizontally, this needs to move to a shared store (the `db` SQLite
// collection would do) — and so does security.js's lockout map.
// ============================================================================

const DEFAULT_CAP = 200;

// { day: "YYYY-MM-DD", sent: number } — null until the first send.
let state = null;

// Local calendar date, not UTC: an operator reading "today's SMS count"
// means their own day. Built by hand rather than via toISOString() (which is
// always UTC) or toLocaleDateString() (whose format varies by locale/ICU
// build — it would silently produce a different key shape on a different
// host, which for a day-rollover key is a real bug).
function dayKey(now) {
    const d = now instanceof Date && !isNaN(now.getTime()) ? now : new Date();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${d.getFullYear()}-${month}-${day}`;
}

function getCap() {
    const raw = parseInt(process.env.SMS_DAILY_CAP, 10);
    return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CAP;
}

function currentState(now) {
    const key = dayKey(now);
    if (!state || state.day !== key) state = { day: key, sent: 0 };
    return state;
}

// Read-only view. Does not consume.
function getState(now) {
    const s = currentState(now);
    const cap = getCap();
    return { day: s.day, sent: s.sent, cap, remaining: Math.max(0, cap - s.sent) };
}

// Atomically checks the cap and, if there's room, counts one send.
//
// Check-and-consume BEFORE the SMS actually goes out (fail closed): if the
// send then fails at the provider, we've burned one unit of budget. That's
// the conservative direction to be wrong in for a spend cap, and it also
// means a provider that fails slowly can't be used to slip past the ceiling.
//
// The counter never climbs past the cap, so flipping SMS_DAILY_CAP upward
// mid-day immediately frees exactly the difference.
function tryConsume(now) {
    const s = currentState(now);
    const cap = getCap();
    if (s.sent >= cap) return { ok: false, cap };
    s.sent += 1;
    return { ok: true, remaining: cap - s.sent };
}

function _resetForTests() {
    state = null;
}

module.exports = { tryConsume, getCap, getState, _resetForTests };
