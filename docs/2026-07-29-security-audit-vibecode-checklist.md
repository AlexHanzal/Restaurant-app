# Security audit — "10 holes in almost every vibecoded app" checklist

Date: 2026-07-29
Target: `code/Landing-app-1-main` (restaurant reservation + delivery app)
Method: source review of `src/server/*.js` (all 11 files), `src/js/*.js`, `package.json`, static-serving config.
**Not** runtime-verified — `npm run dev` cannot start in this workspace (OneDrive cloud-only `node_modules`).
Every finding below is a claim about the code as written, with file:line.

---

## Verdict up front

This app is **far better hardened than the post assumes**. It is not a Supabase/Firebase app, so
holes #2, #6 and #7 don't structurally exist, and there is no AI feature, so #10 doesn't exist.
The three that genuinely matter (#1 IDOR, #3 client-side pricing, #5 JWT) have all been
deliberately and correctly addressed — with the exception of **one route that was missed**.

| # | Hole | Status |
|---|------|--------|
| 01 | IDOR | **1 real hole** (`/api/stats/sales`) + 2 role-separation gaps |
| 02 | Open database (RLS off) | N/A — SQLite behind an API, no public DB key |
| 03 | Price decided in browser | Clean — server always re-prices |
| 04 | No rate limiting on expensive endpoints | Mostly good — **no global spend cap** |
| 05 | Forgeable JWTs | Clean — genuinely well done |
| 06 | RLS on but leaky | N/A |
| 07 | Listable storage bucket | N/A, **but backend source is publicly served** |
| 08 | Pre-auth expensive routes | Partially — see #04 |
| 09 | SSRF | Clean — no user-supplied URL is ever server-fetched |
| 10 | Prompt injection | N/A — no AI/LLM anywhere in the codebase |

---

## FINDINGS

### F1 — `GET /api/stats/sales` has no authentication (HIGH)

`src/server/server.js:3615`

```js
app.get(`${api}/stats/sales`, (req, res) => {   // ← no requireAuth, no requireAdmin
```

Every other read route that touches business data is guarded (`/api/orders` → `requireAuth`,
`/api/receipts` → `requireAuth`, `/api/export` → `requireAdmin`, `/api/security/login-audit` →
`requireAdmin`). This one was missed.

**What leaks:** per-dish sales counts and revenue, aggregated across all three order channels
(delivery, table reservations, walk-in), for an attacker-chosen window. `days` is unbounded
upward (`Math.max(1, parseInt(req.query.days,10) || 30)`, line 3617), so
`GET /reservation/api/stats/sales?days=99999` returns the restaurant's entire revenue history.

**Why it matters:** this is exactly the post's Number 01 — the backend trusts that only the
admin panel would ever call this route, instead of checking who is calling. No login, no cookie,
no guessing required. A competitor can read your full menu-level revenue breakdown.

**Fix:** one word.

```js
app.get(`${api}/stats/sales`, requireAuth, (req, res) => {
```

Use `requireAdmin` if revenue figures shouldn't be visible to drivers (see F2).

---

### F2 — Drivers have staff-wide read/delete access (MEDIUM)

`requireAuth` means "any valid session" — driver, waiter, or admin. These routes use it:

| Route | Line | What a driver account can do |
|---|---|---|
| `GET /api/orders` | 2990 | Read every delivery order: name, address, PSČ, phone, note |
| `GET /api/users` | 3739 | List every staff account — name, abbreviation, `isAdmin`, `isDriver` |
| `GET /api/receipts` | 3672 | Read every receipt ever issued |
| `DELETE /api/orders/:id` | 3043 | Delete any order |
| `DELETE /api/indoor-orders/:id` | 3339 | Delete any table order |

`GET /api/users` is the sharpest of these: it hands a low-trust account the exact login
identifiers (`abbreviation`) plus which of them are admins — the recon step before a credential
attack. Passwords are correctly stripped (line 3741), so this is enumeration, not disclosure.

**Why it matters:** the post's framing is "the backend trusts the ID in the URL". The variant
here is "the backend trusts that a session is a session" — a driver's phone, left on a table or
lost, is a full read of the customer database plus a delete button.

**Fix:** `GET /api/users` → `requireAdmin`. The two `DELETE` routes → `requireAdmin`, or add a
`requireStaff` middleware (`isAdmin || !isDriver`) if waiters need to delete but drivers don't.

---

### F3 — The entire backend source is served as a static file (MEDIUM)

`src/server/server.js:51` sets `frontendPath: "src"`, and line 2050 mounts

```js
app.use(base, express.static(frontendPath, staticOptions));
```

`src/server/` sits **inside** `src/`, so it is served too. These are publicly fetchable:

```
/reservation/server/server.js      /reservation/server/auth.js
/reservation/server/csrf.js        /reservation/server/security.js
/reservation/server/gopay.js       /reservation/server/db.js
/reservation/server/validation.js  /reservation/server/config_help.txt
/reservation/server/ip.sh          /reservation/server/ip.bat
```

The minify middleware (`src/server/minify.js:100`) will even esbuild them on the way out. Its
traversal guard is correct — but no traversal is needed, these paths are legitimately under the
root. `express.static` does not do directory listing, so this isn't the post's Number 07
exactly; it's the same *shape* of problem (the drawer is unlocked, you just need to know the
file names, and the file names are conventional).

