# Security Fixes (F1–F6) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the six findings from `docs/2026-07-29-security-audit-vibecode-checklist.md` — an unauthenticated revenue endpoint, over-broad driver permissions, publicly served backend source, an unvalidated payment return URL, an uncapped SMS spend surface, and a `.gitignore` that doesn't exclude the customer database.

**Architecture:** Two pieces of genuinely new logic (return-URL validation, SMS daily cap) go into their own **zero-dependency** modules, matching this codebase's existing "self-contained black box" convention (`settings.js`, `csrf.js`, `validation.js`, `reorder.js` all follow it). This is not just style: it is the only way these get real automated tests in this environment (see Global Constraints). Everything else is a middleware or route-guard edit in `server.js` / `auth.js`.

**Tech Stack:** Node 22, Express 5, `node --test` (built-in runner), no new npm dependencies.

## Global Constraints

- **No new npm dependencies.** `npm install` cannot run here (see below); anything requiring a new package is out of scope.
- **The app cannot be booted and the existing test suite cannot be run.** `node_modules` in this OneDrive folder is mostly cloud-only placeholder files. Verified: `cors` and `better-sqlite3` load; `express`, `zod`, `helmet`, `cookie-parser`, `jsonwebtoken`, `bcryptjs`, `express-rate-limit`, `compression`, `esbuild` all fail with `UNKNOWN: unknown error, read`. `tests/` is likewise unreadable (`Permission denied`). Do **not** attempt `npm start`, `npm test`, or `npm install`.
- **Therefore, two verification tiers.** New zero-dependency modules get real `node --test` unit tests that must pass. Edits to `server.js` / `auth.js` get `node --check` (syntax) plus careful review. Never claim a `server.js` change is "tested" — it is not.
- **Verified working commands:** `node --check <file>` and `node --test <file>`.
- **All user-facing error strings must be Czech**, matching the existing style in `server.js` (e.g. `"Vyžadována administrátorská oprávnění"`).
- **Preserve the codebase's comment convention.** Every security decision in this repo carries a `// SECURITY:` comment explaining the threat model. Match that — a bare guard with no explanation will read as arbitrary to the next maintainer and is liable to be deleted.
- **Do not reformat, re-wrap, or "tidy" surrounding code.** Edits must be surgical.
- **Working directory** for all commands: `code/Landing-app-1-main`.

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/server/urlsafe.js` | **Create** | Zero-dep. Same-origin validation for client-supplied redirect URLs (F4). |
| `src/server/smscap.js` | **Create** | Zero-dep. Global daily SMS send counter with midnight rollover (F5). |
| `tests/unit/urlsafe.test.js` | **Create** | Unit tests for `urlsafe.js`. |
| `tests/unit/smscap.test.js` | **Create** | Unit tests for `smscap.js`. |
| `src/server/auth.js` | Modify | Add `requireStaff` middleware (F2). |
| `src/server/server.js` | Modify | Route guards (F1, F2), static-mount block (F3), wire in both new modules (F4, F5). |
| `.gitignore` | Modify | Exclude the database, `node_modules`, and env files (F6). |

**Ordering:** Task 1 and Task 2 create the new modules and must land before Task 5 (which requires them). Tasks 3, 4, 6, 7 are independent of each other.

**Scoping note — read before starting Task 4.** F2 deliberately does **not** touch `GET /api/orders`. The driver page (`src/js/driver.js`) depends on it to show delivery addresses, so drivers legitimately need it. Only `GET /api/users` (staff-account enumeration) and the two DELETE routes are narrowed. Do not "helpfully" add guards to routes not named in this plan — several public routes are public by design and documented as such in their own comments.

---

### Task 1: `urlsafe.js` — same-origin return-URL validation (F4)

**Files:**
- Create: `src/server/urlsafe.js`
- Test: `tests/unit/urlsafe.test.js`

**Interfaces:**
- Consumes: nothing (zero dependencies — Node's global `URL` only).
- Produces: `safeReturnUrl(ownOrigin: string, candidate: unknown) => string | null`. Returns `candidate` unchanged when it resolves to exactly `ownOrigin`; returns `null` for anything else (missing, foreign origin, malformed, non-string, or a non-http(s) scheme). Task 5 consumes this.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/urlsafe.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert");
const { safeReturnUrl } = require("../../src/server/urlsafe");

const OWN = "https://restaurace.example";

test("accepts an absolute URL on the same origin", () => {
    assert.equal(safeReturnUrl(OWN, `${OWN}/reservation/delivery`), `${OWN}/reservation/delivery`);
});

test("accepts a relative path (resolves onto own origin)", () => {
    assert.equal(safeReturnUrl(OWN, "/reservation/app"), "/reservation/app");
});

test("rejects a foreign origin", () => {
    assert.equal(safeReturnUrl(OWN, "https://evil.example/platba"), null);
});

test("rejects a protocol-relative URL pointing off-origin", () => {
    // "//evil.example/x" resolves against the base's scheme -> https://evil.example/x
    assert.equal(safeReturnUrl(OWN, "//evil.example/x"), null);
});

test("rejects the javascript: scheme", () => {
    assert.equal(safeReturnUrl(OWN, "javascript:alert(1)"), null);
});

test("rejects a same-host URL on a different port", () => {
    assert.equal(safeReturnUrl(OWN, "https://restaurace.example:8443/x"), null);
});

test("rejects a same-host URL over plain http when own origin is https", () => {
    assert.equal(safeReturnUrl(OWN, "http://restaurace.example/x"), null);
});

test("rejects a host that merely starts with the own host", () => {
    assert.equal(safeReturnUrl(OWN, "https://restaurace.example.evil.test/x"), null);
});

test("returns null for missing / empty / non-string input", () => {
    assert.equal(safeReturnUrl(OWN, undefined), null);
    assert.equal(safeReturnUrl(OWN, null), null);
    assert.equal(safeReturnUrl(OWN, ""), null);
    assert.equal(safeReturnUrl(OWN, 42), null);
    assert.equal(safeReturnUrl(OWN, { toString: () => `${OWN}/x` }), null);
});

test("returns null when own origin is itself missing or unparseable", () => {
    assert.equal(safeReturnUrl("", `${OWN}/x`), null);
    assert.equal(safeReturnUrl("not a url", `${OWN}/x`), null);
});

test("does not throw on malformed candidates", () => {
    assert.equal(safeReturnUrl(OWN, "http://["), null);       // invalid IPv6 host
    assert.equal(safeReturnUrl(OWN, "https://exa mple.com"), null); // space in host
    assert.equal(safeReturnUrl(OWN, "http://"), null);        // no host at all
});

// Documents a deliberate behaviour that is easy to mistake for a bug: "%%%"
// LOOKS malformed but is a perfectly legal relative path to the WHATWG URL
// parser (a percent sign not followed by valid hex is kept literally, not
// rejected). It therefore resolves onto our own origin and is accepted, via
// exactly the same code path as the ordinary "/reservation/app" case above.
// That is correct — a relative path cannot navigate the user off-origin,
// which is the only thing this function exists to prevent.
test("accepts an odd but valid relative path", () => {
    assert.equal(safeReturnUrl(OWN, "%%%"), "%%%");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/unit/urlsafe.test.js`
