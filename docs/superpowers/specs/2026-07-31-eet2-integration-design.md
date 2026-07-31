# EET 2.0 integration — design

Date: 2026-07-31
Status: approved
Interface version: EET datové rozhraní **v4.1** (`http://fs.gov.cz/eet/schema/v4`)

## 1. Problem

The restaurant is going live and takes real money through three channels —
delivery, walk-in tables, and reservation food orders — settled by cash, card
on delivery, card terminal, or online card via GoPay. Every one of those is a
sale that must be reported to Finanční správa under EET 2.0 before the receipt
is handed to the customer.

Nothing in the app talks to EET today.

The good news is that the receipt system already solves the hardest part.
`createReceiptForOrder()` (`src/server/server.js`) is a single funnel that
fires **exactly once, at exactly the moment a payment is confirmed**, and is
already idempotent against double mark-paid. That is precisely the EET hook
point, and it means this integration attaches at one place rather than five.

Its five call sites:

| Path | Kind | Payment method |
|---|---|---|
| GoPay webhook → `applyGatewayPaymentState` | delivery, indoor | `online_card` |
| GoPay webhook → reservation slot | reservation | `online_card` |
| `POST /orders/:id/mark-paid` | delivery | cash / card-on-delivery |
| `POST /indoor-orders/:id/mark-paid` | indoor | cash / card terminal |
| `POST /kitchen/reservation/mark-paid` | reservation | cash |

### 1.1 What changed from EET 1.0

Anyone porting prior EET knowledge should read this first. Interface v4.1 is
drastically smaller than 1.0:

- **BKP and PKP are gone.** There is no `KontrolniKody` element at all.
- **The VAT breakdown is gone.** No `zakl_dan1`, `dan1`, and so on. A sale
  carries only its total.
- `dic_popl` became **`eic_popl`** (pattern `CZ[0-9]{8,10}`).
- `id_provoz` became **`id_jednotky`**.

A sale is now just `eic_popl` + `id_jednotky` + `id_pokl` + `porad_cis` +
`dat_trzby` + `celk_trzba`. Most of the cryptographic receipt-code machinery
from 1.0 simply does not exist any more.

## 2. Decisions taken

| Question | Decision |
|---|---|
| Deployment | Real restaurant, going live. Production-grade from day one. |
| Bank transfers (GoPay `BANK_ACCOUNT`) | **Report everything** — no instrument-based exclusion. |
| Register split | **Three registers**, one per channel. |
| Mezní doba odezvy | **5 seconds**, then issue without POK and queue. |
| Implementation | **Zero new dependencies** — canonical-by-construction XML, PEM certificates. |

### 2.1 Open question — blocking go-live, not implementation

EET 2.0 removed BKP/PKP, which under EET 1.0 were what a receipt printed when
the service could not be reached in time. **What a receipt must display when
no POK was obtained is a ZoET §20 question that the interface specification
does not answer.**

This design puts that value in exactly one place (`renderReceiptHtml`, the
`eet` block) so it can be filled in once the restaurant's accountant confirms
it. Everything else can be built and tested without the answer.

Similarly, whether a bank transfer is legally an *evidovaná tržba* is a tax
question, not a technical one. The decision above (report everything) is the
owner's, taken knowingly; §5.4 keeps it to a one-line change.

## 3. Module

One new file, `src/server/eet.js`, shaped deliberately like `gopay.js` —
stateless with respect to credentials, taking a config object as its first
argument, with no hidden dependency on `server.js`:

```js
buildTrzbaBody(sale)              // → canonical XML string. Pure. No crypto, no I/O.
buildSignedEnvelope(body, creds)  // → full SOAP envelope with WS-Security header
sendTrzba(config, sale)           // → { pok, uuidZpravy, warnings, raw }
verifyConnection(config)          // → overeni="true" ping, for health checks
classifyError(code)               // → "retry" | "terminal"
```

