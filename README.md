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

## Design docs

Specs and implementation plans live in `docs/superpowers/specs/` and `docs/superpowers/plans/` — start with `2026-07-19-go-live-operations-design.md`.