Expected: FAIL — `Cannot find module '../../src/server/urlsafe'`

- [ ] **Step 3: Write the implementation**

Create `src/server/urlsafe.js`:

```js
// ============================================================================
// urlsafe.js — same-origin validation for client-supplied redirect URLs.
//
// Zero dependencies (Node's global URL only), same self-contained "black box"
// module pattern as settings.js/csrf.js/validation.js/reorder.js.
//
// Why this exists (audit 2026-07-29, finding F4):
//   Three payment routes accept a `returnUrl` from the request body and hand
//   it to GoPay as the post-payment redirect target:
//     POST ${api}/orders
//     POST ${api}/kitchen/reservation/pay-online
//     POST ${api}/indoor-orders/:id/pay-online
//   validation.js only bounds its LENGTH (z.string().max(500)), so any
//   absolute URL was accepted verbatim.
//
//   The attack that makes this worth fixing: an attacker creates a real,
//   payable order with returnUrl pointing at a site they control, receives a
//   genuine gate.gopay.cz redirect URL in the response, and shares THAT link.
//   The victim sees a real payment page on a real GoPay domain, pays, and is
//   then handed to the attacker's page — which can convincingly present
//   "platba selhala, zadejte kartu znovu". The app's own CSP form-action
//   directive cannot help: the redirect is issued by GoPay, not by us.
//
//   The fix is an allow-list of exactly one origin: our own. A legitimate
//   returnUrl only ever points back at this app (the delivery page sending
//   GoPay back to itself so it can resume polling), so nothing legitimate is
//   lost. Rejected values fall back to the server-side default in
//   gatewayCallbackUrls() rather than erroring the request — a hand-crafted
//   returnUrl is not worth failing a real customer's payment over, and the
//   default is always safe.
// ============================================================================

// Returns `candidate` unchanged when it resolves to exactly `ownOrigin`,
// otherwise null. Never throws.
//
// Uses URL resolution rather than string prefix matching, deliberately:
//   - a prefix check on "https://restaurace.example" also accepts
//     "https://restaurace.example.evil.test" (covered by a test)
//   - "//evil.example/x" is a valid protocol-relative URL that a naive
//     "doesn't start with http" check waves through (also covered)
// Comparing parsed .origin values collapses scheme, host AND port into one
// comparison, so a downgraded scheme or a different port is caught too.
function safeReturnUrl(ownOrigin, candidate) {
    if (typeof candidate !== "string" || !candidate) return null;
    if (typeof ownOrigin !== "string" || !ownOrigin) return null;

    let base;
    try {
        base = new URL(ownOrigin);
    } catch {
        return null; // caller gave us a nonsense origin — fail closed
    }

    let resolved;
    try {
        resolved = new URL(candidate, base);
    } catch {
        return null; // malformed candidate
    }

    // Non-http(s) schemes (javascript:, data:, file:) parse to an opaque
    // origin — the string "null" — which can never equal base.origin. The
    // explicit protocol check below is belt-and-braces so this stays correct
    // even if a future scheme were to expose a matching origin.
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return null;
    if (resolved.origin !== base.origin) return null;

    return candidate;
}

module.exports = { safeReturnUrl };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/unit/urlsafe.test.js`
Expected: PASS — `# pass 12`, `# fail 0`

