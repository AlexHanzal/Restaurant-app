# Table QR Self-Order Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a guest scan a QR code on their table, browse the full menu on their own phone, and send an order straight to the kitchen board — no waiter required to take it.

**Architecture:** The QR URL carries a signed, per-table capability token derived from the table's stable `fileId`. A new public route verifies the token, gates on a new `settings.tableOrdering` block, prices the cart through the existing `priceOrderItems()` funnel, and writes an ordinary `indoor_orders` row tagged `source: "qr"` — so the kitchen board, admin overview, sales stats, receipts and EET pick it up with no changes at all.

**Tech Stack:** Node 20+/Express 5, better-sqlite3 via `src/server/db.js`, zod 4 validation, express-rate-limit, vanilla ES5-flavoured browser JS (no build step, no modules — scripts are `<script src>` tags exposing globals), `node --test`.

**Spec:** `docs/superpowers/specs/2026-08-04-table-qr-self-order-design.md` — read it before starting any task.

## Global Constraints

- **No new npm dependencies.** The repo already ships a dependency-free QR encoder at `src/js/qr.js` exposing `window.QR.renderSVG(text, { ecLevel, scale })`. Use it.
- **All user-facing text is Czech.** Match the tone of existing strings (`"Objednávka nenalezena"`, `"Rozvoz je momentálně uzavřen."`).
- **Heavy explanatory comments are the house style.** Every non-obvious decision gets a comment saying *why*, not *what*. Read a neighbouring file before writing; match its comment density.
- **No build step.** Browser JS files are plain scripts loaded by `<script src>`; they communicate through `window.*` globals. No `import`/`export`, no bundler.
- **`priceOrderItems()` in `src/server/server.js` must not be modified.** It is the single server-side pricing funnel for every order route.
- **`auth.js`'s `JWT_SECRET` must never be used for the table token.** Derive a separate key via `auth.deriveSecret()`. See `src/server/auth.js:192` for why.
- **Czech base path:** every page/API path is prefixed by `SERVER_CONFIG.basePath` (`/reservation` by default). Never hardcode it in server code — use the existing `base` / `api` template variables.
- **Git:** this repo needs `git config windows.appendAtomically false` (already set) because it lives inside a OneDrive folder. Commit author is `Alex Hanzal <alexhanzal@example.com>` (repo-local config, already set).
- **Run the server** with `$env:PORT='<port>'; node src/server/server.js` from the repo root (PowerShell). Use a spare port (4310+) so you never fight the owner's running instance.

---

## File Structure

**New files**

| Path | Responsibility |
|---|---|
| `src/server/table-token.js` | Mint/verify signed per-table capability tokens. Pure crypto, no Express, no db. |
| `src/js/menu-catalog.js` | Shared menu **data** layer (fetch + normalise + combo helpers). No DOM. |
| `src/js/table-order.js` | Guest table-ordering page controller. |
| `src/html/table.html` | Guest table-ordering page shell. |
| `src/css/table-page.css` | Only what the guest page needs beyond `delivery-page.css`. |
| `tests/helpers/harness.js` | Spawn a real server on a free port against a temp SQLite DB. |
| `tests/unit/table-token.test.js` | Token round-trip, tampering, key separation. |
| `tests/smoke/table-orders.test.js` | End-to-end over the four public routes. |

**Modified files**

| Path | Change |
|---|---|
| `src/server/settings.js` | `tableOrdering` defaults + `isTableOrderingOpenNow()`. |
| `src/server/validation.js` | `tableOrderSchema`, `paramsTableToken`, `tableOrdering` in `settingsSchema`. |
| `src/server/security.js` | `tableOrderIpLimiter`, `tableOrderTableLimiter`. |
| `src/server/server.js` | 5 API routes, 1 page route, `source` on the existing indoor route. |
| `src/js/delivery.js` | Consume `menu-catalog.js` instead of local definitions. |
| `src/html/delivery.html` | Load `menu-catalog.js` before `delivery.js`. |
| `src/js/inner.js` | Delete the future-note, QR panel, print sheet, settings UI, QR badge. |
| `src/js/kitchen.js` | QR badge on indoor tickets. |
| `src/css/inner.css` | QR panel + print sheet styles. |
| `package.json` | `test:smoke` script. |
| `.env.example` | `TABLE_QR_EPOCH`. |

**Task dependency order** — Tasks 1 and 2 are independent and may run in parallel. Task 3 needs both. Task 4 is independent of all server work. Tasks 5, 6, 7 need Task 3's route contract (fully specified below, so they may start once Task 3's routes exist).

```
T1 (token) ─┐
            ├─> T3 (server routes) ─┬─> T5 (guest page)
T2 (config) ┘                       ├─> T6 (admin + kitchen)
                                    └─> T7 (smoke tests)
T4 (menu-catalog) ─────────────────────> (T5 consumes it)
```

---

## Task 1: Signed table token module

**Files:**
- Create: `src/server/table-token.js`
- Create: `tests/unit/table-token.test.js`
- Read first: `src/server/auth.js:185-215` (the `deriveSecret` header comment — it explains exactly why this module exists), `src/server/reorder.js:38-70` (the precedent).

**Interfaces:**
- Consumes: `require("./auth").deriveSecret(purpose) -> string` (hex).
- Produces:
  ```js
  mintTableToken(fileId: string) -> string          // "<fileId>.<sig>"
  verifyTableToken(token: unknown) -> string | null  // fileId, or null
  ```
  Task 3 imports both. Task 7 imports `mintTableToken` to forge test URLs.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/table-token.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert");

// JWT_SECRET must be set before auth.js is required — it hard-fails in
// production without one and generates a random per-process secret
// otherwise, which would make these assertions non-deterministic.
process.env.JWT_SECRET = "test-secret-for-table-token-tests";

const tableToken = require("../../src/server/table-token");
const auth = require("../../src/server/auth");

test("mint then verify round-trips the fileId", () => {
    const token = tableToken.mintTableToken("abc123");
    assert.strictEqual(tableToken.verifyTableToken(token), "abc123");
});

test("a tampered signature is rejected", () => {
    const token = tableToken.mintTableToken("abc123");
    const [id, sig] = token.split(".");
    const flipped = sig.slice(0, -1) + (sig.slice(-1) === "A" ? "B" : "A");
    assert.strictEqual(tableToken.verifyTableToken(`${id}.${flipped}`), null);
});

