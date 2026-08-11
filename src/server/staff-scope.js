// ============================================================================
// staff-scope.js — how much history a non-admin session may read, and what
// never leaves the server at all.
//
// Review 2026-08-08 finding M4: "one leaked waiter password reads the entire
// customer database". requireAuth is binary — any valid session, including a
// brand-new waiter account created five minutes ago, could read every receipt
// the restaurant had ever issued and a full quarter of revenue history.
//
// WHY THIS IS SCOPING RATHER THAN A ROLE MODEL. The obvious fix is a `role`
// claim and a permission table. It was considered and rejected for this
// installation: the only roles the app can actually ASSIGN are admin and
// driver (two checkboxes in Uživatelé), so a taxonomy of manager/waiter/kitchen
// would be roles nobody can grant — dead configuration that reads as
// protection. What the finding is really about is not "who is this person" but
// "how much of the archive does an ordinary shift need", and the answer to
// that does not require inventing job titles.
//
// So: staff keep every screen they have today, and keep the part of the
// history a shift actually uses. What they lose is the long tail — the quarter
// of revenue and the years of receipts that only the owner has a reason to
// read, and which is the entire value of a stolen waiter password.
//
// THE LIMIT IS REPORTED, NOT SILENT. Every function here returns what it
// clamped to so the route can say so in its response and the UI can label it.
// A screen that quietly shows 7 days when the user asked for 90 is a bug
// report waiting to happen ("the numbers are wrong"), and a security control
// nobody can see is one nobody can trust.
// ============================================================================

// A shift's worth of history. 7 days rather than 1 deliberately: "how did we
// do this week" is a normal question for whoever is running the floor, and a
// Monday-morning look at the weekend is exactly the case a 1-day window would
// break. 30 and 90 days are business analysis — the owner's screen.
const STAFF_HISTORY_DAYS = 7;

function isAdminSession(user) {
    return !!(user && user.isAdmin);
}

/**
 * The most history this session may read, in days. `null` means unlimited.
 */
function historyLimitDays(user) {
    return isAdminSession(user) ? null : STAFF_HISTORY_DAYS;
}

/**
 * Clamps a requested `days` window (GET /stats/sales).
 *
 * Returns { days, limited, limitDays } — `limited` tells the route to say so
 * in its response. Clamping rather than refusing is deliberate: a 403 here
 * would blank the sales screen for a waiter who tapped the wrong tab, which
 * turns a privacy control into an outage. Narrower data still answers the
 * question they were entitled to ask.
 */
function clampDays(requestedDays, user) {
    const limitDays = historyLimitDays(user);
    if (limitDays === null) return { days: requestedDays, limited: false, limitDays: null };
    if (!Number.isFinite(requestedDays)) return { days: limitDays, limited: true, limitDays };
    if (requestedDays <= limitDays) return { days: requestedDays, limited: false, limitDays };
    return { days: limitDays, limited: true, limitDays };
}

/**
 * Clamps a requested { from, to } range (GET /receipts) to the session's
 * window, in the same shape.
 *
 * `from` is pushed forward to the earliest date this session may see; `to` is
 * left alone, because a future `to` reveals nothing. A missing `from` from a
 * non-admin is NOT "everything" — it becomes the earliest allowed date, which
 * is the whole point: the unbounded default was the exposure.
 */
function clampRange(from, to, user, now = new Date()) {
    const limitDays = historyLimitDays(user);
    if (limitDays === null) return { from, to, limited: false, limitDays: null };

    const earliest = new Date(now.getTime() - limitDays * 24 * 60 * 60 * 1000);
    const requested = from ? new Date(from) : null;
    const requestedUsable = requested && Number.isFinite(requested.getTime());

    // An unparseable `from` is treated as absent rather than trusted — the
    // route's own filter would have ignored it too, and "ignored" must not
    // mean "unbounded" here.
    if (!requestedUsable || requested < earliest) {
        return { from: earliest.toISOString(), to, limited: true, limitDays };
    }
    return { from, to, limited: false, limitDays };
}

// ── SECRETS THAT MUST NOT LEAVE THE SERVER ──────────────────────────────
//
// `cancelToken` is a 128-bit capability handed to a guest by SMS: whoever
// holds it can cancel that booking. It lives on the booking slot because the
// slot is the only thing that identifies a booking, but it was being sent to
// every authenticated caller of GET /timetables/:name — including drivers, the
// lowest-trust accounts in the building.
//
// Nothing client-side reads it (checked: no reference in any file under
// src/js/), so this is not a scoping decision at all. It is a value that
// should never have been on the wire, and stripping it costs nothing.
//
// NOT stripped from GET /export, and that is correct rather than an oversight:
// that route streams the raw SQLite file as a backup, and a backup with the
// tokens filtered out would silently break every outstanding cancel link the
// moment it was restored. The export is admin-only and is the owner's own copy
// of their own database — the same reasoning verification-codes.js records for
// pending SMS codes.
//
// Deliberately strips for ADMINS TOO. An admin is entitled to cancel any
// booking — through the routes that do that, which address a slot by date,
// weekday and hour and never need the token. Sending it anyway would put live
// credentials into an export file that gets e-mailed to an accountant.
const SLOT_SECRETS = ["cancelToken"];

function stripSlotSecrets(slot) {
    if (!slot || typeof slot !== "object") return slot;
    let copy = null;
    for (const key of SLOT_SECRETS) {
        if (key in slot) {
            copy = copy || { ...slot };
            delete copy[key];
        }
    }
    return copy || slot;
}

/**
 * Returns a timetable record with every booking slot's secrets removed.
 *
 * Handles both grid shapes — applyBookingToTimetable writes data[dateStr] as
 * an array indexed by weekday, while PUT /timetables/:name accepts an object
 * keyed by weekday. Same duality sanitizeTimetableForPublic and
 * reservation-retention.js handle; missing it would leak through whichever
 * shape was forgotten.
 *
 * Returns the record UNCHANGED (same reference) when there was nothing to
 * strip, so the common path allocates nothing.
 */
function stripTimetableSecrets(record) {
    const data = record && record.data;
    if (!data || typeof data !== "object") return record;

    let changedData = null;

    for (const dateStr of Object.keys(data)) {
        const dayContainer = data[dateStr];
        if (!dayContainer || typeof dayContainer !== "object") continue;

        let changedDay = null;
        for (const dayKey of Object.keys(dayContainer)) {
            const hours = dayContainer[dayKey];
            if (!hours || typeof hours !== "object") continue;

            let changedHours = null;
            for (const hourKey of Object.keys(hours)) {
                const cleaned = stripSlotSecrets(hours[hourKey]);
                if (cleaned !== hours[hourKey]) {
                    changedHours = changedHours || { ...hours };
                    changedHours[hourKey] = cleaned;
                }
            }
            if (changedHours) {
                changedDay = changedDay || (Array.isArray(dayContainer) ? [...dayContainer] : { ...dayContainer });
                changedDay[dayKey] = changedHours;
            }
        }
        if (changedDay) {
            changedData = changedData || { ...data };
            changedData[dateStr] = changedDay;
        }
    }

    return changedData ? { ...record, data: changedData } : record;
}

module.exports = {
    STAFF_HISTORY_DAYS,
    isAdminSession,
    historyLimitDays,
    clampDays,
    clampRange,
    SLOT_SECRETS,
    stripSlotSecrets,
    stripTimetableSecrets,
};
