# Restaurant System

Web application for a Czech restaurant: table reservations with SMS verification, food delivery ordering with online payment (GoPay), and staff surfaces for admin, kitchen and delivery drivers. Vanilla JS frontend, Express + SQLite backend, no build step.

## Surfaces

| Path | Who | What |
|---|---|---|
| `/reservation/app` | customers | table reservation (7 days, SMS-verified, optional food preorder) |
| `/reservation/delivery` | customers | delivery ordering — cart, PSČ zone, delivery fee, polední menu, online/cash/card payment |
| `/reservation/admin` | owner/staff | tables, menu (incl. sold-out + daily specials), sales, receipts, users, **Nastavení** (hours, closed days, pause, delivery rules, notifications, business identity) |
| `/reservation/kitchen` | kitchen | ticket board for pending orders |
| `/reservation/driver` | drivers | claim + deliver orders, mark paid |
| `/reservation/obchodni-podminky`, `/ochrana-osobnich-udaju`, `/reklamace` | public | legal pages (templates — lawyer review required before go-live) |

## Quick start (development)

**Node 20–26.** The lower bound is better-sqlite3, which ships prebuilt
binaries only for 20.x and up; the upper bound is the newest major it
currently builds for. `node --test` with glob patterns (used by the test
scripts) needs 18+.

```bash
npm ci
npm start                      # serves everything on PORT (default 3000)
npm test                       # unit + smoke
```

Without Twilio/GoPay/SMTP credentials the app runs in fallback mode: SMS codes and e-mails are logged to the console, payments are simulated. See `.env.example` in the repo root for every environment variable.

### The first admin account

The app is installed together with a database that already contains one, so
normally there is nothing to do here.

Worth knowing if you ever start from a genuinely empty `data/app.db`: there is
no bootstrap script in this repo, and no way in through the API — `POST
/api/users` is behind `requireAdmin`, and `initializeData()` seeds only the
menu and combos singletons, never a user. Either restore a database that has
an admin, or insert a row into the `users` collection by hand with a bcrypt
hash at cost 12 (the shape is `{ id, abbreviation, password, name, isAdmin,
isDriver }` — see `src/server/auth.js` and the `seedAdminUser` helper in
`tests/smoke/table-orders.test.js` for a working example).

## Nasazení pro další restauraci

Všechno, co se liší restauraci od restaurace, je v jednom souboru:

```bash
cp restaurace.config.example.js restaurace.config.js
```

Vyplň ho (název, barvy, IČO, co si zákazník koupil, výchozí ceny za rozvoz)
a restartuj server. Soubor je okomentovaný a na konci má seznam šesti věcí,
které se musí udělat ručně — vytvořit přihlášení, naimportovat menu, nakreslit
rozložení stolů a tak dál.

Hesla a klíče do něj nepatří — ty zůstávají v `.env` (vzor v `.env.example`).

Když soubor neexistuje, aplikace jede na výchozích hodnotách.

## Production

Set `TZ` (see `.env.example`). It defaults to `Europe/Prague`, which is what
this restaurant wants; the boot log prints the zone in effect, and it is worth
checking after the first deploy. Opening hours, the polední-menu window, which
day a sale lands on in the sales view and when reservation reminders fire are
all local-time rules, so a wrong zone shifts every one of them silently.

### Run exactly one instance

This app is single-instance by design. Sessions are stateless JWTs and would
survive being spread across processes, but several things behind them are
plain in-memory state and would not: the per-account login lockout map and the
rate-limit stores (`src/server/security.js`), the pending SMS verification map
(`src/server/server.js`), and the connected-client set behind
`broadcastBoardEvent()`. With two instances, lockouts and rate limits would
apply per process, and a kitchen board would only receive live updates for
orders that happened to land on the instance it is connected to.

Scale by giving the one instance more resources. Sharing that state (Redis or
equivalent) is the prerequisite for anything else, and `data/app.db` — a
single SQLite file — would need addressing at the same time.