The split is load-bearing. `buildTrzbaBody` is a pure string function, so the
one genuinely risky part of this design — hand-rolled canonicalisation — gets
golden-file tests with no crypto and no network in the way.

### 3.1 Why no dependencies

The project convention (see the `gopay.js` header) is built-in `fetch` and no
SDKs. Two gaps have to be bridged to hold that line:

**No XML canonicalisation in the standard library.** EET requires Exclusive
C14N + RSA-SHA256 over `soap:Body`. Rather than canonicalise after building,
we **emit the body already in exclusive-canonical form** and digest those exact
bytes. This is safe because we author 100% of that XML: no user-controlled
markup ever enters it, and every attribute value is a UUID, ISO timestamp,
EIČ, decimal, or a string the XSD restricts to `[0-9a-zA-Z.,:;/#\-_ ]` — a
charset containing nothing XML-special. Attribute escaping is implemented
anyway, so the assumption failing later degrades to "still correct".

**No PKCS#12 support in `node:crypto`.** `createPrivateKey()` accepts PEM and
DER only, and the pokladní certifikát from MOJE daně arrives as `.p12`. The
certificate is therefore converted once at deploy:

```bash
openssl pkcs12 -in pokladni.p12 -clcerts -nokeys -out secrets/eet-cert.pem
openssl pkcs12 -in pokladni.p12 -nocerts -nodes -out secrets/eet-key.pem
```

If that deploy step proves troublesome, adding `node-forge` to read `.p12`
directly is a contained change affecting only credential loading.

### 3.2 Canonical form — the rules that must hold

Canonical XML is not "XML that looks tidy". The specific rules this code must
obey, each covered by a golden-file test:

- **No self-closing tags.** `<eet:Data/>` must be `<eet:Data></eet:Data>`.
- Attributes sorted by namespace URI, then local name.
- Namespace declarations precede attributes.
- No comments, no processing instructions, no inter-element whitespace.
- UTF-8, no BOM.
- `celk_trzba` serialised with **exactly two decimals** — the XSD pattern
  `((0|-?[1-9]\d{0,7})\.\d\d|-0\.(0[1-9]|[1-9]\d))` rejects `"349"`; it must
  be `"349.00"`.
- `dat_trzby` / `dat_odesl` must carry a timezone offset (`Z` or `±HH:MM`).

## 4. Configuration

Follows the dev-fallback pattern Twilio and GoPay already use: with
`EET_ENABLED=false` or a missing certificate, sends are logged to console
instead of transmitted, so `npm start` works locally with no certificate
present.

```
EET_ENABLED=false
EET_PLAYGROUND=true              # pg.trzbyeet.gov.cz vs production
EET_EIC=                         # falls back to BUSINESS_DIC
EET_ID_JEDNOTKY=                 # assigned in MOJE daně / DIS+
EET_CERT_PEM=./secrets/eet-cert.pem
EET_KEY_PEM=./secrets/eet-key.pem
EET_KEY_PASSPHRASE=
EET_TIMEOUT_MS=5000              # mezní doba odezvy
EET_RETRY_INTERVAL_MS=60000      # background retry scanner tick
EET_POKL_DELIVERY=DELIVERY
EET_POKL_INDOOR=INDOOR
EET_POKL_RESERVATION=RESERVATION
```

Endpoint (playground): `https://pg.trzbyeet.gov.cz/eet/services/EETServiceSOAP/v4`

`secrets/` is added to `.gitignore`. The repo has a security audit doc; a
committed pokladní certifikát would be a serious finding. The passphrase is
never logged, and the certificate never appears in error messages or in the
`raw` response stored on records.

`id_jednotky` is **assigned by the tax portal**, not chosen. It must have at
least two decimal digits and end in 1–4; a value like `1` is accepted but
returns warning code 6.

## 5. Data flow

**The queue is the source of truth. The synchronous send is only an
optimisation to get a POK onto the receipt before it prints.**

