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

```bash
npm ci
npm start                      # serves everything on PORT (default 3000)
node deploy/create-admin.js "Jméno" login "heslo"   # bootstrap the first admin
```

Without Twilio/GoPay/SMTP credentials the app runs in fallback mode: SMS codes and e-mails are logged to the console, payments are simulated. See `deploy/env.example` for every environment variable.

## Production

- `deploy/NASAZENI.md` — Czech runbook: Ubuntu VPS from zero (systemd + Caddy + HTTPS + backups)
- `deploy/GO-LIVE-CHECKLIST.md` — Czech go-live checklist: GoPay merchant account, Twilio sender, DNS, legal review, test matrix
- `docs/CZ-PAYMENTS-SETUP.md` — payments/receipts specifics

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

## Design docs

Specs and implementation plans live in `docs/superpowers/specs/` and `docs/superpowers/plans/` — start with `2026-07-19-go-live-operations-design.md`.
