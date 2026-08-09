// ============================================================================
// validation.js — request body/param schema validation (zod) shared by
// server.js.
//
// SECOND security-hardening pass (input validation / injection audit). This
// module is self-contained (only depends on `zod`) so it can be treated as a
// black box by whichever agent touches server.js next, same pattern as
// security.js from the first pass.
//
// What it provides:
//   1. validate(schema)        — Express middleware: parses req.body against
//                                 a zod schema, replaces req.body with the
//                                 parsed/coerced result, or responds 400 with
//                                 a Czech error message.
//   2. validateParams(schema)  — same, but for req.params (route params like
//                                 :id/:name/:fileId/:receiptId).
//   3. A library of reusable field-level schemas (strings with length caps,
//      phone numbers, cart items, bounded hour/day integers, id-shaped route
//      params, free-text name params) and the full set of per-route body/
//      param schemas used across server.js.
//   4. containsDangerousKeys() + rejectDangerousKeys middleware — recursively
//      scans a parsed JSON body for literal "__proto__" / "constructor" /
//      "prototype" keys and rejects the request outright. Belt-and-braces:
//      JSON.parse (which express.json() uses internally) already treats
//      "__proto__" as an inert own data property per spec, and every merge
//      in server.js uses object-spread (CreateDataProperty semantics, not
//      [[Set]]), so this app was not actually exploitable for prototype
//      pollution even before this file existed — see the audit notes in the
//      handoff report. This middleware just makes that guarantee explicit
//      and future-proofs against someone later adding a recursive/deep-merge
//      helper that WOULD be exploitable.
//
// Design notes:
//   - Fields the app doesn't currently use for anything meaningful (legacy
//     client-sent `price`/`total`/`email` on order bodies, etc.) are left out
//     of `.strict()` schemas or the schema uses `.passthrough()` — server.js
//     already only ever destructures the fields it cares about, so passing
//     extra junk through is inert. Routes where the ENTIRE body gets merged
//     into a stored record via object-spread (PUT /timetables/:name, PUT
//     /menu) get `.strict()`/fully-enumerated schemas instead, because in
//     those two spots an unlisted field really would end up persisted.
//   - Numeric fields that feed a `for (let h = start; h <= end; h++)` loop
//     (reservation/kitchen hour ranges, booking duration) are TIGHTLY bounded
//     here. Before this file existed, sending e.g. `duration: 1e9` or
//     `endHour: 1e9` to /reservations/send-code or /kitchen/indoor/status
//     would make the server spin a loop with that many iterations,
//     synchronously blocking the single-threaded event loop — a real,
//     easy-to-trigger denial-of-service. Bounding these to real-world hour-
//     of-day / duration ranges closes that off.
// ============================================================================

const { z } = require("zod");

// ── GENERIC HELPERS ─────────────────────────────────────────────────────

// Coerces missing/non-string input to "" first so a missing field and an
// empty field both fail the same, clear `.min(1, ...)` check below instead
// of a generic zod "expected string, received undefined" type error.
function toStringOrEmpty(val) {
    return typeof val === "string" ? val : (val === undefined || val === null ? "" : val);
}

// Required, trimmed string with a length cap and a Czech "required" message.
function reqStr(max, label) {
    return z.preprocess(
        toStringOrEmpty,
        z.string({ error: `${label} musí být text` })
            .trim()
            .min(1, `${label} je povinné`)
            .max(max, `${label} je příliš dlouhé (max ${max} znaků)`)
    );
}

// Password field — required, length-capped (and floor-checked when
// creating a new account), but deliberately NOT trimmed. A password is an
// opaque secret, and hashPassword()/comparePassword() in auth.js never
// trimmed it either; trimming here would silently change what gets hashed
// vs. what the user typed, and could break login for any pre-existing
// account whose real password happens to have meaningful leading/trailing
// whitespace.
function passwordSchema(max, min = 1, shortMessage) {
    return z.preprocess(
        toStringOrEmpty,
        z.string({ error: "Heslo musí být text" })
            .min(1, "Heslo je povinné")
            .min(min, shortMessage || "Heslo je příliš krátké")
            .max(max, `Heslo je příliš dlouhé (max ${max} znaků)`)
    );
}

// Optional trimmed string with a length cap — missing/empty is fine.
function optStr(max, label) {
    return z.string({ error: `${label} musí být text` })
        .trim()
        .max(max, `${label} je příliš dlouhé (max ${max} znaků)`)
        .optional();
}

// Bounded integer, coerced from string/number (matches how the rest of the
// app already treats numeric form fields), with an explicit Czech message —
// this is the primary defense against the huge-loop DoS described above.
// Missing/object/array input is normalized to NaN *before* zod's own type
// check so every failure path (missing field, wrong type, out of range)
// produces the same clear Czech range message instead of a generic
// "expected number, received undefined/NaN".
function boundedInt(min, max, label) {
    return z.preprocess(
        val => (typeof val === "number" || typeof val === "string" ? val : NaN),
        z.coerce.number({ error: `${label} musí být v rozsahu ${min}–${max}` })
            .int(`${label} musí být v rozsahu ${min}–${max}`)
            .min(min, `${label} musí být v rozsahu ${min}–${max}`)
            .max(max, `${label} musí být v rozsahu ${min}–${max}`)
    );
}

// Czech-ish phone number: digits plus the punctuation normalizePhone() in
// server.js already strips (spaces, dashes, dots, parens) and an optional
// leading "+". Length bounds are on the raw (unnormalized) input.
const phoneSchema = z.preprocess(
    toStringOrEmpty,
    z.string({ error: "Neplatné telefonní číslo" })
        .trim()
        .min(6, "Zadejte telefonní číslo")
        .max(25, "Neplatné telefonní číslo")
        .regex(/^[0-9+\s\-().]+$/, "Neplatné telefonní číslo")
);