`createReceiptForOrder()` stays **synchronous** and gains one addition: it
writes an `eet_records` row in state `pending` alongside the receipt. It sends
nothing. Making it async would ripple through all five call sites and
`applyGatewayPaymentState`.

Sending is a separate `async sendEetForReceipt(receiptId)`, awaited by call
sites where a human is waiting:

```
mark-paid route ──┬─► createReceiptForOrder()   [sync, enqueues pending]
                  └─► await sendEetForReceipt() [5s budget]
                         ├─ POK returned  → state="confirmed", POK on receipt
                         └─ timeout/error → stays "pending", receipt without POK
```

The safety property: **a forgotten `await` at a call site becomes a latency
bug, never a compliance failure.** The background worker picks up anything
left `pending` regardless.

### 5.1 Storage

New collection `eet_records` (`COL.eetRecords`), keyed by `receipt.id`.
Reusing the receipt id gives idempotency for the common case for free —
calling `enqueue()` twice with the same `receipt.id` returns the existing
record untouched.

That is NOT sufficient on its own, though — it was falsified during
implementation. `createReceiptForOrder`'s lost-receipt-row fallback (a
receipt row that `existingReceiptId` pointed at has gone missing) mints a
**new** receipt with a **new** id, and if the normal enqueue path ran for
that new receipt, it would open a second, independent `eet_records` row —
new `uuidZpravy`, new `datTrzby` — for a sale that had already been queued
(and possibly already reported) under the old id. Same sale, reported twice.
`enqueue()`'s `supersedesReceiptId` option is the actual fix: when the
caller passes the old, lost receipt id alongside the new receipt, and a
prior `eet_records` row exists under that old id, `enqueue()` carries the
prior row's frozen identity (`uuidZpravy`, `datTrzby`, `poradCis`,
`celkTrzba`, `state`) forward under the *new* receipt's id and removes the
old row, rather than minting a fresh one. See the header comment on
`enqueue()` in `eet-queue.js` for the full reasoning, and its own note there
on the residual race this creates with an in-flight `sendOnce()` for the
superseded id (fixed by a re-existence check right before `sendOnce`'s final
persist).

```js
{
  id,                    // = receipt.id
  receiptId, receiptNumber,
  kind,                  // "delivery" | "indoor" | "reservation" | "refund"
  uuidZpravy,            // generated ONCE, reused on every retry
  eic, idJednotky, idPokl, poradCis,
  datTrzby,              // frozen at first attempt
  celkTrzba,             // number, not a string — formatted to two decimals
                          // only at the XML-building boundary (formatAmount
                          // in eet.js), never stored as formatted text
  prvniZaslani,          // true on first attempt, false on all retries
  state,                 // "pending" | "confirmed" | "failed"
  pok, warnings,
  attempts, lastAttemptAt, lastError,
  sentAt, deadlineAt     // datTrzby + 48h
}
```

### 5.2 Fields frozen across retries

These are the ones that cause silent revenue duplication if got wrong:

- **`uuid_zpravy`** is generated once and reused on every retry. A fresh UUID
  on retry reads as a *new sale*.
- **`dat_trzby`** is frozen at payment time, never `now()` at retry time.
- **`prvni_zaslani`** is `true` on the first attempt, `false` on every
  subsequent one.

Spec §4 states that the authority determines sale uniqueness from the
canonicalised values of the `<Data>` element, so a resent sale is recognised
as the same sale. That is the safety net beneath the retry queue — but it only
holds if the identity fields above stay frozen.

### 5.3 Field mapping

| EET | Source | Note |
|---|---|---|
| `eic_popl` | `EET_EIC`, falling back to `BUSINESS_DIC` | `CZ` + 8–10 digits |
| `id_jednotky` | `EET_ID_JEDNOTKY` | from DIS+; ≥2 digits ending 1–4 |
| `id_pokl` | per-channel env var | DELIVERY / INDOOR / RESERVATION |
| `porad_cis` | `receipt.number` | `2026-000001` — 11 chars, fits 25, charset legal |
| `dat_trzby` | `receipt.issuedAt`, milliseconds stripped by `enqueue()` | must match `\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(Z\|[+-]\d\d:\d\d)` — a timezone offset (`Z` or `±hh:mm`) and NO fractional seconds |
| `celk_trzba` | `receipt.total` | `.toFixed(2)` — exactly two decimals |

