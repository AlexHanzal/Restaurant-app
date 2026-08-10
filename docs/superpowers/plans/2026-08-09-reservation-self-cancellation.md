# Guest Self-Cancellation Implementation Plan

> **STATUS: complete, 2026-08-10.** All seven tasks landed. Two deviations from
> the text below, both found while implementing:
>
> - **Task 4** proposed `req.query = result.data` in `validateQuery`. Express 5
>   defines `req.query` as a getter with no setter, so that assignment either
>   throws or silently no-ops — the shipped helper uses `Object.assign`, the
>   same in-place mutation `validateParams` already used.
> - **Task 6** used `__BASE_PATH__` in the page template. HTML pages are
>   rendered by `brand.renderTokens`, which substitutes `{{BASE}}`; only
>   `sw.js` uses the `__BASE_PATH__` form. The shipped page uses `{{BASE}}`.
>
> Task 7's browser pass also turned up a real bug the API tests could not see:
> `.ds-btn { display: inline-flex }` overrode the `hidden` attribute, so the
> confirm button was on screen before the booking had loaded and stayed there
> after cancelling. Fixed globally with `[hidden] { display: none !important }`
> in `design.css` — see the comment there; the same trap had already been
> patched twice per-component in `delivery-page.css`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a guest cancel their own reservation from a one-tap link in the confirmation SMS, freeing the table without a phone call.

**Architecture:** A 22-character opaque capability token (`cancelToken`) is written onto every hour-slot of a booking at booking time. Two public routes look a booking up by that token — one to summarise it, one to cancel it — with all refusal logic in a pure, dependency-free module (`reservation-cancel.js`) so it is unit-testable without a server. Cancelling deletes the slots, producing byte-for-byte the same end state as the admin's own "Smazat rezervaci".

**Tech Stack:** Node 26, Express, better-sqlite3, zod, `node:test`, `node:crypto`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-09-reservation-self-cancellation-design.md`

## Global Constraints

- Czech user-facing strings throughout; error text is the exact wording in spec §7.
- `cancelToken` is a SECRET. It must never appear in `sanitizeTimetableForPublic` output, the kitchen-board payload, the summary endpoint, or any log line.
- Unknown token and already-cancelled token return the SAME 410 response. Never distinguish them.
- Token comparison uses `crypto.timingSafeEqual`, guarded by a length check first (it throws on mismatched lengths).
- Both new routes are gated by `requireFeature("reservations")` and mounted BEFORE any other middleware, matching every other gated route in `server.js`.
- No CSRF on either route, consistent with the other public reservation/reorder routes.
- Tests: `npm run test:unit` and `npm run test:smoke` (glob form required — bare `node --test <dir>` fails on Node 26).
- Git: repo needs `git config windows.appendAtomically false` in this OneDrive folder or commits fail.
- Branch: `feat/reservations`.

## File Structure

| File | Responsibility |
| --- | --- |
| Create `src/server/reservation-cancel.js` | Token generation, booking lookup by token, and the pure `canCancel` decision. No db, no express. |
| Create `tests/unit/reservation-cancel.test.js` | Unit coverage for the above. |
| Create `src/html/zrusit.html` | The cancellation page shell. |
| Create `src/js/zrusit.js` | Page behaviour: read `?t=`, fetch summary, confirm, POST. |
| Modify `src/server/server.js` | Write `cancelToken` at booking time; add the two routes; add the page route; append the link to the confirmation SMS. |
| Modify `src/server/security.js` | Add `cancelIpLimiter` + its `RATE_LIMITS` entry. |
| Modify `src/server/validation.js` | Add `cancelTokenSchema` / query + body schemas. |
| Modify `tests/smoke/reservations.test.js` | End-to-end cancellation cases. |

---

### Task 1: The pure cancellation module

**Files:**
- Create: `src/server/reservation-cancel.js`
- Test: `tests/unit/reservation-cancel.test.js`

**Interfaces:**
- Consumes: nothing (dependency-free apart from `node:crypto`).
- Produces:
  - `newToken(): string` — 22-char base64url.
  - `tokensMatch(a: string, b: string): boolean` — timing-safe.
  - `findBooking(records: object[], token: string): Booking | null` where
    `Booking = { record, dateStr, dayIndex, hourKeys: number[], slots: object[] }`.
  - `canCancel(booking: Booking | null, now: Date): { ok: boolean, status: number, reason: string | null }`.
  - `START_HOUR_OFFSET: 7` — hourIndex 1-12 → 8:00-20:00.

- [x] **Step 1: Write the failing test**

Create `tests/unit/reservation-cancel.test.js`:

```js
// ============================================================================
// reservation-cancel.test.js — the pure half of guest self-cancellation.
// Spec: docs/superpowers/specs/2026-08-09-reservation-self-cancellation-design.md
// ============================================================================

