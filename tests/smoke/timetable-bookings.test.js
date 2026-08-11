// ============================================================================
// timetable-bookings.test.js — the admin can no longer overwrite the
// reservation grid, and can still edit one booking at a time.
//
// Finding H3, docs/2026-08-08-architecture-dataflow-security-review.md,
// still open as of the 2026-08-10 review, fixed here.
//
// THE CASE THIS FILE EXISTS FOR is "a stale snapshot cannot delete a booking":
// the admin frontend used to PUT the whole week × day × hour grid on every save,
// taken from a snapshot loaded when the page opened. Owner opens /admin at
// 18:00, three customers book between 18:00 and 19:00, owner edits the table's
// description at 19:00 — and the three reservations were gone, silently, with
// the customers still holding their confirmation SMS. No attacker, just a tab
// left open.
//
// The fix removes the capability rather than guarding it, so the test that
// matters replays exactly that sequence and asserts the bookings survive. The
// per-slot routes are covered too, but they are the smaller half: a regression
// there is a broken button, whereas a regression in the first case is
// unrecoverable data loss.
// ============================================================================

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert");
const bcrypt = require("bcryptjs");

const harness = require("../helpers/harness");

const COL = harness.COL;

const TABLE_FILE_ID = "h3-table-1";
const TABLE_NAME = "Stůl 1";
const DATE = "2026-09-14";     // a Monday
const DAY_INDEX = 0;

const ADMIN = { id: "h3-admin", abbreviation: "h3-admin", password: "H3!AdminPass123" };
const WAITER = { id: "h3-waiter", abbreviation: "h3-waiter", password: "H3!WaiterPass123" };

// A booking as applyBookingToTimetable writes one, including the fields that
// must survive an edit they were not part of.
function booking(name, extra = {}) {
    return {
        content: name,
        abbreviation: name.split(/\s+/).map(w => w[0]).join("").slice(0, 3).toUpperCase(),
        isPermanent: false,
        phone: "+420600111222",
        cancelToken: "aBcDeFgHiJkLmNoPqRsTuV",
        guests: 2,
        ...extra,
    };
}

function tableRecord(hours = {}) {
    const data = {};
    data[DATE] = [];
    data[DATE][DAY_INDEX] = hours;
    return {
        className: TABLE_NAME,
        fileId: TABLE_FILE_ID,
        data,
        calendar: "",
        currentWeek: new Date().toISOString(),
        info: "Original description",
        attributes: ["u okna"],
        seats: 4,
        layout: { room: "Hlavní sál", x: 10, y: 20, w: 60, h: 60 },
        permanentHours: { "0": {}, "1": {}, "2": {}, "3": {}, "4": {}, "5": {}, "6": {} },
    };
}

function seedUser(dbPath, { id, abbreviation, password }, extra = {}) {
    harness.seedRecord(dbPath, COL.users, id, {
        id, abbreviation, name: `Test ${abbreviation}`,
        password: bcrypt.hashSync(password, 12),
        isAdmin: false, isDriver: false, ...extra,
    });
}

// ── HTTP HELPERS ─────────────────────────────────────────────────────────

function cookieFrom(res, prefix) {
    const all = typeof res.headers.getSetCookie === "function"
        ? res.headers.getSetCookie()
        : [res.headers.get("set-cookie")].filter(Boolean);
    const hit = all.find(c => c && c.startsWith(prefix));
    return hit ? hit.split(";")[0] : null;
}