**No credentials leak** — every secret is read from `process.env` (`JWT_SECRET`, `CSRF_SECRET`,
`TWILIO_*`, `GOPAY_*`, `SMTP_*`), and none are hardcoded. What leaks is the complete route map,
which routes are unauthenticated, `LOCKOUT_THRESHOLD`/`LOCKOUT_DURATION_MS` defaults, the
rate-limit windows, and the ID-generation scheme — i.e. everything an attacker would otherwise
have to probe for. It also makes F1 trivially discoverable.

**Fix:** move the frontend to its own directory (`src/public/` already exists but holds only a
README), or set `frontendPath` to a directory that doesn't contain `server/`. Quickest
stopgap — mount a 404 for `/server/*` before `express.static`, the same pattern already used for
`blockRawLegalTemplate` at line 2043.

---

### F4 — `returnUrl` is attacker-controlled and unvalidated (MEDIUM)

`src/server/validation.js:281, 337, 342`:

```js
returnUrl: z.string().max(500).optional(),
```

Length-checked only. It flows to `gatewayCallbackUrls()` (`server.js:250-256`) and is handed to
GoPay verbatim as the post-payment redirect target on three routes: `POST /api/orders` (2878),
`POST /api/kitchen/reservation/pay-online` (3214), `POST /api/indoor-orders/:id/pay-online` (3299).

**The attack:** attacker places a real order with `returnUrl: "https://evil.example/platba"`,
gets back a genuine `gate.gopay.cz` redirect URL, and shares that link. The victim sees a real
GoPay page on a real GoPay domain, pays, and is then dropped on the attacker's page — which can
present a convincing "platba selhala, zadejte kartu znovu" form. The app's own CSP
(`formAction: 'self'`, line 1404) does nothing here, because the redirect is issued by GoPay,
not by this server.

Severity is capped by the fact that the attacker pays for their own order to set it up, and by
whatever validation GoPay applies to return URLs on its side (unverified).

**Fix:** allowlist it against the app's own origin.