const test = require("node:test");
const assert = require("node:assert");

const cancel = require("../../src/server/reservation-cancel");

const MON = "2026-08-10";           // a Monday, dayIndex 0
const NOW = new Date("2026-08-10T09:30:00");

function slot(extra = {}) {
    return { content: "Jan Novák", abbreviation: "JN", isPermanent: false, cancelToken: "tok", ...extra };
}

function record(hours, dateStr = MON, dayIndex = 0) {
    const data = {};
    data[dateStr] = [];
    data[dateStr][dayIndex] = hours;
    return { className: "Stůl 1", fileId: "t1", data };
}

// ── tokens ──────────────────────────────────────────────────────────────

test("newToken returns 22 base64url chars and does not repeat", () => {
    const a = cancel.newToken();
    assert.match(a, /^[A-Za-z0-9_-]{22}$/);
    assert.notStrictEqual(a, cancel.newToken());
});

test("tokensMatch is true only for an exact match", () => {
    assert.strictEqual(cancel.tokensMatch("abc", "abc"), true);
    assert.strictEqual(cancel.tokensMatch("abc", "abd"), false);
});

test("tokensMatch returns false rather than throwing on bad input", () => {
    // timingSafeEqual throws on different lengths — that must never reach a route.
    for (const [a, b] of [["abc", "abcd"], ["", "a"], [null, "a"], ["a", undefined], [123, "a"]]) {
        assert.strictEqual(cancel.tokensMatch(a, b), false, `${JSON.stringify([a, b])}`);
    }
});

// ── findBooking ─────────────────────────────────────────────────────────

test("findBooking locates every hour of a multi-hour booking", () => {
    const r = record({ 5: slot(), 6: slot(), 7: slot({ cancelToken: "other" }) });
    const found = cancel.findBooking([r], "tok");

    assert.ok(found);
    assert.strictEqual(found.dateStr, MON);
    assert.strictEqual(found.dayIndex, 0);
    assert.deepStrictEqual(found.hourKeys, [5, 6]);
    assert.strictEqual(found.slots.length, 2);
});

test("findBooking returns null for an unknown or empty token", () => {
    const r = record({ 5: slot() });
    assert.strictEqual(cancel.findBooking([r], "nope"), null);
    assert.strictEqual(cancel.findBooking([r], ""), null);
    assert.strictEqual(cancel.findBooking([r], null), null);
});

test("findBooking ignores slots with no cancelToken at all", () => {
    // Bookings made before this feature shipped.
    const r = record({ 5: { content: "Starý host", isPermanent: false } });
    assert.strictEqual(cancel.findBooking([r], "tok"), null);
});

// ── canCancel ───────────────────────────────────────────────────────────

test("an unpaid future booking can be cancelled", () => {
    const found = cancel.findBooking([record({ 5: slot() })], "tok");
    assert.deepStrictEqual(cancel.canCancel(found, NOW), { ok: true, status: 200, reason: null });
});

test("a missing booking is 410 with the not-found wording", () => {
    const r = cancel.canCancel(null, NOW);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.status, 410);
    assert.match(r.reason, /nebyla nalezena/i);
});

test("a paid preorder is 409 and says to phone", () => {
    const found = cancel.findBooking([record({ 5: slot({ order: [{}], isPaid: true }) })], "tok");
    const r = cancel.canCancel(found, NOW);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.status, 409);
    assert.match(r.reason, /telefonicky/i);
});

test("a paid hour anywhere in the booking blocks the whole booking", () => {
    const found = cancel.findBooking([record({ 5: slot(), 6: slot({ order: [{}], isPaid: true }) })], "tok");
    assert.strictEqual(cancel.canCancel(found, NOW).status, 409);
});

test("an unpaid preorder does not block cancellation", () => {
    const found = cancel.findBooking([record({ 5: slot({ order: [{}], isPaid: false }) })], "tok");
    assert.strictEqual(cancel.canCancel(found, NOW).ok, true);
});

test("a booking whose start has passed is 409", () => {
    // hourIndex 1 is the 8:00 slot; NOW is 09:30 the same day.
    const found = cancel.findBooking([record({ 1: slot() })], "tok");
    const r = cancel.canCancel(found, NOW);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.status, 409);
    assert.match(r.reason, /proběhla/i);
});