test("a tampered fileId is rejected", () => {
    const token = tableToken.mintTableToken("abc123");
    const sig = token.split(".")[1];
    assert.strictEqual(tableToken.verifyTableToken(`abc124.${sig}`), null);
});

test("malformed input returns null rather than throwing", () => {
    for (const bad of ["", ".", "nodot", "a.b.c", null, undefined, 42, {}, "x".repeat(5000)]) {
        assert.strictEqual(tableToken.verifyTableToken(bad), null, `input: ${String(bad)}`);
    }
});

test("a token minted under a different epoch is rejected", () => {
    const token = tableToken.mintTableToken("abc123");
    delete require.cache[require.resolve("../../src/server/table-token")];
    process.env.TABLE_QR_EPOCH = "2";
    const rotated = require("../../src/server/table-token");
    assert.strictEqual(rotated.verifyTableToken(token), null);
    // …and its own tokens still work under the new epoch.
    assert.strictEqual(rotated.verifyTableToken(rotated.mintTableToken("abc123")), "abc123");
    delete process.env.TABLE_QR_EPOCH;
    delete require.cache[require.resolve("../../src/server/table-token")];
});

// ── KEY SEPARATION ──────────────────────────────────────────────────────
// This is the security property the whole module exists for: a table token
// is handed to anyone who photographs a QR code, so it must be incapable of
// authenticating as staff, and a stolen staff session must be incapable of
// impersonating a table. See src/server/auth.js:192.
test("a staff JWT is not a valid table token", () => {
    const staffJwt = auth.generateToken({ id: "u1", abbreviation: "AH", role: "admin" });
    assert.strictEqual(tableToken.verifyTableToken(staffJwt), null);
});

test("a table token is not a valid staff session", () => {
    const token = tableToken.mintTableToken("abc123");
    assert.strictEqual(auth.verifyToken(token), null);
});
```

> If `auth.generateToken` / `auth.verifyToken` are named differently, open `src/server/auth.js`'s `module.exports` and use the real names — do **not** delete these two tests.

- [ ] **Step 2: Run the test to verify it fails**

```bash
node --test tests/unit/table-token.test.js
```

Expected: FAIL — `Cannot find module '../../src/server/table-token'`.

- [ ] **Step 3: Write the implementation**

Create `src/server/table-token.js`:

```js
// ============================================================================
// table-token.js — signed, per-table capability tokens for the customer QR
// self-order page (spec: docs/superpowers/specs/2026-08-04-table-qr-self-
// order-design.md §4.1).
//
// A table's QR code encodes  <basePath>/stul/<token> . The token is the
// ONLY thing standing between "anyone on the internet" and "can push an
// order onto this restaurant's kitchen board", so two properties matter:
//
//   1. It must be unguessable. A bare /stul/5 must do nothing.
//   2. It must be INCAPABLE of authenticating as staff.
//
// (2) is why the signing key is derived via auth.deriveSecret() and is NOT
// JWT_SECRET. requireAuth() accepts any signature-valid staff JWT, and
// several read routes sit behind requireAuth alone — a same-secret table
// token would therefore be a privilege escalation, not a scoped capability.
// The identical hazard is documented at length in auth.js:192 for reorder
// tokens; this module is the second instance of that pattern.
//
// A payload-shape check inside requireAuth (`if (payload.kind !== "table")`)
// would NOT be an acceptable substitute: it is one line a later refactor can
// delete without understanding why it was there. A different key cannot be
// refactored away by accident — verification fails at the signature level,
// before any field is inspected.
//
// The payload is the table's `fileId`, never its `className`. Tables can be
// renamed (POST /timetables/:name/rename, server.js:2957) and that route
// deliberately leaves fileId alone — so binding the token to fileId means
// RENAMING A TABLE DOES NOT INVALIDATE ITS PRINTED QR CODE. The current
// name is resolved from the record at order time.
//
// Env vars:
//   TABLE_QR_EPOCH — optional break-glass. Mixed into the derivation
//                    purpose, so changing it invalidates every printed code
//                    at once. Deliberately NOT wired to admin UI: this is
//                    the "someone photographed our QR sheet" lever, not a
//                    routine rotation schedule (spec decision D2 — the codes
//                    are printed once and never reprinted).
// ============================================================================

const crypto = require("crypto");
const auth = require("./auth");

// 16 bytes = 128 bits of forgery resistance, and keeps the URL short enough
// for a low QR version. Denser codes are measurably harder to scan off a
// printed card in restaurant lighting, which is the actual failure mode
// here — not brute force.
const SIG_BYTES = 16;

const PURPOSE = `table-qr-v1:${process.env.TABLE_QR_EPOCH || "1"}`;
const KEY = auth.deriveSecret(PURPOSE);

// Guards against a pathological input burning CPU in createHmac. Real
// fileIds are short system ids (see generateFileId() in server.js).
const MAX_FILE_ID_LEN = 128;

function sign(fileId) {
    return crypto
        .createHmac("sha256", KEY)
        .update(fileId)
        .digest()
        .subarray(0, SIG_BYTES)
        .toString("base64url");
}

function mintTableToken(fileId) {
    if (typeof fileId !== "string" || !fileId || fileId.length > MAX_FILE_ID_LEN) {
        throw new Error("mintTableToken: fileId must be a short non-empty string");
    }
    if (fileId.includes(".")) {
        // The token format is "<fileId>.<sig>" — a dot in the id would make
        // parsing ambiguous. generateFileId() never produces one; this is a
        // fail-loud guard in case that ever changes.
        throw new Error("mintTableToken: fileId must not contain '.'");
    }
    return `${fileId}.${sign(fileId)}`;
}

function verifyTableToken(token) {
    // Returns null for EVERY failure mode rather than throwing — this runs
    // on a public route against attacker-controlled input, and a thrown
    // exception there is a 500 that leaks the difference between "malformed"
    // and "well-formed but wrong".
    if (typeof token !== "string" || token.length > MAX_FILE_ID_LEN + 64) return null;

    const dot = token.indexOf(".");
    if (dot <= 0 || dot === token.length - 1) return null;

    const fileId = token.slice(0, dot);
    const provided = token.slice(dot + 1);
    if (fileId.length > MAX_FILE_ID_LEN || provided.includes(".")) return null;

    const expected = sign(fileId);

    // timingSafeEqual THROWS on a length mismatch, so the length check must
    // come first — and must not itself be the whole comparison.
    const a = Buffer.from(provided, "utf8");
    const b = Buffer.from(expected, "utf8");
    if (a.length !== b.length) return null;
    if (!crypto.timingSafeEqual(a, b)) return null;

    return fileId;
}