// 5-digit Czech postal code (PSČ) — shared by the delivery order's required
// `psc` field (go-live Task 2, spec §4) and settings.delivery.pscWhitelist
// (defined further down alongside the rest of the settings schema). Declared
// here, ahead of createOrderSchema below, since a `const` can't be referenced
// before its own declaration in the same module.
const pscSchema = z.preprocess(
    toStringOrEmpty,
    z.string({ error: "PSČ musí být 5 číslic" }).regex(/^\d{5}$/, "PSČ musí být 5 číslic")
);

// ── DANGEROUS-KEY (prototype pollution) GUARD ───────────────────────────

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function containsDangerousKeys(value, depth = 0) {
    if (depth > 25 || value === null || typeof value !== "object") return false;
    if (Array.isArray(value)) {
        return value.some(item => containsDangerousKeys(item, depth + 1));
    }
    for (const key of Object.keys(value)) {
        if (DANGEROUS_KEYS.has(key)) return true;
    }
    return Object.values(value).some(v => containsDangerousKeys(v, depth + 1));
}

// Mount once, globally, right after the JSON body parser(s) and before any
// route handlers — see setupMiddleware() in server.js.
function rejectDangerousKeys(req, res, next) {
    if (req.body && containsDangerousKeys(req.body)) {
        return res.status(400).json({ error: "Neplatná data v požadavku" });
    }
    next();
}

// ── MIDDLEWARE FACTORIES ────────────────────────────────────────────────

function firstIssueMessage(error, fallback) {
    const issue = error.issues && error.issues[0];
    return (issue && issue.message) || fallback;
}

// Validates req.body against `schema`. On success, req.body is replaced with
// the parsed (trimmed/coerced/defaulted) value so downstream handlers see
// clean data. On failure, responds 400 with a single Czech error message.
function validate(schema) {
    return (req, res, next) => {
        const result = schema.safeParse(req.body ?? {});
        if (!result.success) {
            return res.status(400).json({ error: firstIssueMessage(result.error, "Neplatná data v požadavku") });
        }
        req.body = result.data;
        next();
    };
}

// Same idea for route params (:id/:name/:fileId/...). Mutates req.params in
// place (Express 5's req.params is a plain assignable object, but we avoid
// replacing the reference in case anything downstream captured it).
function validateParams(schema) {
    return (req, res, next) => {
        const result = schema.safeParse(req.params ?? {});
        if (!result.success) {
            return res.status(400).json({ error: firstIssueMessage(result.error, "Neplatný parametr požadavku") });
        }
        Object.assign(req.params, result.data);
        next();
    };
}

// ── ROUTE PARAM SCHEMAS ──────────────────────────────────────────────────
// Every :id/:fileId/:receiptId/:orderId/:gatewayTransactionId in server.js
// is either a server-generated id (generateFileId() — alnum, optionally
// prefixed "SIMULATED-") or a GoPay transaction id (digits). None of them
// are ever used as filesystem paths (confirmed by audit — see handoff
// report), only as SQLite lookup keys via parameterized queries, but we
// still cap length/charset here as defense-in-depth against abuse (log
// spam, absurd values, accidental type confusion).
const SYSTEM_ID_RE = /^[A-Za-z0-9_\-]+$/;

function systemIdParam(paramName, max = 100) {
    return z.object({
        [paramName]: z.string()
            .min(1, "Neplatný parametr požadavku")
            .max(max, "Neplatný parametr požadavku")
            .regex(SYSTEM_ID_RE, "Neplatný parametr požadavku"),
    });
}

// Free-text name params (table/class names an admin picked — can contain
// spaces, Czech diacritics, punctuation). No filesystem/SQL use anywhere
// (confirmed by audit), so we only block control characters and cap length.
function freeTextNameParam(paramName, max = 200) {
    return z.object({
        [paramName]: z.string()
            .min(1, "Neplatný parametr požadavku")
            .max(max, "Neplatný parametr požadavku")
            .refine(v => !/[\x00-\x1F\x7F]/.test(v), "Neplatný parametr požadavku"),
    });
}

const paramsName = freeTextNameParam("name");
const paramsFileId = systemIdParam("fileId");
const paramsId = systemIdParam("id");
// The QR token is "<fileId>.<base64url sig>" — base64url plus one dot. This
// is the shape gate only; table-token.js's HMAC check is the real one.
const paramsTableToken = z.object({
    token: z.string().min(3).max(200).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, "Neplatný kód stolu"),
});
const paramsReceiptId = systemIdParam("receiptId", 80);
const paramsOrderId = systemIdParam("orderId");
const paramsGatewayTxId = systemIdParam("gatewayTransactionId", 150);

// ── CART ITEM / ORDER SCHEMAS ────────────────────────────────────────────
// Keep MAX_ITEM_QTY / MAX_ITEMS_PER_ORDER in sync with server.js — this is
// the first line of defense (clear 400 before priceOrderItems() even runs);
// priceOrderItems() re-checks the same bounds server-side regardless, so a
// mismatch here would fail closed, never open.
const MAX_ITEM_QTY = 50;
const MAX_ITEMS_PER_ORDER = 200;

// Two cart shapes are used across the app: delivery (`id`/`name`) and
// indoor/reservation (`item`). Both, plus legacy `price`/`total`/`categoryId`
// the client may still send, are accepted — server.js always re-derives the
// real price from the live menu (priceOrderItems) and ignores whatever the
// client sent here, so passthrough fields are inert, never trusted.
const QTY_MESSAGE = "Neplatné množství u položky (1–50 ks)";
const cartItemSchema = z.object({
    id: z.union([z.string().max(200), z.number()]).optional(),
    item: z.string().max(200).optional(),
    name: z.string().max(200).optional(),
    qty: z.preprocess(
        val => (typeof val === "number" || typeof val === "string" ? val : NaN),
        z.coerce.number({ error: QTY_MESSAGE })
            .int(QTY_MESSAGE)
            .min(1, QTY_MESSAGE)
            .max(MAX_ITEM_QTY, QTY_MESSAGE)
    ),
}).passthrough();