test("the earliest hour decides whether the booking has started", () => {
    // 8:00-10:00: started at 08:00, so already under way at 09:30.
    const found = cancel.findBooking([record({ 1: slot(), 2: slot() })], "tok");
    assert.strictEqual(cancel.canCancel(found, NOW).ok, false);
});

test("a booking on an earlier date is 409 even at a later hour", () => {
    const found = cancel.findBooking([record({ 12: slot() }, "2026-08-09", 6)], "tok");
    assert.strictEqual(cancel.canCancel(found, NOW).ok, false);
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `node --test "tests/unit/reservation-cancel.test.js"`
Expected: FAIL with `Cannot find module '../../src/server/reservation-cancel'`

- [x] **Step 3: Write minimal implementation**

Create `src/server/reservation-cancel.js`:

```js
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

// When does this booking start, as a local Date? null if the stored date is
// not a real one.
//
// CORRECTED after Task 1's review: splitting the string by hand produced
// `new Date(NaN, ...)` for a junk date key, and every comparison against an
// Invalid Date is false — so canCancel's "already started" check was silently
// skipped and it returned ok:true. It failed OPEN. timetable.parseDateStr
// does the validated parse (including the round-trip check that catches
// "2026-02-29", which JS rolls over to March 1) and is itself
// dependency-free, so reusing it costs this module nothing.
function bookingStart(booking) {
    const date = timetable.parseDateStr(booking.dateStr);
    if (!date) return null;
    date.setHours(booking.hourKeys[0] + START_HOUR_OFFSET, 0, 0, 0);
    return date;
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
```

- [x] **Step 4: Run test to verify it passes**

Run: `node --test "tests/unit/reservation-cancel.test.js"`
Expected: PASS, all tests, no warnings.

- [x] **Step 5: Commit**

```bash
git add src/server/reservation-cancel.js tests/unit/reservation-cancel.test.js
git commit -m "feat(reservations): add the pure cancellation module"
```

---

### Task 2: Issue a cancelToken when a booking is written

**Files:**
- Modify: `src/server/server.js` — `applyBookingToTimetable`, the slot literal
- Test: `tests/smoke/reservations.test.js`

**Interfaces:**
- Consumes: `reservation-cancel.newToken()` from Task 1.
- Produces: every slot written by `applyBookingToTimetable` carries a `cancelToken`, and all hours of one booking share the SAME value. `applyBookingToTimetable` returns `{ ok: true, cancelToken }` so the SMS step in Task 5 can use it.

- [x] **Step 1: Write the failing test**

Add to `tests/smoke/reservations.test.js`, inside the `describe("reservation booking flow")` block:

```js
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
```

- [x] **Step 2: Run test to verify it fails**

Run: `node --test "tests/smoke/reservations.test.js"`
Expected: FAIL — "every hour of a booking carries one shared cancel token" fails because `day[3].cancelToken` is `undefined`.

- [x] **Step 3: Write minimal implementation**

In `src/server/server.js`, add the require next to the other server modules (near `const timetable = require("./timetable");`):

```js
const reservationCancel = require("./reservation-cancel"); // guest self-cancellation: token + refusal policy — see reservation-cancel.js
```

In `applyBookingToTimetable`, mint one token for the whole booking, immediately before the `for` loop that writes the slots:

```js
        // Guest self-cancellation: ONE token for the whole booking, written
        // onto every hour, so cancelling is "delete every slot with this
        // token" rather than arithmetic over startHour/duration. Secret —
        // see reservation-cancel.js's header.
        const cancelToken = reservationCancel.newToken();
```

Add it to the slot literal, right after the `phone` spread:

```js
                ...(phone ? { phone } : {}),
                cancelToken,
```

Change the success return so the caller can put the token in the SMS:

```js
        return { ok: true, cancelToken };
```

- [x] **Step 4: Run test to verify it passes**

Run: `node --test "tests/smoke/reservations.test.js"`
Expected: PASS, all tests including the two new ones.

- [x] **Step 5: Commit**

```bash
git add src/server/server.js tests/smoke/reservations.test.js
git commit -m "feat(reservations): issue a cancel token with every booking"
```

---

### Task 3: Rate limiter and validation schemas

**Files:**
- Modify: `src/server/security.js` — `RATE_LIMITS` and a new limiter
- Modify: `src/server/validation.js` — two schemas
- Test: `tests/unit/reservation-cancel-schema.test.js` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `security.cancelIpLimiter` (express middleware); `V.cancelQuerySchema` (validates `{ t }`), `V.cancelBodySchema` (validates `{ token }`).

- [x] **Step 1: Write the failing test**

Create `tests/unit/reservation-cancel-schema.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert");

const V = require("../../src/server/validation");

test("cancel schemas accept a real token and reject junk", () => {
    const good = "aBcDeFgHiJkLmNoPqRsTuV";
    assert.strictEqual(V.cancelQuerySchema.safeParse({ t: good }).success, true);
    assert.strictEqual(V.cancelBodySchema.safeParse({ token: good }).success, true);

    for (const bad of [{}, { t: "" }, { t: "short" }, { t: "a".repeat(200) }, { t: "has spaces here!!!!!!" }]) {
        assert.strictEqual(V.cancelQuerySchema.safeParse(bad).success, false, JSON.stringify(bad));
    }
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `node --test "tests/unit/reservation-cancel-schema.test.js"`
Expected: FAIL — `Cannot read properties of undefined (reading 'safeParse')`.

- [x] **Step 3: Write minimal implementation**

In `src/server/validation.js`, near the other reservation schemas:

```js
// Guest self-cancellation (spec 2026-08-09). The token is 16 random bytes as
// base64url — exactly 22 chars from that alphabet, nothing else. Pinning the
// shape here means a malformed query never reaches the timetable scan.
const cancelTokenField = z
    .string({ error: "Chybí odkaz na rezervaci" })
    .trim()
    .regex(/^[A-Za-z0-9_-]{22}$/, "Neplatný odkaz na rezervaci");

const cancelQuerySchema = z.object({ t: cancelTokenField }).strict();
const cancelBodySchema = z.object({ token: cancelTokenField }).strict();
```

Add both to `module.exports`:

```js
    cancelQuerySchema,
    cancelBodySchema,
```

In `src/server/security.js`, add to `RATE_LIMITS`:

```js
    cancelIp: 60,
```

and the limiter next to `tableOrderIpLimiter`:

```js
// Guest self-cancellation. The token is unguessable, so this is not about
// brute force — it bounds the timetable SCAN each lookup costs, the same
// concern that put a limiter in front of resolveTableToken. Sized so a guest
// reloading their cancellation page is never inconvenienced.
const cancelIpLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: RATE_LIMITS.cancelIp,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Příliš mnoho požadavků. Zkuste to prosím za chvíli." },
});
```

Add `cancelIpLimiter` to `module.exports`.

- [x] **Step 4: Run test to verify it passes**

Run: `node --test "tests/unit/reservation-cancel-schema.test.js" && npm run test:smoke`
Expected: PASS. `tests/smoke/api-rate-limit.test.js` asserts limiter ORDERING off `RATE_LIMITS` — if it fails, the new value sits in the wrong place relative to its neighbours; read that test's assertion and place `cancelIp` accordingly.

- [x] **Step 5: Commit**

```bash
git add src/server/security.js src/server/validation.js tests/unit/reservation-cancel-schema.test.js
git commit -m "feat(reservations): rate limiter and schemas for cancellation"
```

---

### Task 4: The two API routes

**Files:**
- Modify: `src/server/server.js` — after `POST /reservations/verify-and-book`
- Test: `tests/smoke/reservations.test.js`

**Interfaces:**
- Consumes: `reservationCancel.findBooking/canCancel` (Task 1), `cancelToken` on slots (Task 2), `security.cancelIpLimiter` + `V.cancelQuerySchema`/`V.cancelBodySchema` (Task 3).
- Produces: `GET /api/reservations/cancellation?t=` and `POST /api/reservations/cancel`.

- [x] **Step 1: Write the failing test**

Add to `tests/smoke/reservations.test.js`. Add this helper next to the other flow helpers:

```js
// Books, then digs the booking's cancel token straight out of the DB — the
// SMS link is asserted separately in Task 5.
async function bookAndGetToken(server, body = {}) {
    const out = await book(server, body);
    assert.strictEqual(out.res.status, 200, `booking failed: ${JSON.stringify(out.body)}`);

    const record = harness.readRecord(server.dbPath, COL.timetables, TABLE_FILE_ID);
    const dateStr = body.dateStr || TOMORROW;
    const hour = body.startHour || 5;
    return record.data[dateStr][dayIndexOf(dateStr)][hour].cancelToken;
}
```

and this suite after the existing `describe` block:

```js
describe("reservation self-cancellation", () => {
    let server;

    before(async () => {
        server = await harness.start();
        seedSettings(server.dbPath);
        harness.seedRecord(server.dbPath, COL.timetables, TABLE_FILE_ID, tableRecord());
    });

    after(async () => { if (server) await server.stop(); });

    test("summary describes the booking without leaking who made it", async () => {
        const token = await bookAndGetToken(server, { startHour: 5, guestName: "Jan Novák" });

        const res = await fetch(`${server.api}/reservations/cancellation?t=${token}`);
        assert.strictEqual(res.status, 200);
        const body = await res.json();

        assert.strictEqual(body.tableName, TABLE_NAME);
        assert.strictEqual(body.dateStr, TOMORROW);
        assert.strictEqual(body.startHour, 5);
        assert.strictEqual(body.cancellable, true);

        const raw = JSON.stringify(body);
        assert.ok(!raw.includes("Jan Novák"), "no guest name");
        assert.ok(!raw.includes("+420"), "no phone");
        assert.ok(!raw.includes("cancelToken"), "never echo the token back");
    });

    test("cancelling frees the slot and is not repeatable", async () => {
        const token = await bookAndGetToken(server, { startHour: 6, guestName: "Eva Malá" });

        const first = await post(server, "/reservations/cancel", { token });
        assert.strictEqual(first.status, 200);

        const record = harness.readRecord(server.dbPath, COL.timetables, TABLE_FILE_ID);
        assert.ok(!record.data[TOMORROW][dayIndexOf(TOMORROW)][6], "slot must be gone");

        const second = await post(server, "/reservations/cancel", { token });
        assert.strictEqual(second.status, 410);
        const body = await second.json();
        assert.match(body.error, /nebyla nalezena/i);
    });

    test("a freed slot can be booked again", async () => {
        const token = await bookAndGetToken(server, { startHour: 7, guestName: "Petr Dvořák" });
        assert.strictEqual((await post(server, "/reservations/cancel", { token })).status, 200);

        const rebook = await book(server, { startHour: 7, guestName: "Tomáš Sedlák" });
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

    test("an unknown token answers exactly like an already-cancelled one", async () => {
        const res = await post(server, "/reservations/cancel", { token: "aBcDeFgHiJkLmNoPqRsTuV" });
        assert.strictEqual(res.status, 410);
        assert.match((await res.json()).error, /nebyla nalezena/i);
    });

    test("a malformed token is rejected without scanning", async () => {
        const res = await post(server, "/reservations/cancel", { token: "nope" });
        assert.strictEqual(res.status, 400);
    });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `node --test "tests/smoke/reservations.test.js"`
Expected: FAIL — the summary request 404s because the route does not exist.

- [x] **Step 3: Write minimal implementation**

In `src/server/server.js`, immediately after the `POST /reservations/verify-and-book` handler:

```js
    // ── GUEST SELF-CANCELLATION (spec 2026-08-09) ────────────────────────
    // Both routes are public and carry no session: the 22-char token in the
    // request IS the credential, so there is no confused-deputy risk for
    // CSRF to protect against — same reasoning as the reorder routes below.
    // cancelIpLimiter is not about guessing the token (128 bits); it bounds
    // the timetable scan each lookup costs.

    // GET — what the confirmation page shows before the guest commits.
    // Returns the minimum needed to recognise the booking: NO name, phone,
    // party size, order contents or receiptId. The link travels by SMS and
    // may be forwarded or screenshotted.
    app.get(`${api}/reservations/cancellation`, requireFeature("reservations"), security.cancelIpLimiter, V.validateQuery(V.cancelQuerySchema), (req, res) => {
        const booking = reservationCancel.findBooking(db.list(COL.timetables), req.query.t);
        const verdict = reservationCancel.canCancel(booking, new Date());

        if (!booking) return res.status(verdict.status).json({ error: verdict.reason });

        res.json({
            tableName: booking.record.className,
            dateStr: booking.dateStr,
            startHour: booking.hourKeys[0],
            endHour: booking.hourKeys[booking.hourKeys.length - 1],
            hasOrder: booking.slots.some(s => Array.isArray(s.order) && s.order.length > 0),
            isPaid: booking.slots.some(s => s.isPaid),
            cancellable: verdict.ok,
            reason: verdict.reason,
        });
    });

    // POST — perform it. Deletes exactly the slots carrying the token,
    // leaving the record in the same state the admin's own "Smazat
    // rezervaci" produces.
    app.post(`${api}/reservations/cancel`, requireFeature("reservations"), security.cancelIpLimiter, V.validate(V.cancelBodySchema), (req, res) => {
        const booking = reservationCancel.findBooking(db.list(COL.timetables), req.body.token);
        const verdict = reservationCancel.canCancel(booking, new Date());
        if (!verdict.ok) return res.status(verdict.status).json({ error: verdict.reason });

        const hours = booking.record.data[booking.dateStr][booking.dayIndex];
        const hadOrder = booking.slots.some(s => Array.isArray(s.order) && s.order.length > 0);
        for (const hourKey of booking.hourKeys) delete hours[hourKey];

        db.set(COL.timetables, booking.record.fileId, booking.record);

        // Mirrors applyBookingToTimetable's own broadcast on the way in —
        // without this the kitchen board keeps showing a ticket for a
        // booking that no longer exists.
        if (hadOrder) broadcastBoardEvent();

        res.json({ success: true });
    });
```

`validateQuery` does **not** exist yet — `validation.js` has only `validate` (body) and `validateParams` (params). Add it next to `validateParams`, matching their exact shape, including `firstIssueMessage`'s two-argument signature:

```js
// Same contract as validate()/validateParams(), for req.query.
function validateQuery(schema) {
    return (req, res, next) => {
        const result = schema.safeParse(req.query);
        if (!result.success) {
            return res.status(400).json({ error: firstIssueMessage(result.error, "Neplatný parametr požadavku") });
        }
        req.query = result.data;
        next();
    };
}
```

and add `validateQuery` to `module.exports`.

- [x] **Step 4: Run test to verify it passes**

Run: `node --test "tests/smoke/reservations.test.js"`
Expected: PASS, all tests in both suites.

- [x] **Step 5: Commit**

```bash
git add src/server/server.js src/server/validation.js tests/smoke/reservations.test.js
git commit -m "feat(reservations): summary and cancel routes"
```

---

### Task 5: Put the link in the confirmation SMS

**Files:**
- Modify: `src/server/server.js` — the `smsReservationConfirmed` block in `verify-and-book`
- Test: `tests/smoke/reservations.test.js`

**Interfaces:**
- Consumes: `cancelToken` from `applyBookingToTimetable`'s return value (Task 2), the page route from Task 6 (URL shape only — the SMS is just a string, so this task does not depend on the page existing).
- Produces: nothing later tasks consume.

- [x] **Step 1: Write the failing test**

Add to the `describe("reservation self-cancellation")` suite:

```js
test("the confirmation SMS carries a working cancel link", async () => {
    // This one needs the confirmation SMS on, unlike the rest of the suite.
    seedSettings(server.dbPath, {}, { smsReservationConfirmed: true });

    const { phone } = await sendCode(server, { startHour: 9, guestName: "Karel Ryba" });
    await new Promise(r => setTimeout(r, 50));
    await post(server, "/reservations/verify-and-book", { phone, code: readCode(server, phone) });
    await new Promise(r => setTimeout(r, 50));

    const confirmation = server.logs().split("\n").filter(l => l.includes(phone) && l.includes("Zrušit"));
    assert.ok(confirmation.length > 0, "confirmation SMS must contain a cancel link");

    const match = /zrusit\?t=([A-Za-z0-9_-]{22})/.exec(confirmation[confirmation.length - 1]);
    assert.ok(match, `no cancel link in: ${confirmation[confirmation.length - 1]}`);

    // The link in the SMS must actually work.
    const res = await fetch(`${server.api}/reservations/cancellation?t=${match[1]}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await res.json()).startHour, 9);

    seedSettings(server.dbPath); // restore
});
```

Extend `seedSettings` to take notification overrides:

```js
function seedSettings(dbPath, resvOverrides = {}, notifOverrides = {}) {
    harness.seedRecord(dbPath, COL.settings, harness.SETTINGS_ID, {
        reservations: { paused: false, maxDaysAhead: 14, days: reservationDays(), ...resvOverrides },
        notifications: {
            smsOrderConfirmed: false,
            smsOrderOnTheWay: false,
            smsReservationConfirmed: false,
            smsReservationReminder: false,
            emailEnabled: false,
            ...notifOverrides,
        },
    });
}
```

- [x] **Step 2: Run test to verify it fails**

Run: `node --test "tests/smoke/reservations.test.js"`
Expected: FAIL — "confirmation SMS must contain a cancel link".

- [x] **Step 3: Write minimal implementation**

In `verify-and-book`, capture the token from the booking result:

```js
            const result = await applyBookingToTimetable(pending.payload);
            if (!result.ok) return res.status(409).json({ error: result.error });
