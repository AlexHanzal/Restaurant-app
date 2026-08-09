// ============================================================================
// reservations.test.js — end-to-end smoke coverage for the public reservation
// flow (POST /reservations/send-code -> POST /reservations/verify-and-book),
// against a REAL spawned server and a REAL temp SQLite DB.
//
// Before this file the only test touching these two routes asserted they 404
// when the `reservations` feature is off (tests/smoke/features.test.js) —
// nothing exercised a booking actually being written. These cases are the
// regression guard for the three fixes from the 2026-08-09 review:
//
//   fix 1  dayIndex is derived from dateStr, not taken from the request body
//   fix 2  dateStr must be a real calendar date, today-or-later, within the
//          configured booking horizon
//   fix 3  the occupancy check honours permanent bookings carried forward
//          from earlier dates, the same way the customer-facing page does
//
// BUDGET: every case here spends one request against smsIpLimiter (20/hour
// per IP, and every request in this file comes from 127.0.0.1) — including
// the ones that end in a 400, because the limiter sits in front of
// validation. Keep this suite under ~15 send-code calls or it starts
// failing on 429s that have nothing to do with what is being tested.
//
// The verification code is read out of the child's console output: with
// TWILIO_* blanked by the harness and NODE_ENV != production, notify.js logs
// the message body instead of sending an SMS. See harness.logs().
// ============================================================================

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert");

const harness = require("../helpers/harness");

const COL = harness.COL;

// ── FIXTURES ─────────────────────────────────────────────────────────────

const TABLE_FILE_ID = "resv-table-1";
const TABLE_NAME = "Stůl 1";

function tableRecord(data = {}) {
    return {
        className: TABLE_NAME,
        fileId: TABLE_FILE_ID,
        data,
        calendar: "",
        currentWeek: new Date().toISOString(),
        info: "",
        attributes: [],
        seats: 4,
        layout: null,
        permanentHours: { "0": {}, "1": {}, "2": {}, "3": {}, "4": {}, "5": {}, "6": {} },
    };
}

function reservationDays(overrides = {}) {
    const days = {};
    for (let i = 0; i <= 6; i++) days[String(i)] = { open: true, fromHour: 1, toHour: 12 };
    return { ...days, ...overrides };
}

function seedSettings(dbPath, resvOverrides = {}) {
    harness.seedRecord(dbPath, COL.settings, harness.SETTINGS_ID, {
        reservations: { paused: false, maxDaysAhead: 14, days: reservationDays(), ...resvOverrides },
        notifications: {
            smsOrderConfirmed: false,
            smsOrderOnTheWay: false,
            // Off so the ONLY SMS in the child's log is the verification
            // code — otherwise readCode() could pick up a confirmation.
            smsReservationConfirmed: false,
            smsReservationReminder: false,
            emailEnabled: false,
        },
    });
}

// ── DATE HELPERS ─────────────────────────────────────────────────────────
// Every date is computed relative to the day the suite runs, so these cases
// keep meaning the same thing forever. Local-midnight arithmetic, matching
// settings.formatDateStrLocal.

function dateStrOffset(days) {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// undefined for anything that is not a real date, so the deliberately-bad
// dateStr cases below omit the field rather than sending a NaN the schema
// would reject — those cases must fail on the DATE check, not on a
// malformed companion field.
function dayIndexOf(dateStr) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr || "")) return undefined;
    const [y, m, d] = dateStr.split("-").map(Number);
    const date = new Date(y, m - 1, d);
    if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return undefined;
    return (date.getDay() + 6) % 7;
}

// Tomorrow, so "is this hour already past?" can never make the suite flaky
// the way booking today at a fixed hour would after 12:00.
const TOMORROW = dateStrOffset(1);

// ── FLOW HELPERS ─────────────────────────────────────────────────────────

let phoneCounter = 0;
// A fresh number per booking: the 30s resendCooldownMs is per phone, and so
// is smsPhoneLimiter (5/hour). Reusing one number would make the suite fail
// on cooldown rather than on what it is asserting.
function nextPhone() {
    phoneCounter += 1;
    return `+42060000${String(phoneCounter).padStart(4, "0")}`;
}