const itemsArraySchema = z.array(cartItemSchema)
    .min(1, "Košík je prázdný")
    .max(MAX_ITEMS_PER_ORDER, "Příliš mnoho položek v objednávce");

// POST /orders (delivery)
const createOrderSchema = z.object({
    customerName: reqStr(150, "Jméno"),
    address: reqStr(300, "Adresa"),
    // Required (go-live Task 2, spec §4): the checkout now collects PSČ as
    // its own field instead of relying on it being embedded in the free-text
    // address — POST /orders re-quotes delivery fee/min-order/whitelist
    // eligibility against this exact value via settingsStore.quoteDelivery().
    psc: pscSchema,
    phone: phoneSchema,
    items: itemsArraySchema,
    note: optStr(500, "Poznámka"),
    email: z.string().max(200).optional(), // legacy/unused server-side, kept so real clients aren't rejected
    total: z.any().optional(),             // legacy/unused — server always recomputes
    paymentMethod: z.string().max(30).optional(),
    returnUrl: z.string().max(500).optional(),
}).passthrough();

// POST /indoor-orders (staff-placed)
//
// `offlineSale`/`total` exist for the offline POS queue (spec 2026-08-02
// §4.3). Deliberately loose here: this schema only says "the field may be
// present and is a boolean/number". The real money guards — every line
// price finite and non-negative, `total` equal to the sum of its own lines
// — live in offline-sale.js's validateClientPricing, because they are
// cross-field rules with tax consequences and belong somewhere unit-testable
// rather than buried in a zod chain. Adding them is safe precisely because
// cartItemSchema is already `.passthrough()`, so a `price` on a line has
// always been accepted and, until now, always ignored.
const createIndoorOrderSchema = z.object({
    tableName: reqStr(100, "Stůl"),
    guestName: optStr(150, "Jméno hosta"),
    items: itemsArraySchema,
    offlineSale: z.boolean().optional(),
    total: z.number().optional(),
}).passthrough();

// POST /table-orders — the customer-facing QR self-order route (spec
// 2026-08-04 §5.3).
//
// Deliberately NOT .passthrough() like createIndoorOrderSchema: that route
// is staff-authenticated and carries offline-POS fields; this one takes
// anonymous input from a stranger's phone, so the accepted surface is
// exactly these four keys and nothing else. In particular `total` and
// `offlineSale` are REJECTED here rather than ignored — a guest device is
// never an offline POS, and silently dropping a client-supplied price is
// less obvious to a future reader than refusing it outright.
const tableOrderSchema = z.object({
    token: reqStr(200, "Kód stolu"),
    guestName: optStr(150, "Jméno"),
    note: optStr(500, "Poznámka"),
    items: itemsArraySchema,
}).strict();

// POST /indoor-orders/:id/mark-paid
//
// A body was never required on this route and still is not — `paidAt` is
// the offline queue telling the server when the money ACTUALLY changed
// hands (spec §4.2). Range-checked in offline-sale.js's resolvePaidAt, not
// here: "not in the future, not older than 72 hours" is a rule about the
// server's clock at request time, which a static schema cannot express.
const markPaidSchema = z.object({
    paidAt: z.string().max(40).optional(),
}).passthrough();

// POST /orders/:id/claim
const claimOrderSchema = z.object({
    driverId: reqStr(100, "Řidič"),
    driverName: reqStr(150, "Jméno řidiče"),
});

// POST /orders/:orderId/refund-reason — labels a refund that already
// happened (see server.js route comment); never creates one.
const refundReasonSchema = z.object({
    reason: z.enum(["badly_prepared", "late", "customer_cancelled",
                    "wrong_order", "other"], { error: "Neplatný důvod" }),
    note: z.string().max(200, { error: "Poznámka je příliš dlouhá" }).optional(),
});

// POST /orders/:id/kitchen-status and /indoor-orders/:id/kitchen-status
const kitchenStatusSchema = z.object({
    status: z.enum(["pending", "completed"], { error: "Neplatný stav" }),
});

// POST /kitchen/indoor/status (reservation-attached order kitchen status)
const kitchenIndoorStatusSchema = z.object({
    fileId: reqStr(100, "fileId"),
    dateStr: reqStr(20, "dateStr"),
    dayIndex: boundedInt(0, 6, "dayIndex"),
    startHour: boundedInt(0, 23, "startHour"),
    endHour: boundedInt(0, 23, "endHour"),
    status: z.enum(["pending", "completed"], { error: "Neplatný stav" }),
});

// POST /kitchen/indoor/remove
const kitchenIndoorRemoveSchema = z.object({
    fileId: reqStr(100, "fileId"),
    dateStr: reqStr(20, "dateStr"),
    dayIndex: boundedInt(0, 6, "dayIndex"),
    startHour: boundedInt(0, 23, "startHour"),
    endHour: boundedInt(0, 23, "endHour"),
});

// POST /kitchen/reservation/mark-paid
const kitchenReservationMarkPaidSchema = z.object({
    fileId: reqStr(100, "fileId"),
    dateStr: reqStr(20, "dateStr"),
    dayIndex: boundedInt(0, 6, "dayIndex"),
    startHour: boundedInt(0, 23, "startHour"),
    endHour: boundedInt(0, 23, "endHour"),
});

// POST /kitchen/reservation/pay-online
const kitchenReservationPayOnlineSchema = z.object({
    fileId: reqStr(100, "fileId"),
    dateStr: reqStr(20, "dateStr"),
    dayIndex: boundedInt(0, 6, "dayIndex"),
    startHour: boundedInt(0, 23, "startHour"),
    endHour: boundedInt(0, 23, "endHour"),
    returnUrl: z.string().max(500).optional(),
});

// POST /indoor-orders/:id/pay-online
const payOnlineReturnUrlSchema = z.object({
    returnUrl: z.string().max(500).optional(),
}).passthrough();