`receipt.issuedAt` is produced by `createReceiptForOrder` as
`new Date().toISOString()`, which always appends milliseconds
(`"...T10:00:00.731Z"`). The XSD pattern above forbids fractional seconds
outright, so `enqueue()` strips them — via a plain regex on the fractional-
seconds component only, not by round-tripping the value through
`new Date(...).toISOString()`, which would additionally rewrite any
non-UTC-offset timestamp (e.g. `"...+02:00"`) to UTC `Z` form. That
rewrite would still be XSD-legal, but it's an unnecessary change to a value
this module's whole contract is to freeze verbatim once assigned — so the
strip is scoped to exactly the milliseconds and nothing else. This
normalisation was added after a defect found in final review: every
fixture in the test suite already used a clean, millisecond-free
`issuedAt`, so nothing caught that `datTrzby` failed `assertEetDateTime` on
every real sale in production, permanently stuck each record `pending` (the
throw happens before there's a response to classify as `failed`) while the
receipt printed a false "reported" notice. See
`tests/unit/eet-queue-issuedat-normalisation.test.js`.

### 5.4 Which sales are reported

One predicate, one place:

```js
// Owner's decision (2026-07-31): report every confirmed payment regardless of
// instrument, including GoPay BANK_ACCOUNT transfers. Takes the arguments it
// would need so narrowing this later is a one-line change.
function isEvidovanaTrzba(paymentMethod, gopayInstrument) { return true; }
```

### 5.5 Refunds

`gopay.js` already exposes `refundPayment()`, and `applyGatewayPaymentState`
already handles `REFUNDED` — but issues no receipt today. A storno is an
evidovaná tržba with a **negative** `celk_trzba`, which `CastkaType` explicitly
permits (`minExclusive -100000000`).

A refund therefore mints a full **refund receipt** through
`createReceiptForOrder()` — same funnel, same idempotency, `kind: "refund"` —
rather than being special-cased. This means:

- It draws a fresh sequential number from `nextReceiptNumber()`, so
  `porad_cis` stays unique and traceable with no new numbering scheme.
- Its `eet_records` row is keyed by that new receipt's id, so a refund cannot
  collide with the original sale's record.
- `celk_trzba` is the negated original total; `dat_trzby` is the refund's own
  timestamp, not the original sale's.

The refund receipt stores `refundOf: <original receipt id>` so the pair can be
reconciled. Note this makes `kind` a four-value field on both receipts and
`eet_records` — `"delivery" | "indoor" | "reservation" | "refund"` — where
existing code assumes three. Every `kind` consumer must be checked during
implementation; `id_pokl` for a refund is the register of the original sale.

## 6. Error handling

The spec's error list (§3.5.4) splits into two categories. Conflating them is
the main way this fails in production — a queue that retries everything would
hammer the authority's endpoint for 48 hours over a signature bug while staff
see nothing.

| Code | Meaning | Handling |
|---|---|---|
| `-1` | Dočasná technická chyba | **Retry** |
| `8` | Not processed — technical or data error | **Retry** |
| `2` | Invalid XML encoding | **Terminal** — alert |
| `3` | Failed XSD validation | **Terminal** — alert |
| `4` | Invalid SOAP signature | **Terminal** — alert |
| `6` | Malformed EIČ | **Terminal** — alert |
| `7` | Message too large | **Terminal** — alert |
| `0` | Success — ověřovací mód only | Health check |

Transport-level failures (timeout, DNS, TLS, 5xx) are retryable. Codes
`-999…-2` and `9…999` are reserved for future use and are treated as
**terminal-but-loud** rather than silently retried.

**Warnings** (`kod_varov`) are non-fatal and arrive alongside a valid POK.
They are stored on the record and surfaced to staff, never treated as failure.

### 6.1 Retry worker

A `setInterval` scanner in the same shape as the existing reservation reminder
scanner, running every 60 seconds (`EET_RETRY_INTERVAL_MS`).

Backoff per record, from `lastAttemptAt`: 1 min, 5 min, 15 min, then hourly
until `deadlineAt`. Bounded and predictable — an outage produces roughly 50
attempts over 48 hours, not thousands.

Escalation is concrete, not aspirational:

- Any transition to `state: "failed"` (terminal code) logs at `console.error`
  with the receipt number, the EET code, and its text.
- A record still `pending` with under 6 hours to `deadlineAt` logs an error on
  every scan.
- `GET /api/eet/health` (staff-auth) returns counts by state, the oldest
  `pending` record, and the last error — so the condition is visible without
  reading logs.

Records that blow the deadline keep `state: "pending"`, retain their full
error history, and stay in the database permanently. They are never deleted
and never silently dropped.

## 7. Receipt changes

`receipt` gains an `eet` block:

```js
eet: { pok, uuidZpravy, datTrzby, mode, state }   // mode: "playground" | "production"
```

`renderReceiptHtml()` prints the POK when confirmed.

When `state` is `pending`, it renders the contents of a single module-level
constant:

```js
// §2.1 — EET 2.0 removed BKP/PKP, so there is no fallback code to print when
// the sale could not be reported in time. What ZoET §20 requires here is a
// question for the restaurant's accountant. This constant is that answer's
// only home; change it here and nowhere else.
const RECEIPT_EET_PENDING_NOTICE = "Tržba je evidována v běžném režimu.";
```

The placeholder text above is a **provisional default, not legal advice** —
it must be confirmed before go-live. Implementation proceeds without the
answer; only the string changes when it arrives.

Note the print button's CSP hash: `RECEIPT_PRINT_SCRIPT` is allow-listed by
exact SHA-256, and the hash is derived at startup from that constant. Adding
EET fields to the receipt **markup** is safe; changing that script constant
is not, and this design does not touch it.

## 8. Testing

Four layers, in the repo's existing `node --test` style under `tests/unit/`:

1. **Canonical XML golden files** — pure string in, string out. No crypto, no
   network. Covers every rule in §3.2: self-closing expansion, attribute
   ordering, namespace placement, two-decimal amounts, negative amounts for
   storno, timezone offsets.
2. **Signature round-trip** — sign a body, verify locally with
   `crypto.verify()` against the certificate's public key. Catches
   canonicalisation drift without the network.
3. **Queue state machine** — retryable vs terminal classification, UUID
   stability across retries, `prvni_zaslani` flipping, idempotency on double
   mark-paid, 48h deadline escalation.
4. **Live playground integration** — opt-in via env var so `npm test` stays
   offline and fast, using the three shared playground certificates
   (`CZ00000019`, `CZ8551015704`, `CZ683555118`).

Layer 4 is what makes approach A defensible: the playground is an
authoritative oracle. A wrong digest returns error code 4 immediately, so
canonicalisation correctness is *proven* rather than assumed. This was
verified end-to-end during design — a signed sale returned
`POK=…-ff test="true"` with a signed confirmation response.

### 8.1 Playground notes for whoever tests this

- Test certificates ship in `CAEET_Playground_2026_v1.zip` from eet.gov.cz,
  **including** the password file — no separate request needed.
- The playground accepts `dat_trzby` from 2026-07-01 00:00 onward.
- Maintenance window: Thursdays 20:00–06:00.
- Playground POKs end in `-ff` and carry `test="true"`. Assert on this so a
  test POK can never reach a customer receipt.
- The playground certificates are **shared with every other developer testing
  right now**, and uniqueness is `(eic_popl, id_jednotky, id_pokl, dat_trzby)`.
  Use distinctive `id_pokl` values to avoid colliding with strangers.