function post(server, path, body) {
    return fetch(`${server.api}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
}

// Pulls the most recent verification code out of the child's log. The
// simulated-SMS line is: "📲 [SMS fallback — not actually sent] To: <phone> |
// Váš ověřovací kód pro rezervaci: 123456 (platnost 5 minut)."
function readCode(server, phone) {
    const lines = server.logs().split("\n").filter(l => l.includes(phone) && l.includes("ověřovací kód"));
    assert.ok(lines.length > 0, `no simulated verification SMS logged for ${phone}`);
    // Anchored on the message text, NOT just "six digits on the line" — the
    // line also carries the phone number, whose digits come first.
    const match = /ověřovací kód pro rezervaci: (\d{6})/.exec(lines[lines.length - 1]);
    assert.ok(match, `could not read a 6-digit code out of: ${lines[lines.length - 1]}`);
    return match[1];
}

// `dayIndex` defaults to whatever the effective dateStr implies — the server
// refuses a dayIndex that disagrees with its own date, so a helper that
// hardcoded one weekday would make every case that picks a different date
// fail for a reason it is not testing. Pass it explicitly only to test that
// refusal; pass `undefined` to omit the field entirely.
function sendCode(server, body = {}) {
    const phone = body.phone || nextPhone();
    const dateStr = "dateStr" in body ? body.dateStr : TOMORROW;
    const dayIndex = "dayIndex" in body ? body.dayIndex : dayIndexOf(dateStr);

    return post(server, "/reservations/send-code", {
        tableName: TABLE_NAME,
        startHour: 5,
        duration: 1,
        guestName: "Jan Novák",
        guests: 2,
        ...body,
        phone,
        dateStr,
        dayIndex,
    }).then(res => ({ res, phone }));
}

// The whole flow. Returns the verify-and-book response, or the send-code
// response when that is what failed.
async function book(server, body = {}) {
    const { res, phone } = await sendCode(server, body);
    if (!res.ok) return { stage: "send-code", res, body: await res.json().catch(() => ({})) };

    // The log is written synchronously by the child before it responds, but
    // it reaches this process over a pipe — give it a beat to arrive.
    await new Promise(r => setTimeout(r, 50));

    const verify = await post(server, "/reservations/verify-and-book", { phone, code: readCode(server, phone) });
    return { stage: "verify-and-book", res: verify, body: await verify.json().catch(() => ({})) };
}

// ── SUITE ────────────────────────────────────────────────────────────────

describe("reservation booking flow", () => {
    let server;

    before(async () => {
        server = await harness.start();
        seedSettings(server.dbPath);
        harness.seedRecord(server.dbPath, COL.timetables, TABLE_FILE_ID, tableRecord());
    });

    after(async () => { if (server) await server.stop(); });

    test("books a slot and writes it under the date's real weekday index", async () => {
        const out = await book(server);
        assert.strictEqual(out.res.status, 200, `expected 200, got ${out.res.status} at ${out.stage}: ${JSON.stringify(out.body)}`);

        const record = harness.readRecord(server.dbPath, COL.timetables, TABLE_FILE_ID);
        const slot = record.data[TOMORROW][dayIndexOf(TOMORROW)][5];
        assert.strictEqual(slot.content, "Jan Novák");
        assert.strictEqual(slot.guests, 2);
        assert.strictEqual(slot.isPermanent, false);
    });

    test("the slot just booked is no longer free", async () => {
        const out = await book(server, { guestName: "Petr Dvořák" });
        assert.strictEqual(out.res.status, 409, JSON.stringify(out.body));
    });

    // ── fix 1 ───────────────────────────────────────────────────────────
    test("a dayIndex that contradicts dateStr is refused outright", async () => {
        const real = dayIndexOf(TOMORROW);
        const lying = (real + 3) % 7;

        // Hour 6 is still free on this date; only the dayIndex is hostile.
        // Every real client derives this field from the date the same way the
        // server does, so a mismatch is never an honest request — refusing it
        // is louder than silently correcting it, and costs no SMS.
        const { res } = await sendCode(server, { dayIndex: lying, startHour: 6, guestName: "Eva Malá" });
        assert.strictEqual(res.status, 400);
        const body = await res.json();
        assert.match(body.error, /den/i);

        const record = harness.readRecord(server.dbPath, COL.timetables, TABLE_FILE_ID);
        assert.ok(!record.data[TOMORROW][real] || !record.data[TOMORROW][real][6], "nothing booked under the real weekday");
        assert.ok(
            !(record.data[TOMORROW][lying] && record.data[TOMORROW][lying][6]),
            "and nothing under the claimed one — that slot would be invisible to the customer page"
        );
    });

    test("a matching dayIndex, and no dayIndex at all, both book normally", async () => {
        const real = dayIndexOf(TOMORROW);

        const withIndex = await book(server, { dayIndex: real, startHour: 6, guestName: "Eva Malá" });
        assert.strictEqual(withIndex.res.status, 200, JSON.stringify(withIndex.body));

        // Omitted entirely: the field is optional and the server derives it.
        const withoutIndex = await book(server, { dayIndex: undefined, startHour: 7, guestName: "Tomáš Sedlák" });
        assert.strictEqual(withoutIndex.res.status, 200, JSON.stringify(withoutIndex.body));

        const record = harness.readRecord(server.dbPath, COL.timetables, TABLE_FILE_ID);
        assert.strictEqual(record.data[TOMORROW][real][6].content, "Eva Malá");
        assert.strictEqual(record.data[TOMORROW][real][7].content, "Tomáš Sedlák");
    });

    test("a closed weekday is refused, and claiming an open one does not help", async () => {
        const target = dateStrOffset(2);
        const realDay = dayIndexOf(target);
        const openDay = (realDay + 1) % 7;

        seedSettings(server.dbPath, { days: reservationDays({ [String(realDay)]: { open: false, fromHour: 1, toHour: 12 } }) });

        // Honest request: refused by the weekday gate, before any SMS.
        const honest = await book(server, { dateStr: target, guestName: "Karel Ryba" });
        assert.strictEqual(honest.stage, "send-code", "must be refused before any SMS is sent");
        assert.strictEqual(honest.res.status, 400);
        assert.match(honest.body.error, /nepřijímáme/i);

        // Pointing at an open weekday's index does not reopen the day — it is
        // now refused one step earlier, as a date/weekday contradiction.
        const { res } = await sendCode(server, { dateStr: target, dayIndex: openDay, guestName: "Karel Ryba" });
        assert.strictEqual(res.status, 400);

        seedSettings(server.dbPath); // restore
    });

    // ── fix 2 ───────────────────────────────────────────────────────────
    test("rejects a dateStr that is not a real date", async () => {
        for (const bad of ["aaaa", "2026-02-29"]) {
            const { res } = await sendCode(server, { dateStr: bad });
            assert.strictEqual(res.status, 400, `${bad} must be rejected`);
        }

        const record = harness.readRecord(server.dbPath, COL.timetables, TABLE_FILE_ID);
        assert.ok(!("aaaa" in record.data), "a junk date key must never reach the stored record");
    });

    test("rejects a date in the past", async () => {
        const { res } = await sendCode(server, { dateStr: dateStrOffset(-1) });
        assert.strictEqual(res.status, 400);
        const body = await res.json();
        assert.match(body.error, /minulosti/i);
    });

    test("rejects a date beyond the booking horizon", async () => {
        const { res } = await sendCode(server, { dateStr: dateStrOffset(15) });
        assert.strictEqual(res.status, 400);
        const body = await res.json();
        assert.match(body.error, /dopředu/i);

        // ...and accepts the last day inside it.
        const inside = await sendCode(server, { dateStr: dateStrOffset(14) });
        assert.strictEqual(inside.res.status, 200);
    });

    // ── fix 3 ───────────────────────────────────────────────────────────
    test("a permanent booking on an earlier date blocks the same weekday and hour", async () => {
        // A standing reservation created a week before the target date —
        // exactly what renderer.js greys out for the customer, and what the
        // server used to write straight over.
        const target = dateStrOffset(7);
        const day = dayIndexOf(target);
        const earlier = dateStrOffset(0);

        const data = {};
        data[earlier] = [];
        data[earlier][day] = { 8: { content: "Firemní oběd", abbreviation: "FO", isPermanent: true } };
        harness.seedRecord(server.dbPath, COL.timetables, TABLE_FILE_ID, tableRecord(data));

        const out = await book(server, { dateStr: target, startHour: 8, guestName: "Lucie Krátká" });
        assert.strictEqual(out.res.status, 409, `standing reservation must block this slot: ${JSON.stringify(out.body)}`);

        // The neighbouring hour is genuinely free and must still book.
        const ok = await book(server, { dateStr: target, startHour: 9, guestName: "Lucie Krátká" });
        assert.strictEqual(ok.res.status, 200, JSON.stringify(ok.body));
    });
});