// ── RESERVATION SCHEMAS ──────────────────────────────────────────────────

// POST /reservations/send-code
const sendCodeSchema = z.object({
    phone: phoneSchema,
    tableName: reqStr(100, "Stůl"),
    // Format/calendar validity and the past/horizon bounds are enforced by
    // settings.isReservationSlotOpen, which owns every other reservation
    // rule and can phrase the rejection in the same Czech the customer sees
    // for a paused/closed/out-of-hours slot. Kept as a plain bounded string
    // here so a malformed date is not reported as a schema error.
    dateStr: reqStr(20, "Datum"),
    // NOT the source of truth as of the 2026-08-09 review (fix 1) — the
    // server derives the weekday from dateStr. Optional, so a client that
    // omits it is fine; when present it is cross-checked against the date
    // and a disagreement is refused (see the send-code handler in
    // server.js). Clients cached from before the fix keep working because
    // they compute the same value from the same date.
    dayIndex: boundedInt(0, 6, "dayIndex").optional(),
    startHour: boundedInt(0, 23, "startHour"),
    duration: boundedInt(1, 24, "duration"),
    guestName: reqStr(150, "Jméno"),
    order: z.array(cartItemSchema).max(MAX_ITEMS_PER_ORDER, "Příliš mnoho položek v objednávce").optional(),
    orderTotal: z.coerce.number().finite().min(0).max(10_000_000).optional(),
    // Floorplan (design doc §7.1/§7.3): party size, threaded through to
    // applyBookingToTimetable() at verify-and-book time via the
    // pendingVerifications payload, where it's checked against the table's
    // `seats`. `.passthrough()` on this schema already made an unlisted
    // `guests` field harmless before this line existed (server.js only ever
    // destructures fields it names), but it's declared explicitly — and
    // bounded, same as every other client-controlled integer in this file —
    // rather than relying on that passthrough leniency.
    guests: boundedInt(1, 20, "Počet osob").optional(),
}).passthrough();

// POST /reservations/verify-and-book
const verifyAndBookSchema = z.object({
    phone: phoneSchema,
    code: reqStr(20, "Kód"),
});

// ── REORDER SCHEMAS ──────────────────────────────────────────────────────
// docs/superpowers/specs/2026-07-25-reorder-design.md §10. Reuses the same
// phoneSchema/reqStr helpers as the reservation flow above — accepted phone
// formats must stay identical between the two flows because both are keyed
// under the same normalizePhone() output (server.js). `.passthrough()`
// matches sendCodeSchema/verifyAndBookSchema's own convention: the reorder
// routes only ever destructure the fields they name, so any extra client-
// sent junk is inert.
const reorderSendCodeSchema = z.object({
    phone: phoneSchema,
}).passthrough();

const reorderVerifySchema = z.object({
    phone: phoneSchema,
    code: reqStr(20, "Kód"),
}).passthrough();

// ── TIMETABLE SCHEMAS ─────────────────────────────────────────────────────

// POST /timetables — create
const createTimetableSchema = z.object({
    name: reqStr(150, "Název"),
    info: optStr(5000, "Info"),
    // Floorplan (docs/superpowers/specs/2026-07-27-floorplan-table-picking-
    // design.md §4.1): optional seat count for the new table. server.js
    // defaults this to 4 when the client omits it, so it's optional here too.
    seats: boundedInt(1, 20, "Počet míst").optional(),
}).strict();

// PUT /timetables/:name — the ENTIRE parsed body is object-spread into the
// stored record (`{...found, ...req.body, className: found.className}`), so
// this one is deliberately `.strict()` with every field the three real call
// sites in the frontend send (persistTimetable / saveTimetable / saveInfo's
// rename flow) enumerated — see the audit notes in the handoff report for
// exactly which fields those are. Deep shapes (data/permanentHours booking
// grids, calendar blob) aren't feasible to fully schema-validate without
// risking breaking legitimate saves, so they're type/size-capped instead;
// the 1MB body-size limit on this route is the primary backstop against
// pathological sizes, and rejectDangerousKeys (mounted globally) guards
// against prototype-pollution-shaped payloads inside them.
//
// Floorplan (design doc §7.1, persistence hazard #1): `seats` and `layout`
// are two more fields the frontend's PUT payload can now carry. Because
// this schema is `.strict()`, omitting either here would make EVERY table
// save fail with a 400 the moment the floorplan editor ships — not just
// floorplan-related saves. `layout` is nullable (a table can be explicitly
// unplaced) as well as optional (older callers that don't touch placement
// at all just omit the key and keep whatever was already stored, same as
// every other optional field on this schema).
const timetablePutSchema = z.object({
    fileId: z.string().max(100).optional(),
    data: z.record(z.any()).optional(),
    info: optStr(5000, "Info"),
    attributes: z.array(z.any()).max(500, "Příliš mnoho atributů").optional(),
    calendar: z.string().max(300000, "Kalendář je příliš velký").optional(),
    currentWeek: z.string().max(100).optional(),
    permanentHours: z.record(z.any()).optional(),
    seats: boundedInt(1, 20, "Počet míst").optional(),
    layout: z.object({
        room: reqStr(80, "Místnost"),
        x: z.coerce.number().finite().min(-10_000).max(10_000),
        y: z.coerce.number().finite().min(-10_000).max(10_000),
        w: z.coerce.number().finite().min(1).max(10_000),
        h: z.coerce.number().finite().min(1).max(10_000),
    }).strict().nullable().optional(),
}).strict();

// DELETE /timetables — body is optional { name }
const deleteTimetableByNameSchema = z.object({
    name: optStr(150, "Název"),
}).strict();

// POST /timetables/:name/rename — { newName }. Renaming used to be done
// client-side as create-under-new-name + copy + (never actually) delete-old,
// which duplicated the table and left the copy's walk-in orders stranded
// under the old name. The route this schema guards renames the record in
// place instead, so `newName` is the only thing it ever accepts. Same 150-char
// bound as createTimetableSchema's `name` — the two must agree, since a
// rename can produce any name a create could.
const renameTimetableSchema = z.object({
    newName: reqStr(150, "Nový název"),
}).strict();

