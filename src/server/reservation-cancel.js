// ============================================================================
// reservation-cancel.js — guest self-cancellation, the parts that are pure.
//
// Spec: docs/superpowers/specs/2026-08-09-reservation-self-cancellation-design.md
//
// A booking is N duplicated hour-slots with no shared identity, so this
// module gives one: `cancelToken`, written onto every slot of a booking when
// it is created. "Cancel this booking" then means "delete every slot carrying
// this token", which stays correct for a multi-hour booking without
// recomputing [startHour, startHour + duration) and hoping it still matches
// what was written.
//
// The token is ALSO the credential. It is 128 bits of entropy handed to the
// guest in an SMS, so it must be treated as a secret everywhere: never
// published by sanitizeTimetableForPublic (which whitelists slot fields, so
// this is safe by construction), never in the kitchen-board payload, never
// logged.
//
// Why not a signed JWT, like reorder tokens: the confirmation SMS carries
// Czech diacritics and is therefore UCS-2 encoded, 70 characters per segment.
// A JWT is 150+ characters and would turn one message into four.
//
// Dependency-free apart from node:crypto — no db, no express, no settings —
// so every refusal rule is unit-testable without standing up a server.
// ============================================================================

const crypto = require("crypto");

// hourIndex 1-12 -> real clock hour 8:00-20:00. Same convention as
// RESERVATION_HOURS in renderer.js and the reminder scanner in server.js.
const START_HOUR_OFFSET = 7;

// 16 random bytes -> 22 base64url characters. Short enough to keep the
// confirmation SMS to two segments; far too large to guess.
function newToken() {
    return crypto.randomBytes(16).toString("base64url");
}

// Constant-time compare that NEVER throws. timingSafeEqual requires equal
// lengths and throws otherwise, which would turn a malformed query string
// into a 500 — and the throw itself would leak length information.
function tokensMatch(a, b) {
    if (typeof a !== "string" || typeof b !== "string") return false;
    if (a.length === 0 || a.length !== b.length) return false;
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// Scans every timetable record for the slots carrying `token`. Same shape of
// scan as reminderScannerTick; the per-IP limiter on the routes is what
// bounds how often an anonymous caller can trigger it.
//
// Returns the booking as { record, dateStr, dayIndex, hourKeys, slots }, or
// null when nothing matches — including for an empty/absent token, so a
// slot that predates this feature can never be matched by one.
function findBooking(records, token) {
    if (typeof token !== "string" || token.length === 0) return null;

    for (const record of records || []) {
        const data = (record && record.data) || {};

        for (const dateStr of Object.keys(data)) {
            const dayMap = data[dateStr];
            if (!dayMap || typeof dayMap !== "object") continue;

            for (const dayKey of Object.keys(dayMap)) {
                const hours = dayMap[dayKey];
                if (!hours || typeof hours !== "object") continue;

                const hourKeys = Object.keys(hours)
                    .filter(h => hours[h] && tokensMatch(hours[h].cancelToken, token))
                    .map(Number)
                    .sort((a, b) => a - b);

                if (hourKeys.length > 0) {
                    return {
                        record,
                        dateStr,
                        dayIndex: Number(dayKey),
                        hourKeys,
                        slots: hourKeys.map(h => hours[h]),
                    };
                }
            }
        }
    }

    return null;
}

// When does this booking start, as a local Date?
function bookingStart(booking) {
    const hour = booking.hourKeys[0] + START_HOUR_OFFSET;
    const [y, m, d] = booking.dateStr.split("-").map(Number);
    return new Date(y, m - 1, d, hour, 0, 0, 0);
}

// The whole refusal policy, in evaluation order. Pure function of the
// booking and the clock.
function canCancel(booking, now = new Date()) {
    // "Unknown token" and "already cancelled" deliberately give the SAME
    // answer: distinguishing them would make this endpoint an oracle for
    // "is this token real", and a cancelled booking's slots are gone, so
    // the two are genuinely indistinguishable here anyway.
    if (!booking) {
        return { ok: false, status: 410, reason: "Rezervace nebyla nalezena — možná už byla zrušena." };
    }

    // No refund is ever initiated by an untrusted link. Money movement stays
    // with staff. Any paid hour blocks the whole booking.
    if (booking.slots.some(s => s && s.isPaid)) {
        return { ok: false, status: 409, reason: "Objednávka je zaplacená — zrušení prosím vyřešte telefonicky." };
    }

    if (bookingStart(booking) <= now) {
        return { ok: false, status: 409, reason: "Tato rezervace už proběhla." };
    }

    return { ok: true, status: 200, reason: null };
}

module.exports = {
    START_HOUR_OFFSET,
    newToken,
    tokensMatch,
    findBooking,
    bookingStart,
    canCancel,
};