```

then extend the confirmation SMS block:

```js
            if (notifSettings.notifications.smsReservationConfirmed) {
                const { tableName, dateStr: bookedDateStr, startHour: bookedStartHour } = pending.payload;
                const [y, m, d] = bookedDateStr.split("-");
                const dateLabel = `${Number(d)}.${Number(m)}.${y}`;
                const timeLabel = `${Number(bookedStartHour) + 7}:00`;

                // Self-cancellation link (spec 2026-08-09 §10). Absolute URL
                // built from the request origin, the same way
                // gatewayCallbackUrls() derives GoPay's return URL.
                //
                // COST: this takes the message from one SMS segment to two.
                // The text is Czech, so it is UCS-2 encoded at 70 characters
                // per segment, not 160. That is a deliberate, accepted
                // trade: a freed table is worth more than a segment.
                const origin = `${req.protocol}://${req.get("host")}`;
                const cancelUrl = `${origin}${SERVER_CONFIG.basePath}/zrusit?t=${result.cancelToken}`;

                notify
                    .sendSms(cleanPhone, `Rezervace potvrzena: stůl ${tableName}, ${dateLabel} v ${timeLabel}. Zrušit: ${cancelUrl}`)
                    .catch(e => console.error("Reservation-confirmed SMS crashed unexpectedly:", e));
            }