// ── MENU SCHEMA ────────────────────────────────────────────────────────
// PUT /menu also fully replaces the stored record, so it's schema-shaped
// too. vatRate is intentionally left loosely typed here (number|string) —
// the existing route-level loop in server.js re-validates it against
// VALID_VAT_RATES with its own Czech error message; duplicating that check
// here with a different message would just be confusing, so we coordinate
// rather than conflict, per the task brief.
const MAX_MENU_CATEGORIES = 300;
const MAX_DISHES_PER_CATEGORY = 500;

const dishSchema = z.object({
    id: z.union([z.string().max(200), z.number()]).optional(),
    name: z.string().max(300).optional(),
    price: z.union([z.number(), z.string().max(50)]).optional(),
    vatRate: z.union([z.number(), z.string().max(10)]).nullable().optional(),
    info: z.string().max(3000).optional(),
    // Either an external https:// URL (short) or an inline base64 data-URL
    // from the admin's file upload. The old max(3000) silently made every
    // real file upload fail with 400 — inner.js downscales uploads to at
    // most ~1.4M chars (IMG_TARGET_CHARS there), so the cap here is that
    // plus headroom. Keep the two in sync.
    imageUrl: z.string().max(1_500_000, "Obrázek je příliš velký").optional(),
    // go-live Task 3 (spec §5): optional sold-out flag. Coerced to a real
    // boolean (rather than left passthrough) so a stray truthy/falsy string
    // from an older client can't end up stored as something priceOrderItems()'s
    // `if (dish.soldOut)` check reads inconsistently; missing entirely (every
    // dish that existed before this field did) is fine — server.js's checks
    // all use `if (dish.soldOut)`, which is false for undefined.
    soldOut: z.coerce.boolean().optional(),
}).passthrough();

const menuPutSchema = z.record(
    z.string().max(200),
    z.array(dishSchema).max(MAX_DISHES_PER_CATEGORY, "Příliš mnoho položek v kategorii")
).refine(
    obj => Object.keys(obj).length <= MAX_MENU_CATEGORIES,
    { message: "Příliš mnoho kategorií v menu" }
);

// ── COMBOS SCHEMA ("Zvýhodněná menu", spec: docs/superpowers/specs/ ────
// 2026-07-22-combo-menus-design.md) ─────────────────────────────────────
// PUT /api/combos fully replaces the stored array in one shot (same pattern
// as PUT /menu just above) — the whole array is schema-shaped here, unlike
// menuPutSchema/dishSchema which leave a couple of fields loosely typed for
// legacy-coordination reasons (see that schema's header comment): this is a
// brand-new shape with exactly one producer (the admin "Zvýhodněná menu"
// panel in inner.js — Task 2), so there's no legacy data to accommodate.
// `.passthrough()` is still used at every object level though, matching the
// rest of this file's convention of never using `.strict()` on shapes that
// aren't fully object-spread into a stored record verbatim — server.js's
// priceOrderItems() combo branch only ever reads the fields it knows about,
// so unlisted extra keys are inert either way.
const MAX_COMBOS = 50;
const MAX_COMBO_ITEMS = 10;
const MAX_COMBO_SWAPS_PER_ITEM = 20;
const MAX_COMBO_EXTRAS = 10;

// Dish ids elsewhere in this codebase (dishSchema.id above, cartItemSchema.id)
// are typed string|number rather than string-only, because some pre-existing
// menu data may carry numeric dish ids. combo.items[].dishId and .swaps[]
// entries reference those same live-menu dish ids, so they share that same
// union — a plain string-only cap here would reject a perfectly valid combo
// referencing a numeric-id dish.
const dishIdRefSchema = z.union([z.string().max(200), z.number()]);

// Same three Czech VAT rates as VALID_VAT_RATES in server.js (0/12/21),
// duplicated as a literal union here for the same "coordinate rather than
// import" reason as dailyMenuVatRateSchema below. Unlike that one, a
// combo's vatRate is OPTIONAL — an omitted value falls back to
// DEFAULT_VAT_RATE (12) via resolveVatRate() in server.js, exactly like an
// ordinary menu dish with no vatRate of its own.
const comboVatRateSchema = z.preprocess(
    val => (val === undefined || val === null || val === ""
        ? undefined
        : (typeof val === "number" || typeof val === "string" ? Number(val) : NaN)),
    z.union([z.literal(0), z.literal(12), z.literal(21)], { error: "Neplatná sazba DPH (povoleno 0, 12, 21)" })
        .optional()
);

// One slot inside a combo (e.g. "polévka" or "hlavní jídlo") — a default
// dish plus how the customer is allowed to customize that slot.
const comboSlotSchema = z.object({
    slotId: reqStr(50, "ID položky menu"),        // stable id, unique within the combo (admin-assigned)
    dishId: dishIdRefSchema,                      // required — id of the default dish on the live menu
    removable: z.coerce.boolean().optional(),
    removeValue: nonNegNumber(100_000, "Hodnota odebrání").optional(),
    swaps: z.array(dishIdRefSchema)
        .max(MAX_COMBO_SWAPS_PER_ITEM, "Příliš mnoho náhrad u položky")
        .optional(),
}).passthrough();

// One paid add-on a combo can offer (e.g. "Extra sýr, +20 Kč").
const comboExtraSchema = z.object({
    id: reqStr(50, "ID příplatku"),
    name: reqStr(120, "Název příplatku"),
    price: nonNegNumber(100_000, "Cena příplatku"),
}).passthrough();

