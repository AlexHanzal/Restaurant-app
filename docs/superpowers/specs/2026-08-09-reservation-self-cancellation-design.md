# Guest self-cancellation of a reservation — design

Date: 2026-08-09
Status: approved, ready for implementation

## 1. Why

Staff can delete a booking (`deleteBooking` in `inner.js`); the guest who made
it has no way to. Today the only way a guest can tell the restaurant they are
not coming is to phone during service, so in practice most of them do not, and
the table stays blocked through the sitting. Self-cancellation is the single
biggest lever on no-shows, and it is the one that costs the restaurant nothing
when it works.

Out of scope, deliberately: rescheduling, no-show tracking, waitlists,
deposits, and the reservation-record refactor. Each is listed in the
2026-08-09 review and each wants its own spec. This one adds cancellation and
nothing else.

## 2. Decisions taken up front

| Question | Decision | Why |
| --- | --- | --- |
| How does the guest prove the booking is theirs? | A one-tap link in the confirmation SMS | Costs no extra SMS and nothing to type. A guest who deletes the SMS phones the restaurant, as they do today. |
| A preorder that is already paid? | Refuse; tell them to phone | No refund is ever initiated by an untrusted link. Money movement stays with staff. An *unpaid* preorder is cancelled with the booking. |
| How late may they cancel? | Any time before the slot starts | A cutoff converts the same guest into a no-show, which is strictly worse for the restaurant. Also means no new setting. |
| What does the restaurant see? | The freed slot, nothing more | Same end state as the admin's own delete. The kitchen board re-broadcast is a correctness requirement, not a notification. |

## 3. The token

**An opaque random token, stored on the booking's slots. Not a JWT.**

A JWT signed with `auth.deriveSecret(...)` — the reorder-token pattern — is
the obvious choice and is wrong here, for one concrete reason: the
confirmation SMS contains Czech diacritics, so it is UCS-2 encoded at **70
characters per segment**. A JWT is 150+ characters and would turn a
one-segment message into four.

- `crypto.randomBytes(16).toString("base64url")` → 22 characters, 128 bits.
- Written as `cancelToken` onto **every** hour-slot of the booking, by
  `applyBookingToTimetable`, at booking time.
- Compared with `crypto.timingSafeEqual`, after a length check (it throws on
  mismatched lengths).
- No signing key: at 128 bits of entropy, guessing is not a threat model.

It is stateful, but the state already exists — the slot. It also gives a
booking the grouping key the review found missing: "delete every slot carrying
this token" is exactly right for a multi-hour booking, where recomputing
`[startHour, startHour + duration)` could drift from what was actually
written.

### 3.1 Why this is safe to store on a slot

`cancelToken` is a secret. It is protected by the fact that
`sanitizeTimetableForPublic` **whitelists** the slot fields it publishes
(`content` collapsed to a marker, `isPermanent`) rather than blocklisting the
ones it hides. A field added to a slot is therefore private by default, and
`GET /api/timetables/:name` — which is public and unauthenticated — cannot
leak it.

This is a load-bearing property, not an incidental one. A test asserts
`cancelToken` never appears in that endpoint's response.

The token must likewise never be added to the kitchen-board payload, the
admin booking rows, or any log line.

## 4. Data

One new field on a booking slot, alongside `phone` and `guests`:

```js
data[dateStr][dayIndex][hourIndex] = {
    content, abbreviation, isPermanent,
    phone, guests,
    cancelToken,                 // NEW: 22-char base64url, secret
    order, orderTotal, isPaid,   // only when food was preordered
}
```

Bookings written before this ships carry no `cancelToken`. They also never
received a link, so there is nothing to reconcile — they simply cannot be
self-cancelled. No migration.

## 5. Module

New `src/server/reservation-cancel.js`, pure and dependency-free apart from
`crypto`, in the same black-box style as `timetable.js`:

- `newToken()` → a fresh 22-character token.
- `findBooking(records, token)` → `{ record, dateStr, dayIndex, hourKeys, slots }`
  or `null`. Scans `db.list(COL.timetables)` the way `reminderScannerTick`
  already does.
- `canCancel(booking, now)` → `{ ok, status, reason }`, a pure function of the
  slots and the clock, so every refusal rule is unit-testable without a
  server.

`server.js` stays thin: verify → look up → decide → write → respond.

## 6. Routes

Both public, both gated by `requireFeature("reservations")`, both behind a
per-IP limiter that bounds the timetable scan — the same reasoning that put
one in front of `resolveTableToken`.

### `GET /api/reservations/cancellation?t=<token>`

Returns what the confirmation page needs to show, and nothing else:

```json
{ "tableName": "Stůl 1", "dateStr": "2026-08-10", "startHour": 12,
  "endHour": 13, "hasOrder": true, "isPaid": false, "cancellable": true,
  "reason": null }
```

Deliberately **not** returned: the guest's name, phone, party size, order
contents, `receiptId`. The link may be forwarded or land in a screenshot; it
should reveal only enough to confirm "yes, this is my booking".

### `POST /api/reservations/cancel` — body `{ token }`

Performs the cancellation.

No CSRF, consistent with the documented reasoning for the other public
reservation and reorder routes: no pre-existing session is being ridden. The
token in the body **is** the credential, and an attacker who has it does not
need a forged cross-site request to use it.

## 7. Refusal rules

Evaluated in this order. The server is the authority; the page is advisory.

| Condition | Status | Message to the guest |
| --- | --- | --- |
| Token missing, malformed, or matches nothing | 410 | Rezervace nebyla nalezena — možná už byla zrušena. |
| Any slot has `isPaid: true` | 409 | Objednávka je zaplacená — zrušení prosím vyřešte telefonicky. |
| Booking start is not in the future | 409 | Tato rezervace už proběhla. |
| Otherwise | 200 | — |

"Unknown token" and "already cancelled" deliberately give the **same** answer.
Distinguishing them would turn the endpoint into an oracle for "is this token
real", and a cancelled booking's slots are gone, so the two are genuinely
indistinguishable server-side anyway.

Booking start is `dateStr` at `startHour + 7` local time — the 1-12 → 8:00-20:00
convention `RESERVATION_HOURS` and the reminder scanner already use.

## 8. Performing the cancellation

1. Delete every hour key carrying the token, from that one record.
2. `db.set(COL.timetables, record.fileId, record)`.
3. If any deleted slot had `.order`, `broadcastBoardEvent()` — mirroring
   exactly what `applyBookingToTimetable` does when it *creates* a booking
   with food. Without this the kitchen board keeps showing a ticket for a
   booking that no longer exists.

Nothing is written back in place of the slots. The end state is byte-for-byte
what the admin's own "Smazat rezervaci" produces.

## 9. Page

`GET /reservation/zrusit` serves `src/html/zrusit.html`, with `src/js/zrusit.js`:

1. Read `?t=` from the URL.
2. `GET` the summary; render table / date / time.
3. If `cancellable` is false, show the reason and no button.
4. Otherwise one confirm button → `POST` → success or the server's reason.

Reuses `design.css` and `reservation.css`; no new visual language. Added to
the service-worker precache list alongside the other pages.

The page shows a summary before acting, rather than cancelling on page load:
SMS clients, link scanners, and messaging previews fetch URLs unbidden, and a
GET that destroys a booking would let a preview delete someone's table.

## 10. SMS

The confirmation gains a second line:

```
Rezervace potvrzena: stůl Stůl 1, 10.8.2026 v 19:00.
Zrušit: https://<host>/reservation/zrusit?t=xK3p...
```

The absolute URL is built from the request origin, `${req.protocol}://${req.get("host")}`,
the pattern `gatewayCallbackUrls` already uses.

**Accepted cost:** this takes the confirmation SMS from one segment to two,
roughly doubling what that one message costs. There is no way around it — a
URL is a URL. The owner's existing `notifications.smsReservationConfirmed`
toggle is the lever, with the understood consequence that turning it off also
means no cancel link is ever issued.

## 11. Testing

**Unit** (`reservation-cancel.test.js`) — `canCancel` against hand-built slot
sets: unpaid, paid, past, multi-hour, and a booking whose slots are gone.
Token comparison: correct, wrong, wrong-length, empty.

**Smoke** (extending `reservations.test.js`) — against a real spawned server:

- book → cancel → the slot is bookable again
- cancelling twice: second attempt is 410
- a paid preorder is refused 409 and the slots **survive**
- a booking in the past is refused
- a garbage token is refused, in the same shape as an unknown one
- `GET /api/timetables/:name` never contains `cancelToken`
- the summary endpoint returns no name, phone, or order contents

Each rule will be re-broken once to confirm the test that covers it actually
fails, as with the three fixes in the previous commit.

## 12. Risks

- **A forwarded link cancels the booking.** Accepted: it is a capability
  token, exactly like the table QR codes. The blast radius is one booking, and
  the holder of the SMS is the person who made it.
- **SMS cost doubles for the confirmation.** Stated above; the owner's call.
- **The scan is O(tables × dates).** Same shape as the reminder scanner, and
  the per-IP limiter bounds how often an anonymous caller can trigger it.
- **No cancel link when SMS is off or unavailable.** Consistent with today:
  such an installation has no SMS-driven flows at all.