```

- [x] **Step 4: Run test to verify it passes**

Run: `node --test "tests/smoke/reservations.test.js"`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/server/server.js tests/smoke/reservations.test.js
git commit -m "feat(reservations): put the cancel link in the confirmation SMS"
```

---

### Task 6: The cancellation page

**Files:**
- Create: `src/html/zrusit.html`
- Create: `src/js/zrusit.js`
- Modify: `src/server/server.js` — page route + static asset list
- Test: `tests/smoke/reservations.test.js`

**Interfaces:**
- Consumes: the two routes from Task 4.
- Produces: `GET /reservation/zrusit`.

- [x] **Step 1: Write the failing test**

Add to the `describe("reservation self-cancellation")` suite:

```js
test("the cancellation page is served", async () => {
    const res = await fetch(`${server.baseUrl}/reservation/zrusit?t=aBcDeFgHiJkLmNoPqRsTuV`);
    assert.strictEqual(res.status, 200);
    const html = await res.text();
    assert.match(html, /zrusit\.js/, "page must load its script");
    assert.ok(!html.includes("aBcDeFgHiJkLmNoPqRsTuV"), "the token must not be echoed into the HTML");
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `node --test "tests/smoke/reservations.test.js"`
Expected: FAIL — 404.

- [x] **Step 3: Write minimal implementation**

Create `src/html/zrusit.html`:

```html
<!DOCTYPE html>
<html lang="cs">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="robots" content="noindex, nofollow">
    <title>Zrušit rezervaci</title>
    <link rel="stylesheet" href="__BASE_PATH__/css/design.css">
    <link rel="stylesheet" href="__BASE_PATH__/css/reservation.css">
