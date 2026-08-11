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

function seedSettings(dbPath, resvOverrides = {}, notifOverrides = {}) {
    harness.seedRecord(dbPath, COL.settings, harness.SETTINGS_ID, {
        reservations: { paused: false, maxDaysAhead: 14, days: reservationDays(), ...resvOverrides },
        notifications: {
            smsOrderConfirmed: false,
            smsOrderOnTheWay: false,
            // Off so the ONLY SMS in the child's log is the verification
            // code — otherwise readCode() could pick up a confirmation.
            // The cancel-link case below turns this one back on deliberately,
            // and restores it afterwards.
            smsReservationConfirmed: false,
            smsReservationReminder: false,
            emailEnabled: false,
            ...notifOverrides,
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

// Books, then digs the booking's cancel token straight out of the DB. The
// SMS-delivered link is asserted separately, by its own case below — reading
// the token from storage here keeps every other cancellation case independent
// of whether confirmation SMS happens to be switched on.
async function bookAndGetToken(server, body = {}) {
    const out = await book(server, body);
    assert.strictEqual(out.res.status, 200, `booking failed at ${out.stage}: ${JSON.stringify(out.body)}`);

    const dateStr = body.dateStr || TOMORROW;
    const hour = body.startHour || 5;
    const record = harness.readRecord(server.dbPath, COL.timetables, TABLE_FILE_ID);
    const slot = record.data[dateStr][dayIndexOf(dateStr)][hour];
    assert.ok(slot, `no slot written at ${dateStr} hour ${hour}`);
    return slot.cancelToken;
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

    // Finding M3's non-negotiable: the payload verify-and-book books from is
    // the one priced and stored server-side at send-code time, and NOTHING
    // else — the whole reason it's held server-side instead of round-
    // tripped through the client. A hostile body bolted onto the real
    // verify-and-book call must have zero effect: verifyAndBookSchema has no
    // `.passthrough()` (so these fields are stripped before the handler ever
    // sees them) AND the handler only ever reads phone/code off req.body,
    // booking from pending.payload — two independent layers, either one of
    // which is enough on its own.
    test("verify-and-book books only the server-priced payload from send-code — a tampered body is not honoured", async () => {
        const out = await sendCode(server, { startHour: 11, guestName: "Server Cena" });
        assert.strictEqual(out.res.status, 200, JSON.stringify(await out.res.json().catch(() => ({}))));
        await new Promise(r => setTimeout(r, 50));
        const code = readCode(server, out.phone);

        const res = await post(server, "/reservations/verify-and-book", {
            phone: out.phone,
            code,
            startHour: 12,
            guestName: "Tampered Guest",
            tableName: "Nonexistent Table",
            orderTotal: 0,
        });
        assert.strictEqual(res.status, 200, JSON.stringify(await res.json().catch(() => ({}))));

        const record = harness.readRecord(server.dbPath, COL.timetables, TABLE_FILE_ID);
        assert.strictEqual(
            record.data[TOMORROW][dayIndexOf(TOMORROW)][11].content,
            "Server Cena",
            "the ORIGINAL guest name/hour from send-code must be what gets booked"
        );
        assert.ok(!record.data[TOMORROW][dayIndexOf(TOMORROW)][12], "the tampered hour must never be booked");
    });

    // Finding M3: checkResendCooldown reads `existing.lastSentAt` back out of
    // COL.reservationPendingCodes — this is the end-to-end proof the 30s
    // per-phone resend cooldown still works now that the pending row lives
    // in SQLite instead of a Map. Two real requests, no clock trickery: a
    // second send-code for the SAME phone, moments after the first, must
    // still be refused.
    test("a second send-code for the same phone within 30s is refused with the cooldown message", async () => {
        const phone = nextPhone();
        const first = await sendCode(server, { phone, startHour: 9, guestName: "Cooldown Test" });
        assert.strictEqual(first.res.status, 200, JSON.stringify(await first.res.json().catch(() => ({}))));

        const second = await sendCode(server, { phone, startHour: 9, guestName: "Cooldown Test" });
        assert.strictEqual(second.res.status, 429);
        const body = await second.res.json();
        assert.match(body.error, /Zkuste to znovu za \d+ s/);
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

    test("every hour of a booking carries one shared cancel token", async () => {
        const target = dateStrOffset(3);
        const out = await book(server, { dateStr: target, startHour: 3, duration: 2, guestName: "Anna Bílá" });
        assert.strictEqual(out.res.status, 200, JSON.stringify(out.body));

        const record = harness.readRecord(server.dbPath, COL.timetables, TABLE_FILE_ID);
        const day = record.data[target][dayIndexOf(target)];

        assert.match(day[3].cancelToken, /^[A-Za-z0-9_-]{22}$/);
        assert.strictEqual(day[3].cancelToken, day[4].cancelToken, "both hours belong to one booking");
    });

    test("the cancel token is never published by the public timetable route", async () => {
        const res = await fetch(`${server.api}/timetables/${encodeURIComponent(TABLE_NAME)}`);
        assert.strictEqual(res.status, 200);
        const body = await res.text();
        assert.ok(!body.includes("cancelToken"), "cancelToken must not appear in the public payload");
    });
});

// ── GUEST SELF-CANCELLATION ──────────────────────────────────────────────
// Its own spawned server, not a shared one with the suite above: both suites
// spend from the same per-IP SMS budget (20/hour, and every request here comes
// from 127.0.0.1), and the booking suite above is already close to it.
describe("reservation self-cancellation", () => {
    let server;

    before(async () => {
        server = await harness.start();
        seedSettings(server.dbPath);
        harness.seedRecord(server.dbPath, COL.timetables, TABLE_FILE_ID, tableRecord());
    });

    after(async () => { if (server) await server.stop(); });

    test("the summary describes the booking without leaking who made it", async () => {
        const token = await bookAndGetToken(server, { startHour: 5, guestName: "Jan Novák" });

        const res = await fetch(`${server.api}/reservations/cancellation?t=${token}`);
        assert.strictEqual(res.status, 200);
        const body = await res.json();

        assert.strictEqual(body.tableName, TABLE_NAME);
        assert.strictEqual(body.dateStr, TOMORROW);
        assert.strictEqual(body.startHour, 5);
        assert.strictEqual(body.endHour, 5);
        assert.strictEqual(body.cancellable, true);

        // The link travels by SMS and may be forwarded or screenshotted, so
        // the response is written for an audience that might not be the guest.
        const raw = JSON.stringify(body);
        assert.ok(!raw.includes("Jan Novák"), "no guest name");
        assert.ok(!raw.includes("+420"), "no phone number");
        assert.ok(!raw.includes(token), "never echo the token back");
    });

    test("cancelling frees the slot and is not repeatable", async () => {
        const token = await bookAndGetToken(server, { startHour: 6, guestName: "Eva Malá" });

        const first = await post(server, "/reservations/cancel", { token });
        assert.strictEqual(first.status, 200, await first.text());

        const record = harness.readRecord(server.dbPath, COL.timetables, TABLE_FILE_ID);
        assert.ok(!record.data[TOMORROW][dayIndexOf(TOMORROW)][6], "the slot must be gone, not blanked");

        const second = await post(server, "/reservations/cancel", { token });
        assert.strictEqual(second.status, 410);
        assert.match((await second.json()).error, /nebyla nalezena/i);
    });

    test("a multi-hour booking is cancelled whole, and only its own hours", async () => {
        const target = dateStrOffset(2);
        const day = dayIndexOf(target);

        const token = await bookAndGetToken(server, { dateStr: target, startHour: 3, duration: 2, guestName: "Anna Bílá" });
        // A neighbouring booking that must survive: it proves the delete is
        // keyed on the token rather than on the hour arithmetic.
        await bookAndGetToken(server, { dateStr: target, startHour: 5, guestName: "Tomáš Sedlák" });

        assert.strictEqual((await post(server, "/reservations/cancel", { token })).status, 200);

        const hours = harness.readRecord(server.dbPath, COL.timetables, TABLE_FILE_ID).data[target][day];
        assert.ok(!hours[3] && !hours[4], "both hours of the cancelled booking must be gone");
        assert.strictEqual(hours[5].content, "Tomáš Sedlák", "the neighbouring booking must be untouched");
    });

    test("a freed slot can be booked again", async () => {
        const token = await bookAndGetToken(server, { startHour: 7, guestName: "Petr Dvořák" });
        assert.strictEqual((await post(server, "/reservations/cancel", { token })).status, 200);

        const rebook = await book(server, { startHour: 7, guestName: "Karel Ryba" });
        assert.strictEqual(rebook.res.status, 200, JSON.stringify(rebook.body));
    });

    test("a paid preorder is refused and the booking survives", async () => {
        const token = await bookAndGetToken(server, { startHour: 8, guestName: "Lucie Krátká" });

        // Mark it paid the way a completed payment would.
        const record = harness.readRecord(server.dbPath, COL.timetables, TABLE_FILE_ID);
        const slot = record.data[TOMORROW][dayIndexOf(TOMORROW)][8];
        slot.order = [{ item: "Svíčková", price: 150, qty: 1 }];
        slot.orderTotal = 150;
        slot.isPaid = true;
        harness.seedRecord(server.dbPath, COL.timetables, TABLE_FILE_ID, record);

        const res = await post(server, "/reservations/cancel", { token });
        assert.strictEqual(res.status, 409);
        assert.match((await res.json()).error, /telefonicky/i);

        const after = harness.readRecord(server.dbPath, COL.timetables, TABLE_FILE_ID);
        assert.ok(after.data[TOMORROW][dayIndexOf(TOMORROW)][8], "a refused cancellation must not delete anything");
    });

    test("a booking that has already started is refused", async () => {
        const token = await bookAndGetToken(server, { startHour: 9, guestName: "Marek Sýkora" });

        // Move the booking into the past by re-keying it onto yesterday —
        // cheaper and far less flaky than waiting for a clock.
        const record = harness.readRecord(server.dbPath, COL.timetables, TABLE_FILE_ID);
        const yesterday = dateStrOffset(-1);
        const slot = record.data[TOMORROW][dayIndexOf(TOMORROW)][9];
        delete record.data[TOMORROW][dayIndexOf(TOMORROW)][9];
        record.data[yesterday] = [];
        record.data[yesterday][dayIndexOf(yesterday)] = { 9: slot };
        harness.seedRecord(server.dbPath, COL.timetables, TABLE_FILE_ID, record);

        const res = await post(server, "/reservations/cancel", { token });
        assert.strictEqual(res.status, 409);
        assert.match((await res.json()).error, /proběhla/i);
    });

    test("an unknown token answers exactly like an already-cancelled one", async () => {
        // Same shape, same status, same wording — the endpoint must not become
        // an oracle for "is this token real".
        const res = await post(server, "/reservations/cancel", { token: "aBcDeFgHiJkLmNoPqRsTuV" });
        assert.strictEqual(res.status, 410);
        assert.match((await res.json()).error, /nebyla nalezena/i);

        const summary = await fetch(`${server.api}/reservations/cancellation?t=aBcDeFgHiJkLmNoPqRsTuV`);
        assert.strictEqual(summary.status, 410);
    });

    test("a malformed token is rejected by the schema, before any scan", async () => {
        for (const bad of ["nope", "", "a".repeat(200), "has spaces here!!!!!!"]) {
            const res = await post(server, "/reservations/cancel", { token: bad });
            assert.strictEqual(res.status, 400, `${JSON.stringify(bad)} must be a 400`);
        }
        assert.strictEqual((await fetch(`${server.api}/reservations/cancellation`)).status, 400, "a missing ?t= is a 400");
    });

    test("the confirmation SMS carries a link that actually works", async () => {
        // The only case in this file that needs the confirmation SMS on.
        seedSettings(server.dbPath, {}, { smsReservationConfirmed: true });

        const { phone } = await sendCode(server, { startHour: 10, guestName: "Jana Horká" });
        await new Promise(r => setTimeout(r, 50));
        await post(server, "/reservations/verify-and-book", { phone, code: readCode(server, phone) });
        await new Promise(r => setTimeout(r, 50));

        const confirmations = server.logs().split("\n").filter(l => l.includes(phone) && l.includes("Zrušit"));
        assert.ok(confirmations.length > 0, "the confirmation SMS must carry a cancel link");

        const match = /zrusit\?t=([A-Za-z0-9_-]{22})/.exec(confirmations[confirmations.length - 1]);
        assert.ok(match, `no cancel link in: ${confirmations[confirmations.length - 1]}`);

        // End to end: the link out of the SMS resolves to this booking.
        const res = await fetch(`${server.api}/reservations/cancellation?t=${match[1]}`);
        assert.strictEqual(res.status, 200);
        assert.strictEqual((await res.json()).startHour, 10);

        seedSettings(server.dbPath); // restore
    });

    test("the page is served and never echoes the token into the HTML", async () => {
        const res = await fetch(`${server.baseUrl}/reservation/zrusit?t=aBcDeFgHiJkLmNoPqRsTuV`);
        assert.strictEqual(res.status, 200);
        const html = await res.text();
        assert.match(html, /zrusit\.js/, "the page must load its script");
        assert.ok(!html.includes("aBcDeFgHiJkLmNoPqRsTuV"), "the token must stay in the query string");
        assert.ok(!html.includes("{{"), "every template token must be rendered");
    });

    test("the raw template is not reachable under /html", async () => {
        const res = await fetch(`${server.baseUrl}/reservation/html/zrusit.html`);
        assert.strictEqual(res.status, 404);
    });
});

// ── FINDING M3: PENDING VERIFICATION SURVIVES A RESTART ──────────────────
// Before this fix, pendingVerifications was a bare in-memory Map: a code
// requested moments before a deploy/crash/OOM was silently gone on the next
// process, and the customer who had just received it hit "Nejprve si
// vyžádejte ověřovací kód" for no reason they could see. This is the direct
// regression guard — a PINNED temp DB (not the auto-generated one
// harness.start() otherwise uses per call), so a second, brand-new server
// process can be pointed at the exact same file the first one wrote to.
// Own describe block/server, so a failure here is never entangled with the
// booking suite above.
describe("reservation verification survives a restart", () => {
    const os = require("os");
    const path = require("path");
    const crypto = require("crypto");
    const dbPath = path.join(os.tmpdir(), `reservation-m3-smoke-${process.pid}-${crypto.randomBytes(6).toString("hex")}.db`);

    test("a code requested before a crash still books after the process restarts", async () => {
        const first = await harness.start({ env: { SQLITE_PATH: dbPath } });
        let phone;
        try {
            seedSettings(dbPath);
            harness.seedRecord(dbPath, COL.timetables, TABLE_FILE_ID, tableRecord());

            const out = await sendCode(first, { startHour: 5, guestName: "Restartová Zkouška" });
            assert.strictEqual(out.res.status, 200, JSON.stringify(await out.res.json().catch(() => ({}))));
            phone = out.phone;
            await new Promise(r => setTimeout(r, 50));
            var code = readCode(first, phone); // eslint-disable-line no-var
        } finally {
            await first.stop();
        }

        // A brand new process, same DB file, no send-code call against it —
        // if verify-and-book succeeds here, the pending code (and the
        // server-priced payload it carries — table/date/hour/guest name)
        // can only have come from disk, not from any Map instance, which
        // died with the first process.
        const second = await harness.start({ env: { SQLITE_PATH: dbPath } });
        try {
            const verify = await post(second, "/reservations/verify-and-book", { phone, code });
            assert.strictEqual(verify.status, 200, await verify.text());

            const record = harness.readRecord(dbPath, COL.timetables, TABLE_FILE_ID);
            const slot = record.data[TOMORROW][dayIndexOf(TOMORROW)][5];
            assert.strictEqual(slot.content, "Restartová Zkouška", "the booking written after the restart must carry the ORIGINAL server-priced payload from before it");
        } finally {
            await second.stop();
        }
    });
});
