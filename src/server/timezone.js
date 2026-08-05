// ============================================================================
// timezone.js — pins the process to the restaurant's own timezone.
//
// MUST BE REQUIRED FIRST, before anything else in server.js. Node reads the
// zone lazily but caches it, so setting process.env.TZ after some other
// module has already formatted a Date can leave the two disagreeing for the
// life of the process. Requiring this at the top of server.js — above express,
// above db.js — is what makes the guarantee hold.
//
// Why this exists at all: essentially every business rule in this app is
// written in LOCAL time. settings.js's formatDateStrLocal() and formatHHMM()
// use getFullYear()/getHours() with no zone argument, and everything downstream
// inherits that — the daily-menu window, isDeliveryOpenNow(),
// isTableOrderingOpenNow(), the sales-stats day buckets, and the reservation
// reminder scanner's `new Date(`${todayStr}T${hh}:00:00`)`.
//
// A Linux container defaults to UTC. In Czech summer that is two hours off,
// so on a default deployment:
//   - the daily menu ("polední menu") switches over at 02:00 local,
//   - "are we open right now" answers for the wrong hour,
//   - a day's takings split across two report days in the sales view,
//   - reservation reminders fire two hours from when they should.
// None of it throws. It just quietly reports wrong numbers, which is the
// worst way for this class of bug to behave — hence a default rather than a
// line of documentation somebody has to read.
//
// EET is deliberately NOT affected either way: eet.js formats dat_trzby with
// an explicit UTC offset (see EET_DATETIME_RE there), so the instant it
// reports is correct regardless of the process zone. This is about which
// calendar DAY the rest of the app files a sale under, not about the instant.
//
// Overridable: an operator who sets TZ explicitly gets exactly what they
// asked for. This only fills in a sane default for the deployment this app
// was actually written for.
// ============================================================================

const DEFAULT_TIMEZONE = "Europe/Prague";

// Blank counts as unset, and that is the case that actually bites: .env files
// are full of `TZ=` with nothing after it, and tests/helpers/harness.js
// force-blanks a whole block of vars. An empty TZ is read by Node as UTC —
// i.e. the exact failure above, arrived at via the config meant to prevent it.
function resolveTimezone(env) {
    const raw = env && typeof env.TZ === "string" ? env.TZ.trim() : "";
    return raw || DEFAULT_TIMEZONE;
}

// Writes the resolved zone back onto the env object and returns it. Split
// from resolveTimezone so the decision stays a pure function that can be
// tested without mutating the real process environment.
function applyTimezone(env) {
    const zone = resolveTimezone(env);
    if (env) env.TZ = zone;
    return zone;
}

// The one side effect, run at require time — see the ordering note at the top.
const TIMEZONE = applyTimezone(process.env);

module.exports = { TIMEZONE, DEFAULT_TIMEZONE, resolveTimezone, applyTimezone };