</head>
<body>
    <main class="rsv-cancel" id="cancelRoot">
        <h1 class="rsv-cancel__title">Zrušit rezervaci</h1>
        <p class="rsv-cancel__status" id="cancelStatus">Načítám rezervaci…</p>

        <dl class="rsv-cancel__summary" id="cancelSummary" hidden>
            <dt>Stůl</dt><dd id="cancelTable"></dd>
            <dt>Datum</dt><dd id="cancelDate"></dd>
            <dt>Čas</dt><dd id="cancelTime"></dd>
        </dl>

        <button type="button" class="ds-btn ds-btn--danger" id="cancelConfirmBtn" hidden>
            Zrušit rezervaci
        </button>
    </main>

    <script src="__BASE_PATH__/config.js"></script>
    <script src="__BASE_PATH__/js/zrusit.js"></script>
</body>
</html>
```

Create `src/js/zrusit.js`:

```js
// ============================================================================
// zrusit.js — the guest-facing cancellation page.
//
// Spec: docs/superpowers/specs/2026-08-09-reservation-self-cancellation-design.md
//
// Shows a summary and waits for a click rather than cancelling on load: SMS
// clients, link scanners and chat previews fetch URLs unbidden, and a GET
// that destroyed a booking would let a link preview delete someone's table.
// ============================================================================