const comboSchema = z.object({
    id: z.union([z.string().max(200), z.number()]).optional(),
    name: reqStr(120, "Název menu"),
    description: optStr(500, "Popis menu"),
    price: nonNegNumber(100_000, "Cena menu"),
    // Inline data-URL image, same convention (and same cap) as
    // dishSchema.imageUrl above — inner.js downscales uploads to at most
    // ~1.4M chars before storing, so this is that plus headroom. The whole
    // request additionally has to fit the 10MB PUT body limit (see
    // isLargeBodyRoute() in server.js).
    image: z.string().max(1_500_000, "Obrázek je příliš velký").optional(),
    soldOut: z.coerce.boolean().optional(),
    vatRate: comboVatRateSchema,
    items: z.array(comboSlotSchema)
        .min(1, "Menu musí mít alespoň jednu položku")
        .max(MAX_COMBO_ITEMS, "Příliš mnoho položek v menu"),
    extras: z.array(comboExtraSchema)
        .max(MAX_COMBO_EXTRAS, "Příliš mnoho příplatků v menu")
        .optional(),
}).passthrough();

const combosPutSchema = z.array(comboSchema).max(MAX_COMBOS, "Příliš mnoho zvýhodněných menu");

// ── DAILY MENU SCHEMA (polední menu, go-live Task 3, spec §5) ───────────
// PUT /api/daily-menu replaces one date's ENTIRE record in one shot, same
// full-object-replace pattern as PUT /menu/PUT /settings — `.strict()`
// throughout so an unlisted/misspelled key fails loudly rather than being
// silently dropped or (worse) accepted and never actually stored. Unlike
// dishSchema (menu items, `.passthrough()` — a lot of legacy call sites),
// this is a brand-new shape with exactly one producer (the admin "Polední
// menu" panel in inner.js), so there is no passthrough/legacy-field need.
const MAX_DAILY_ITEMS = 100;

// Same three Czech VAT rates as VALID_VAT_RATES in server.js (0/12/21) —
// duplicated as a literal union here (rather than imported) to keep this
// module dependency-free (only `zod`), same reasoning as the menu schema's
// header comment above about coordinating rather than importing.
const dailyMenuVatRateSchema = z.preprocess(
    val => (typeof val === "number" || typeof val === "string" ? Number(val) : NaN),
    z.union([z.literal(0), z.literal(12), z.literal(21)], { error: "Neplatná sazba DPH (povoleno 0, 12, 21)" })
);

const dailyMenuItemSchema = z.object({
    // Optional on input — items without one (a brand-new row the admin just
    // added) get a server-generated id in the PUT /daily-menu handler itself;
    // items round-tripped from a GET (edit flow) already carry one.
    id: z.union([z.string().max(200), z.number()]).optional(),
    name: reqStr(300, "Název položky"),
    price: nonNegNumber(100_000, "Cena"),
    vatRate: dailyMenuVatRateSchema,
}).strict();