- [ ] **Step 5: Syntax-check the new file**

Run: `node --check src/server/urlsafe.js`
Expected: no output, exit 0

---

### Task 2: `smscap.js` — global daily SMS cap (F5)

**Files:**
- Create: `src/server/smscap.js`
- Test: `tests/unit/smscap.test.js`

**Interfaces:**
- Consumes: nothing (zero dependencies).
- Produces:
  - `tryConsume(now?: Date) => { ok: true, remaining: number } | { ok: false, cap: number }` — increments the counter and reports whether the send is allowed. Fails closed at the cap.
  - `getCap() => number` — reads `SMS_DAILY_CAP` from the environment on every call (default `200`).
  - `getState(now?: Date) => { day: string, sent: number, cap: number, remaining: number }` — read-only, for diagnostics.
  - `_resetForTests()` — clears internal state.

  Task 5 consumes `tryConsume`.

**Why a separate module rather than adding this to `security.js`:** `security.js` requires `express-rate-limit` and `db.js`, neither of which can be loaded in this environment — putting the counter there would make it untestable. It is also genuinely a different concern: `security.js` limits *who* may call a route; this limits *how much money the account can spend in a day* regardless of caller.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/smscap.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert");
const smscap = require("../../src/server/smscap");

function fresh(cap) {
    smscap._resetForTests();
    if (cap === undefined) delete process.env.SMS_DAILY_CAP;
    else process.env.SMS_DAILY_CAP = String(cap);
}

test("defaults to a cap of 200 when SMS_DAILY_CAP is unset", () => {
    fresh(undefined);
    assert.equal(smscap.getCap(), 200);
});

test("reads SMS_DAILY_CAP from the environment", () => {
    fresh(5);
    assert.equal(smscap.getCap(), 5);
});

test("falls back to 200 for a garbage or non-positive SMS_DAILY_CAP", () => {
    fresh("banana");
    assert.equal(smscap.getCap(), 200);
    fresh(0);
    assert.equal(smscap.getCap(), 200);
    fresh(-10);
    assert.equal(smscap.getCap(), 200);
});

test("allows sends up to the cap, then refuses", () => {
    fresh(3);
    const day = new Date("2026-07-29T10:00:00");
    assert.deepEqual(smscap.tryConsume(day), { ok: true, remaining: 2 });
    assert.deepEqual(smscap.tryConsume(day), { ok: true, remaining: 1 });
    assert.deepEqual(smscap.tryConsume(day), { ok: true, remaining: 0 });
    assert.deepEqual(smscap.tryConsume(day), { ok: false, cap: 3 });
    assert.deepEqual(smscap.tryConsume(day), { ok: false, cap: 3 });
});

test("a refused send does not increment the counter past the cap", () => {
    fresh(2);
    const day = new Date("2026-07-29T10:00:00");
    smscap.tryConsume(day);
    smscap.tryConsume(day);
    smscap.tryConsume(day);
    smscap.tryConsume(day);
    assert.equal(smscap.getState(day).sent, 2);
});

test("resets at the local-date rollover", () => {
    fresh(2);
    const late = new Date("2026-07-29T23:59:00");
    assert.equal(smscap.tryConsume(late).ok, true);
    assert.equal(smscap.tryConsume(late).ok, true);
    assert.equal(smscap.tryConsume(late).ok, false);

    const nextDay = new Date("2026-07-30T00:01:00");
    assert.deepEqual(smscap.tryConsume(nextDay), { ok: true, remaining: 1 });
    assert.equal(smscap.getState(nextDay).sent, 1);
});