module.exports = { mintTableToken, verifyTableToken };
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
node --test tests/unit/table-token.test.js
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Document the env var**

Append to `.env.example`, matching the file's existing comment style:

```
# Break-glass invalidation for printed table QR codes (see
# src/server/table-token.js). Leave unset. Bump to any new value ONLY if a
# QR code sheet leaks — every printed code stops working immediately and
# every table must be reprinted from the admin panel.
# TABLE_QR_EPOCH=1
```

- [ ] **Step 6: Commit**

```bash
git add src/server/table-token.js tests/unit/table-token.test.js .env.example
git commit -m "feat(table-qr): signed per-table capability tokens"
```

---

## Task 2: Settings, validation and rate limiters

**Files:**
- Modify: `src/server/settings.js` (add `tableOrdering` to `DEFAULT_SETTINGS`, add `isTableOrderingOpenNow`, export it)
- Modify: `src/server/validation.js` (add `paramsTableToken`, `tableOrderSchema`, `tableOrdering` in `settingsSchema`)
- Modify: `src/server/security.js` (add two limiters + exports)
- Read first: `src/server/settings.js:287-311` (`isDeliveryOpenNow` — copy its shape), `src/server/validation.js:781-814` (`settingsSchema`), `src/server/security.js:40-80` (limiter style).

**Interfaces:**
- Produces (Task 3 consumes all of these):
  ```js
  // settings.js
  settings.tableOrdering = { enabled: boolean, days: { "0".."6": { open, from, to } } }
  isTableOrderingOpenNow(settings, now?) -> { ok: boolean, reason: string|null, today: object|null }

  // validation.js
  V.paramsTableToken   // validateParams middleware for :token
  V.tableOrderSchema   // validate middleware for POST /table-orders body

  // security.js
  security.tableOrderIpLimiter     // express middleware
  security.tableOrderTableLimiter  // express middleware, keyed by req.tableFileId
  ```

- [ ] **Step 1: Add the settings defaults**

In `src/server/settings.js`, inside `DEFAULT_SETTINGS`, immediately **after** the `delivery: { … }` block:

```js
        // Customer QR self-order at tables (spec: docs/superpowers/specs/
        // 2026-08-04-table-qr-self-order-design.md §7). Same day/hours shape
        // as `delivery` above, deliberately — the admin UI reuses the very
        // same hours table renderer.
        //
        // `enabled` defaults to FALSE, unlike delivery. Printing and placing
        // the QR codes IS the deployment step for this feature; an install
        // that has never printed one must not be silently accepting
        // anonymous orders from anyone who guesses the URL shape.
        tableOrdering: {
            enabled: false,
            days: {
                "0": { open: true, from: "11:00", to: "21:00" },
                "1": { open: true, from: "11:00", to: "21:00" },
                "2": { open: true, from: "11:00", to: "21:00" },
                "3": { open: true, from: "11:00", to: "21:00" },
                "4": { open: true, from: "11:00", to: "21:00" },
                "5": { open: true, from: "11:00", to: "21:00" },
                "6": { open: true, from: "11:00", to: "21:00" },
            },
        },
```

- [ ] **Step 2: Add the hours helper**

In `src/server/settings.js`, immediately after `isDeliveryOpenNow`:

```js
// Table QR self-ordering gate. Same contract as isDeliveryOpenNow above —
// { ok, reason, today } — so the guest page can render today's hours without
// a second lookup. POST /table-orders re-checks this for real; the page's
// own banner is only the front-of-house reflection of it.
//
// Note the inverted flag: delivery has `paused` (opt-out), this has
// `enabled` (opt-in). See the DEFAULT_SETTINGS comment for why.
function isTableOrderingOpenNow(settings, now = new Date()) {
    const cfg = settings.tableOrdering || {};

    if (!cfg.enabled) {
        return { ok: false, reason: "Objednávky u stolu nejsou momentálně dostupné.", today: null };
    }

    const dateStr = formatDateStrLocal(now);
    if (findClosedDay(settings, dateStr)) {
        return { ok: false, reason: "Dnes máme zavřeno.", today: null };
    }

    const dayKey = String(dayIndexMonFirst(now));
    const day = cfg.days && cfg.days[dayKey];
    if (!day || !day.open) {
        return { ok: false, reason: "Objednávky u stolu jsou momentálně uzavřeny.", today: day || null };
    }

    const hhmm = formatHHMM(now);
    if (hhmm < day.from || hhmm > day.to) {
        return { ok: false, reason: `Objednávky u stolu přijímáme ${day.from}–${day.to}.`, today: day };
    }

    return { ok: true, reason: null, today: day };
}
```

Add `isTableOrderingOpenNow` to `module.exports` next to `isDeliveryOpenNow`.

- [ ] **Step 3: Extend the settings schema (THE HAZARD)**

> ⚠️ `settingsSchema` is `.strict()`. Skipping this step makes `PUT /api/settings`
> return 400 the instant the admin panel round-trips the settings object,
> because the panel always PUTs back the whole object it GET-ed. The identical
> trap is already documented for `floorplanSchema` at `src/server/validation.js:810`.

In `src/server/validation.js`, inside `settingsSchema`, after the `delivery` block:

```js
    // Customer QR self-order (spec 2026-08-04 §7). MUST be declared here or
    // PUT /settings 400s the moment the admin panel sends back the object it
    // just fetched — same persistence hazard as floorplanSchema below.
    // Reuses deliveryDaysSchema: the shapes are identical on purpose.
    tableOrdering: z.object({
        enabled: z.coerce.boolean(),
        days: deliveryDaysSchema,
    }).strict(),
```

- [ ] **Step 4: Add the request schemas**

In `src/server/validation.js`, next to `createIndoorOrderSchema` (line ~295):