const dailyMenuPutSchema = z.object({
    date: z.preprocess(toStringOrEmpty, z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Neplatné datum (YYYY-MM-DD)")),
    items: z.array(dailyMenuItemSchema).max(MAX_DAILY_ITEMS, "Příliš mnoho položek v poledním menu"),
}).strict();

// ── SETTINGS SCHEMA ───────────────────────────────────────────────────────
// PUT /api/settings, like PUT /menu and PUT /timetables/:name, replaces the
// ENTIRE stored record in one shot (see settings.js's saveSettings — it
// merges the submitted object over the defaults, so this schema doesn't
// need every field required, but it IS `.strict()` at every level: an
// unlisted/misspelled key must fail loudly here rather than silently being
// dropped by settings.js's merge (which only ever looks at DEFAULT_SETTINGS'
// own keys) or, worse, quietly accepted and never actually taking effect.
//
// Weekday keys: reservations now cover every day ("0".."6", Po-Ne,
// Monday-first — go-live Task 6, spec §11 follow-up; previously Po-Pá only,
// "0".."4"), same as delivery ("0".."6"). hourIndex 1-12 matches
// RESERVATION_HOURS (8:00-20:00, renderer.js) — the reservation model keeps
// its fixed intraday slot grid (spec §9 — extending hours-of-day stays out
// of scope), so fromHour/toHour are bounded to that same 1-12 range rather
// than a generic 0-23 hour-of-day.

const RESV_WEEKDAY_KEYS = ["0", "1", "2", "3", "4", "5", "6"];
const DELIVERY_WEEKDAY_KEYS = ["0", "1", "2", "3", "4", "5", "6"];

const hhmmSchema = z.preprocess(
    toStringOrEmpty,
    z.string({ error: "Neplatný čas (HH:MM)" }).regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Neplatný čas (HH:MM)")
);

const reservationDaySchema = z.object({
    open: z.coerce.boolean(),
    fromHour: boundedInt(1, 12, "Rezervace — hodina 'od'"),
    toHour: boundedInt(1, 12, "Rezervace — hodina 'do'"),
}).strict().refine(d => d.fromHour <= d.toHour, {
    message: "Rezervace: hodina 'od' musí být menší nebo rovna hodině 'do'",
});

const reservationDaysSchema = z.object(
    Object.fromEntries(RESV_WEEKDAY_KEYS.map(k => [k, reservationDaySchema]))
).strict();

const deliveryDaySchema = z.object({
    open: z.coerce.boolean(),
    from: hhmmSchema,
    to: hhmmSchema,
}).strict().refine(d => d.from < d.to, {
    message: "Rozvoz: čas 'od' musí být dříve než čas 'do'",
});

const deliveryDaysSchema = z.object(
    Object.fromEntries(DELIVERY_WEEKDAY_KEYS.map(k => [k, deliveryDaySchema]))
).strict();

const MAX_CLOSED_DAYS = 366;
const closedDaySchema = z.object({
    date: z.preprocess(toStringOrEmpty, z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Neplatné datum (YYYY-MM-DD)")),
    note: optStr(200, "Poznámka").default(""),
}).strict();

const closedDaysSchema = z.array(closedDaySchema).max(MAX_CLOSED_DAYS, "Příliš mnoho zavřených dnů");

const MAX_PSC_ENTRIES = 500;
// pscSchema itself is defined earlier, next to phoneSchema, so createOrderSchema
// (also earlier in this file) can use the same shape for the order's own psc field.
const pscWhitelistSchema = z.array(pscSchema).max(MAX_PSC_ENTRIES, "Příliš mnoho PSČ v seznamu");

function nonNegNumber(max, label) {
    return z.preprocess(
        val => (typeof val === "number" || typeof val === "string" ? val : NaN),
        z.coerce.number({ error: `${label} musí být nezáporné číslo` })
            .min(0, `${label} musí být nezáporné číslo`)
            .max(max, `${label} je příliš vysoké`)
    );
}

// Delivery routing/batching (spec 2026-08-08 §13). MUST stay in lockstep
// with settings.js's DEFAULT_SETTINGS.delivery.routing — `delivery` below is
// .strict(), so a default without a schema entry here makes PUT /settings
// 400 the moment the admin panel round-trips the object it just fetched.
const routingSchema = z.object({
    enabled: z.coerce.boolean(),
    // Hard ceiling of 6, NOT a taste call: routing.js's planBatch() brute-
    // forces all permutations for a provably optimal stop order. 6 stops is
    // 720 permutations (microseconds); 10 would be 3.6 million.
    maxStops: boundedInt(2, 6, "Max. zastávek ve skupině"),
    groupRadiusM: boundedInt(100, 5000, "Poloměr skupiny (m)"),
    batchWindowMinutes: boundedInt(1, 60, "Okno pro slučování (min)"),
    ageGraceMinutes: boundedInt(0, 240, "Tolerance čekání (min)"),
    agePriorityKmPerMinute: nonNegNumber(5, "Váha čekání"),
    batchBonusKm: nonNegNumber(20, "Bonus za sloučení"),
    originLat: z.number().min(-90).max(90).nullable(),
    originLon: z.number().min(-180).max(180).nullable(),
}).strict();

// POST /api/driver/route — the driver's live position. Sent in the BODY, not
// a query string: it is location data, and query strings end up in access
// logs and proxy caches.
const driverRouteSchema = z.object({
    lat: z.number().min(-90).max(90).nullish(),
    lon: z.number().min(-180).max(180).nullish(),
}).strict();

// POST /api/orders/claim-batch — a batch id, deliberately NOT a list of
// order ids. The server owns batch membership, so a client cannot ask to
// claim an arbitrary set of orders by calling it a "batch".
const claimBatchSchema = z.object({
    batchId: reqStr(80, "ID skupiny"),
}).strict();

// ── FLOORPLAN SCHEMA (docs/superpowers/specs/2026-07-27-floorplan-table- ──
// picking-design.md §4.2, §7.1) ─────────────────────────────────────────
// settings.floorplan.rooms — the admin *Rozložení* editor's PUT /settings
// payload. Bounded generously above anything a real floorplan needs (a
// couple of rooms, a handful of fixtures each) purely as a sanity cap, same
// spirit as MAX_CLOSED_DAYS/MAX_PSC_ENTRIES above.
const MAX_FLOORPLAN_ROOMS = 20;
const MAX_FLOORPLAN_FIXTURES = 50;

// Exactly the two fixture types the design supports (§4.2): a filled
// labelled block (kitchen/stairs/bar/WC) and a door arc. `facing` only
// means anything for `type: "door"`, but it's accepted-and-ignored on a
// `block` too rather than forcing the client to omit it conditionally.
const floorplanFixtureSchema = z.object({
    type: z.enum(["block", "door"], { error: "Neplatný typ prvku" }),
    label: optStr(80, "Popisek prvku"),
    x: z.coerce.number().finite().min(-10_000).max(10_000),
    y: z.coerce.number().finite().min(-10_000).max(10_000),
    w: z.coerce.number().finite().min(1).max(10_000),
    h: z.coerce.number().finite().min(1).max(10_000),
    facing: z.enum(["left", "right", "up", "down"]).optional(),
}).strict();

// Room shape editing (docs/superpowers/specs/2026-07-28-room-shape-editing-
// design.md §2/§6): an optional custom polygon outline for a room, layered on
// top of its existing width/height coordinate space. A corner is just a
// point, so it reuses the exact same finite/bounded number chain as
// floorplanFixtureSchema's x/y right above rather than inventing a new bound
// scoped to the room's own width/height — same convention, same file.
// Optional and `.strict()` like every object in this schema: a room with no
// `corners` is still valid (design §7, falls back to the implicit rectangle
// [(0,0),(w,0),(w,h),(0,h)]), and 3..24 bounds a real polygon (fewer than 3
// isn't one) against a generous sanity cap.
const floorplanCornerSchema = z.object({
    x: z.coerce.number().finite().min(-10_000).max(10_000),
    y: z.coerce.number().finite().min(-10_000).max(10_000),
}).strict();

const floorplanRoomSchema = z.object({
    id: reqStr(80, "ID místnosti"),
    name: reqStr(150, "Název místnosti"),
    width: z.coerce.number().finite().min(1).max(10_000),
    height: z.coerce.number().finite().min(1).max(10_000),
    fixtures: z.array(floorplanFixtureSchema).max(MAX_FLOORPLAN_FIXTURES, "Příliš mnoho prvků v místnosti"),
    corners: z.array(floorplanCornerSchema)
        .min(3, "Místnost musí mít alespoň 3 rohy")
        .max(24, "Místnost může mít nejvýše 24 rohů")
        .optional(),
}).strict();

const floorplanSchema = z.object({
    rooms: z.array(floorplanRoomSchema).max(MAX_FLOORPLAN_ROOMS, "Příliš mnoho místností"),
}).strict();

const settingsBusinessSchema = z.object({
    name: optStr(200, "Název provozovny"),
    ico: optStr(20, "IČO"),
    dic: optStr(20, "DIČ"),
    address: optStr(300, "Adresa"),
    email: optStr(200, "E-mail"),
    phone: optStr(30, "Telefon"),
    // go-live Task 5 (spec §7): optional fixed effective-date string for the
    // legal template pages (see settings.js's DEFAULT_SETTINGS comment).
    termsEffectiveDate: optStr(40, "Datum účinnosti podmínek"),
}).strict();

const settingsSchema = z.object({
    business: settingsBusinessSchema,
    reservations: z.object({
        paused: z.coerce.boolean(),
        // Booking horizon in days (2026-08-09 review, fix 2). Declared here
        // because this object is .strict() and the admin panel PUTs back the
        // whole settings object it GET-ed — a default settings.js ships but
        // this schema doesn't declare 400s every save. Capped at a year:
        // beyond that the per-table record just accumulates date keys
        // nobody will ever look at.
        maxDaysAhead: boundedInt(0, 365, "Rezervace dopředu (dny)"),
        days: reservationDaysSchema,
    }).strict(),
    delivery: z.object({
        paused: z.coerce.boolean(),
        days: deliveryDaysSchema,
        fee: nonNegNumber(10_000, "Poplatek za dopravu"),
        minOrder: nonNegNumber(100_000, "Minimální objednávka"),
        freeAbove: nonNegNumber(100_000, "Doprava zdarma od"),
        pscWhitelist: pscWhitelistSchema,
        etaMinutes: boundedInt(1, 600, "Doba doručení (min)"),
        routing: routingSchema,
    }).strict(),
    // Customer QR self-order (spec 2026-08-04 §7). MUST be declared here or
    // PUT /settings 400s the moment the admin panel sends back the object it
    // just fetched — same persistence hazard as floorplanSchema below.
    // Reuses deliveryDaysSchema: the shapes are identical on purpose.
    tableOrdering: z.object({
        enabled: z.coerce.boolean(),
        days: deliveryDaysSchema,
    }).strict(),
    closedDays: closedDaysSchema,
    dailyMenu: z.object({
        enabled: z.coerce.boolean(),
        from: hhmmSchema,
        to: hhmmSchema,
    }).strict(),
    notifications: z.object({
        smsOrderConfirmed: z.coerce.boolean(),
        smsOrderOnTheWay: z.coerce.boolean(),
        smsReservationConfirmed: z.coerce.boolean(),
        smsReservationReminder: z.coerce.boolean(),
        emailEnabled: z.coerce.boolean(),
    }).strict(),
    // Floorplan (design doc §4.2/§7.1): rooms + fixtures for the admin
    // *Rozložení* editor. Like every other section of settingsSchema, this
    // must be declared here or PUT /settings 400s the instant a client sends
    // it — see the design's persistence hazard #5.
    floorplan: floorplanSchema,
}).strict();

// ── USERS / DRIVERS SCHEMAS ──────────────────────────────────────────────
// abbreviation/username are compared with `===` against stored string
// values (`u.abbreviation === abbreviation`) — forcing these through
// z.string() here means an object/array-typed value is rejected with a
// clean 400 up front instead of silently never-matching deeper in the
// route (harmless either way, but this is the explicit, intended fix).

const loginSchema = z.object({
    abbreviation: reqStr(100, "Přihlašovací jméno"),
    password: passwordSchema(200),
}).strict();

const driverLoginSchema = z.object({
    username: reqStr(100, "Přihlašovací jméno"),
    password: passwordSchema(200),
}).strict();

const createUserSchema = z.object({
    name: reqStr(150, "Jméno"),
    abbreviation: reqStr(100, "Zkratka"),
    password: passwordSchema(200, 4, "Heslo je příliš krátké"),
    isAdmin: z.coerce.boolean().optional(),
    isDriver: z.coerce.boolean().optional(),
}).strict();

const createDriverSchema = z.object({
    name: reqStr(150, "Jméno"),
    username: reqStr(100, "Uživatelské jméno"),
    password: passwordSchema(200, 4, "Heslo je příliš krátké"),
}).strict();

// ── GOPAY WEBHOOK ─────────────────────────────────────────────────────────
// Public, unauthenticated-by-design (GoPay calls it server-to-server); the
// handler re-verifies status against GoPay's own API rather than trusting
// the body, but the id/paymentId field is still worth shape-capping so a
// junk payload can't reach db.get() with a bizarre key type.
const gopayWebhookBodySchema = z.object({
    id: z.union([z.string().max(200), z.number()]).optional(),
    paymentId: z.union([z.string().max(200), z.number()]).optional(),
}).passthrough();

module.exports = {
    z,
    validate,
    validateParams,
    rejectDangerousKeys,
    containsDangerousKeys,

    // params
    paramsName,
    paramsFileId,
    paramsId,
    paramsReceiptId,
    paramsOrderId,
    paramsGatewayTxId,
    paramsTableToken,
    systemIdParam,
    freeTextNameParam,

    // bodies
    createOrderSchema,
    createIndoorOrderSchema,
    tableOrderSchema,
    markPaidSchema,
    claimOrderSchema,
    refundReasonSchema,
    kitchenStatusSchema,
    kitchenIndoorStatusSchema,
    kitchenIndoorRemoveSchema,
    kitchenReservationMarkPaidSchema,
    kitchenReservationPayOnlineSchema,
    payOnlineReturnUrlSchema,
    sendCodeSchema,
    verifyAndBookSchema,
    reorderSendCodeSchema,
    reorderVerifySchema,
    createTimetableSchema,
    timetablePutSchema,
    deleteTimetableByNameSchema,
    renameTimetableSchema,
    menuPutSchema,
    combosPutSchema,
    dailyMenuPutSchema,
    settingsSchema,
    loginSchema,
    driverLoginSchema,
    createUserSchema,
    createDriverSchema,
    gopayWebhookBodySchema,
    driverRouteSchema,
    claimBatchSchema,
};