**The deployment runbooks are not in this repository.** `PRED-NAHRANIM.md`
explains why: `deploy/NASAZENI.md` (Ubuntu VPS runbook — systemd + Caddy +
HTTPS + backups), `deploy/GO-LIVE-CHECKLIST.md` (GoPay merchant account,
Twilio sender, DNS, legal review, test matrix), `docs/CZ-PAYMENTS-SETUP.md`,
`deploy/create-admin.js`, `deploy/backup.sh`, `deploy/Caddyfile`,
`deploy/restaurace.service` and `tools/` were all cloud-only OneDrive stubs
that could not be read when this repo was assembled, so they were deliberately
left out rather than published unread. They are still in the original
`Landing-app-1-main` folder — make them available offline in Explorer ("Always
keep on this device"), check them for real credentials, and only then add them
here.

## EET 2.0 — elektronická evidence tržeb

Every confirmed sale (order, indoor bill, reservation deposit, and refund) is
reported to Finanční správa. Implementation: `src/server/eet.js` (protocol —
canonical XML, WS-Security signing, send) and `src/server/eet-queue.js`
(persistence, retry, health). The EET-specific routes and config live in the
"EET" regions of `src/server/server.js`.
Design: `docs/superpowers/specs/2026-07-31-eet2-integration-design.md`.
Plan: `docs/superpowers/plans/2026-07-31-eet2-integration.md`.

### Environment variables

| Variable | Default | Note |
|---|---|---|
| `EET_ENABLED` | `false` | Master switch. `false` = sales are logged, not sent. |
| `EET_PLAYGROUND` | `true` | **Safe default.** `true` = playground (`pg.trzbyeet.gov.cz`), `false` = production (`trzbyeet.gov.cz`). Going live is this one switch. |
| `EET_EIC` | falls back to `BUSINESS_DIC` | `CZ` + 8–10 digits. |
| `EET_ID_JEDNOTKY` | *(none — required)* | Assigned in MOJE daně / DIS+, not chosen. Must be at least 2 digits, last digit 1–4. A malformed value (e.g. `1`) is still accepted by the tax authority but comes back as warning code 6 — see `tests/integration/eet-playground.test.js`. |
| `EET_CERT_PEM` | `./secrets/eet-cert.pem` | PEM certificate, converted from the `.p12` — see below. |
| `EET_KEY_PEM` | `./secrets/eet-key.pem` | PEM private key, converted from the `.p12`. |
| `EET_KEY_PASSPHRASE` | *(none)* | Only needed if the converted key is left encrypted (`-nodes` in the command below leaves it unencrypted, so normally empty). |
| `EET_TIMEOUT_MS` | `5000` | Mezní doba odezvy. Legal minimum is 2000ms. |
| `EET_RETRY_INTERVAL_MS` | `60000` | How often the background retry worker ticks. |
| `EET_POKL_DELIVERY` / `EET_POKL_INDOOR` / `EET_POKL_RESERVATION` | `DELIVERY` / `INDOOR` / `RESERVATION` | One EET cash register (`id_pokl`) per sales channel. |

### Certificate setup

Node's `node:crypto` cannot read `.p12` (PKCS#12), so the pokladní certifikát
issued by MOJE daně must be converted to PEM once, at deploy time:

```bash
mkdir -p secrets
openssl pkcs12 -in pokladni.p12 -clcerts -nokeys -out secrets/eet-cert.pem
openssl pkcs12 -in pokladni.p12 -nocerts -nodes  -out secrets/eet-key.pem
chmod 600 secrets/*.pem
```

Both commands prompt for the `.p12` import password. `secrets/` is gitignored
— never commit these files. (Verified against a locally-generated test
`.p12`/PEM pair and `eet.loadCredentials()` while writing this doc.)

### Testing against the playground

The live integration test is opt-in (skipped by default so `npm test` stays
offline and fast). It needs the shared EET playground certificates from
<https://eet.gov.cz/pro-vyvojare/>, converted the same way as above:

```bash
EET_LIVE_TEST=1 EET_TEST_CERT=secrets/playground/eet-cert.pem \
  EET_TEST_KEY=secrets/playground/eet-key.pem \
  node --test tests/integration/eet-playground.test.js
```

Playground POKs always end in `-ff` and the response carries `test="true"`;
receipts issued while `EET_PLAYGROUND=true` render a visible "TESTOVACÍ
PROSTŘEDÍ — NEPLATNÁ ÚČTENKA" marker instead of "Tržba evidována", so a
playground receipt can never be mistaken for a real one.

### Monitoring

`GET /api/eet/health` (staff auth required) returns:

```json
{
  "enabled": true,
  "mode": "playground",
  "pending": 0,
  "confirmed": 128,
  "failed": 0,
  "overdue": 0,
  "oldestPending": null,
  "lastError": null
}
```

**`overdue > 0` means at least one sale has missed its legal 48-hour EET
reporting deadline (ZoET) and needs manual attention right away.** The
background retry worker also logs a `console.error` warning for any record
within 6 hours of that deadline, so `overdue` reaching a nonzero value on the
dashboard should be treated as already-late, not as an early warning.

### Partial refunds are not reported automatically

GoPay's API does not expose the actual refunded amount on a partial refund —
only the original sale total. Rather than guess (and silently under-report or
over-report the storno), the code deliberately skips the automated EET report
for a partial refund: it creates a zero-total marker receipt for the audit
trail and logs, at `console.error` level:

```
EET: PARTIAL refund on reservation <fileId>/<dateStr>#<dayIndex> (original receipt
<number>, original total <total> Kč) needs MANUAL EET storno reporting — GoPay
does not expose the refunded amount, so no automated trzba was generated.
Marker receipt: <number> (<id>).
```

Anyone monitoring server logs (or building alerting on them) must treat this
line as an action item: **manually report the storno's real amount to
Finanční správa** (e.g. through the tax portal's own web form) once the true
refunded amount is known. A *full* refund (the whole original sale reversed)
does not have this problem — GoPay confirms the full original amount, so that
case is reported automatically as a negative trzba.

### Every instrument is reported, including bank transfers — by design

`isEvidovanaTrzba(paymentMethod, gopayInstrument)` in `src/server/eet-queue.js`
(currently `return true;` unconditionally, lines 32–34) decides whether a
confirmed payment gets an EET record enqueued at all. GoPay's checkout offers
four instruments (`DEFAULT_PAYMENT_INSTRUMENTS` in `src/server/gopay.js`):
`PAYMENT_CARD`, `GPAY`, `APPLE_PAY`, and `BANK_ACCOUNT` (bank transfer). Right
now every one of them — plus every other `paymentMethod` this app has — is
reported to Finanční správa as an evidovaná tržba, with no branching on
instrument at all.

This is the owner's explicit decision, made 2026-07-31, not an oversight:
whether a GoPay `BANK_ACCOUNT` bank transfer legally counts as an evidovaná
tržba is a tax question the code cannot answer on its own, so it currently
reports it rather than guessing it doesn't. If the restaurant's accountant
later determines bank transfers (or any other instrument) should be
excluded, narrowing the reporting is a one-line change in one place: replace
`return true;` in `isEvidovanaTrzba` (`src/server/eet-queue.js`, lines 32–34)
with logic that inspects `paymentMethod`/`gopayInstrument`.
`tests/unit/eet-queue.test.js` already calls the function with both
arguments, so a narrowed implementation has a test in place to update.

## Design docs

Specs and implementation plans live in `docs/superpowers/specs/` and
`docs/superpowers/plans/`, one pair per feature — floorplan, room-shape
editing, EET 2.0, offline-first POS, sales stats, table-QR self-order. Start
with `docs/superpowers/specs/2026-08-04-table-qr-self-order-design.md`, the
most recent one.

Note that only the readable subset came across when this repo was assembled
(again, see `PRED-NAHRANIM.md`), so some code comments cite design docs that
are not here — `2026-07-19-go-live-operations-design.md`,
`2026-07-22-combo-menus-design.md` and `2026-07-25-reorder-design.md` among
them. The code is the source of truth where they disagree.

`docs/2026-07-29-security-audit-vibecode-checklist.md` is the standing
security audit; findings referenced as "audit 2026-07-29, finding F<n>" in
source comments point at it.