```js
// POST /table-orders — the customer-facing QR self-order route (spec
// 2026-08-04 §5.3).
//
// Deliberately NOT .passthrough() like createIndoorOrderSchema: that route
// is staff-authenticated and carries offline-POS fields; this one takes
// anonymous input from a stranger's phone, so the accepted surface is
// exactly these five keys and nothing else. In particular `total` and
// `offlineSale` are REJECTED here rather than ignored — a guest device is
// never an offline POS, and silently dropping a client-supplied price is
// less obvious to a future reader than refusing it outright.
const tableOrderSchema = z.object({
    token: reqStr(200, "Kód stolu"),
    guestName: optStr(150, "Jméno"),
    note: optStr(500, "Poznámka"),
    items: itemsArraySchema,
}).strict();
```

And next to `paramsId` (line ~230):

```js
// The QR token is "<fileId>.<base64url sig>" — base64url plus one dot. This
// is the shape gate only; table-token.js's HMAC check is the real one.
const paramsTableToken = z.object({
    token: z.string().min(3).max(200).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, "Neplatný kód stolu"),
});
```

Add `tableOrderSchema` and `paramsTableToken` to `module.exports`.

- [ ] **Step 5: Add the rate limiters**

In `src/server/security.js`, after `smsPhoneLimiter`:

```js
// ── TABLE QR SELF-ORDER LIMITERS ────────────────────────────────────────
// Spec 2026-08-04 §6. The signed token stops URL guessing but CANNOT stop
// someone who photographed a real QR code, or a guest firing orders from
// home. These two limiters are what caps the damage in that case.

// Backstop across all the public table routes.
const tableOrderIpLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Příliš mnoho požadavků. Zkuste to prosím za chvíli." },
});

// THE ONE THAT MATTERS. Keyed on the RESOLVED table (req.tableFileId, set by
// the route's token-verification step), not on the IP — a leaked QR code
// photo is abused from many phones, which per-IP limiting does not see. A
// real table cannot plausibly place more than a dozen separate orders in a
// quarter of an hour.
//
// MOUNTING CONTRACT: this must run AFTER the middleware that verifies the
// token and assigns req.tableFileId. If it ever runs first, keyGenerator
// falls back to the IP and the protection silently degrades — hence the
// explicit marker rather than a silent `|| req.ip`.
const tableOrderTableLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 12,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.tableFileId || "unresolved-table",
    message: { error: "Z tohoto stolu přišlo příliš mnoho objednávek. Obraťte se prosím na obsluhu." },
});
```

Add both to `module.exports`.

- [ ] **Step 6: Verify nothing regressed**

```bash
node --test "tests/unit/**/*.test.js"
```