(function () {
    const API_URL = window.API_BASE_URL + '/api';
    const token = new URLSearchParams(window.location.search).get('t') || '';

    const statusEl = document.getElementById('cancelStatus');
    const summaryEl = document.getElementById('cancelSummary');
    const confirmBtn = document.getElementById('cancelConfirmBtn');

    function say(text) { statusEl.textContent = text; }

    function formatDate(dateStr) {
        const [y, m, d] = dateStr.split('-');
        return `${Number(d)}.${Number(m)}.${y}`;
    }

    // hourIndex 1-12 -> 8:00-20:00, the RESERVATION_HOURS convention.
    function formatHours(startHour, endHour) {
        return `${startHour + 7}:00 – ${endHour + 8}:00`;
    }

    async function load() {
        if (!token) { say('Odkaz je neplatný.'); return; }

        try {
            const res = await fetch(`${API_URL}/reservations/cancellation?t=${encodeURIComponent(token)}`);
            const body = await res.json();

            if (!res.ok) { say(body.error || 'Rezervaci se nepodařilo načíst.'); return; }

            document.getElementById('cancelTable').textContent = body.tableName;
            document.getElementById('cancelDate').textContent = formatDate(body.dateStr);
            document.getElementById('cancelTime').textContent = formatHours(body.startHour, body.endHour);
            summaryEl.hidden = false;

            if (body.cancellable) {
                say('Opravdu chcete tuto rezervaci zrušit?');
                confirmBtn.hidden = false;
            } else {
                say(body.reason || 'Tuto rezervaci už nelze zrušit.');
            }
        } catch (e) {
            say('Nepodařilo se spojit se serverem.');
        }
    }

    async function confirm() {
        confirmBtn.disabled = true;
        say('Ruším rezervaci…');

        try {
            const res = await fetch(`${API_URL}/reservations/cancel`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token }),
            });
            const body = await res.json();

            if (!res.ok) {
                say(body.error || 'Rezervaci se nepodařilo zrušit.');
                confirmBtn.disabled = false;
                return;
            }

            summaryEl.hidden = true;
            confirmBtn.hidden = true;
            say('Rezervace byla zrušena. Děkujeme, že jste nám dali vědět.');
        } catch (e) {
            say('Nepodařilo se spojit se serverem.');
            confirmBtn.disabled = false;
        }
    }

    confirmBtn.addEventListener('click', confirm);
    load();
})();
```

In `src/server/server.js`, next to the other page routes:

```js
        if (brand.isEnabled("reservations")) app.get(`${base}/zrusit`, makePageRoute("zrusit.html"));