test("counts a same-day send at a different hour against the same budget", () => {
    fresh(2);
    assert.equal(smscap.tryConsume(new Date("2026-07-29T01:00:00")).ok, true);
    assert.equal(smscap.tryConsume(new Date("2026-07-29T22:00:00")).ok, true);
    assert.equal(smscap.tryConsume(new Date("2026-07-29T22:30:00")).ok, false);
});

test("getState reports the current day without consuming", () => {
    fresh(10);
    const day = new Date("2026-07-29T12:00:00");
    smscap.tryConsume(day);
    const before = smscap.getState(day);
    smscap.getState(day);
    smscap.getState(day);
    assert.deepEqual(smscap.getState(day), before);
    assert.deepEqual(before, { day: "2026-07-29", sent: 1, cap: 10, remaining: 9 });
});

test("picks up a cap change mid-day without a restart", () => {
    fresh(2);
    const day = new Date("2026-07-29T12:00:00");
    smscap.tryConsume(day);
    smscap.tryConsume(day);
    assert.equal(smscap.tryConsume(day).ok, false);
    process.env.SMS_DAILY_CAP = "4";
    assert.deepEqual(smscap.tryConsume(day), { ok: true, remaining: 1 });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/unit/smscap.test.js`
Expected: FAIL — `Cannot find module '../../src/server/smscap'`

- [ ] **Step 3: Write the implementation**

Create `src/server/smscap.js`:

```js
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/unit/smscap.test.js`
Expected: PASS — `# pass 9`, `# fail 0`

- [ ] **Step 5: Syntax-check the new file**

Run: `node --check src/server/smscap.js`
Expected: no output, exit 0

---

### Task 3: `requireStaff` middleware (F2, part 1)

**Files:**
- Modify: `src/server/auth.js:233-238` (insert after `requireDriver`), and its `module.exports` block at `src/server/auth.js:240-253`

**Interfaces:**
- Consumes: `requireAuth` (already defined in this file).
- Produces: `requireStaff(req, res, next)` — Express middleware. Allows admins and any non-driver session; rejects driver-only accounts with 403. Task 4 consumes this.

- [ ] **Step 1: Add the middleware**

In `src/server/auth.js`, immediately after the closing `}` of `requireDriver` (line 238) and before `module.exports`, insert:

```js
// SECURITY (audit 2026-07-29, finding F2): "logged in" is not the same as
// "trusted with the whole restaurant". requireAuth accepts ANY valid session,
// including a driver's — and drivers are the lowest-trust accounts here: the
// session lives on a personal phone that travels around town all shift.
//
// Before this, a driver session could DELETE any delivery order and any
// walk-in table order. Neither is anything a driver's job requires; both are
// destructive and unlogged.
//
// requireAdmin would be the obvious guard and is the WRONG one — the kitchen
// page's delete button (src/js/kitchen.js, deleteOrder) is used by ordinary
// non-admin kitchen staff, so requiring admin would break real daily work.
// The actual boundary being drawn is "everyone except drivers", which is what
// this expresses: admins always pass; a session that is a driver and nothing
// else does not.
//
// Deliberately NOT applied to GET ${api}/orders — driver.js needs the order
// list (names, addresses) to actually deliver. That route stays requireAuth.
function requireStaff(req, res, next) {
    requireAuth(req, res, () => {
        if (req.user.isAdmin || !req.user.isDriver) return next();
        return res.status(403).json({ error: "Vyžadována oprávnění personálu" });
    });
}
```

- [ ] **Step 2: Export it**

In the `module.exports` block at the end of `src/server/auth.js`, change:

```js
    requireAuth,
    requireAdmin,
    requireDriver,
```

to:

```js
    requireAuth,
    requireAdmin,
    requireDriver,
    requireStaff,
```

- [ ] **Step 3: Verify syntax**

Run: `node --check src/server/auth.js`
Expected: no output, exit 0

- [ ] **Step 4: Confirm the export is wired**

Run: `grep -n "requireStaff" src/server/auth.js`
Expected: exactly 3 hits — the comment reference is not counted; you should see the `function requireStaff` line, the `module.exports` line, and nothing else unexpected.

---

### Task 4: Route guards (F1 + F2, part 2)

**Files:**
- Modify: `src/server/server.js:126-142` (the `require("./auth")` destructure)
- Modify: `src/server/server.js:3615` (`GET /api/stats/sales`)
- Modify: `src/server/server.js:3739` (`GET /api/users`)
- Modify: `src/server/server.js:3043` (`DELETE /api/orders/:id`)
- Modify: `src/server/server.js:3339` (`DELETE /api/indoor-orders/:id`)

**Interfaces:**
- Consumes: `requireStaff` from Task 3; `requireAuth` / `requireAdmin` already imported.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Import `requireStaff`**

In the destructuring `require("./auth")` near the top of `src/server/server.js`, change:

```js
    requireAuth,
    requireAdmin,
    requireDriver,
```

to:

```js
    requireAuth,
    requireAdmin,
    requireDriver,
    requireStaff,
```

- [ ] **Step 2: Guard `GET /api/stats/sales` (F1 — the headline fix)**

Change:

```js
    app.get(`${api}/stats/sales`, (req, res) => {
```

to:

```js
    // SECURITY (audit 2026-07-29, finding F1): this route had NO guard at
    // all — every comparable read route is protected (GET /orders and
    // GET /receipts use requireAuth, GET /export and GET /security/login-audit
    // use requireAdmin), and this one was simply missed. Anyone on the
    // internet could read per-dish sales counts and revenue across all three
    // order channels, for a window of their choosing: `days` is unbounded
    // upward (see the parseInt below), so ?days=99999 returned the
    // restaurant's entire revenue history to an anonymous GET.
    //
    // requireAuth, NOT requireAdmin: the sales view is deliberately available
    // to all staff — the client-side view gate in src/js/inner.js admin-locks
    // users/settings/dailyMenu/layout but not stats, and tightening this to
    // admin here would break the panel for ordinary staff.
    app.get(`${api}/stats/sales`, requireAuth, (req, res) => {
```

- [ ] **Step 3: Guard `GET /api/users` (F2)**

Change:

```js
    app.get(`${api}/users`, requireAuth, (req, res) => {
```

to:

```js
    // SECURITY (audit 2026-07-29, finding F2): admin-only. Passwords were
    // already stripped below, so this was never a credential leak — but it
    // handed ANY session (including a driver's) the exact login identifiers
    // (`abbreviation`) for every staff member plus which of them are admins.
    // That is the reconnaissance step before a credential attack, served to
    // the lowest-trust account type in the system.
    //
    // Safe to narrow: the only caller is renderUsersView() in src/js/inner.js,
    // behind a view gate that is already admin-only.
    app.get(`${api}/users`, requireAdmin, (req, res) => {
```

- [ ] **Step 4: Guard `DELETE /api/orders/:id` (F2)**

Change:

```js
    app.delete(`${api}/orders/:id`, csrf.requireCsrf, requireAuth, V.validateParams(V.paramsId), (req, res) => {
```

to:

```js
    // SECURITY (audit 2026-07-29, finding F2): requireStaff, not requireAuth —
    // deleting orders is not part of a driver's job. See requireStaff's
    // comment in auth.js for why this is not requireAdmin (the kitchen page's
    // delete button is used by non-admin staff).
    app.delete(`${api}/orders/:id`, csrf.requireCsrf, requireStaff, V.validateParams(V.paramsId), (req, res) => {
```

- [ ] **Step 5: Guard `DELETE /api/indoor-orders/:id` (F2)**

Change:

```js
    app.delete(`${api}/indoor-orders/:id`, csrf.requireCsrf, requireAuth, V.validateParams(V.paramsId), (req, res) => {
```

to:

```js
    // SECURITY (audit 2026-07-29, finding F2): same reasoning as
    // DELETE /orders/:id above — drivers have no business deleting table orders.
    app.delete(`${api}/indoor-orders/:id`, csrf.requireCsrf, requireStaff, V.validateParams(V.paramsId), (req, res) => {
```

- [ ] **Step 6: Verify syntax**

Run: `node --check src/server/server.js`
Expected: no output, exit 0

- [ ] **Step 7: Verify no route was missed or over-guarded**

Run: `grep -n "stats/sales\|api}/users\`\|delete(\`\${api}/orders/:id\|delete(\`\${api}/indoor-orders/:id" src/server/server.js`

Expected: `stats/sales` shows `requireAuth`; `` `${api}/users` `` GET shows `requireAdmin` (the POST on the same path keeps `requireAdmin` — it already had it); both DELETEs show `requireStaff`.

Run: `grep -c "requireAuth" src/server/server.js`
Expected: the count dropped by exactly 3 from its pre-edit value (stats/sales gained one, so: users −1, two DELETEs −2, stats +1 = net −2 from the original count; confirm the delta is −2 and that `GET /api/orders` still reads `requireAuth`).

---

### Task 5: Wire in `urlsafe` and `smscap` (F4 + F5)

**Files:**
- Modify: `src/server/server.js` — module requires near the top (alongside `const reorder = require("./reorder");` at line 125)
- Modify: `src/server/server.js:250-256` (`gatewayCallbackUrls`)
- Modify: `src/server/server.js:2515-2525` (`POST /api/reservations/send-code`)
- Modify: `src/server/server.js:2676-2690` (`POST /api/reorder/send-code`)

**Interfaces:**
- Consumes: `safeReturnUrl(ownOrigin, candidate)` from Task 1; `tryConsume(now?)` from Task 2.
- Produces: nothing consumed by later tasks.

**Note:** `gatewayCallbackUrls` already computes the app's own origin as `` `${req.protocol}://${req.get("host")}` `` — reuse that exact expression so the allow-list and the fallback agree by construction. Fixing this in `gatewayCallbackUrls` covers all three payment routes at once, rather than patching each call site.

- [ ] **Step 1: Add the requires**

After `const reorder = require("./reorder");`, add:

```js
// Same self-contained-module convention as reorder.js/settings.js above.
// See each file's header comment for the threat model it addresses
// (audit 2026-07-29, findings F4 and F5).
const { safeReturnUrl } = require("./urlsafe");
const smscap = require("./smscap");
```

- [ ] **Step 2: Validate `returnUrl` in `gatewayCallbackUrls` (F4)**

Change:

```js
function gatewayCallbackUrls(req, overrideReturnUrl) {
    const origin = `${req.protocol}://${req.get("host")}`;
    return {
        returnUrl: overrideReturnUrl || SERVER_CONFIG.payments.returnUrl || `${origin}${SERVER_CONFIG.basePath}/app`,
        notificationUrl: SERVER_CONFIG.payments.notificationUrl || `${origin}${SERVER_CONFIG.basePath}/api/payments/gopay/webhook`,
    };
}
```

to:

```js
function gatewayCallbackUrls(req, overrideReturnUrl) {
    const origin = `${req.protocol}://${req.get("host")}`;

    // SECURITY (audit 2026-07-29, finding F4): `overrideReturnUrl` comes
    // straight from the request body on all three pay-online routes, and
    // validation.js bounds only its LENGTH. Unvalidated, it let an attacker
    // mint a genuine gate.gopay.cz payment link that dumps the payer on a
    // site of their choosing after a real, successful payment — see
    // urlsafe.js's header for the full scenario.
    //
    // Rejected values fall through to the configured/derived default rather
    // than erroring: a bad returnUrl is never worth failing a real customer's
    // payment over, and the fallback is always safe. Validating here rather
    // than at each call site means all three routes are covered by
    // construction, including any added later.
    const safeOverride = safeReturnUrl(origin, overrideReturnUrl);
    if (overrideReturnUrl && !safeOverride) {
        console.warn(`💳 Rejected off-origin returnUrl, using default instead: ${String(overrideReturnUrl).slice(0, 200)}`);
    }

    return {
        returnUrl: safeOverride || SERVER_CONFIG.payments.returnUrl || `${origin}${SERVER_CONFIG.basePath}/app`,
        notificationUrl: SERVER_CONFIG.payments.notificationUrl || `${origin}${SERVER_CONFIG.basePath}/api/payments/gopay/webhook`,
    };
}
```

- [ ] **Step 3: Enforce the SMS cap in `/reservations/send-code` (F5)**

In `POST ${api}/reservations/send-code`, find the existing resend-cooldown block:

```js
        const existing = pendingVerifications.get(cleanPhone);
        const cooldown = SERVER_CONFIG.sms.resendCooldownMs;
        if (existing && Date.now() - existing.lastSentAt < cooldown) {
            const waitSec = Math.ceil((cooldown - (Date.now() - existing.lastSentAt)) / 1000);
            return res.status(429).json({ error: `Zkuste to znovu za ${waitSec} s` });
        }

        const code = generateCode(SERVER_CONFIG.sms.codeLength);
```

and insert the cap check between the cooldown block and the `const code = ...` line, so it reads:

```js
        const existing = pendingVerifications.get(cleanPhone);
        const cooldown = SERVER_CONFIG.sms.resendCooldownMs;
        if (existing && Date.now() - existing.lastSentAt < cooldown) {
            const waitSec = Math.ceil((cooldown - (Date.now() - existing.lastSentAt)) / 1000);
            return res.status(429).json({ error: `Zkuste to znovu za ${waitSec} s` });
        }

        // SECURITY (audit 2026-07-29, finding F5): last line of defence on SMS
        // spend. smsIpLimiter/smsPhoneLimiter above cap one IP and one phone
        // number; neither bounds the TOTAL, so a pool of addresses multiplies
        // straight through them. This is the global ceiling — see smscap.js.
        // Checked here, after the cheap validation/cooldown rejections, so a
        // request that was going to be refused anyway doesn't burn budget.
        const smsBudget = smscap.tryConsume();
        if (!smsBudget.ok) {
            console.error(`📲 Daily SMS cap (${smsBudget.cap}) reached — refusing reservation code to ${cleanPhone}`);
            return res.status(503).json({ error: "Ověřovací SMS momentálně nelze odeslat. Zkuste to prosím později nebo nám zavolejte." });
        }

        const code = generateCode(SERVER_CONFIG.sms.codeLength);
```

- [ ] **Step 4: Enforce the SMS cap in `/reorder/send-code` (F5)**

In `POST ${api}/reorder/send-code`, find:

```js
        const cleanPhone = normalizePhone(phone);
        if (!cleanPhone) return res.status(400).json({ error: "Zadejte telefonní číslo" });

        const code = generateCode(SERVER_CONFIG.sms.codeLength);
```

and change it to:

```js
        const cleanPhone = normalizePhone(phone);
        if (!cleanPhone) return res.status(400).json({ error: "Zadejte telefonní číslo" });

        // SECURITY (audit 2026-07-29, finding F5): same global ceiling as
        // /reservations/send-code. Both routes draw from ONE shared daily
        // budget (a single module-level counter in smscap.js), mirroring how
        // they already share smsIpLimiter/smsPhoneLimiter instances — so this
        // route cannot be used to spend the budget the other one is meant to
        // be constrained by.
        const smsBudget = smscap.tryConsume();
        if (!smsBudget.ok) {
            console.error(`📲 Daily SMS cap (${smsBudget.cap}) reached — refusing reorder code to ${cleanPhone}`);
            return res.status(503).json({ error: "Ověřovací SMS momentálně nelze odeslat. Zkuste to prosím později nebo nám zavolejte." });
        }

        const code = generateCode(SERVER_CONFIG.sms.codeLength);
```

- [ ] **Step 5: Verify syntax**

Run: `node --check src/server/server.js`
Expected: no output, exit 0

- [ ] **Step 6: Confirm both routes are covered and the requires landed**

Run: `grep -n "smscap\|safeReturnUrl" src/server/server.js`
Expected: 6 hits — 2 requires, 2 `smscap.tryConsume()` call sites, 1 `safeReturnUrl(` call, 1 `smscap.tryConsume` in each send-code route (i.e. both send-code routes appear).

- [ ] **Step 7: Re-run both unit suites (the modules must still be self-consistent)**

Run: `node --test tests/unit/urlsafe.test.js tests/unit/smscap.test.js`
Expected: `# pass 21`, `# fail 0`

---

### Task 6: Stop serving backend source (F3)

**Files:**
- Modify: `src/server/server.js:2041-2075` (both branches of the static-mount block in `setupMiddleware`)

**Interfaces:** none.

**Context:** `SERVER_CONFIG.frontendPath` is `"src"` and `express.static(frontendPath)` therefore serves `src/server/` too — `/reservation/server/auth.js`, `/server/security.js`, `/server/gopay.js` and friends are all publicly fetchable, and `minify.js` will even esbuild them on the way out. The block must be registered **before** both `minify.createMinifyMiddleware` and `express.static` in each branch, exactly like the existing `blockRawLegalTemplate` guard immediately above them.

- [ ] **Step 1: Add the blocker next to `blockRawLegalTemplate`**

Find:

```js
    const legalTemplateFileNames = ["obchodni-podminky.html", "ochrana-osobnich-udaju.html", "reklamace.html"];
    const blockRawLegalTemplate = (req, res) => res.status(404).send("Stránka nenalezena");
```

and add below it:

```js
    // SECURITY (audit 2026-07-29, finding F3): SERVER_CONFIG.frontendPath is
    // "src", and src/server/ lives INSIDE it — so express.static below served
    // the entire backend as static files. /server/server.js, /server/auth.js,
    // /server/security.js, /server/gopay.js, /server/config_help.txt were all
    // publicly fetchable, and minify.js (mounted first, and it handles .js)
    // would even esbuild them on the way out.
    //
    // No credentials leaked — every secret is read from process.env and none
    // is hardcoded — but it published the complete route map, exactly which
    // routes are unauthenticated, the lockout thresholds and rate-limit
    // windows, and the id-generation scheme. That is the entire reconnaissance
    // phase, handed over for free.
    //
    // app.use (not app.get) so EVERY method and every sub-path under /server
    // is covered, and registered before minify + express.static in both
    // branches below so it always wins. Same 404-don't-confirm-it-exists
    // shape as blockRawLegalTemplate above.
    //
    // Proper fix is to move the frontend into its own directory so the
    // backend was never under the static root at all; this is the surgical
    // version that doesn't touch the layout of the repo.
    const blockServerSource = (req, res) => res.status(404).send("Stránka nenalezena");
```

- [ ] **Step 2: Mount it in the `base` branch**

In the `if (base) {` branch, change:

```js
        for (const filename of legalTemplateFileNames) {
            app.get(`${base}/html/${filename}`, blockRawLegalTemplate);
        }
```

to:

```js
        for (const filename of legalTemplateFileNames) {
            app.get(`${base}/html/${filename}`, blockRawLegalTemplate);
        }
        app.use(`${base}/server`, blockServerSource);
```

- [ ] **Step 3: Mount it in the bare-path `else` branch**

Change:

```js
    } else {
        for (const filename of legalTemplateFileNames) {
            app.get(`/html/${filename}`, blockRawLegalTemplate);
        }
```

to:

```js
    } else {
        for (const filename of legalTemplateFileNames) {
            app.get(`/html/${filename}`, blockRawLegalTemplate);
        }
        app.use("/server", blockServerSource);
```

- [ ] **Step 4: Verify syntax**

Run: `node --check src/server/server.js`
Expected: no output, exit 0

- [ ] **Step 5: Confirm both branches are covered and ordering is right**

Run: `grep -n "blockServerSource\|express.static\|createMinifyMiddleware" src/server/server.js`

Expected: `blockServerSource` is defined once, then mounted twice; **each** mount line number is lower than the `createMinifyMiddleware` and `express.static` line numbers in its own branch. If a mount appears after a static line, the fix does nothing — fix the ordering.

---

### Task 7: `.gitignore` (F6)

**Files:**
- Modify: `.gitignore`

**Interfaces:** none.

**Context:** the current file is one line (`.superpowers/`). `data/app.db` — customers, phones, addresses, order history, bcrypt password hashes — is not excluded, nor are its `.bak-*` / `.orphan-*` siblings. This directory is not currently a git repo, so nothing is committed today; the fix is to make sure that stays true if it ever becomes one.

- [ ] **Step 1: Replace the contents**

Write `.gitignore`:

```gitignore
.superpowers/

# SECURITY (audit 2026-07-29, finding F6): the live SQLite database holds
# customer names, addresses, phone numbers, full order history and bcrypt
# password hashes. It must never be committed — including the backup and
# orphaned-WAL copies that accumulate next to it (data/ currently holds
# app.db plus .bak-* and .orphan-* siblings).
data/
*.db
*.db-wal
*.db-shm

# Secrets live in the environment, never in the repo.
.env
.env.*
!.env.example

node_modules/

# OS / editor noise
.DS_Store
Thumbs.db
```

- [ ] **Step 2: Verify**

Run: `cat .gitignore`
Expected: the content above.

---

## Final verification

- [ ] **All new unit tests pass**

Run: `node --test tests/unit/urlsafe.test.js tests/unit/smscap.test.js`
Expected: `# pass 21`, `# fail 0`

- [ ] **Every touched JS file parses**

Run: `node --check src/server/server.js && node --check src/server/auth.js && node --check src/server/urlsafe.js && node --check src/server/smscap.js && echo ALL_OK`
Expected: `ALL_OK`

- [ ] **Report honestly.** State plainly that the `server.js` and `auth.js` changes are syntax-checked and reviewed but **not** runtime-tested, because the dependencies needed to boot the app do not load in this environment. Do not describe those changes as "verified" or "tested". The two new modules genuinely are unit-tested; say so, and keep the distinction explicit.

## Manual verification for the user (cannot be automated here)

Once `npm install` has been run somewhere the dependencies actually load:

1. `GET /reservation/api/stats/sales` with no cookie → **401**. With a staff login → 200. The admin stats panel still renders.
2. `GET /reservation/server/auth.js` → **404** (was: the file's source).
3. Log in as a driver-only account → the kitchen delete button returns 403; log in as kitchen staff (non-admin, non-driver) → delete still works. **This is the highest-risk change; check it first.**
4. Place a delivery order with `returnUrl: "https://example.com/x"` → server logs the rejection and GoPay gets the default return URL. A same-origin `returnUrl` still round-trips normally.
5. Set `SMS_DAILY_CAP=1`, request two reservation codes → the second returns **503**.