Expected: PASS, same count as before this task (no new tests here — Task 7's smoke tests exercise these).

Then start the server and confirm the new settings block is served:

```bash
node -e "const s=require('./src/server/settings.js'); console.log(JSON.stringify(s.DEFAULT_SETTINGS.tableOrdering)); console.log(s.isTableOrderingOpenNow({tableOrdering:{enabled:false}}));"
```

Expected: the defaults object, then `{ ok: false, reason: 'Objednávky u stolu nejsou momentálně dostupné.', today: null }`.

- [ ] **Step 7: Commit**

```bash
git add src/server/settings.js src/server/validation.js src/server/security.js
git commit -m "feat(table-qr): settings gate, request schemas and rate limiters"
```

---

## Task 3: Server routes

**Files:**
- Modify: `src/server/server.js`
- Read first: `src/server/server.js:3423-3520` (`POST /orders` — the public-route precedent), `src/server/server.js:3912-3985` (`POST /indoor-orders` — the row shape to mirror), `src/server/server.js:2424-2470` (html route handlers), `src/server/server.js:2690-2700` (page route registration, **both** the `base` and no-`base` branches).

**Interfaces:**
- Consumes: `tableToken.mintTableToken/verifyTableToken` (Task 1), `settingsStore.isTableOrderingOpenNow` (Task 2), `V.tableOrderSchema` / `V.paramsTableToken` (Task 2), `security.tableOrderIpLimiter` / `tableOrderTableLimiter` (Task 2), and the existing `priceOrderItems`, `generateFileId`, `broadcastBoardEvent`, `db`, `COL`.
- Produces (Tasks 5, 6, 7 consume):
  ```
  GET  ${base}/stul/:token                          -> src/html/table.html
  GET  ${api}/table-session/:token                  -> { tableName, ordering: {enabled, open, notice} }
  POST ${api}/table-orders                          -> { success, orderId, tableName, total, items }
  GET  ${api}/table-orders/:id/status?token=<tok>   -> { kitchenStatus, paymentStatus, total, createdAt }
  GET  ${api}/table-qr-tokens        (requireAuth)  -> [{ fileId, className, token, url }]
  ```

- [ ] **Step 1: Require the module**

Near the other `src/server/*` requires at the top of `server.js`:

```js
const tableToken = require("./table-token");
```

- [ ] **Step 2: Tag existing indoor orders with their source**

In `POST ${api}/indoor-orders` (~line 3951), add one field to the `order` object, right after `clientSaleId`:

```js
            // Which side placed this. "staff" = a waiter using *Objednat ke
            // stolu*; "qr" = the guest's own phone via POST /table-orders
            // (spec 2026-08-04 §4.2). Rows written before that feature
            // existed carry NO `source` at all and are read as "staff" —
            // they are deliberately not migrated.
            source: "staff",
```

- [ ] **Step 3: Add the token-resolution middleware and the four public routes**

Add a new section immediately after the `// ── INDOOR ORDERS (staff-placed) ──` block ends (after the `DELETE ${api}/indoor-orders/:id` route, ~line 4090):

```js
    // ── TABLE QR SELF-ORDER (customer-placed) ────────────────────────────
    //
    // Spec: docs/superpowers/specs/2026-08-04-table-qr-self-order-design.md
    //
    // These routes are PUBLIC and session-less by design — the caller is a
    // guest's phone that scanned a QR code, and it has no account. That is
    // the same posture as POST /orders (delivery checkout) above, and the
    // same reason csrf.requireCsrf is absent: CSRF protection defends routes
    // that act on the strength of an auth COOKIE. There is no cookie here,
    // so there is nothing for an attacker to ride. What guards these routes
    // instead is the signed token + the rate limiters + the settings gate.

    // Resolves :token (params) or body.token to a live table record and
    // hangs the result on the request. Runs BEFORE tableOrderTableLimiter,
    // which keys on req.tableFileId — see that limiter's mounting contract
    // in security.js.
    function resolveTableToken(source) {
        return (req, res, next) => {
            const raw = source === "body" ? (req.body || {}).token : req.params.token;
            const fileId = tableToken.verifyTableToken(raw);
            // 404, not 403: a bad signature must be indistinguishable from
            // a URL that was never valid. Telling an attacker "the signature
            // was wrong" confirms the id half was right.
            if (!fileId) return res.status(404).json({ error: "Neplatný kód stolu" });

            const table = db.list(COL.timetables).find(t => t.fileId === fileId);
            // 410 Gone, not 404: the token IS valid, the table was deleted.
            // A printed card outliving its table is a real operational case
            // and the guest page says something useful about it.
            if (!table) return res.status(410).json({ error: "Tento stůl už neexistuje" });

            req.tableFileId = fileId;
            req.tableRecord = table;
            next();
        };
    }

    // GET — turns a scan into a usable page: the table's CURRENT name (the
    // token is bound to fileId, so a renamed table keeps its printed code
    // working) plus whether ordering is open right now.
    app.get(
        `${api}/table-session/:token`,
        security.tableOrderIpLimiter,
        V.validateParams(V.paramsTableToken),
        resolveTableToken("params"),
        (req, res) => {
            const settings = settingsStore.getSettings();
            const open = settingsStore.isTableOrderingOpenNow(settings);
            res.json({
                tableName: req.tableRecord.className,
                ordering: {
                    enabled: !!(settings.tableOrdering && settings.tableOrdering.enabled),
                    open: open.ok,
                    notice: open.reason,
                },
            });
        }
    );

    // POST — the guest places an order. Writes an ORDINARY indoor order, so
    // the kitchen board, admin overview, sales stats, receipts and EET all
    // pick it up with no code of their own. The only difference from a
    // waiter-placed row is source:"qr".
    app.post(
        `${api}/table-orders`,
        security.tableOrderIpLimiter,
        V.validate(V.tableOrderSchema),
        resolveTableToken("body"),
        security.tableOrderTableLimiter,
        (req, res) => {
            const { guestName, note, items } = req.body || {};

            // The server is the authority on whether we are open — the page
            // shows its own banner, but a stale tab or a crafted request
            // must not get past this.
            const settings = settingsStore.getSettings();
            const open = settingsStore.isTableOrderingOpenNow(settings);
            if (!open.ok) return res.status(403).json({ error: open.reason });

            // Same single pricing funnel every other order route uses. The
            // offlineSale branch of POST /indoor-orders is deliberately NOT
            // reachable from here: a guest phone is never an offline POS, so
            // a client-supplied price is never accepted, and priced.error
            // always 400s (that is the sold-out guard).
            const priced = priceOrderItems(items);
            if (priced.error) return res.status(400).json({ error: priced.error });

            const id = generateFileId();
            const order = {
                id,
                tableName: req.tableRecord.className,
                guestName: (guestName || "").trim(),
                note: (note || "").trim(),
                items: priced.items,
                total: priced.total,
                kitchenStatus: "pending",
                createdAt: new Date().toISOString(),
                pricedOffline: false,
                offlineServerTotal: null,
                offlinePricingReason: null,
                clientSaleId: null,
                paymentStatus: "unpaid",
                gatewayTransactionId: null,
                receiptId: null,
                // See POST /indoor-orders' matching field.
                source: "qr",
            };

            db.set(COL.indoorOrders, id, order);
            broadcastBoardEvent();

            res.json({
                success: true,
                orderId: id,
                tableName: order.tableName,
                total: order.total,
                items: order.items,
            });
        }
    );

    // GET — live status for ONE order the guest just placed.
    //
    // Scoped hard: the caller must present the table token, and the order's
    // tableName must match that token's table. A token for stůl 5 can never
    // read stůl 6's order, and there is deliberately no listing route. The
    // response carries no item list and no guest name — only what the
    // "your order is being cooked" screen needs.
    //
    // Polled, not SSE: GET /api/events/board sits behind requireAuth and
    // must stay there.
    app.get(
        `${api}/table-orders/:id/status`,
        security.tableOrderIpLimiter,
        V.validateParams(V.paramsId),
        (req, res) => {
            const fileId = tableToken.verifyTableToken(req.query.token);
            if (!fileId) return res.status(404).json({ error: "Neplatný kód stolu" });

            const table = db.list(COL.timetables).find(t => t.fileId === fileId);
            if (!table) return res.status(410).json({ error: "Tento stůl už neexistuje" });

            const order = db.get(COL.indoorOrders, req.params.id);
            // Same 404 for "no such order" and "someone else's order" — the
            // distinction is exactly what an enumerator would want.
            if (!order || order.tableName !== table.className) {
                return res.status(404).json({ error: "Objednávka nenalezena" });
            }

            res.json({
                kitchenStatus: order.kitchenStatus,
                paymentStatus: order.paymentStatus,
                total: order.total,
                createdAt: order.createdAt,
            });
        }
    );

    // GET — every table's QR token + printable URL, for the admin panel.
    //
    // A SEPARATE, AUTHENTICATED route on purpose. GET /timetables (line
    // ~2809) is PUBLIC — renderer.js depends on that — so attaching tokens
    // to its payload would publish every table's ordering capability to the
    // internet and defeat the signature entirely.
    app.get(`${api}/table-qr-tokens`, requireAuth, (req, res) => {
        try {
            const origin = `${req.protocol}://${req.get("host")}`;
            const rows = db.list(COL.timetables)
                .filter(t => t && t.fileId && t.className)
                .map(t => {
                    const token = tableToken.mintTableToken(t.fileId);
                    return {
                        fileId: t.fileId,
                        className: t.className,
                        token,
                        url: `${origin}${SERVER_CONFIG.basePath}/stul/${token}`,
                    };
                });
            rows.sort((a, b) => a.className.localeCompare(b.className, "cs"));
            res.json(rows);
        } catch (e) {
            console.error("Failed to mint table QR tokens:", e);
            res.status(500).json({ error: "Nepodařilo se vygenerovat QR kódy" });
        }
    });