async function sessionFor(server, user) {
    const login = await fetch(`${server.api}/users/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ abbreviation: user.abbreviation, password: user.password }),
    });
    if (login.status !== 200) assert.fail(`login failed for ${user.abbreviation}: ${login.status} ${await login.text()}`);
    const authCookie = cookieFrom(login, "auth_token");

    const csrf = await fetch(`${server.api}/csrf-token`, { headers: { cookie: authCookie } });
    const { csrfToken } = await csrf.json();
    return { cookie: `${authCookie}; ${cookieFrom(csrf, "csrf_token")}`, csrfToken };
}

function authed(server, session, path, method, body) {
    return fetch(`${server.api}${path}`, {
        method,
        headers: {
            "content-type": "application/json",
            cookie: session.cookie,
            "x-csrf-token": session.csrfToken,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
}

const readTable = (server) => harness.readRecord(server.dbPath, COL.timetables, TABLE_FILE_ID);
const hoursOf = (record) => (record.data[DATE] && record.data[DATE][DAY_INDEX]) || {};

// ── SUITE ────────────────────────────────────────────────────────────────

describe("timetable bookings are not writable through the table PUT", () => {
    let server, admin;

    before(async () => {
        server = await harness.start();
        seedUser(server.dbPath, ADMIN, { isAdmin: true });
        seedUser(server.dbPath, WAITER);
        admin = await sessionFor(server, ADMIN);
    });

    after(async () => { if (server) await server.stop(); });

    // ── THE REGRESSION GUARD ────────────────────────────────────────────

    test("a stale snapshot cannot delete reservations booked since it was taken", async () => {
        // 18:00 — the admin page loads and holds this.
        harness.seedRecord(server.dbPath, COL.timetables, TABLE_FILE_ID, tableRecord({ 5: booking("Jan Novák") }));
        const snapshot = readTable(server);

        // 18:00-19:00 — three customers book, straight into the stored record,
        // exactly as applyBookingToTimetable would.
        const live = readTable(server);
        live.data[DATE][DAY_INDEX][6] = booking("Eva Malá");
        live.data[DATE][DAY_INDEX][7] = booking("Petr Dvořák");
        live.data[DATE][DAY_INDEX][8] = booking("Lucie Krátká");
        harness.seedRecord(server.dbPath, COL.timetables, TABLE_FILE_ID, live);

        // 19:00 — the owner edits the description. The frontend used to send the
        // whole 18:00 grid along with it; a browser on a pre-fix bundle still
        // does, which is why the field is accepted and ignored rather than
        // rejected. Either way it must not be applied.
        const res = await authed(server, admin, `/timetables/${encodeURIComponent(TABLE_NAME)}`, "PUT", {
            fileId: snapshot.fileId,
            data: snapshot.data,              // ← the 18:00 snapshot
            info: "Edited at 19:00",
            attributes: snapshot.attributes,
            calendar: snapshot.calendar,
            currentWeek: snapshot.currentWeek,
            permanentHours: snapshot.permanentHours,
            seats: snapshot.seats,
            layout: snapshot.layout,
        });
        assert.strictEqual(res.status, 200, await res.text());

        const after = readTable(server);
        assert.strictEqual(after.info, "Edited at 19:00", "the edit the owner actually asked for must land");

        const hours = hoursOf(after);
        assert.strictEqual(hours[6] && hours[6].content, "Eva Malá", "booking made after the snapshot must survive");
        assert.strictEqual(hours[7] && hours[7].content, "Petr Dvořák", "booking made after the snapshot must survive");
        assert.strictEqual(hours[8] && hours[8].content, "Lucie Krátká", "booking made after the snapshot must survive");
        assert.strictEqual(hours[5] && hours[5].content, "Jan Novák", "and so must the one that was in the snapshot");
    });

    test("a snapshot cannot resurrect a booking that was cancelled since", async () => {
        // The mirror image, and the one a naive "merge instead of replace" fix
        // would get wrong: the grid the client holds still contains a booking
        // the guest has since cancelled.
        harness.seedRecord(server.dbPath, COL.timetables, TABLE_FILE_ID, tableRecord({ 5: booking("Jan Novák") }));
        const snapshot = readTable(server);

        const live = readTable(server);
        delete live.data[DATE][DAY_INDEX][5];
        harness.seedRecord(server.dbPath, COL.timetables, TABLE_FILE_ID, live);

        await authed(server, admin, `/timetables/${encodeURIComponent(TABLE_NAME)}`, "PUT", {
            data: snapshot.data,
            info: "Touched",
        });

        assert.ok(!hoursOf(readTable(server))[5], "a cancelled booking must stay cancelled");
    });

    test("cancel tokens survive an edit to the table itself", async () => {
        // Once guest self-cancellation shipped, the whole-grid PUT also wiped
        // cancelToken — so links already sent by SMS stopped working, with
        // nothing to explain it.
        harness.seedRecord(server.dbPath, COL.timetables, TABLE_FILE_ID, tableRecord({ 5: booking("Jan Novák") }));

        const res = await authed(server, admin, `/timetables/${encodeURIComponent(TABLE_NAME)}`, "PUT", {
            data: { [DATE]: [{ 5: { content: "Jan Novák", isPermanent: false } }] }, // no token in the client's copy
            info: "Renamed section",
        });
        assert.strictEqual(res.status, 200);

        const slot = hoursOf(readTable(server))[5];
        assert.strictEqual(slot.cancelToken, "aBcDeFgHiJkLmNoPqRsTuV", "the guest's cancel link must keep working");
        assert.strictEqual(slot.phone, "+420600111222", "and the reminder scanner's phone must survive");
    });

    test("the table's own fields still save normally", async () => {
        harness.seedRecord(server.dbPath, COL.timetables, TABLE_FILE_ID, tableRecord({ 5: booking("Jan Novák") }));

        const res = await authed(server, admin, `/timetables/${encodeURIComponent(TABLE_NAME)}`, "PUT", {
            info: "New description",
            attributes: ["u okna", "klidný kout"],
            seats: 6,
            layout: { room: "Zahrádka", x: 5, y: 5, w: 40, h: 40 },
        });
        assert.strictEqual(res.status, 200, await res.text());

        const after = readTable(server);
        assert.strictEqual(after.info, "New description");
        assert.deepStrictEqual(after.attributes, ["u okna", "klidný kout"]);
        assert.strictEqual(after.seats, 6);
        assert.strictEqual(after.layout.room, "Zahrádka");
        assert.strictEqual(hoursOf(after)[5].content, "Jan Novák", "and the booking is untouched");
    });
});

describe("single-booking edits", () => {
    let server, admin, waiter;

    before(async () => {
        server = await harness.start();
        seedUser(server.dbPath, ADMIN, { isAdmin: true });
        seedUser(server.dbPath, WAITER);
        admin = await sessionFor(server, ADMIN);
        waiter = await sessionFor(server, WAITER);
    });

    after(async () => { if (server) await server.stop(); });

    const reseed = (hours) => harness.seedRecord(server.dbPath, COL.timetables, TABLE_FILE_ID, tableRecord(hours));
    const rename = (body) => authed(server, admin, `/timetables/${encodeURIComponent(TABLE_NAME)}/bookings/rename`, "POST", body);
    const remove = (body) => authed(server, admin, `/timetables/${encodeURIComponent(TABLE_NAME)}/bookings`, "DELETE", body);

    test("renaming one booking leaves everything else on the slot alone", async () => {
        reseed({ 5: booking("Jan Novák", { order: [{ item: "Svíčková", qty: 1 }], orderTotal: 150, receiptId: "r1" }) });

        const res = await rename({ dateStr: DATE, dayIndex: DAY_INDEX, hour: 5, content: "Petra Svobodová" });
        assert.strictEqual(res.status, 200, await res.text());

        const slot = hoursOf(readTable(server))[5];
        assert.strictEqual(slot.content, "Petra Svobodová");
        assert.strictEqual(slot.abbreviation, "PS", "initials are recomputed, not left stale");
        assert.strictEqual(slot.phone, "+420600111222");
        assert.strictEqual(slot.cancelToken, "aBcDeFgHiJkLmNoPqRsTuV");
        assert.strictEqual(slot.orderTotal, 150);
        assert.strictEqual(slot.receiptId, "r1");
        assert.strictEqual(slot.guests, 2);
    });

    test("renaming one booking does not touch its neighbours", async () => {
        reseed({ 5: booking("Jan Novák"), 6: booking("Eva Malá") });
        assert.strictEqual((await rename({ dateStr: DATE, dayIndex: DAY_INDEX, hour: 5, content: "Nový Host" })).status, 200);

        const hours = hoursOf(readTable(server));
        assert.strictEqual(hours[5].content, "Nový Host");
        assert.strictEqual(hours[6].content, "Eva Malá", "the next hour is a different booking");
    });

    test("deleting one booking removes exactly that hour", async () => {
        reseed({ 5: booking("Jan Novák"), 6: booking("Eva Malá") });

        const res = await remove({ dateStr: DATE, dayIndex: DAY_INDEX, hour: 5 });
        assert.strictEqual(res.status, 200, await res.text());

        const hours = hoursOf(readTable(server));
        assert.ok(!hours[5], "the slot is gone, not blanked");
        assert.strictEqual(hours[6].content, "Eva Malá");
    });

    test("an address that matches nothing is a 404, and changes nothing", async () => {
        reseed({ 5: booking("Jan Novák") });

        const cases = [
            { dateStr: "2026-09-21", dayIndex: DAY_INDEX, hour: 5 }, // wrong date
            { dateStr: DATE, dayIndex: 3, hour: 5 },                  // wrong weekday
            { dateStr: DATE, dayIndex: DAY_INDEX, hour: 11 },         // empty hour
        ];
        for (const body of cases) {
            assert.strictEqual((await remove(body)).status, 404, `${JSON.stringify(body)} must 404`);
            assert.strictEqual((await rename({ ...body, content: "X" })).status, 404, `${JSON.stringify(body)} must 404`);
        }
        assert.strictEqual(hoursOf(readTable(server))[5].content, "Jan Novák", "nothing was touched");
    });

    test("an unknown table is a 404", async () => {
        assert.strictEqual((await authed(server, admin, `/timetables/${encodeURIComponent("Neexistuje")}/bookings`, "DELETE",
            { dateStr: DATE, dayIndex: DAY_INDEX, hour: 5 })).status, 404);
    });

    test("a blank rename is refused rather than treated as a delete", async () => {
        reseed({ 5: booking("Jan Novák") });
        assert.strictEqual((await rename({ dateStr: DATE, dayIndex: DAY_INDEX, hour: 5, content: "   " })).status, 400);
        assert.ok(hoursOf(readTable(server))[5], "the booking must still be there");
    });

    test("a malformed address is refused by the schema", async () => {
        reseed({ 5: booking("Jan Novák") });
        const bad = [
            { dateStr: "14.9.2026", dayIndex: 0, hour: 5 },
            { dateStr: DATE, dayIndex: 9, hour: 5 },
            { dateStr: DATE, dayIndex: 0, hour: 99 },
            { dateStr: DATE, dayIndex: 0 },
            { dayIndex: 0, hour: 5 },
            { dateStr: DATE, dayIndex: 0, hour: 5, extra: "x" },
        ];
        for (const body of bad) {
            assert.strictEqual((await remove(body)).status, 400, `${JSON.stringify(body)} must be a 400`);
        }
        assert.ok(hoursOf(readTable(server))[5], "and nothing was deleted");
    });

    test("a non-admin cannot edit bookings, and neither can an anonymous caller", async () => {
        reseed({ 5: booking("Jan Novák") });

        assert.strictEqual((await authed(server, waiter, `/timetables/${encodeURIComponent(TABLE_NAME)}/bookings`, "DELETE",
            { dateStr: DATE, dayIndex: DAY_INDEX, hour: 5 })).status, 403, "same level the whole-table PUT always required");

        const anon = await fetch(`${server.api}/timetables/${encodeURIComponent(TABLE_NAME)}/bookings`, {
            method: "DELETE",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ dateStr: DATE, dayIndex: DAY_INDEX, hour: 5 }),
        });
        assert.ok(anon.status === 401 || anon.status === 403, `expected a refusal, got ${anon.status}`);

        assert.ok(hoursOf(readTable(server))[5], "the booking survived both");
    });

    test("a valid session without the CSRF header is refused", async () => {
        reseed({ 5: booking("Jan Novák") });
        const res = await fetch(`${server.api}/timetables/${encodeURIComponent(TABLE_NAME)}/bookings`, {
            method: "DELETE",
            headers: { "content-type": "application/json", cookie: admin.cookie },
            body: JSON.stringify({ dateStr: DATE, dayIndex: DAY_INDEX, hour: 5 }),
        });
        assert.strictEqual(res.status, 403);
        assert.ok(hoursOf(readTable(server))[5]);
    });
});