```js
function safeReturnUrl(req, candidate) {
    if (!candidate) return null;
    const own = `${req.protocol}://${req.get("host")}`;
    try { return new URL(candidate, own).origin === own ? candidate : null; }
    catch { return null; }
}
```

---

### F5 — No global cap on SMS spend (MEDIUM — this is the post's Number 08)

Two unauthenticated routes send a real Twilio SMS on every call:
`POST /api/reservations/send-code` (2459) and `POST /api/reorder/send-code` (2676).

The layering here is genuinely good, and better than most:

- `smsIpLimiter` — 20/hour per IP (`security.js:75`)
- `smsPhoneLimiter` — 5/hour per phone number (`security.js:89`)
- both routes deliberately **share** the same limiter instances, so reorder can't be used to top
  up a bombing run the reservation limiter already capped (comment at 2669-2675)
- `resendCooldownMs` — 30s between consecutive sends to one number
- `apiLimiter` — 300/15min per IP across all of `/api`

What's missing is the last line the post specifically calls for: *"put a hard global daily cap
on spend so the worst case is capped, not infinite."* Every limiter here is per-IP or per-phone.
A botnet, or anything with a pool of IPs, multiplies straight through: 20 SMS/hour/IP × N IPs,
with no ceiling anywhere. There is no counter of "SMS sent today" and no kill switch.

**Fix:** a module-level daily counter in `security.js`, reset at midnight, that makes both
`send-code` routes return 503 past a configured `SMS_DAILY_CAP` (set it to ~3× a busy day's real
volume). Twilio's own account-level spend alerts are worth turning on as a second net.

**Related, smaller:** `POST /api/indoor-orders/:id/pay-online` (3285) is unauthenticated and
creates a `payments` row plus a real GoPay API call per request. It's bounded by `apiLimiter`
and needs a valid 12-char order id, so it's a nuisance rather than a hole — but it is an
unauthenticated route that costs you a third-party API call.

---

### F6 — `data/` is not in `.gitignore` (LOW, situational)

`.gitignore` contains exactly one line: `.superpowers/`. `data/app.db` — the live SQLite
database holding customer names, addresses, phone numbers, order history and bcrypt password
hashes — is not excluded, nor are the `.bak-*` and `.orphan-*` copies sitting next to it
(`data/` listing shows 7 files, incl. a 144 KB orphaned WAL).

This directory is not currently a git repo, so nothing is committed today. But the folder name
(`Landing-app-1-main`) is the shape of a GitHub zip download, which suggests an upstream repo
with this same `.gitignore`. If that repo exists and is or becomes public, the customer database
goes with it.

**Fix:**

```
data/
node_modules/
.env
*.db
*.db-wal
*.db-shm
```

---

## WHAT'S ALREADY RIGHT

Worth stating explicitly, because these are the holes the post says almost everyone has, and
this app doesn't:

**Number 03 (price decided in the browser) — clean.** Every order path re-prices server-side
against the live menu and ignores whatever the client sent. `POST /api/orders:2790`
(`priceOrderItems`), the delivery fee re-quoted at 2800 (`quoteDelivery` — the client's copy of
that logic is explicitly marked advisory), `POST /api/indoor-orders:3236`, and the reservation
flow prices at `send-code` time and holds the result **server-side** in `pendingVerifications`
so it can't be tampered with between the two steps (2506-2513). `validation.js:279` even keeps
accepting a client `total` field and comments it as "legacy/unused — server always recomputes".

**Number 05 (forgeable JWTs) — clean, and better than "clean".** No hardcoded fallback secret;
production hard-fails at startup without `JWT_SECRET` (`auth.js:62-78`). Cookie is httpOnly +
`sameSite:"strict"` + `secure` + `__Host-` prefix in production (`auth.js:51, 145`). bcrypt cost
12. 12h TTL.

The part that stands out: the 90-day customer reorder token is signed with
`deriveSecret("reorder-token-v1")` — an HMAC-derived key, **not** `JWT_SECRET`
(`auth.js:212`, `reorder.js:50`). The reasoning is written out at `auth.js:173-211`: a customer
can copy their own reorder cookie out of devtools and paste it in as `auth_token`, and if the
two shared a key that would verify against `requireAuth` and hand them the entire order list.
A different key fails at the *signature* level, so no future refactor can delete the check by
accident. `JWT_SECRET` is deliberately never exported. That is a threat model most production
codebases don't have.

**Number 01 (IDOR) — clean everywhere except F1.** The patterns that would normally be holes are
all closed:

- `GET /api/timetables/:name` (2229) is public, but unauthenticated callers get
  `sanitizeTimetableForPublic()` (866) — a whitelist that collapses every booking to
  `content: "obsazeno"`. Guest names, phones, preorders and receipt ids are staff-only.
- `GET /api/reorder/recent` (2731) takes the phone **from the verified token payload only** —
  there is no route anywhere that accepts a caller-supplied phone and returns order data.
- `POST /api/reorder/send-code` never queries the orders table at all, so it can't become an
  oracle for "has this person ordered here" — the guarantee is architectural, not phrasing.
- Public-by-id routes (`/api/receipts/:receiptId`, `/api/payments/:orderId/status`) rely on
  `generateFileId()`, which uses `crypto.randomInt` — 12 chars for order ids, 40 for receipt ids
  (`server.js:1543, 1005`). Not sequential, not guessable. The status route returns only payment
  fields, no PII.

**Number 09 (SSRF) — clean.** The only outbound `fetch()` in the whole server is
`gopay.js:64,104`, against a base URL derived from config, never from a request.

**Number 04 (rate limiting) — good, modulo F5.** Login: 8/15min per IP with
`skipSuccessfulRequests`, plus a cross-IP per-account lockout (6 failures → 15 min,
`security.js:110-148`) so a distributed attack on one account still locks. Plus a persisted
login audit log, plus `dummyCompare()` (`security.js:198`) running a real bcrypt against a fixed
hash so "no such user" and "wrong password" take the same time — closing the username
enumeration timing oracle.

**Number 10 (prompt injection) — N/A.** Grepped for `openai|anthropic|claude|gpt|prompt` across
`src/server/`: zero hits. No AI feature, nothing to inject into.

**Also solid, beyond the checklist:** signed double-submit CSRF tokens on every mutating
staff route (`csrf.js`, HMAC + `timingSafeEqual`); a default-deny CSP with **no**
`script-src 'unsafe-inline'` (the one inline script is allowlisted by SHA-256 hash, line 1392);
CORS reduced from `origin:"*", credentials:true` to a same-origin allowlist; consistent
`escapeHtml()` on both the server-rendered receipt page and every client `innerHTML` template
(`delivery.js`, `driver.js`, `kitchen.js`, `inner.js`); recursive prototype-pollution rejection
before any handler (`V.rejectDangerousKeys`, line 1882); a generic error handler that never
echoes stack traces; parameterized SQL throughout `db.js`; and a GoPay webhook that re-fetches
the real payment state from GoPay rather than trusting the notification body (2938-2950).

---

## Recommended order

1. **F1** — add `requireAuth`/`requireAdmin` to `/api/stats/sales`. One line, closes a live
   data leak.
2. **F3** — stop serving `src/server/`. Small config change, removes the map that makes
   everything else easier to find.
3. **F5** — global daily SMS cap. This is the one with an unbounded worst case attached to a
   real bill.
4. **F2** — tighten `GET /api/users` and the two `DELETE` routes to admin.
5. **F4** — allowlist `returnUrl` to the app's own origin.
6. **F6** — expand `.gitignore` before this ever reaches a remote.