```

> If the local names differ (`settingsStore`, `security`, `requireAuth`, `V`, `SERVER_CONFIG`), use whatever `server.js` actually calls them. Do not add new requires for things already in scope.

- [ ] **Step 4: Add the page route**

Next to `deliveryHtmlRoute` (~line 2435):

```js
    // The guest QR self-order page. Serves the shell unconditionally —
    // token validation happens in GET /api/table-session/:token, not here,
    // so the HTML stays cacheable and every rejection lives in one place.
    const tableHtmlRoute = async (req, res) => {
        const candidates = [
            path.join(frontendPath, "table.html"),
            path.join(frontendPath, "html", "table.html")
        ];
        for (const file of candidates) {
            try { await fs.access(file); return res.sendFile(file); } catch {}
        }
        res.status(404).send("table.html not found");
    };
```

Register it in **both** branches at ~line 2690, alongside `app.get(\`${base}/delivery\`, deliveryHtmlRoute)`:

```js
        app.get(`${base}/stul/:token`, tableHtmlRoute);
```

and in the no-`base` branch:

```js
        app.get("/stul/:token", tableHtmlRoute);
```

> Do **not** add `table.html` / `table-order.js` / `table-page.css` to `SW_SHELL_FILES` (line ~2620). This page is a one-off scan by a stranger's phone, not an installed staff shell — spec §8.2.

- [ ] **Step 5: Verify by hand**

Start the server on a spare port, then:

```bash
curl -s "http://localhost:4310/reservation/api/table-session/bogus.token" -w "\n%{http_code}\n"
```

Expected: `{"error":"Neplatný kód stolu"}` and `404`.

```bash
curl -s "http://localhost:4310/reservation/stul/bogus.token" -o /dev/null -w "%{http_code}\n"
```

Expected: `404` for now (table.html doesn't exist until Task 5) — after Task 5, `200`.

- [ ] **Step 6: Commit**

```bash
git add src/server/server.js
git commit -m "feat(table-qr): public table-session, table-orders and status routes"
```

---

## Task 4: Extract the shared menu catalog

**Files:**
- Create: `src/js/menu-catalog.js`
- Modify: `src/js/delivery.js`
- Modify: `src/html/delivery.html`
- Read first: `src/js/delivery.js:1-120` and its combo section (~line 560 onward).

**This is a behaviour-preserving refactor of live checkout code.** Nothing about the delivery page may change from the user's point of view.

**Interfaces:**
- Produces `window.MenuCatalog` (Task 5 consumes it):
  ```js
  window.MenuCatalog = {
      MENU_CATEGORIES,          // [{ id, label }]
      DAILY_ITEM_ID_PREFIX,     // 'daily:'
      DAILY_CATEGORY_ID,        // 'daily-menu'
      COMBO_ITEM_ID_PREFIX,     // 'combo:'
      COMBO_CATEGORY_ID,        // 'combo-menu'
      categoryLabel(categoryId) -> string,
      fetchMenu(apiUrl)      -> Promise<menu>          // {} on failure, rethrows nothing
      fetchDailyMenu(apiUrl) -> Promise<Array<item>>   // [] on failure
      fetchCombos(apiUrl)    -> Promise<Array<combo>>  // [] on failure, NEVER toasts
      isComboRenderable(combo, menu) -> boolean,
      comboPricePreview(combo, selection, menu) -> { total, lines },
  };
  ```

- [ ] **Step 1: Create the module by moving code, not rewriting it**

Create `src/js/menu-catalog.js` with the header:

```js
// ════════════════════════════════════════════════════════════════════════
// MENU-CATALOG.JS — the shared MENU DATA layer for every customer-facing
// ordering surface: the delivery page (src/js/delivery.js) and the QR
// table-order page (src/js/table-order.js).
//
// DATA ONLY. No DOM, no rendering, no cart. The two pages render the same
// menu very differently — the table page has no address, no PSČ, no
// delivery fee, no minimum order and no reorder flow — so their markup
// stays in their own files. What must NOT diverge is the shape of the menu,
// the id-prefix conventions the server's priceOrderItems() keys off, and
// the combo price formula the customer sees before they commit.
//
// Extracted from delivery.js (spec 2026-08-04 §8.1) with NO behavioural
// change. In particular the two fetchers fail differently ON PURPOSE:
// fetchMenu() surfaces a toast because a page with no menu is broken, while
// fetchCombos() fails silently to an empty array because combos are a bonus
// on top of the regular menu and must never block it. That asymmetry was
// deliberate in delivery.js and is preserved here.
//
// No build step in this app — this is a plain script exposing a global.
// It MUST be loaded before delivery.js and before table-order.js.
// ════════════════════════════════════════════════════════════════════════
```

Then **move** (cut, do not retype) from `delivery.js`: `MENU_CATEGORIES`, `DAILY_ITEM_ID_PREFIX`, `DAILY_CATEGORY_ID`, `COMBO_ITEM_ID_PREFIX`, `COMBO_CATEGORY_ID`, `fetchCombos`, `fetchMenu`, the daily-menu fetch, `categoryLabel`, `isComboRenderable`, and the combo price-preview computation.

Two adaptations, and only these two:
1. Each fetcher takes `apiUrl` as its first argument instead of closing over `API_URL`.
2. They return their result instead of assigning a module-level `let`. `delivery.js` keeps its own `currentMenu` / `dailyMenuItems` / `combos` variables and assigns from the return value.

- [ ] **Step 2: Rewire delivery.js**

Replace the moved definitions with references. At the top of `delivery.js`, after the `API_URL` constant:

```js
// Menu data layer, shared with the QR table-order page — see
// src/js/menu-catalog.js. Loaded by a <script> tag ahead of this file.
const MC = window.MenuCatalog;
const MENU_CATEGORIES = MC.MENU_CATEGORIES;
const DAILY_ITEM_ID_PREFIX = MC.DAILY_ITEM_ID_PREFIX;
const DAILY_CATEGORY_ID = MC.DAILY_CATEGORY_ID;
const COMBO_ITEM_ID_PREFIX = MC.COMBO_ITEM_ID_PREFIX;
const COMBO_CATEGORY_ID = MC.COMBO_CATEGORY_ID;
```

Every remaining reference in the file keeps working unchanged. Update the three call sites to `await MC.fetchMenu(API_URL)` etc. and assign the result to the existing module-level variables.

- [ ] **Step 3: Load it in the HTML**

In `src/html/delivery.html`, add **before** the `delivery.js` script tag:

```html
<script src="/reservation/js/menu-catalog.js"></script>
```

- [ ] **Step 4: Verify the delivery page is unchanged**

Start the server, open `http://localhost:4310/reservation/delivery`, and check **all** of:
- Console has zero errors.
- All four menu categories render.
- "Polední menu" renders (enable it in admin settings if today's window is closed).
- "Zvýhodněná menu" renders, and the customize sheet opens, swaps a slot, ticks an extra, and adds one line to the cart at the expected price.
- A full checkout still succeeds and the order appears in the admin panel.

- [ ] **Step 5: Commit**

```bash
git add src/js/menu-catalog.js src/js/delivery.js src/html/delivery.html
git commit -m "refactor(menu): extract shared menu data layer from delivery.js"
```

---

## Task 5: The guest table-order page

**Files:**
- Create: `src/html/table.html`, `src/js/table-order.js`, `src/css/table-page.css`
- Read first: `src/html/delivery.html` (whole file — the structure to mirror), `src/js/delivery.js` (menu rendering, cart sheet, combo customize sheet), `src/css/delivery-page.css` (the classes to reuse).

**Interfaces:**
- Consumes: `window.MenuCatalog` (Task 4), the four public routes (Task 3), `window.API_BASE_URL` (from `src/config.js`).
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Build the page shell**

`src/html/table.html`, mirroring `delivery.html`'s head/footer. Script order matters:

```html
<script src="/reservation/config.js"></script>
<script src="/reservation/js/menu-catalog.js"></script>
<script src="/reservation/js/table-order.js"></script>
```

Load `design.css`, `delivery-page.css` (reused wholesale), then `table-page.css`.

Screens as sibling elements toggled by `hidden`:
`#loadingScreen`, `#errorScreen`, `#menuScreen`, `#statusScreen`.
The header must show the resolved table name **prominently** — a guest who scanned the wrong table should notice immediately. That is a stated part of the anti-abuse design (spec §6 layer 4), not decoration.

- [ ] **Step 2: Boot flow in `table-order.js`**

```js
// Token comes from the path — /reservation/stul/<token> — not a query
// string, so it survives being typed off a printed card.
const TOKEN = window.location.pathname.split('/').filter(Boolean).pop();
```

On load: `GET ${API_URL}/table-session/${TOKEN}`.
- `404` → error screen, *"Neplatný kód stolu. Zkuste prosím QR kód naskenovat znovu, nebo se obraťte na obsluhu."*
- `410` → error screen, *"Tento stůl už neexistuje. Obraťte se prosím na obsluhu."*
- `200` → store `tableName`, show the menu screen, and if `ordering.open === false` show `ordering.notice` in a banner and disable the submit button. **The menu stays browsable either way** — same rule as `delivery.html`'s `deliveryNotice`.

- [ ] **Step 3: Menu, cart and combo sheet**

Fetch all three sources in parallel via `MenuCatalog`, render in this order:
**Zvýhodněná menu → Polední menu → MENU_CATEGORIES**, matching delivery.

Cart sheet contains: line items with +/− quantity, total, an optional `Jméno` input (`maxlength="150"`), an optional `Poznámka` textarea (`maxlength="500"`), and the submit button labelled **"Odeslat objednávku"**.

It must contain **no** address, phone, email, PSČ, delivery-fee or minimum-order UI. Those are delivery concepts and do not apply here (spec D5).

The combo customize sheet is ported from `delivery.js` with full functionality: slot removal, slot swaps, paid extras, per-line note (spec D10).

- [ ] **Step 4: Submit**

```js
POST ${API_URL}/table-orders
{ token: TOKEN, guestName, note, items }
```

No CSRF header — this route has none (spec §5.3).
- `403` → show the server's `error` message in the banner and re-enable the button. The server is the authority on opening hours; a tab left open since lunch must be told so.
- `400` → show the server's `error` (typically a sold-out item).
- `200` → persist `{ orderId, token }` in `sessionStorage`, switch to the status screen.

- [ ] **Step 5: Status screen**

Poll `GET ${API_URL}/table-orders/${orderId}/status?token=${TOKEN}` every 15 s.
Map `kitchenStatus` → **Přijato** / **Připravuje se** / **Hotovo**. Stop polling on `completed`.
Show the total and, permanently, **"Zaplatíte u obsluhy"** (spec D3 — there is no online payment in this flow).
Also stop polling when the tab is hidden (`document.visibilityState`) and resume on focus — this runs on a guest's battery.

On page load, if `sessionStorage` holds an order for this token, go straight to the status screen. A guest who refreshes must not land in an empty cart.

- [ ] **Step 6: Verify by hand**

Get a real URL from `GET /api/table-qr-tokens` (needs a staff session) or mint one:

```bash
node -e "process.env.JWT_SECRET=process.env.JWT_SECRET||'dev'; const t=require('./src/server/table-token'); console.log(t.mintTableToken('<a real fileId from the DB>'))"
```

Open the URL in a mobile-sized viewport and check: table name shown, all three menu sections, combo customize works, cart totals match, submit succeeds, status screen appears and updates when the kitchen marks the order complete.

- [ ] **Step 7: Commit**

```bash
git add src/html/table.html src/js/table-order.js src/css/table-page.css
git commit -m "feat(table-qr): guest self-order page"
```

---

## Task 6: Admin QR panel, print sheet, settings UI and kitchen badge

**Files:**
- Modify: `src/js/inner.js`, `src/css/inner.css`, `src/js/kitchen.js`
- Read first: `src/js/inner.js:1648-1760` (`renderDetail`), `src/js/inner.js:1505-1530` (`renderPayOnlineStarted` — the existing `QR.renderSVG` call site), `src/js/inner.js:3737` (`renderDeliveryHoursTable`), `src/js/kitchen.js:232` (`renderIndoorCard`).

- [ ] **Step 1: Delete the placeholder note**

Remove the `futureNote` block at `src/js/inner.js:1737-1740` — the three lines creating the `inn-future-note` div and appending it. This feature is what that note was waiting for. Remove the now-unused `.inn-future-note` rule from `inner.css` if nothing else uses it.

- [ ] **Step 2: Add the QR panel to the table detail view**

In `renderDetail(name)`, after the bookings panel, add a *QR kód pro objednávky u stolu* panel containing:
- the code, via `QR.renderSVG(url, { ecLevel: 'M', scale: 5 })` — the same call already used at `inner.js:1517`;
- the full URL as selectable text beneath it;
- a **Tisknout** button.

Tokens come from `GET ${API_URL}/table-qr-tokens` (staff-authenticated, via the existing `apiFetch`), fetched once and cached for the view. Match this table by `className`.

- [ ] **Step 3: Add the "print all tables" sheet**

A **"Tisknout QR kódy všech stolů"** button in the tables/Rozložení view opens a print-friendly window: one card per table, each with the table name, its QR, and the caption *"Naskenujte a objednejte"*. Size the cards for cutting out and standing on tables, and add `@media print` rules so the browser's print dialog produces a usable sheet.

- [ ] **Step 4: Add the settings UI**

In the Nastavení view, next to the delivery hours table, add an *Objednávky u stolu* section: an `enabled` checkbox plus a per-day hours table. Clone `renderDeliveryHoursTable()` as `renderTableOrderingHoursTable()` — the shapes are identical (spec §7).

> The settings panel PUTs back the whole object it GET-ed, so this section only needs to read and write `settings.tableOrdering`; Task 2 already taught the schema to accept it.

- [ ] **Step 5: QR badges**

`src/js/kitchen.js`, in `renderIndoorCard()` (~line 249): add a `QR` badge next to `kit-ticket__source` when `order.source === 'qr'`. Style it in `kitchen-page.css`.

`src/js/inner.js`, in `renderWalkinOrderRow()` (~line 1294): same badge.

Both guard on `order.source === 'qr'` explicitly — rows predating this feature have **no** `source` field and must render exactly as they do today.

- [ ] **Step 6: Verify by hand**

Log into the admin panel and check: the placeholder note is gone; a table's detail view shows a scannable QR (scan it with a real phone); the print sheet renders every table; the settings section saves and survives a reload (**this is where a missed `settingsSchema` entry from Task 2 shows up as a 400**); a QR-placed order shows the badge on both the kitchen board and the admin overview, and a waiter-placed order does not.

- [ ] **Step 7: Commit**

```bash
git add src/js/inner.js src/css/inner.css src/js/kitchen.js src/css/kitchen-page.css
git commit -m "feat(table-qr): admin QR codes, print sheet, settings and kitchen badge"
```

---

## Task 7: Test harness and smoke tests

**Files:**
- Create: `tests/helpers/harness.js`, `tests/smoke/table-orders.test.js`
- Modify: `package.json`

**This repo has no test harness yet** — `tests/` holds only unit tests plus one EET integration test. Building it is part of this task.

- [ ] **Step 1: Write the harness**

`tests/helpers/harness.js` must:
- probe a free port (bind `net.createServer()` to port 0, read the assigned port, close);
- spawn `src/server/server.js` as a child process with `PORT`, `SQLITE_PATH` pointing at a fresh temp file under `os.tmpdir()`, `JWT_SECRET` and `CSRF_SECRET` set to fixed test values;
- **force-blank `TWILIO_*`, `SMTP_*` and `GOPAY_*`** so a test run can never send a real SMS or reach a payment gateway;
- wait for the server to answer `GET /` before resolving;
- expose `start()` → `{ baseUrl, api, stop() }`, with `stop()` killing the child and deleting the temp DB.

Seed fixtures **after** boot — the server's `initializeData` owns the schema.

- [ ] **Step 2: Write the smoke tests**

`tests/smoke/table-orders.test.js`. Seed a table (`POST /api/timetables` with an admin session, or write directly to the temp DB), mint a token with `table-token.js`, then assert:

| Case | Expected |
|---|---|
| `GET /table-session/<bogus>` | 404 |
| `GET /table-session/<valid>` after deleting the table | 410 |
| `POST /table-orders` with `tableOrdering.enabled: false` | 403 |
| `POST /table-orders` outside today's hours | 403 |
| `POST /table-orders` happy path | 200, and the row appears in `GET /indoor-orders` with `source: "qr"` |
| `POST /table-orders` with a client-supplied `total` | 400 (schema is `.strict()`) |
| `POST /table-orders` with `offlineSale: true` | 400 (same) |
| Happy-path total | equals the server-derived price, **not** anything the client sent |
| `GET /table-orders/:id/status` with table A's token for table B's order | 404 |
| 13 orders from one table inside the window | the 13th is 429 |

- [ ] **Step 3: Wire up the script**

In `package.json`:

```json
"test:smoke": "node --test \"tests/smoke/**/*.test.js\""
```

> A bare directory argument to `node --test` fails with MODULE_NOT_FOUND on recent Node. The glob form is required.

- [ ] **Step 4: Run everything**

```bash
npm run test:unit
```

```bash
npm run test:smoke
```

Expected: both PASS. Paste the real output into the task report — a claim of "tests pass" without it is not evidence.

- [ ] **Step 5: Commit**

```bash
git add tests/helpers/harness.js tests/smoke/table-orders.test.js package.json
git commit -m "test(table-qr): smoke harness and end-to-end route coverage"
```

---

## Self-review notes

Spec coverage check — every spec section maps to a task:

| Spec § | Task |
|---|---|
| §4.1 token | T1 |
| §4.2 order shape | T3 step 2, T3 step 3 |
| §5.1 page route | T3 step 4 |
| §5.2–5.4 public routes | T3 step 3 |
| §6 anti-abuse (limiters) | T2 step 5, mounted T3 step 3 |
| §6 layer 4 (staff visibility) | T5 step 1 (table name), T6 step 5 (badges) |
| §7 settings + hazard | T2 steps 1–3, T6 step 4 |
| §8.1 menu-catalog | T4 |
| §8.2 guest page | T5 |
| §8.3 admin | T6 steps 1–4 |
| §8.4 kitchen | T6 step 5 |
| §9.1 unit tests | T1 |
| §9.2 smoke tests | T7 |
| §9.3 live | post-implementation, owner-run |
| §11 `.env.example` | T1 step 5 |