```

No extra wiring is needed for `zrusit.js`: `express.static` serves the whole frontend directory, so `src/js/zrusit.js` is reachable at `/reservation/js/zrusit.js` the moment the file exists — same as every other page script. `ds-btn--danger` already exists in `design.css`, so the button needs no new CSS.

- [x] **Step 4: Run test to verify it passes**

Run: `node --test "tests/smoke/reservations.test.js"`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/html/zrusit.html src/js/zrusit.js src/server/server.js tests/smoke/reservations.test.js
git commit -m "feat(reservations): the guest cancellation page"
```

---

### Task 7: Mutation-check, full suite, and a real browser pass

**Files:** none created; this task verifies the previous six.

- [x] **Step 1: Confirm each refusal rule is load-bearing**

For each of the three rules below, break it, run the smoke suite, confirm ONLY the expected test fails, then restore.

| Break | In | Test that must fail |
| --- | --- | --- |
| Remove the `isPaid` check from `canCancel` | `reservation-cancel.js` | "a paid preorder is refused and the booking survives" |
| Make `canCancel` return `ok: true` for a null booking | `reservation-cancel.js` | "cancelling frees the slot and is not repeatable" |
| Delete the `broadcastBoardEvent()` call | `server.js` cancel route | (none — note this as a known coverage gap) |

```bash
node --test "tests/smoke/reservations.test.js"
```

- [x] **Step 2: Run the full suite**

```bash
npm run test:unit && npm run test:smoke
```
Expected: all pass, zero failures.

- [x] **Step 3: Drive the page in a real browser**

Start a throwaway instance on port 4399 against a temp `SQLITE_PATH`, book a reservation through the API, read the cancel link out of the log, open it, confirm the summary renders and the button cancels. Verify the slot is gone from the DB afterwards.

Remember: the service worker caches aggressively — unregister it and clear caches if the page looks stale.

- [x] **Step 4: Commit any fixes**

```bash
git add -A
git commit -m "test(reservations): verify cancellation rules are load-bearing"
```
