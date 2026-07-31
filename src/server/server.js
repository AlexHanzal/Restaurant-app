// ============================================================================
// CONFIG (SAFE FOR RENDER + LOCAL)
// ============================================================================
//
// MIGRATED TO SQLITE — see db.js and migrate-json-to-sqlite.js.
// Every collection that used to be "one JSON file per record" (timetables,
// users, drivers, orders, indoor-orders, menu) is now stored as rows in a
// single SQLite database (data/app.db by default). The record *shape* is
// unchanged — this file still works with the exact same plain JS objects,
// it just calls db.list/get/set/remove instead of fs.readdir/readFile/
// writeFile/unlink for those six things.
//
// Run `node migrate-json-to-sqlite.js` once before starting this server if
// you have existing data/*.json files you want carried over.
// ============================================================================

const SERVER_CONFIG = {
    port: process.env.PORT || 3000,
    basePath: "/reservation",
    appName: "School Reservation System",
    apiVersion: "1.0",
    // SECURITY (3rd hardening pass): the old `corsOrigins: "all"` flag that
    // used to live here is gone — CORS is no longer a static on/off switch,
    // it's computed per-request in configureCors()/buildCorsAllowList()
    // further down (own-origin always allowed + ALLOWED_ORIGINS env var +
    // localhost defaults in dev). See that function's header comment.
    // Collection names in SQLite (was: directory names on disk)
    collections: {
        timetables: "timetables",
        users: "users",
        drivers: "drivers",
        orders: "orders",
        indoorOrders: "indoor_orders",
        menu: "menu",
        // go-live Task 3 (spec §5): daily specials ("polední menu"), one
        // record per calendar date, id = "YYYY-MM-DD" — see the
        // "DAILY MENU" section further down for the shape/routes.
        dailyMenu: "daily_menu",
        payments: "payments",
        receipts: "receipts",
        receiptCounters: "receipt_counters",
        // Combo menus ("Zvýhodněná menu" — docs/superpowers/specs/
        // 2026-07-22-combo-menus-design.md). Same one-singleton-record
        // pattern as `menu` above: db.get(COL.combos, COMBOS_SINGLETON_ID)
        // holds the WHOLE array of combo objects. See the "COMBOS" route
        // section and priceOrderItems()'s COMBO_ITEM_ID_PREFIX branch
        // further down for the shape/pricing rules.
        combos: "combos",
    },
    serveFrontend: true,
    frontendPath: "src",

    // ── SMS verification (Twilio) ──────────────────────────────────────
    sms: {
        accountSid: process.env.TWILIO_ACCOUNT_SID || "",
        authToken: process.env.TWILIO_AUTH_TOKEN || "",
        fromNumber: process.env.TWILIO_FROM_NUMBER || "",
        codeLength: 6,
        codeTtlMs: 5 * 60 * 1000,
        maxAttempts: 5,
        resendCooldownMs: 30 * 1000,
    },

    // ── PAYMENTS (GoPay) ─────────────────────────────────────────────────
    // Same dev-fallback pattern as Twilio above: until GOPAY_GOID/CLIENT_ID/
    // CLIENT_SECRET are all set, online-card orders are created with
    // paymentStatus "unpaid" and a simulated gateway URL is logged to the
    // console instead of a real GoPay redirect, so the flow is testable
    // end-to-end locally before real credentials exist.
    // NOTE: cash / card-on-delivery orders never touch this block at all —
    // they're collected physically by the driver/waiter, same as today.
    payments: {
        goid: process.env.GOPAY_GOID || "",
        clientId: process.env.GOPAY_CLIENT_ID || "",
        clientSecret: process.env.GOPAY_CLIENT_SECRET || "",
        sandbox: process.env.GOPAY_SANDBOX !== "false", // default to sandbox until explicitly turned off
        returnUrl: process.env.GOPAY_RETURN_URL || "", // where GoPay sends the customer back after paying
        // GoPay's server-to-server payment-status callback. If unset, we
        // derive it from the incoming request's own origin at payment-create
        // time (…/api/payments/gopay/webhook) so sandbox testing works
        // without extra env vars; set this explicitly in production so it
        // doesn't depend on which host/proxy handled the /orders request.
        notificationUrl: process.env.GOPAY_NOTIFICATION_URL || "",
    },

    // ── BUSINESS / SELLER IDENTITY (for receipts / účtenky) ────────────────
    // Same dev-fallback pattern as SMS/GoPay above: sensible placeholder
    // values so receipts render locally without any env setup. Set real
    // values in production. BUSINESS_VAT_PAYER defaults to "false" — until
    // this business is VAT-registered, receipts must say "Nejsme plátci
    // DPH" and never show a VAT breakdown (see docs/CZ-PAYMENTS-SETUP.md).
    business: {
        name: process.env.BUSINESS_NAME || "Ukázková restaurace s.r.o.",
        ico: process.env.BUSINESS_ICO || "12345678",
        dic: process.env.BUSINESS_DIC || "CZ12345678",
        address: process.env.BUSINESS_ADDRESS || "Náměstí Svobody 1, 602 00 Brno",
        vatPayer: process.env.BUSINESS_VAT_PAYER === "true", // default: NOT a VAT payer
    },
};

// ============================================================================

const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const compression = require("compression"); // gzip — performance optimization design (2026-07-23) §1
const path = require("path");
const crypto = require("crypto");
const fs = require("fs").promises; // still used for serving frontend HTML files
const db = require("./db");
const minify = require("./minify"); // esbuild minify-on-serve for .js/.css — see minify.js, same design doc §2
const gopay = require("./gopay");
const security = require("./security");
const csrf = require("./csrf"); // CSRF double-submit-cookie protection — see csrf.js
const V = require("./validation"); // input validation (zod schemas + validate()/validateParams() middleware) — see validation.js
const settingsStore = require("./settings"); // restaurant settings singleton (hours/closed days/pause/delivery rules) — see settings.js
const notify = require("./notify"); // customer notifications: SMS (Twilio) + optional e-mail (nodemailer) — see notify.js, go-live Task 4
// One-tap "Objednat znovu" (reorder) — docs/superpowers/specs/2026-07-25-
// reorder-design.md. Self-contained module (token sign/verify, pending-code
// store, recent-order selection/preview) — see its header comment for why
// it takes the pricing function as an argument instead of importing
// priceOrderItems() itself. server.js only wires it up behind four thin
// routes (see the "REORDER" section below, after the reservation routes).
const reorder = require("./reorder");
// Same self-contained-module convention as reorder.js/settings.js above.
// See each file's header comment for the threat model it addresses
// (audit 2026-07-29, findings F4 and F5).
const { safeReturnUrl } = require("./urlsafe");
const smscap = require("./smscap");
const {
    hashPassword,
    comparePassword,
    issueSessionCookie,
    clearSessionCookie,
    requireAuth,
    requireAdmin,
    requireDriver,
    requireStaff,
    // go-live Task 3 (spec §5): GET /api/daily-menu's `?date=` admin override
    // needs to check "is this caller a logged-in admin?" WITHOUT rejecting
    // the request outright when they aren't (the same route's default,
    // no-`?date=` path stays fully public) — so it reads/verifies the auth
    // cookie by hand instead of using the requireAdmin middleware (which
    // always short-circuits with a 401/403). See getAdminUserIfAny() below.
    verifyToken,
    COOKIE_NAME: AUTH_COOKIE_NAME,
} = require("./auth");

const app = express();

// SECURITY: Render (and most PaaS hosts) put the app behind exactly one
// reverse-proxy hop, so `req.ip`/`req.secure` should trust the *first*
// X-Forwarded-* entry from that hop only — not the whole XFF chain, which a
// client could pad with arbitrary fake IPs to spoof req.ip and dodge the
// per-IP rate limiters below. `1` here means "trust 1 hop", not "trust all
// proxies" (that would be `true`). Adjust if the deployment topology
// changes (e.g. an extra CDN/load balancer in front adds another hop).
app.set("trust proxy", 1);

// SECURITY (3rd hardening pass): NODE_ENV=production gate used consistently
// below by the HTTPS-redirect middleware, helmet's HSTS/upgrade-insecure-
// requests directives, and CORS's default allow-list — all transport-layer
// behavior that should be a strict no-op during local `npm start` (plain
// HTTP, no reverse proxy) and only kick in on Render.
const isProd = process.env.NODE_ENV === "production";

const COL = SERVER_CONFIG.collections;
const MENU_SINGLETON_ID = "singleton";
// Combo menus (spec above) — same singleton-record pattern as the menu.
const COMBOS_SINGLETON_ID = "singleton";

// ============================================================================
// SMS (TWILIO) — client/credentials/fallback logic lives in notify.js (go-
// live Task 4) so there is exactly one copy shared by the verification-code
// path below AND the customer-notification events (order confirmed/on-the-
// way, reservation confirmed/reminder). This section keeps only what's
// specific to the verification-code flow itself.
// ============================================================================

function smsIsConfigured() {
    return notify.isSmsConfigured();
}

const pendingVerifications = new Map();

function normalizePhone(raw) {
    return (raw || "").trim().replace(/[\s\-().]/g, "");
}

// SECURITY: crypto.randomInt (CSPRNG) instead of Math.random() — the SMS
// code gates a real booking + food order, so it must not be predictable.
function generateCode(length) {
    let code = "";
    for (let i = 0; i < length; i++) code += crypto.randomInt(0, 10);
    return code;
}

// Unlike the fire-and-forget notification events (see notify.js's own
// header comment), the verification-code SMS is NOT fire-and-forget: its
// caller (POST /reservations/send-code) awaits this and must still surface
// a real failure to the customer as a 500 (same behavior as before this
// refactor) — so notify.sendSms()'s `{ ok: false }` result is turned back
// into a thrown error here, deliberately, rather than swallowed.
async function sendVerificationSms(phone, code) {
    const message = `Váš ověřovací kód pro rezervaci: ${code} (platnost 5 minut).`;
    const result = await notify.sendSms(phone, message);
    if (!result.ok) throw new Error(result.error || "SMS send failed");
    return { simulated: result.simulated };
}

// Reorder feature (spec §7) needs its own verification SMS text — the
// existing sendVerificationSms() above hardcodes "pro rezervaci" ("for your
// reservation"), which would be a wrong/confusing message for someone who's
// just trying to look at their past delivery orders. A separate function
// (rather than adding a message parameter to sendVerificationSms and
// updating its one call site) keeps that existing function and its callers
// completely untouched, per this task's scope. Same await-and-throw-on-
// failure shape: POST /reorder/send-code awaits this and must turn a real
// send failure into a 500, exactly like the reservation flow.
async function sendReorderCodeSms(phone, code) {
    const message = `Váš ověřovací kód pro zobrazení vašich objednávek: ${code} (platnost 5 minut).`;
    const result = await notify.sendSms(phone, message);
    if (!result.ok) throw new Error(result.error || "SMS send failed");
    return { simulated: result.simulated };
}

// ============================================================================
// PAYMENTS (GOPAY) — real REST API client (src/server/gopay.js), same
// dev-fallback pattern as Twilio above: until GOPAY_GOID/CLIENT_ID/
// CLIENT_SECRET are all set, payments are simulated (logged to the console,
// no real gateway contacted) so every "pay online" flow stays testable
// end-to-end locally without real credentials.
// ============================================================================
//
// The `payments` SQLite collection is the single source of truth mapping a
// GoPay transaction id back to whatever it's paying for, across all three
// flows that can go through the gateway:
//   { id: gatewayTransactionId, kind: "delivery",    target: { orderId } }
//   { id: gatewayTransactionId, kind: "indoor",       target: { orderId } }
//   { id: gatewayTransactionId, kind: "reservation",  target: { fileId, dateStr, dayIndex, startHour, endHour } }
// The webhook (and the status-polling routes) look the transaction up here
// first, then dispatch to the right collection/record. This is what lets a
// single generic webhook handler serve delivery orders, walk-in table
// orders, and reservation-attached food orders without three copies of the
// same logic.

function paymentsAreConfigured() {
    const p = SERVER_CONFIG.payments;
    return !!(p.goid && p.clientId && p.clientSecret);
}

// Works out the return/notification URLs GoPay needs. Falls back to this
// request's own origin when GOPAY_RETURN_URL / GOPAY_NOTIFICATION_URL
// aren't set in env, so sandbox testing works without extra config.
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

// Starts a gateway payment for any of the three payable things in this app
// and records it in the `payments` collection. Real GoPay call when
// configured; console-logged simulation otherwise (order/slot stays
// "unpaid" until the simulated webhook is triggered — see the log line for
// exactly how to do that locally).
async function initiateGatewayPayment({ req, kind, target, amountCzk, items, description, orderNumber, returnUrl: overrideReturnUrl }) {
    const { returnUrl, notificationUrl } = gatewayCallbackUrls(req, overrideReturnUrl);
    const now = new Date().toISOString();

    if (!paymentsAreConfigured()) {
        const gatewayTransactionId = `SIMULATED-${generateFileId()}`;
        db.set(COL.payments, gatewayTransactionId, {
            id: gatewayTransactionId,
            kind,
            target,
            amountCzk,
            status: "pending",
            simulated: true,
            createdAt: now,
            updatedAt: now,
        });
        console.log(`💳 [Payment fallback — no real gateway] ${kind} ${orderNumber}: ${amountCzk} Kč — simulated GoPay checkout`);
        console.log(`   ↳ To simulate GoPay confirming payment locally: GET ${notificationUrl}?id=${gatewayTransactionId}`);
        return { simulated: true, gatewayTransactionId, redirectUrl: null };
    }

    const payment = await gopay.createPayment(SERVER_CONFIG.payments, {
        orderNumber,
        amountCzk,
        items,
        returnUrl,
        notificationUrl,
        description,
    });

    const gatewayTransactionId = String(payment.id);
    db.set(COL.payments, gatewayTransactionId, {
        id: gatewayTransactionId,
        kind,
        target,
        amountCzk,
        status: "pending",
        simulated: false,
        createdAt: now,
        updatedAt: now,
    });

    return { simulated: false, gatewayTransactionId, redirectUrl: payment.gw_url };
}

// Applies a verified GoPay payment state to whatever the payment record
// targets. Called only after re-fetching status from GoPay directly (or,
// for simulated payments, from our own trusted record) — never from an
// unverified webhook body.
async function applyGatewayPaymentState(record, state) {
    let newStatus;
    if (state === "PAID" || state === "AUTHORIZED") newStatus = "paid";
    else if (state === "CANCELED" || state === "TIMEOUTED") newStatus = "failed";
    else if (state === "REFUNDED" || state === "PARTIALLY_REFUNDED") newStatus = "refunded";
    else newStatus = "pending"; // CREATED / PAYMENT_METHOD_CHOSEN — still in progress

    if (newStatus === record.status) return newStatus; // no change, nothing to propagate

    record.status = newStatus;
    record.updatedAt = new Date().toISOString();
    db.set(COL.payments, record.id, record);

    if (newStatus !== "paid" && newStatus !== "failed" && newStatus !== "refunded") return newStatus;
    const paid = newStatus === "paid";

    let receiptCreated = null;

    if (record.kind === "delivery" || record.kind === "indoor") {
        const col = record.kind === "delivery" ? COL.orders : COL.indoorOrders;
        const order = db.get(col, record.target.orderId);
        if (order) {
            // CANCELED/TIMEOUTED: keep the order around (customer/waiter can
            // retry payment) but flag it so staff don't mistake it for paid.
            order.paymentStatus = paid ? "paid" : (newStatus === "refunded" ? "refunded" : "unpaid");
            order.paymentFailed = newStatus === "failed";
            if (paid) {
                const receipt = createReceiptForOrder({
                    kind: record.kind,
                    // Delivery orders get their fee appended as its own
                    // receipt line (see deliveryReceiptItems); indoor orders
                    // have no delivery fee at all, so they pass items through
                    // unchanged.
                    items: record.kind === "delivery" ? deliveryReceiptItems(order) : order.items,
                    total: order.total,
                    paymentMethod: order.paymentMethod,
                    existingReceiptId: order.receiptId,
                    description: record.kind === "delivery"
                        ? `Rozvoz — objednávka ${order.id}`
                        : `Stůl ${order.tableName} — objednávka ${order.id}`,
                });
                order.receiptId = receipt.id;
                receiptCreated = receipt;
            }
            db.set(col, order.id, order);
        }
    } else if (record.kind === "reservation") {
        const { fileId, dateStr, dayIndex, startHour, endHour } = record.target;
        const data = db.get(COL.timetables, fileId);
        const hoursObj = data && data.data && data.data[dateStr] && data.data[dateStr][dayIndex];
        if (hoursObj) {
            if (paid) {
                const primarySlot = hoursObj[startHour];
                if (primarySlot && Array.isArray(primarySlot.order) && primarySlot.order.length > 0) {
                    receiptCreated = createReceiptForOrder({
                        kind: "reservation",
                        items: primarySlot.order,
                        total: primarySlot.orderTotal,
                        paymentMethod: "online_card",
                        existingReceiptId: primarySlot.receiptId,
                        description: `Rezervace ${data.className} — ${dateStr}`,
                    });
                }
            }
            for (let h = startHour; h <= endHour; h++) {
                if (hoursObj[h]) {
                    hoursObj[h].isPaid = paid;
                    hoursObj[h].paymentFailed = newStatus === "failed";
                    if (receiptCreated) hoursObj[h].receiptId = receiptCreated.id;
                }
            }
            db.set(COL.timetables, fileId, data);
        }
    }

    if (receiptCreated) {
        record.receiptId = receiptCreated.id;
        db.set(COL.payments, record.id, record);
    }

    // Every code path that reaches here (paid/failed/refunded) has just
    // written a paymentStatus/isPaid change to a delivery order, an indoor
    // order, or a reservation slot — all three are visible on the kitchen
    // board (see broadcastBoardEvent()'s definition further down for why
    // it's safe to call this early: it's a hoisted function declaration).
    broadcastBoardEvent();

    return newStatus;
}

// ============================================================================
// MENU PRICING — server-side source of truth for item prices/order totals
// ============================================================================
// Every order-creation route (delivery /orders, /indoor-orders, and
// reservation food orders via /reservations/send-code) used to trust
// whatever price/total the client sent — trivially editable in devtools.
// From here on, clients may only send an item identifier (dish id, or its
// name — see the two cart shapes below) + qty; the price and total are
// always looked up/recomputed against the live `menu` collection here.

const MAX_ITEM_QTY = 50;
const MAX_ITEMS_PER_ORDER = 200;

// ── VAT (DPH) rates ─────────────────────────────────────────────────────
// Czech restaurant rates: 12% reduced rate (food for immediate consumption),
// 21% standard rate (drinks, incl. draft beer — moved to standard rate in
// the 2024 tax reform), 0% for the rare exempt/zero-rated case. Menu items
// may set an explicit `vatRate`; items that don't (e.g. pre-existing menu
// data from before this field existed) default to 12 (food) here, at the
// single point every downstream consumer (pricing, receipts, GoPay items)
// reads the rate through — so old menu data never breaks.
const VALID_VAT_RATES = [0, 12, 21];
const DEFAULT_VAT_RATE = 12;

function resolveVatRate(dish) {
    const rate = Number(dish && dish.vatRate);
    return VALID_VAT_RATES.includes(rate) ? rate : DEFAULT_VAT_RATE;
}

// menu = { [categoryId]: [ {id, name, price, ...}, ... ], ... } — flatten
// across categories since an item id/name is unique regardless of category.
function flattenMenuDishes(menuData) {
    const flat = [];
    for (const categoryId of Object.keys(menuData || {})) {
        const dishes = menuData[categoryId];
        if (Array.isArray(dishes)) flat.push(...dishes);
    }
    return flat;
}

function findMenuDish(flatDishes, identifier) {
    if (identifier === undefined || identifier === null) return null;
    const key = String(identifier).trim().toLowerCase();
    if (!key) return null;
    return (
        flatDishes.find(d => d.id != null && String(d.id).toLowerCase() === key) ||
        flatDishes.find(d => (d.name || "").trim().toLowerCase() === key) ||
        null
    );
}

// go-live Task 3 (spec §5): a cart item identifies a "today's specials"
// (dailyMenu collection) line, rather than an ordinary menu dish, by
// prefixing whichever identifier field it uses (id/item/name — see the two
// cart shapes below) with this literal string, e.g. `"daily:AbC123xyz0"`.
// Chosen over a separate boolean flag because every cart shape/schema in
// this app (cartItemSchema in validation.js, the delivery/indoor/reservation
// carts) already keys an item purely by a single identifier string — adding
// a whole new sibling field to every one of those shapes (and every route
// that reads them) just to say "this one's from today's menu" would be a
// much bigger, more error-prone change than namespacing the identifier
// itself. findMenuDish() below never returns a dish whose id/name happens to
// collide with this prefix (regular menu dish ids are admin-generated
// alnum ids — see generateFileId() in inner.js — never containing ":"), so
// there is no ambiguity in practice; the admin menu editor doesn't need to
// guard against it separately.
const DAILY_ITEM_ID_PREFIX = "daily:";

// Combo menus (spec: docs/superpowers/specs/2026-07-22-combo-menus-design.md)
// — same namespacing trick as DAILY_ITEM_ID_PREFIX above, for the same
// reason (every cart shape already keys an item by a single identifier
// string, so a combo line identifies itself by prefixing that identifier
// instead of needing a new sibling field everywhere), e.g.
// `"combo:aB3xK9…"`. Regular menu dish ids never contain ":" (same
// generateFileId() alnum pattern noted above) and combo ids are minted the
// same way (inner.js), so there's no ambiguity with either prefix in
// practice.
const COMBO_ITEM_ID_PREFIX = "combo:";

// Lazily loads + memoizes "today's daily-menu record" + "is the window open
// right now" for the duration of a single priceOrderItems() call — computed
// at most once per call, and only if the cart actually contains a daily
// item (the common case, an all-regular-menu cart, never touches the
// dailyMenu collection or settings at all).
function makeDailyMenuContext() {
    let resolved = null;
    return function getDailyMenuContext() {
        if (!resolved) {
            const settings = settingsStore.getSettings();
            resolved = {
                windowCheck: settingsStore.isDailyMenuWindowOpen(settings),
                record: db.get(COL.dailyMenu, settingsStore.formatDateStrLocal(new Date())) || null,
            };
        }
        return resolved;
    };
}

// Same lazy-memoization idea as makeDailyMenuContext() above, for the combos
// singleton — only ever queried if the cart actually contains a "combo:"
// line.
function makeCombosContext() {
    let resolved = null;
    return function getCombos() {
        if (!resolved) {
            resolved = db.get(COL.combos, COMBOS_SINGLETON_ID) || [];
        }
        return resolved;
    };
}

// Recomputes prices + total for client-submitted cart items against the
// live menu (and, for daily-menu items — see DAILY_ITEM_ID_PREFIX above —
// against TODAY's dailyMenu record instead). Handles both cart shapes used
// across the app:
//   delivery cart:            { id, name, price, categoryId, qty }
//   indoor/reservation cart:  { item, price, qty }
// Output preserves whichever shape was sent (so downstream code that reads
// item.name vs item.item keeps working) but price/qty are always the
// server-verified values. Returns { items, total } or { error }.
//
// This is the ONE place every order-creation route (POST /orders delivery,
// POST /indoor-orders, POST /reservations/send-code's food preorder) funnels
// through — so it's also the one place go-live Task 3's two menu-ops rules
// are enforced everywhere at once:
//   - a regular menu dish with `soldOut: true` is rejected outright (Czech
//     400 naming the dish) — covers both "removed from the menu by the time
//     the order lands" (findMenuDish returns null, existing behavior) and
//     "still on the menu, but marked sold out today" (new).
//   - a daily-menu item is only accepted (and only ever priced from the
//     server's own record, never the client) while the same enabled/from/to
//     window that gates GET /api/daily-menu's public response is open —
//     spec §5 explicitly says sold-out logic does NOT apply to these (they
//     are same-day by construction, so "sold out" isn't a meaningful state
//     for them within this function).
function priceOrderItems(rawItems) {
    if (!Array.isArray(rawItems) || rawItems.length === 0) {
        return { error: "Košík je prázdný" };
    }
    if (rawItems.length > MAX_ITEMS_PER_ORDER) {
        return { error: "Příliš mnoho položek v objednávce" };
    }

    const menuData = db.get(COL.menu, MENU_SINGLETON_ID) || {};
    const flatDishes = flattenMenuDishes(menuData);
    const getDailyMenuContext = makeDailyMenuContext();
    const getCombos = makeCombosContext();

    const items = [];
    let total = 0;

    for (const raw of rawItems) {
        if (!raw || typeof raw !== "object") return { error: "Neplatná položka objednávky" };

        const qty = Number(raw.qty);
        if (!Number.isInteger(qty) || qty <= 0 || qty > MAX_ITEM_QTY) {
            return { error: "Neplatné množství u položky (1–50 ks)" };
        }

        const identifier = raw.id ?? raw.item ?? raw.name;
        const identifierStr = identifier == null ? "" : String(identifier);

        if (identifierStr.startsWith(DAILY_ITEM_ID_PREFIX)) {
            const { windowCheck, record } = getDailyMenuContext();
            if (!windowCheck.ok) {
                return { error: windowCheck.reason };
            }
            const dailyId = identifierStr.slice(DAILY_ITEM_ID_PREFIX.length);
            const dailyItem = record && Array.isArray(record.items)
                ? record.items.find(it => it && String(it.id) === dailyId)
                : null;
            if (!dailyItem) {
                return { error: `Položka poledního menu "${dailyId}" už není k dispozici` };
            }

            const price = Number(dailyItem.price) || 0;
            const resolved = { ...raw, qty, price };
            // Keeps the "daily:" prefix on the stored id — receipts/stats
            // only ever read .name/.price/.qty/.vatRate off order lines (see
            // createReceiptForOrder/GET /stats/sales), so the prefix being
            // present here is inert everywhere downstream; it's simply the
            // one unambiguous marker of "this line came from the dailyMenu
            // record", kept for any future consumer that needs to tell the
            // two kinds of line apart again.
            if (Object.prototype.hasOwnProperty.call(resolved, "id")) resolved.id = identifierStr;
            if (Object.prototype.hasOwnProperty.call(resolved, "item")) resolved.item = dailyItem.name;
            resolved.name = dailyItem.name;
            resolved.vatRate = resolveVatRate(dailyItem);

            items.push(resolved);
            total += price * qty;
            continue;
        }

        // Combo menus (spec: docs/superpowers/specs/2026-07-22-combo-menus-
        // design.md) — a "combo:<comboId>" line is priced from the combos
        // singleton PLUS whatever per-slot customization the customer chose
        // (comboConfig: removed slots, swapped dishes, paid extras, a free-
        // text note), never from the client-sent price/name. Mirrors the
        // "daily:" branch above in shape (namespaced identifier → look up
        // the server-side record → recompute price/name → push a resolved
        // line), but has its own, considerably larger validation surface
        // because a combo has an actual customer-facing customization UI
        // (the daily-menu branch above has none — it's just "pick one of
        // today's fixed items").
        if (identifierStr.startsWith(COMBO_ITEM_ID_PREFIX)) {
            const comboId = identifierStr.slice(COMBO_ITEM_ID_PREFIX.length);
            const combos = getCombos();
            const combo = Array.isArray(combos) ? combos.find(c => c && String(c.id) === comboId) : null;
            if (!combo) {
                return { error: `Menu "${comboId}" už není k dispozici` };
            }
            if (combo.soldOut) {
                return { error: `Menu "${combo.name}" je vyprodáno` };
            }

            // `comboConfig` is untrusted client input — it passed
            // cartItemSchema's `.passthrough()` (see validation.js), which
            // means its own shape is completely unchecked by zod. Every
            // piece is treated as "maybe garbage" here: a container of the
            // wrong type is defensively treated as empty (safe — it just
            // means "no changes of that kind", never a way to smuggle
            // something past the checks below), and every individual
            // value is validated against the combo's own definition before
            // it's allowed to affect price or the stored line.
            const config = (raw.comboConfig && typeof raw.comboConfig === "object" && !Array.isArray(raw.comboConfig))
                ? raw.comboConfig
                : {};
            const removedRaw = Array.isArray(config.removed) ? config.removed.map(String) : [];
            const swapsRaw = (config.swaps && typeof config.swaps === "object" && !Array.isArray(config.swaps))
                ? config.swaps
                : {};
            const extraIdsRaw = Array.isArray(config.extras) ? config.extras.map(String) : [];
            // Unlike removed/swaps/extras (containers that are safe to just
            // treat as empty when malformed — see comment above), a present-
            // but-wrong-typed note is rejected outright rather than silently
            // dropped: it's free text that ends up verbatim in the rebuilt
            // display name shown to kitchen/staff/receipts, so "must be a
            // string ≤ 200 chars" is enforced as a real validation rule here,
            // not just defensive coercion.
            let note = "";
            if (config.note !== undefined && config.note !== null) {
                if (typeof config.note !== "string") {
                    return { error: `Poznámka u menu "${combo.name}" musí být text` };
                }
                note = config.note.trim();
                if (note.length > 200) {
                    return { error: `Poznámka u menu "${combo.name}" je příliš dlouhá (max 200 znaků)` };
                }
            }

            const comboItems = Array.isArray(combo.items) ? combo.items : [];
            const comboItemsBySlot = new Map(comboItems.map(it => [String(it && it.slotId), it]));

            // Removed slots must exist on the combo AND be marked removable.
            const removedSet = new Set();
            for (const slotId of removedRaw) {
                const slot = comboItemsBySlot.get(slotId);
                if (!slot || !slot.removable) {
                    return { error: `Menu "${combo.name}": neplatná položka k odebrání` };
                }
                removedSet.add(slotId);
            }

            // Swaps: the slot must exist, must NOT also be removed, and the
            // target dish must be one of that slot's configured swap
            // options — plus still exist on the live menu and not be sold
            // out (checked once here; the effective-dish pass further below
            // only needs to re-check the DEFAULT dish for slots that were
            // neither removed nor swapped).
            const swapMap = new Map();
            for (const slotIdRaw of Object.keys(swapsRaw)) {
                const targetDishIdRaw = swapsRaw[slotIdRaw];
                if (targetDishIdRaw === null || targetDishIdRaw === undefined || targetDishIdRaw === "") continue;
                const slotId = String(slotIdRaw);
                const slot = comboItemsBySlot.get(slotId);
                if (!slot) {
                    return { error: `Menu "${combo.name}": neplatná záměna položky` };
                }
                if (removedSet.has(slotId)) {
                    return { error: `Menu "${combo.name}": položku nelze zároveň odebrat a nahradit` };
                }
                const targetDishId = String(targetDishIdRaw);
                const allowedSwaps = Array.isArray(slot.swaps) ? slot.swaps.map(String) : [];
                if (!allowedSwaps.includes(targetDishId)) {
                    return { error: `Menu "${combo.name}": zvolená náhrada není povolena` };
                }
                const swapDish = findMenuDish(flatDishes, targetDishId);
                if (!swapDish) {
                    return { error: `Položka náhrady v menu "${combo.name}" už není k dispozici` };
                }
                if (swapDish.soldOut) {
                    return { error: `Položka "${swapDish.name}" je vyprodaná.` };
                }
                swapMap.set(slotId, swapDish);
            }

            // Extras must exist on the combo, each at most once.
            const comboExtras = Array.isArray(combo.extras) ? combo.extras : [];
            const comboExtrasById = new Map(comboExtras.map(e => [String(e && e.id), e]));
            const seenExtraIds = new Set();
            for (const extraId of extraIdsRaw) {
                if (seenExtraIds.has(extraId)) {
                    return { error: `Menu "${combo.name}": příplatek je uveden vícekrát` };
                }
                seenExtraIds.add(extraId);
                if (!comboExtrasById.has(extraId)) {
                    return { error: `Menu "${combo.name}": zvolený příplatek už není k dispozici` };
                }
            }

            // Walk every slot once: removed slots subtract removeValue and
            // contribute a "bez …" note; swapped slots add the signed price
            // difference and a "… místo …" note; everything else is a
            // still-live slot whose DEFAULT dish must still exist on the
            // menu and not be sold out (swap targets were already checked
            // above).
            let priceDelta = 0;
            const removalNotes = [];
            const swapNotes = [];
            for (const slot of comboItems) {
                const slotId = String(slot.slotId);
                const defaultDish = findMenuDish(flatDishes, slot.dishId);

                if (removedSet.has(slotId)) {
                    priceDelta -= Number(slot.removeValue) || 0;
                    removalNotes.push(`bez ${defaultDish ? defaultDish.name : slot.dishId}`);
                    continue;
                }

                const swapDish = swapMap.get(slotId);
                if (swapDish) {
                    const defaultPrice = defaultDish ? Number(defaultDish.price) || 0 : 0;
                    priceDelta += (Number(swapDish.price) || 0) - defaultPrice;
                    swapNotes.push(`${swapDish.name} místo ${defaultDish ? defaultDish.name : slot.dishId}`);
                    continue;
                }

                if (!defaultDish) {
                    return { error: `Položka "${slot.dishId}" v menu "${combo.name}" už není k dispozici` };
                }
                if (defaultDish.soldOut) {
                    return { error: `Položka "${defaultDish.name}" v menu "${combo.name}" je vyprodaná` };
                }
            }

            // Extras notes/total in the combo's OWN extras order (not the
            // client-submitted order) so the rebuilt display name is
            // deterministic regardless of how the client sent extraIds.
            let extrasTotal = 0;
            const extraNotes = [];
            for (const extra of comboExtras) {
                const extraId = String(extra && extra.id);
                if (!seenExtraIds.has(extraId)) continue;
                extrasTotal += Number(extra.price) || 0;
                extraNotes.push(`+ ${extra.name}`);
            }

            const changeNotes = [...removalNotes, ...swapNotes, ...extraNotes];
            if (note) changeNotes.push(`pozn.: ${note}`);

            const basePrice = Number(combo.price) || 0;
            const price = Math.max(0, basePrice + priceDelta + extrasTotal);
            const displayName = changeNotes.length ? `${combo.name} (${changeNotes.join(", ")})` : combo.name;

            const resolved = { ...raw, qty, price };
            // Keeps the "combo:" prefix on the stored id — same reasoning as
            // the "daily:" prefix above (receipts/stats only ever read
            // .name/.price/.qty/.vatRate off order lines).
            if (Object.prototype.hasOwnProperty.call(resolved, "id")) resolved.id = identifierStr;
            // Unlike regular/daily lines, ALWAYS stamp BOTH .item and .name
            // with the rebuilt breakdown: the kitchen ticket for indoor
            // orders renders `item.item` (kitchen.js), delivery tickets
            // render `item.name` — a combo line submitted without one of
            // the two (e.g. a raw API client) would otherwise show a blank
            // dish name on one of the ticket kinds.
            resolved.item = displayName;
            resolved.name = displayName;
            resolved.vatRate = resolveVatRate(combo);

            items.push(resolved);
            total += price * qty;
            continue;
        }

        const dish = findMenuDish(flatDishes, identifier);
        if (!dish) {
            return { error: `Položka "${identifier || "?"}" není na menu` };
        }
        if (dish.soldOut) {
            return { error: `Položka "${dish.name}" je vyprodaná.` };
        }

        const price = Number(dish.price) || 0;
        const resolved = { ...raw, qty, price };
        if (Object.prototype.hasOwnProperty.call(resolved, "id")) resolved.id = dish.id;
        if (Object.prototype.hasOwnProperty.call(resolved, "item")) resolved.item = dish.name;
        // `name` is always stamped (not just preserved when the client sent
        // one) — the indoor/reservation cart shape only sends `item`, but
        // receipts and the GoPay items payload both need a reliable display
        // name regardless of which cart shape produced this line.
        resolved.name = dish.name;
        // Always stamped from the live menu (never client-sent) — used by
        // receipts and passed through to GoPay as items[].vat_rate.
        resolved.vatRate = resolveVatRate(dish);

        items.push(resolved);
        total += price * qty;
    }

    return { items, total: Math.round(total * 100) / 100 };
}

// GO-LIVE (settings.js, Task 2 — delivery rules): the delivery fee is stored
// on the order as its own `deliveryFee` field, deliberately NOT appended to
// `order.items` — GET /stats/sales sums per-dish counts/revenue straight out
// of `order.items`, and a synthetic "Doprava" entry in there would corrupt
// per-dish stats (wrong "dish" with qty 1 and no vatRate story of its own).
// Receipts, however, are legally required to show delivery as its own priced
// line with its own VAT rate (21% — standard rate, spec §4) — so this helper
// builds a receipt-only items array with that line appended, used solely by
// createReceiptForOrder() call sites for delivery orders. Never persisted
// back onto the order itself.
const DELIVERY_FEE_VAT_RATE = 21;
function deliveryReceiptItems(order) {
    const items = (order && order.items) || [];
    const fee = Number(order && order.deliveryFee) || 0;
    if (fee <= 0) return items; // free delivery (or a pre-Task-2 legacy order) — no extra line
    return [...items, { name: "Doprava", qty: 1, price: fee, vatRate: DELIVERY_FEE_VAT_RATE }];
}

// SECURITY (go-live Task 4 review fix, extended for GDPR): GET
// /timetables/:name is intentionally PUBLIC/unauthenticated — renderer.js
// (the customer-facing reservation page) depends on it to compute per-table
// hour availability without a login. But booking slots carry per-customer
// data the public must never see: `phone` (SMS-verified, written by
// applyBookingToTimetable for the reminder scanner), `content` (the guest's
// full name) plus `abbreviation` (their initials), the preordered food
// (`order`, `orderTotal`), payment state (`isPaid`, `paymentFailed`) and
// `receiptId` — that last one guards the receipt page, which is public
// *because* its id is unguessable, so leaking it here would publish paid
// customers' receipts. Rather than blocklisting fields one by one, this
// WHITELISTS exactly what renderer.js consumes: the record metadata it
// reads (className/fileId/info/attributes) and, per slot, only occupancy
// (`content` truthiness, collapsed to a fixed placeholder) and
// `isPermanent` (renderer applies permanent bookings across weeks). Any
// field added to slots or the record in the future is therefore private by
// default. Never mutates `record`/its nested objects — those are the exact
// objects db.list/db.get returned and may still be read elsewhere in this
// process; every returned object is freshly built.
//
// Floorplan (docs/superpowers/specs/2026-07-27-floorplan-table-picking-
// design.md §7.2): `seats` and `layout` are added to the record-level
// whitelist below. Both are safe to publish under the same "is this
// personal data?" test the rest of this whitelist already applies — `seats`
// is just an integer capacity, and `layout` is furniture geometry (which
// room, x/y/w/h), not anything about a customer or a booking. They're also
// exactly what the customer-facing floorplan (renderer.js) needs in order
// to draw the room at all, so withholding them would defeat the feature.
// This does NOT touch the per-slot whitelist above — sanitizeHoursObj still
// returns only `content`/`isPermanent` per hour, so `phone`, the guest's
// real name/`abbreviation`, `order`/`orderTotal`, `isPaid`/`paymentFailed`,
// `receiptId` and the new-in-this-feature `guests` (party size — see
// applyBookingToTimetable) all stay exactly as redacted as before.
function sanitizeTimetableForPublic(record) {
    const sourceData = (record && record.data) || {};
    const publicData = {};

    const sanitizeHoursObj = hoursObj => {
        if (!hoursObj || typeof hoursObj !== "object") return hoursObj;
        const publicHours = {};
        for (const hourKey of Object.keys(hoursObj)) {
            const slot = hoursObj[hourKey];
            if (slot && typeof slot === "object") {
                publicHours[hourKey] = {
                    // renderer.js only ever checks `content` for
                    // truthiness (occupied vs. free), so an occupied
                    // slot's name collapses to a fixed marker and an
                    // empty/missing one stays falsy.
                    content: slot.content ? "obsazeno" : "",
                    isPermanent: !!slot.isPermanent
                };
            } else {
                publicHours[hourKey] = slot;
            }
        }
        return publicHours;
    };

    for (const dateStr of Object.keys(sourceData)) {
        const dayArr = sourceData[dateStr];
        if (Array.isArray(dayArr)) {
            publicData[dateStr] = dayArr.map(sanitizeHoursObj);
        } else if (dayArr && typeof dayArr === "object") {
            // Day maps normally arrive as arrays (applyBookingToTimetable's
            // shape), but PUT /timetables/:name accepts loosely-shaped
            // client data — an object keyed by dayIndex must get the exact
            // same per-slot whitelisting, never a raw pass-through.
            const dayObj = {};
            for (const dayKey of Object.keys(dayArr)) {
                dayObj[dayKey] = sanitizeHoursObj(dayArr[dayKey]);
            }
            publicData[dateStr] = dayObj;
        }
        // Anything else (primitives/null) is dropped: renderer.js has no
        // use for it and "private by default" beats echoing unknown shapes.
    }

    return {
        className: record.className,
        fileId: record.fileId,
        info: record.info || "",
        attributes: record.attributes || [],
        // Floorplan (design doc §7.2): furniture geometry and a seat count,
        // not personal data — see the header comment above. `seats` stays
        // `null` (rather than e.g. 0) for tables that predate this feature
        // so the frontend can tell "no seat count set" apart from "zero
        // seats"; same reasoning for `layout` defaulting to `null` meaning
        // "not placed yet" (design §4.1).
        seats: typeof record.seats === "number" ? record.seats : null,
        layout: record.layout || null,
        data: publicData
    };
}

// go-live Task 4 (spec §6): order-confirmed SMS + e-mail, sent right after
// POST /orders creates the order (any payment method). Fire-and-forget —
// the caller (see setupAPIRoutes below) calls this WITHOUT awaiting it, and
// every notify.sendSms/sendEmail call already never rejects on its own; this
// wrapper is additionally wrapped in its own try/catch so a bug in message
// building can never throw back into the route that just successfully
// created (and already responded — or is about to respond — for) the order.
// `escapeHtml`/`formatCzk` are defined further below in this file (plain
// `function` declarations are hoisted, so referencing them here is safe).
function sendOrderConfirmedNotifications(order, settings, req) {
    try {
        const notifSettings = settings.notifications || {};

        if (notifSettings.smsOrderConfirmed && order.phone) {
            const etaMinutes = (settings.delivery && settings.delivery.etaMinutes) || 60;
            notify
                .sendSms(order.phone, `Objednávku č. ${order.id} jsme přijali. Doručíme přibližně do ${etaMinutes} min.`)
                .catch(e => console.error("Order-confirmed SMS crashed unexpectedly:", e));
        }

        if (notifSettings.emailEnabled && order.email) {
            const host = req.get("host");
            // A receipt only exists at this exact moment for a
            // near-instant-capture edge case (never true today — cash/COD
            // orders get a receipt at handoff, online-card at the GoPay
            // webhook, both strictly after this point) — checked anyway per
            // spec so the email stays correct if that ever changes.
            const receiptLine = order.receiptId
                ? `<p><a href="${req.protocol}://${host}${SERVER_CONFIG.basePath}/uctenka/${order.receiptId}">Zobrazit účtenku</a></p>`
                : "";
            const itemsHtml = (order.items || [])
                .map(it => `<li>${escapeHtml(it.name)} × ${it.qty} — ${formatCzk((Number(it.price) || 0) * (Number(it.qty) || 0))}</li>`)
                .join("");
            const html = `
                <p>Dobrý den${order.customerName ? ` ${escapeHtml(order.customerName)}` : ""},</p>
                <p>děkujeme za Vaši objednávku č. ${escapeHtml(order.id)}.</p>
                <ul>${itemsHtml}</ul>
                <p>
                    Mezisoučet: ${formatCzk(order.itemsTotal)}<br>
                    Doprava: ${formatCzk(order.deliveryFee)}<br>
                    <strong>Celkem: ${formatCzk(order.total)}</strong>
                </p>
                <p>Doručovací adresa: ${escapeHtml(order.address)}, ${escapeHtml(order.psc)}</p>
                ${receiptLine}
                <p>Doručíme přibližně do ${(settings.delivery && settings.delivery.etaMinutes) || 60} min.</p>
            `;
            notify
                .sendEmail(order.email, `Potvrzení objednávky č. ${order.id}`, html)
                .catch(e => console.error("Order-confirmed e-mail crashed unexpectedly:", e));
        }
    } catch (e) {
        console.error("sendOrderConfirmedNotifications failed:", e);
    }
}

// ============================================================================
// RECEIPTS (účtenky) — Czech-compliant, VAT-payer and non-VAT-payer modes
// ============================================================================
//
// A receipt is created exactly once, the moment an order/reservation food
// order actually becomes PAID — never at order-creation time (an order can
// sit unpaid, get cancelled, retried, etc.; only a paid order has a legal
// receipt). All payment paths funnel through createReceiptForOrder() below:
//   - GoPay webhook (applyGatewayPaymentState) — delivery, indoor, reservation
//   - POST /orders/:id/mark-paid                — delivery (cash / card-on-delivery)
//   - POST /indoor-orders/:id/mark-paid          — indoor (cash / card terminal)
//   - POST /kitchen/reservation/mark-paid        — reservation food order (cash)
//
// Idempotency: the caller passes whatever receiptId is already stored on the
// order/slot (if any). If one exists, we just return the existing receipt
// instead of minting a new one/incrementing the counter — so paying or
// marking the same order paid twice never creates a second receipt.
//
// The receipt id (used in URLs) is a long random string — unguessable, so it
// can safely be served without auth (GET /api/receipts/:receiptId and the
// printable HTML page). The sequential "YYYY-NNNNNN" number is a *display*
// field only, never used as a lookup key.

function generateReceiptId() {
    return generateFileId(40);
}

// Sequential numbering per calendar year: "2026-000001", "2026-000002", ...
// better-sqlite3 is fully synchronous and Node is single-threaded, so this
// read-increment-write has no await between the read and the write — no
// other request can interleave and observe/reuse the same counter value.
function nextReceiptNumber(issuedAt) {
    const year = new Date(issuedAt).getFullYear();
    const counterId = String(year);
    const counter = db.get(COL.receiptCounters, counterId) || { year, seq: 0 };
    counter.seq += 1;
    db.set(COL.receiptCounters, counterId, counter);
    return `${year}-${String(counter.seq).padStart(6, "0")}`;
}

const PAYMENT_METHOD_LABELS = {
    cash: "Hotově",
    card_on_delivery: "Kartou při doručení",
    online_card: "Online platební kartou",
};

function paymentMethodLabel(method) {
    return PAYMENT_METHOD_LABELS[method] || "Neuvedeno";
}

// Top-down VAT extraction from a VAT-inclusive (gross) amount: the amount
// already charged includes VAT, so VAT = gross × rate/(100+rate). This is
// the correct method for restaurant receipts, where menu prices are always
// gross/inclusive prices — never net prices with VAT added on top.
function vatFromGross(grossAmount, ratePercent) {
    if (!ratePercent) return 0;
    return Math.round(grossAmount * (ratePercent / (100 + ratePercent)) * 100) / 100;
}

// Builds and persists a receipt for a just-paid order/reservation food
// order, or returns the existing one unchanged if `existingReceiptId` is
// already set (idempotent — see comment block above). `items` uses either
// cart shape ({ name, price, qty, vatRate } or { item, price, qty, vatRate })
// — same shapes priceOrderItems() already normalizes into every order.
function createReceiptForOrder({ kind, items, total, paymentMethod, existingReceiptId, description }) {
    if (existingReceiptId) {
        const existing = db.get(COL.receipts, existingReceiptId);
        if (existing) return existing;
        // existingReceiptId pointed at a receipt that's gone missing (should
        // not normally happen) — fall through and mint a fresh one rather
        // than silently losing the receipt for a paid order.
    }

    const receiptItems = (items || []).map(raw => {
        const qty = Number(raw.qty) || 0;
        const unitPrice = Number(raw.price) || 0;
        const vatRate = resolveVatRate(raw);
        return {
            name: raw.name || raw.item || raw.id || "Položka",
            qty,
            unitPrice,
            lineTotal: Math.round(unitPrice * qty * 100) / 100,
            vatRate,
        };
    });

    const computedTotal = total != null
        ? Math.round(Number(total) * 100) / 100
        : Math.round(receiptItems.reduce((sum, it) => sum + it.lineTotal, 0) * 100) / 100;

    const vatPayer = !!SERVER_CONFIG.business.vatPayer;
    let vatBreakdown = null;
    if (vatPayer) {
        const grossByRate = new Map();
        for (const it of receiptItems) {
            grossByRate.set(it.vatRate, (grossByRate.get(it.vatRate) || 0) + it.lineTotal);
        }
        vatBreakdown = [...grossByRate.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([rate, gross]) => {
                gross = Math.round(gross * 100) / 100;
                const vat = vatFromGross(gross, rate);
                const basis = Math.round((gross - vat) * 100) / 100;
                return { rate, basis, vat, gross };
            });
    }

    const issuedAt = new Date().toISOString();
    const id = generateReceiptId();
    const receipt = {
        id,
        number: nextReceiptNumber(issuedAt),
        issuedAt,
        kind,                                   // "delivery" | "indoor" | "reservation"
        description: description || null,
        seller: { ...SERVER_CONFIG.business },  // snapshot — future config changes don't rewrite old receipts
        paymentMethod: paymentMethod || null,
        paymentMethodLabel: paymentMethodLabel(paymentMethod),
        items: receiptItems,
        total: computedTotal,
        vatPayer,
        vatBreakdown,                            // [{ rate, basis, vat, gross }] when vatPayer, else null
        notVatPayerNote: vatPayer ? null : "Nejsme plátci DPH",
    };

    db.set(COL.receipts, id, receipt);
    return receipt;
}

function escapeHtml(str) {
    return String(str == null ? "" : str).replace(/[&<>"']/g, ch => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[ch]));
}

function formatCzk(amount) {
    return `${(Number(amount) || 0).toLocaleString("cs-CZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} Kč`;
}

function formatDateTime(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleString("cs-CZ", { dateStyle: "medium", timeStyle: "short" });
}

// SECURITY (3rd hardening pass): this receipt page used to wire its print
// button with `onclick="window.print()"` — an inline event-handler
// attribute, which is exactly what CSP's script-src is meant to shut off
// (it's the #1 XSS gadget: if an attacker ever got a `<img onerror=...>` or
// similar past escapeHtml() anywhere on this page, an `'unsafe-inline'`
// script-src would let it execute). This page's content (receipt.* fields)
// is fully escapeHtml()'d already, so there's no known injection today —
// but the CSP shouldn't rely on that being permanently true. Fixed by using
// a real (non-inline-attribute) `<script>` block with STATIC, receipt-data-
// independent content, allow-listed in helmet's CSP via its exact SHA-256
// hash (see CSP_SCRIPT_HASHES / configureCsp() below) instead of a blanket
// `'unsafe-inline'`. Keep this string byte-for-byte identical to what's
// embedded in renderReceiptHtml() — the hash is computed from this exact
// constant at startup, so any edit here must be matched by nothing else
// (the hash is derived automatically, not hardcoded).
const RECEIPT_PRINT_SCRIPT = "document.getElementById('printBtn').addEventListener('click', function () { window.print(); });";

// Server-rendered, standalone printable receipt page — no dependency on the
// app's own JS/CSS, so it works as a bare link a customer can open/print
// directly (e.g. from an SMS/email confirmation) without loading the SPA.
function renderReceiptHtml(receipt) {
    const rowsHtml = receipt.items.map(it => `
        <tr>
            <td>${escapeHtml(it.name)}</td>
            <td class="num">${it.qty}</td>
            <td class="num">${formatCzk(it.unitPrice)}</td>
            ${receipt.vatPayer ? `<td class="num">${it.vatRate} %</td>` : ""}
            <td class="num">${formatCzk(it.lineTotal)}</td>
        </tr>`).join("");

    const vatTableHtml = receipt.vatPayer && receipt.vatBreakdown && receipt.vatBreakdown.length
        ? `
        <table class="vat-table">
            <thead>
                <tr><th>Sazba DPH</th><th class="num">Základ</th><th class="num">DPH</th><th class="num">Celkem</th></tr>
            </thead>
            <tbody>
                ${receipt.vatBreakdown.map(v => `
                <tr>
                    <td>${v.rate} %</td>
                    <td class="num">${formatCzk(v.basis)}</td>
                    <td class="num">${formatCzk(v.vat)}</td>
                    <td class="num">${formatCzk(v.gross)}</td>
                </tr>`).join("")}
            </tbody>
        </table>`
        : `<p class="not-vat-payer">${escapeHtml(receipt.notVatPayerNote || "Nejsme plátci DPH")}</p>`;

    const seller = receipt.seller || {};

    return `<!DOCTYPE html>
<html lang="cs">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Účtenka ${escapeHtml(receipt.number)}</title>
<style>
    :root { color-scheme: light only; }
    * { box-sizing: border-box; }
    html { background: #fff; }
    body {
        font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
        max-width: 480px;
        margin: 24px auto;
        background: #fff;
        padding: 0 16px;
        color: #1a1a1a;
        font-size: 14px;
        line-height: 1.5;
    }
    h1 { font-size: 18px; margin: 0 0 4px; }
    .subtitle { color: #555; margin: 0 0 20px; font-size: 13px; }
    .seller { margin-bottom: 20px; }
    .seller strong { display: block; font-size: 15px; }
    .meta { display: flex; justify-content: space-between; margin-bottom: 20px; border-top: 1px solid #ddd; border-bottom: 1px solid #ddd; padding: 10px 0; }
    .meta div { font-size: 13px; }
    .meta .label { color: #666; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
    th, td { text-align: left; padding: 6px 4px; font-size: 13px; }
    thead th { border-bottom: 2px solid #333; font-weight: 600; }
    tbody tr { border-bottom: 1px solid #eee; }
    td.num, th.num { text-align: right; white-space: nowrap; }
    .total-row td { font-weight: 700; font-size: 15px; border-top: 2px solid #333; border-bottom: none; padding-top: 10px; }
    .vat-table { margin-top: 4px; }
    .vat-table th { border-bottom: 1px solid #999; font-weight: 600; font-size: 12px; color: #555; }
    .not-vat-payer { font-style: italic; color: #555; margin: 16px 0; }
    .footer { margin-top: 28px; text-align: center; color: #888; font-size: 12px; }
    @media print {
        body { margin: 0 auto; }
        .no-print { display: none; }
    }
    .print-btn {
        display: block; margin: 20px auto 0; padding: 8px 20px;
        font-size: 13px; cursor: pointer; border: 1px solid #333; background: #fff; border-radius: 4px;
    }
</style>
</head>
<body>
    <h1>Účtenka č. ${escapeHtml(receipt.number)}</h1>
    <p class="subtitle">${escapeHtml(receipt.description || "")}</p>

    <div class="seller">
        <strong>${escapeHtml(seller.name)}</strong>
        ${escapeHtml(seller.address || "")}<br>
        IČO: ${escapeHtml(seller.ico || "")}${receipt.vatPayer ? ` &nbsp;•&nbsp; DIČ: ${escapeHtml(seller.dic || "")}` : ""}
    </div>

    <div class="meta">
        <div><span class="label">Datum a čas vystavení</span><br>${formatDateTime(receipt.issuedAt)}</div>
        <div style="text-align:right"><span class="label">Způsob platby</span><br>${escapeHtml(receipt.paymentMethodLabel)}</div>
    </div>

    <table>
        <thead>
            <tr>
                <th>Položka</th>
                <th class="num">Množství</th>
                <th class="num">Cena/ks</th>
                ${receipt.vatPayer ? '<th class="num">DPH</th>' : ""}
                <th class="num">Celkem</th>
            </tr>
        </thead>
        <tbody>
            ${rowsHtml}
            <tr class="total-row">
                <td colspan="${receipt.vatPayer ? 4 : 3}">Celkem k úhradě</td>
                <td class="num">${formatCzk(receipt.total)}</td>
            </tr>
        </tbody>
    </table>

    ${vatTableHtml}

    <button class="print-btn no-print" id="printBtn">Vytisknout</button>

    <p class="footer">Děkujeme za nákup.</p>
    <script>${RECEIPT_PRINT_SCRIPT}</script>
</body>
</html>`;
}

function renderReceiptNotFoundHtml() {
    return `<!DOCTYPE html>
<html lang="cs"><head><meta charset="UTF-8"><title>Účtenka nenalezena</title></head>
<body style="font-family:sans-serif; text-align:center; margin-top:80px;">
<h1>Účtenka nenalezena</h1>
<p>Tento odkaz na účtenku není platný nebo účtenka neexistuje.</p>
</body></html>`;
}

// ============================================================================
// HTTPS ENFORCEMENT
// ============================================================================
// SECURITY (3rd hardening pass): Render terminates TLS at its edge and
// forwards plain HTTP to this process (see the `trust proxy` comment above)
// — so `req.secure` (and `x-forwarded-proto`) correctly reflects what the
// BROWSER actually used, even though the Node process itself never speaks
// TLS directly. A request that reaches this app over plain http:// in
// production means either a stale link/bookmark, a manually-typed http://
// URL, or a client explicitly downgrading — redirect it to https:// rather
// than serving it (serving it would mean cookies marked `secure` never get
// sent/read, and any session data would ride over an unencrypted hop).
//
// Guarded on NODE_ENV==="production" only: local `npm start` has no TLS-
// terminating proxy in front of it, `req.secure` is always false there, and
// this must be a complete no-op locally or the dev server would redirect-
// loop itself on every single request.
//
// Uses a 308 (Permanent Redirect) rather than 301/302 specifically because
// 308 is required by spec to preserve the original request method and body
// — a 301/302 is permitted (and, historically, often chosen by clients) to
// turn a POST into a GET on redirect. GoPay's webhook can arrive as either
// GET or POST (see the two `/payments/gopay/webhook` routes below); Render
// already presents HTTPS to every real client including GoPay's servers, so
// this branch should never actually fire for the webhook in practice — but
// 308 means that even in a hypothetical misconfigured-webhook-URL scenario,
// a POST webhook call would be redirected as a POST, not silently
// downgraded to a GET that then fails validation.
function httpsRedirect(req, res, next) {
    if (!isProd) return next();
    if (req.secure || req.get("x-forwarded-proto") === "https") return next();
    return res.redirect(308, `https://${req.get("host")}${req.originalUrl}`);
}

// ============================================================================
// SECURITY HEADERS (helmet)
// ============================================================================
// SECURITY (3rd hardening pass): default-deny Content-Security-Policy, tuned
// to exactly what this app's own frontend needs (see src/html/*.html and
// src/js/*.js — audited directly, not guessed):
//
//   script-src 'self' [+ 1 hash] — every page-level <script> is either an
//     external same-origin file (config.js, renderer.js, inner.js, etc.) or
//     — for the server-rendered printable receipt page only — one static,
//     receipt-data-independent inline <script> allow-listed by its exact
//     SHA-256 hash (see RECEIPT_PRINT_SCRIPT above and CSP_SCRIPT_HASHES
//     below) instead of a blanket 'unsafe-inline'. The 5 frontend HTML pages
//     used to each carry a tiny inline `<script>window.API_BASE_URL = ...`
//     block too, but it was DEAD CODE — config.js (loaded immediately after,
//     on every page) unconditionally overwrites window.API_BASE_URL via
//     autoDetectBackend() regardless of what that inline block set — so
//     those blocks were deleted outright rather than accommodated (see the
//     html/*.html diffs). No 'unsafe-inline', no 'unsafe-eval' — the
//     codebase has zero eval/new Function usage and zero inline event-
//     handler attributes left after that same receipt-page fix.
//
//   style-src 'self' 'unsafe-inline' https://fonts.googleapis.com — the
//     frontend genuinely relies on inline `style="..."` attributes
//     extensively (both static in the HTML and dynamically built via
//     innerHTML template strings in the *.js files) and inner.html has one
//     real inline <style> block. Refactoring every inline style to CSS
//     classes was judged out of scope for this pass (large, risk of visual
//     regressions across 5 pages) — flagging it here as a follow-up rather
//     than silently either breaking the UI or pretending the risk isn't
//     there. `unsafe-inline` for STYLES (not scripts) is a much smaller
//     blast radius — CSS can exfiltrate very limited data at best and can't
//     execute script — which is why this is the one directive where the
//     trade-off is accepted rather than fixed outright.
//     https://fonts.googleapis.com is needed because inner.css does
//     `@import url('https://fonts.googleapis.com/...')` for the Sora/Inter/
//     JetBrains Mono webfonts.
//
//   font-src 'self' https://fonts.gstatic.com data: — the Google Fonts CSS
//     above references actual font files on fonts.gstatic.com.
//
//   img-src 'self' data: https: — dish photos are admin-supplied arbitrary
//     image URLs (see the "dishImageUrl" field in inner.js's menu editor —
//     staff can point a menu item's photo at any external host), so img-src
//     can't be locked to 'self' without breaking that feature; still no
//     `http:` (mixed content on an https page would be blocked by the
//     browser anyway) and `data:` covers the `href="data:,"` empty favicons
//     used across every page plus the client-side QR-code SVG payment
//     codes (src/js/qr.js renders an inline <svg>, not an <img>, so it's
//     actually ungated by img-src at all — noted here for completeness).
//
//   connect-src 'self' — every fetch()/XHR in the frontend hits this same
//     origin's own /api. GoPay is never fetched from the browser — the
//     "pay online" flow gets a redirect URL from our own backend and either
//     navigates the top-level page to it or renders a QR code of it
//     client-side (qr.js) — top-level navigation isn't governed by
//     connect-src at all. NOTE: inner.html's manual "gateApiInput" field
//     (a dev convenience for pointing this frontend at an API on a
//     different host/port) is INCOMPATIBLE with connect-src 'self' if
//     actually used cross-origin — that field predates this CSP and is a
//     manual escape hatch for unusual local setups; using it cross-origin
//     now additionally requires relaxing connect-src to name that host.
//     Same-origin/localhost-same-port usage (the common case) is unaffected.
//
//   object-src 'none', base-uri 'self', form-action 'self' — no <object>/
//     <embed> use anywhere, no <base> tag, and the app has zero <form>
//     elements (every mutation goes through fetch()), so all three are
//     free hardening with zero functional cost.
//
//   frame-ancestors 'none' — nothing in this app is meant to be iframed by
//     anyone, including itself; also covers helmet's separate
//     X-Frame-Options: DENY (kept on too, for browsers that don't honor
//     frame-ancestors).
//
// HSTS (Strict-Transport-Security) and upgrade-insecure-requests are BOTH
// gated on isProd — HSTS pins the browser to HTTPS-only for this host for
// the given maxAge, and upgrade-insecure-requests auto-rewrites http://
// subresource requests to https://; both are actively harmful in local dev
// (plain http, no TLS at all — HSTS would lock a developer's browser out of
// http://localhost, and upgrade-insecure-requests would try to fetch
// https://localhost:PORT/... and fail).
const RECEIPT_SCRIPT_HASH = `'sha256-${crypto.createHash("sha256").update(RECEIPT_PRINT_SCRIPT, "utf8").digest("base64")}'`;

function configureHelmet() {
    const directives = {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", RECEIPT_SCRIPT_HASH],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
    };
    // helmet merges the `directives` object into its own built-in default
    // directive set (useDefaults:true) rather than replacing it wholesale —
    // and `upgrade-insecure-requests` IS one of those built-in defaults, so
    // simply omitting it here in dev is NOT enough to keep it out (it would
    // silently fall back to helmet's default and still get sent, which
    // would break local http dev — see the header comment above). Setting
    // it to `null` explicitly removes that default directive.
    directives.upgradeInsecureRequests = isProd ? [] : null;

    return helmet({
        contentSecurityPolicy: { directives },
        // HSTS only makes sense once the browser has actually reached us
        // over HTTPS at least once — meaningless (and locally harmful, see
        // above) outside production.
        hsts: isProd ? { maxAge: 180 * 24 * 60 * 60, includeSubDomains: true } : false,
        // Explicit even though these are helmet defaults — documents intent
        // rather than relying on a future helmet major version's defaults
        // changing under us.
        noSniff: true, // X-Content-Type-Options: nosniff
        referrerPolicy: { policy: "strict-origin-when-cross-origin" },
        frameguard: { action: "deny" }, // X-Frame-Options: DENY (belt-and-braces with frame-ancestors above)
        hidePoweredBy: true, // drops X-Powered-By: Express
    });
}

// ============================================================================
// CORS
// ============================================================================
// SECURITY (3rd hardening pass): the previous config — cors({ origin: "*",
// credentials: true }) — was doubly wrong: (1) `origin: "*"` + `credentials:
// true` is a combination browsers themselves refuse to honor (a wildcard
// Access-Control-Allow-Origin can never be paired with
// Access-Control-Allow-Credentials: true per the Fetch spec), so it was
// silently broken for its own stated purpose; and (2) even if it "worked",
// wildcard CORS on a cookie-authenticated API is exactly the primitive that
// makes CSRF-via-fetch trivial from any origin, which is what csrf.js's
// double-submit token now separately defends regardless — but there's no
// reason to leave the CORS door open too.
//
// This app is SINGLE-ORIGIN in every real deployment: one Node process
// serves the frontend under SERVER_CONFIG.basePath and the API under
// `${basePath}/api` (see setupMiddleware()/setupAPIRoutes()) — so browser
// CORS has almost nothing legitimate to allow. The allow-list below is:
//   - the request's OWN origin, always (same-origin traffic is never
//     actually a "cross-origin" request in the security sense — this just
//     keeps the `cors` package from erroring out on ordinary same-origin
//     fetches that happen to carry an Origin header, which browsers do send
//     for many same-origin non-GET requests) — computed per-request from
//     req.protocol/req.get("host"), so it works regardless of the actual
//     Render hostname/custom domain without hardcoding it.
//   - ALLOWED_ORIGINS (comma-separated env var) — for any genuinely
//     separate trusted origin an operator wants to add later (a separate
//     admin dashboard host, a staging frontend, etc). Empty by default in
//     production: no cross-origin browser access to the cookie-authenticated
//     API unless explicitly opted in.
//   - in non-production only, common localhost/127.0.0.1 origins on any
//     port — dev convenience for the "frontend on one static server port,
//     API on another" setup (see inner.html's gateApiInput field).
//
// A request with NO Origin header (server-to-server calls — critically,
// GoPay's webhook — and most same-origin GETs, curl, etc.) is always waved
// through: CORS only exists to police *browser* cross-origin requests, and
// a missing Origin header can't be one. We never reject on a missing
// Origin — GoPay's webhook must keep working without any Origin/cookies/
// CSRF token, being a pure server-to-server call (see its route registration
// further down, which intentionally has no CORS/CSRF/auth middleware beyond
// its own zod body validation).
function buildCorsAllowList() {
    const envOrigins = (process.env.ALLOWED_ORIGINS || "")
        .split(",")
        .map(s => s.trim())
        .filter(Boolean);
    const devDefaults = isProd
        ? []
        : [/^https?:\/\/localhost(:\d+)?$/, /^https?:\/\/127\.0\.0\.1(:\d+)?$/];
    return [...envOrigins, ...devDefaults];
}

function configureCors() {
    const allowList = buildCorsAllowList();

    return cors((req, callback) => {
        const origin = req.header("Origin");
        let allowed = true; // no Origin header at all — see comment above

        if (origin) {
            const ownOrigin = `${req.protocol}://${req.get("host")}`;
            allowed = origin === ownOrigin || allowList.some(entry =>
                entry instanceof RegExp ? entry.test(origin) : entry === origin
            );
        }

        callback(null, {
            origin: allowed, // true => cors reflects the request's own Origin back; false => no CORS headers added (browser then blocks the cross-origin caller from reading the response — the request itself still reaches this server, same as any pre-CORS API, which is fine: GoPay's webhook and other legitimate no-Origin server-to-server calls are never affected by this at all)
            credentials: true,
            methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
            allowedHeaders: ["Content-Type", csrf.CSRF_HEADER_NAME],
        });
    });
}

// ============================================================================
// INIT (SQLite replaces mkdir-per-directory; menu gets a default row)
// ============================================================================

async function initializeData() {
    // Touches the DB file / creates the table.
    db.getDb();

    // Make sure a menu record exists so GET /menu never 500s on a fresh DB.
    if (!db.get(COL.menu, MENU_SINGLETON_ID)) {
        db.set(COL.menu, MENU_SINGLETON_ID, {});
    }

    // Same idea for combos (spec: docs/superpowers/specs/
    // 2026-07-22-combo-menus-design.md) — an empty array so GET /combos
    // never 500s on a fresh DB, mirroring the menu seed just above.
    if (!db.get(COL.combos, COMBOS_SINGLETON_ID)) {
        db.set(COL.combos, COMBOS_SINGLETON_ID, []);
    }
}

// ============================================================================
// UTIL
// ============================================================================

// SECURITY: crypto.randomInt (CSPRNG) instead of Math.random(). This isn't
// just cosmetic — generateFileId() mints order ids, gateway transaction
// ids, AND (via generateReceiptId() = generateFileId(40) above) receipt
// ids, which are the *only* access control on GET /api/receipts/:receiptId
// and /uctenka/:receiptId (no auth on those routes — see comments there).
// Math.random() is not cryptographically secure and its output can be
// predicted from a handful of samples for some engines, which would let an
// attacker guess other customers' receipt ids (name/items/payment info).
// Same call signature as before, so every existing call site keeps working
// unchanged.
function generateFileId(length = 12) {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let out = "";
    for (let i = 0; i < length; i++) out += chars[crypto.randomInt(0, chars.length)];
    return out;
}

// ── ZIP BUILDER (no external dependency) — unchanged format, new source ──

function crc32(buf) {
    let crc = ~0;
    for (let i = 0; i < buf.length; i++) {
        crc ^= buf[i];
        for (let j = 0; j < 8; j++) {
            crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
        }
    }
    return (~crc) >>> 0;
}

function buildZip(files) {
    const localChunks = [];
    const centralChunks = [];
    let offset = 0;

    for (const file of files) {
        const nameBuf = Buffer.from(file.name, "utf8");
        const content = file.content;
        const crc = crc32(content);
        const size = content.length;

        const localHeader = Buffer.alloc(30);
        localHeader.writeUInt32LE(0x04034b50, 0);
        localHeader.writeUInt16LE(20, 4);
        localHeader.writeUInt16LE(0, 6);
        localHeader.writeUInt16LE(0, 8);
        localHeader.writeUInt16LE(0, 10);
        localHeader.writeUInt16LE(0, 12);
        localHeader.writeUInt32LE(crc, 14);
        localHeader.writeUInt32LE(size, 18);
        localHeader.writeUInt32LE(size, 22);
        localHeader.writeUInt16LE(nameBuf.length, 26);
        localHeader.writeUInt16LE(0, 28);

        localChunks.push(localHeader, nameBuf, content);

        const centralHeader = Buffer.alloc(46);
        centralHeader.writeUInt32LE(0x02014b50, 0);
        centralHeader.writeUInt16LE(20, 4);
        centralHeader.writeUInt16LE(20, 6);
        centralHeader.writeUInt16LE(0, 8);
        centralHeader.writeUInt16LE(0, 10);
        centralHeader.writeUInt16LE(0, 12);
        centralHeader.writeUInt16LE(0, 14);
        centralHeader.writeUInt32LE(crc, 16);
        centralHeader.writeUInt32LE(size, 20);
        centralHeader.writeUInt32LE(size, 24);
        centralHeader.writeUInt16LE(nameBuf.length, 28);
        centralHeader.writeUInt16LE(0, 30);
        centralHeader.writeUInt16LE(0, 32);
        centralHeader.writeUInt16LE(0, 34);
        centralHeader.writeUInt16LE(0, 36);
        centralHeader.writeUInt32LE(0, 38);
        centralHeader.writeUInt32LE(offset, 42);

        centralChunks.push(centralHeader, nameBuf);

        offset += localHeader.length + nameBuf.length + content.length;
    }

    const centralDirStart = offset;
    const centralDirBuf = Buffer.concat(centralChunks);

    const endRecord = Buffer.alloc(22);
    endRecord.writeUInt32LE(0x06054b50, 0);
    endRecord.writeUInt16LE(0, 4);
    endRecord.writeUInt16LE(0, 6);
    endRecord.writeUInt16LE(files.length, 8);
    endRecord.writeUInt16LE(files.length, 10);
    endRecord.writeUInt32LE(centralDirBuf.length, 12);
    endRecord.writeUInt32LE(centralDirStart, 16);
    endRecord.writeUInt16LE(0, 20);

    return Buffer.concat([...localChunks, centralDirBuf, endRecord]);
}

// Builds zip entries for a whole collection, one .json "file" per record —
// mirrors the old on-disk layout so the exported zip still unpacks into the
// same data/<folder>/<id>.json structure, in case you want to hand-inspect it
// or roll back.
function buildZipEntriesForCollection(collection, zipFolderName, idField = "id") {
    return db.list(collection).map(obj => ({
        name: `${zipFolderName}/${obj[idField] || generateFileId()}.json`,
        content: Buffer.from(JSON.stringify(obj, null, 2), "utf8"),
    }));
}

// Pulls the food-order events out of a timetable's booking grid — unchanged.
function collectTableOrderEvents(timetableData, sinceDate) {
    const events = [];
    const dataObj = (timetableData && timetableData.data) || {};

    for (const dateStr of Object.keys(dataObj)) {
        const d = new Date(`${dateStr}T00:00:00`);
        if (isNaN(d.getTime()) || d < sinceDate) continue;

        const dayArray = dataObj[dateStr] || [];
        for (let dayIndex = 0; dayIndex < dayArray.length; dayIndex++) {
            const hoursObj = dayArray[dayIndex];
            if (!hoursObj) continue;

            const hourKeys = Object.keys(hoursObj)
                .map(Number)
                .filter(h => !isNaN(h))
                .sort((a, b) => a - b);

            let prevSignature = null;
            for (const h of hourKeys) {
                const slot = hoursObj[h];
                if (!slot || !Array.isArray(slot.order) || slot.order.length === 0) {
                    prevSignature = null;
                    continue;
                }
                const signature = JSON.stringify(slot.order) + "|" + slot.orderTotal;
                if (signature !== prevSignature) {
                    events.push({ date: dateStr, order: slot.order, orderTotal: slot.orderTotal });
                }
                prevSignature = signature;
            }
        }
    }

    return events;
}

// Same idea, for the kitchen board — unchanged.
function collectIndoorOrderEvents(timetableData) {
    const events = [];
    const dataObj = (timetableData && timetableData.data) || {};
    const tableName = timetableData.className;
    const fileId = timetableData.fileId;

    for (const dateStr of Object.keys(dataObj)) {
        const dayArray = dataObj[dateStr] || [];
        for (let dayIndex = 0; dayIndex < dayArray.length; dayIndex++) {
            const hoursObj = dayArray[dayIndex];
            if (!hoursObj) continue;

            const hourKeys = Object.keys(hoursObj)
                .map(Number)
                .filter(h => !isNaN(h))
                .sort((a, b) => a - b);

            let run = null;
            const flushRun = () => {
                if (!run) return;
                events.push({
                    kind: "reservation",
                    id: `${fileId}::${dateStr}::${dayIndex}::${run.startHour}`,
                    fileId,
                    tableName,
                    dateStr,
                    dayIndex,
                    startHour: run.startHour,
                    endHour: run.endHour,
                    guestName: run.slot.content || "",
                    order: run.slot.order,
                    orderTotal: run.slot.orderTotal,
                    kitchenStatus: run.slot.kitchenStatus || "pending"
                });
                run = null;
            };

            let prevHour = null;
            let prevSignature = null;
            for (const h of hourKeys) {
                const slot = hoursObj[h];
                if (!slot || !Array.isArray(slot.order) || slot.order.length === 0) {
                    flushRun();
                    prevHour = null;
                    prevSignature = null;
                    continue;
                }
                const signature = JSON.stringify(slot.order) + "|" + slot.orderTotal;
                const isContinuation = run && prevHour === h - 1 && signature === prevSignature;
                if (isContinuation) {
                    run.endHour = h;
                } else {
                    flushRun();
                    run = { startHour: h, endHour: h, slot };
                }
                prevHour = h;
                prevSignature = signature;
            }
            flushRun();
        }
    }

    return events;
}

// ============================================================================
// MIDDLEWARE (frontend static serving — unchanged, still uses fs for html)
// ============================================================================

// ============================================================================
// REQUEST BODY SIZE LIMITS
// ============================================================================
// SECURITY: express.json() used to have no size limit at all — a client
// could POST an arbitrarily large body and have the whole thing buffered
// into memory before any route code (or even auth middleware) ever ran, a
// trivial memory-exhaustion DoS against a single small Render instance.
//
// Almost every route body here is small (names/phones/short item arrays),
// so the default budget is a generous-but-bounded 100kb. A few routes
// legitimately need more: PUT /api/timetables/:name (a table's whole
// booking-grid `data` object — many weeks × many hourly slots) and PUT
// /api/menu + PUT /api/combos (the entire menu/combos document in one
// shot, INCLUDING every dish image inline as a base64 data-URL) get 10MB
// instead. 10MB, because the old 1MB cap 413'd in production the moment a
// real photo was uploaded: inner.js now downscales every upload to
// ≤ ~1.4M chars (~1MB), but the documents are re-PUT wholesale, so the
// limit has to hold a whole menu's worth of images, not just one. Still a
// bounded buffer, so the original DoS reasoning above holds. The parser is
// chosen dynamically by method+path *before* the body is read, because
// body-parser marks a request "already parsed" the first time it runs — a
// second, bigger express.json() mounted directly on those routes later
// in the pipeline would never actually execute if this one already
// rejected/truncated the body first.
const API_PREFIX = SERVER_CONFIG.basePath + "/api";
const LARGE_BODY_PUT_RE = new RegExp(`^${API_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/timetables/[^/]+$`);

const jsonBodySmall = express.json({ limit: "100kb" });
const jsonBodyLarge = express.json({ limit: "10mb" });

function isLargeBodyRoute(req) {
    if (req.method !== "PUT") return false;
    // PUT /combos gets the same 10MB allowance as PUT /menu — combo images
    // are inline data-URLs (downscaled client-side, same pipeline as dish
    // images), so a combo list with a handful of pictures can exceed the
    // default 100kb small-body limit just like the menu can.
    return req.path === `${API_PREFIX}/menu` || req.path === `${API_PREFIX}/combos` || LARGE_BODY_PUT_RE.test(req.path);
}

// ============================================================================
// SSE — BOARD EVENTS (performance optimization design, 2026-07-23, §4)
// ============================================================================
// "Something changed" ping, not a data channel — kitchen.js/driver.js hold
// an EventSource open on GET ${API_PREFIX}/events/board (route further
// down, in setupAPIRoutes()) and re-fetch through the existing, already-
// authed board endpoints (GET /kitchen/orders, GET /orders) whenever a
// message arrives, instead of polling every 5s regardless of whether
// anything changed. Auth/pricing/shape logic stays exactly where it already
// lived — this is purely a "wake up sooner" signal.
//
// State lives at module scope (not inside setupAPIRoutes()) so every order-
// mutating handler in this file — including applyGatewayPaymentState(),
// which is defined and called well before setupAPIRoutes() runs — can call
// broadcastBoardEvent() directly without threading it through as a param.
const SSE_BOARD_PATH = `${API_PREFIX}/events/board`;
const boardEventClients = new Set(); // connected `res` objects

// Fired from every route that creates/updates/deletes a delivery order
// (COL.orders), an indoor/walk-in order (COL.indoorOrders), a reservation-
// attached food order (COL.timetables slot with `.order`), or a driver
// claim/assignment — i.e. anything that changes what the kitchen board or
// driver order list shows. Per-client try/catch: a write failing on one
// half-closed connection must never stop the broadcast to everyone else.
function broadcastBoardEvent() {
    const payload = `data: ${JSON.stringify({ type: "orders-changed" })}\n\n`;
    for (const client of boardEventClients) {
        try {
            client.write(payload);
            if (typeof client.flush === "function") client.flush(); // compression module — see setupMiddleware()'s SSE exemption
        } catch (e) {
            boardEventClients.delete(client);
        }
    }
}

function setupMiddleware() {
    // SECURITY (3rd hardening pass): HTTPS redirect + security headers go
    // FIRST, before anything else touches the request — no reason to parse
    // cookies/CORS/bodies for a plain-http request in production that's
    // about to get redirected anyway, and headers should be present on
    // every single response, including error responses from later
    // middleware.
    app.use(httpsRedirect);

    // PERFORMANCE (2026-07-23 design §1): gzip every response — registered
    // this early (before helmet/cors/body-parsing/static/routes) so nothing
    // downstream can accidentally write a response before compression has
    // wrapped res.write/res.end. Excludes the SSE board-events stream (see
    // "SSE — BOARD EVENTS" above): compression buffers chunks to find a
    // good gzip window, which is exactly wrong for a long-lived stream that
    // needs every `data:`/`: ping` line flushed to the client immediately.
    // compression.filter is still consulted for everything else (skips
    // already-compressed content-types, honors a request's own
    // `Cache-Control: no-transform`, etc.) — this only adds one more
    // exclusion on top of it.
    app.use(compression({
        filter: (req, res) => {
            if (req.path === SSE_BOARD_PATH) return false;
            return compression.filter(req, res);
        },
    }));

    app.use(configureHelmet());
    app.use(configureCors());
    app.use(cookieParser());
    // CSRF token issuance is deliberately NOT mounted here.
    //
    // PRIVACY (ePrivacy / § 89 odst. 3 zák. č. 127/2005 Sb.): this used to
    // be a global `app.use(csrf.ensureCsrfCookie)`, which minted a 12h
    // cookie on the FIRST response to every visitor — including someone who
    // opened the public rozvoz/rezervace page, read the menu and left. That
    // visitor can never use the token: csrf.requireCsrf guards only the
    // staff/admin/driver routes, and the public order/reservation/SMS/
    // GoPay flows are deliberately exempt from it (see csrf.js's header
    // comment for why). Storing data on someone's device without consent is
    // only lawful when it is strictly necessary for the service THAT person
    // requested, and a cookie with no function for them doesn't qualify —
    // so issuance now happens on GET ${api}/csrf-token alone (search this
    // file for "csrf.ensureCsrfCookie").
    //
    // Safe because nothing else reads req.csrfToken, and the frontend only
    // ever obtains the token from that endpoint — never by reading
    // document.cookie (see ensureCsrfToken() in inner.js/kitchen.js/
    // driver.js). cookieParser above must still be global: auth.js reads
    // the session cookie on every guarded route.
    app.use((req, res, next) => {
        (isLargeBodyRoute(req) ? jsonBodyLarge : jsonBodySmall)(req, res, next);
    });
    // SECURITY: belt-and-braces prototype-pollution guard — rejects any
    // request whose JSON body contains a literal "__proto__"/"constructor"/
    // "prototype" key anywhere (recursively) before any route handler runs.
    // See validation.js's header comment for why this app's existing
    // object-spread merge patterns were not actually exploitable even
    // without this, and why it's still worth having explicitly.
    app.use(V.rejectDangerousKeys);

    if (!SERVER_CONFIG.serveFrontend) return;

    const frontendPath = path.join(process.cwd(), SERVER_CONFIG.frontendPath);
    const base = SERVER_CONFIG.basePath;

    const innerHtmlRoute = async (req, res) => {
        const candidates = [
            path.join(frontendPath, "inner.html"),
            path.join(frontendPath, "html", "inner.html")
        ];
        for (const file of candidates) {
            try { await fs.access(file); return res.sendFile(file); } catch {}
        }
        res.status(404).send("inner.html not found");
    };

    const deliveryHtmlRoute = async (req, res) => {
        const candidates = [
            path.join(frontendPath, "delivery.html"),
            path.join(frontendPath, "html", "delivery.html")
        ];
        for (const file of candidates) {
            try { await fs.access(file); return res.sendFile(file); } catch {}
        }
        res.status(404).send("delivery.html not found");
    };

    const driverHtmlRoute = async (req, res) => {
        const candidates = [
            path.join(frontendPath, "driver.html"),
            path.join(frontendPath, "html", "driver.html")
        ];
        for (const file of candidates) {
            try { await fs.access(file); return res.sendFile(file); } catch {}
        }
        res.status(404).send("driver.html not found");
    };

    const kitchenHtmlRoute = async (req, res) => {
        const candidates = [
            path.join(frontendPath, "kitchen.html"),
            path.join(frontendPath, "html", "kitchen.html")
        ];
        for (const file of candidates) {
            try { await fs.access(file); return res.sendFile(file); } catch {}
        }
        res.status(404).send("kitchen.html not found");
    };

    // ── LEGAL PAGES (go-live Task 5, spec §7) ────────────────────────────
    // Three static Czech template pages with {{TOKEN}} placeholders resolved
    // from settings.business AT SERVE TIME (not baked in) — editing business
    // details in admin Nastavení updates these pages immediately, no
    // restart/rebuild. Only the template FILE READ is cached
    // (legalTemplateCache) — the source HTML never changes at runtime, so
    // re-reading it from disk on every request would be pointless I/O — but
    // the RENDERED output is never cached, since settings.business (and
    // hence the placeholder values) can change at any time via
    // PUT /api/settings.
    const legalTemplateCache = new Map(); // filename -> raw template string

    async function loadLegalTemplate(filename) {
        if (legalTemplateCache.has(filename)) return legalTemplateCache.get(filename);
        const candidates = [
            path.join(frontendPath, filename),
            path.join(frontendPath, "html", filename),
        ];
        for (const file of candidates) {
            try {
                const raw = await fs.readFile(file, "utf8");
                legalTemplateCache.set(filename, raw);
                return raw;
            } catch {}
        }
        return null;
    }

    // Token names match the identity block already written into the
    // templates (Czech field names — NAZEV/ADRESA/TELEFON — rather than the
    // English settings.business.{name,address,phone} keys) since that's what
    // reads naturally inline in Czech legal prose. EFFECTIVE_DATE is the one
    // non-identity token: resolved from the optional
    // settings.business.termsEffectiveDate field when the owner has set one
    // (e.g. once a lawyer has actually reviewed and dated the text), else
    // today's date — so the page never shows a blank/unset placeholder. Any
    // {{TOKEN}} with no matching entry here is left untouched rather than
    // blanked: that can only happen from a typo in the template itself, and
    // leaving it visible makes such a bug obvious instead of silently hiding
    // it (still never a literal, USER-facing "{{...}}" for any of the three
    // real templates, which only ever use the tokens listed below).
    function renderLegalTemplate(rawHtml, business) {
        const biz = business || {};
        const effectiveDate = (biz.termsEffectiveDate && String(biz.termsEffectiveDate).trim())
            || new Date().toLocaleDateString("cs-CZ", { day: "numeric", month: "numeric", year: "numeric" });
        const tokens = {
            NAZEV: biz.name || "",
            ICO: biz.ico || "",
            DIC: biz.dic || "",
            ADRESA: biz.address || "",
            EMAIL: biz.email || "",
            TELEFON: biz.phone || "",
            EFFECTIVE_DATE: effectiveDate,
        };
        return rawHtml.replace(/\{\{(\w+)\}\}/g, (match, key) =>
            Object.prototype.hasOwnProperty.call(tokens, key) ? escapeHtml(tokens[key]) : match
        );
    }

    function makeLegalPageRoute(filename) {
        return async (req, res) => {
            const raw = await loadLegalTemplate(filename);
            if (raw == null) return res.status(404).send("Stránka nenalezena");
            const settings = settingsStore.getSettings();
            res.set("Content-Type", "text/html; charset=utf-8");
            res.send(renderLegalTemplate(raw, settings.business));
        };
    }

    const legalPageRoutesByPath = {
        "/obchodni-podminky": makeLegalPageRoute("obchodni-podminky.html"),
        "/ochrana-osobnich-udaju": makeLegalPageRoute("ochrana-osobnich-udaju.html"),
        "/reklamace": makeLegalPageRoute("reklamace.html"),
    };

    // The three template files above live under src/html/ alongside every
    // other page (inner.html, delivery.html, ...) so loadLegalTemplate()'s
    // candidate-path lookup matches the existing convention — but that
    // directory is also served wholesale by express.static below, which
    // would make the RAW, un-rendered template (still full of literal
    // "{{NAZEV}}" etc.) directly reachable at .../html/obchodni-podminky.html
    // etc., alongside the properly rendered version at the real
    // /obchodni-podminky route. Blocking the static path for exactly these
    // three filenames — registered before express.static, so it wins —
    // closes that off without touching how any of the other pages are
    // served (they have no server-side placeholders to leak in the first
    // place, so this isn't needed for them).
    const legalTemplateFileNames = ["obchodni-podminky.html", "ochrana-osobnich-udaju.html", "reklamace.html"];
    const blockRawLegalTemplate = (req, res) => res.status(404).send("Stránka nenalezena");

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

    // PERFORMANCE (2026-07-23 design §1): long, immutable caching for
    // fonts + images only — these filenames never change without also
    // changing (renamed/replaced), so a browser can keep them for 30 days
    // without ever revalidating. HTML and API responses are untouched
    // (express.static only ever serves the frontend's static files, never
    // API JSON). CSS/JS are deliberately NOT covered here — minify.js
    // (mounted right below, before express.static) already sets their own
    // Cache-Control (shorter max-age + a content-hash ETag, since editing a
    // source file DOES change its output); this only applies to requests
    // that fall through to express.static, e.g. already-minified *.min.js.
    const LONG_CACHE_EXTENSIONS = new Set([".woff2", ".png", ".jpg", ".jpeg", ".svg", ".ico", ".webp"]);
    function setLongCacheHeaders(res, filePath) {
        if (LONG_CACHE_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
            res.set("Cache-Control", "public, max-age=2592000, immutable");
        }
    }
    const staticOptions = { setHeaders: setLongCacheHeaders };

    if (base) {
        for (const filename of legalTemplateFileNames) {
            app.get(`${base}/html/${filename}`, blockRawLegalTemplate);
        }
        app.use(`${base}/server`, blockServerSource);
        // Minify-on-serve (design §2) MUST be mounted before express.static
        // so it wins for .js/.css — it falls through to next() (i.e. this
        // express.static call) on anything it can't/shouldn't handle itself
        // (non-.js/.css, *.min.js, missing file, esbuild error).
        app.use(base, minify.createMinifyMiddleware(frontendPath));
        app.use(base, express.static(frontendPath, staticOptions));
        app.get(`${base}/app`, (req, res) => res.sendFile(path.join(frontendPath, "html", "index.html")));
        app.get(`${base}/inner.html`, innerHtmlRoute);
        app.get(`${base}/admin`, innerHtmlRoute);
        app.get(`${base}/delivery`, deliveryHtmlRoute);
        app.get(`${base}/driver`, driverHtmlRoute);
        app.get(`${base}/kitchen`, kitchenHtmlRoute);
        for (const [route, handler] of Object.entries(legalPageRoutesByPath)) {
            app.get(`${base}${route}`, handler);
        }
    } else {
        for (const filename of legalTemplateFileNames) {
            app.get(`/html/${filename}`, blockRawLegalTemplate);
        }
        app.use("/server", blockServerSource);
        app.use(minify.createMinifyMiddleware(frontendPath));
        app.use(express.static(frontendPath, staticOptions));
        app.get("/app", (req, res) => res.sendFile(path.join(frontendPath, "html", "index.html")));
        app.get("/inner.html", innerHtmlRoute);
        app.get("/admin", innerHtmlRoute);
        app.get("/delivery", deliveryHtmlRoute);
        app.get("/driver", driverHtmlRoute);
        app.get("/kitchen", kitchenHtmlRoute);
        for (const [route, handler] of Object.entries(legalPageRoutesByPath)) {
            app.get(route, handler);
        }
    }
}

// ============================================================================
// ROOT
// ============================================================================

app.get("/", (req, res) => {
    const host = req.get("host");
    res.json({
        message: SERVER_CONFIG.appName,
        version: SERVER_CONFIG.apiVersion,
        endpoints: {
            timetables: `${SERVER_CONFIG.basePath}/api/timetables`,
            users: `${SERVER_CONFIG.basePath}/api/users`
        },
        frontend: SERVER_CONFIG.serveFrontend
            ? {
                url: `${req.protocol}://${host}${SERVER_CONFIG.basePath}/app`,
                admin: `${req.protocol}://${host}${SERVER_CONFIG.basePath}/admin`,
                delivery: `${req.protocol}://${host}${SERVER_CONFIG.basePath}/delivery`
              }
            : undefined,
        status: "running"
    });
});

// ============================================================================
// API
// ============================================================================

function setupAPIRoutes() {
    const api = SERVER_CONFIG.basePath + "/api";

    // SECURITY: generous backstop rate limit across the whole /api surface
    // (see src/server/security.js). Login and SMS-send routes below layer
    // their own stricter limiters on top of this one — this one just
    // catches generic scripted abuse.
    //
    // NEXT AGENTS: HTTPS redirect / helmet security headers / CORS are
    // mounted globally in setupMiddleware() (top of this file, runs before
    // this function), not scoped to /api — headers need to be on every
    // response (including the static frontend), not just API ones. CSRF is
    // NOT global in either direction: *issuance* (csrf.ensureCsrfCookie) is
    // mounted on GET ${api}/csrf-token alone, so no cookie is ever placed on
    // a public visitor's device for a token they can't use (see the privacy
    // note in setupMiddleware()); *enforcement* (csrf.requireCsrf) is
    // applied per-route below, only to the specific staff/admin/driver
    // mutating routes that act on the strength of the auth cookie — see
    // csrf.js's header comment for the full exemption reasoning. If you add
    // a new mutating admin/staff route, add `csrf.requireCsrf` as its first
    // middleware (before requireAuth/requireAdmin/requireDriver) unless it
    // has a specific documented reason to be exempt.
    app.use(api, security.apiLimiter);

    // ── CSRF TOKEN ───────────────────────────────────────────────────────
    // The one and only place the CSRF cookie is minted. Endpoint the
    // frontend calls to fetch/refresh its cached token (see ensureCsrfToken()
    // in src/js/inner.js, driver.js, kitchen.js); csrf.ensureCsrfCookie sets
    // the cookie and populates req.csrfToken, and this handler hands the same
    // value back in a body the frontend JS can read (the cookie is also
    // directly readable — it's intentionally non-httpOnly — but a dedicated
    // JSON endpoint also works for the cross-origin-dev case where the
    // frontend document's own origin can't read a cookie belonging to a
    // different API origin; see csrf.js's header comment).
    //
    // Scoping issuance to this route is what keeps the cookie off public
    // visitors' devices — see the privacy note in setupMiddleware(). It is
    // sufficient because the staff pages always call here before their first
    // mutating request, and a 403 from requireCsrf clears the cached token
    // and sends them straight back (self-healing).
    app.get(`${api}/csrf-token`, csrf.ensureCsrfCookie, (req, res) => {
        res.json({ csrfToken: req.csrfToken });
    });

    // ── SSE: BOARD EVENTS (design §4) ───────────────────────────────────
    // kitchen.js and driver.js both already gate their board data behind
    // requireAuth (GET /kitchen/orders and GET /orders, respectively —
    // both use the SAME requireAuth guard, which accepts any logged-in
    // staff OR driver session; see auth.js's requireAuth/requireDriver —
    // requireDriver is just requireAuth + an isDriver check on top). This
    // stream carries no order data itself (just a "something changed"
    // ping — see broadcastBoardEvent() above), but it's gated the same way
    // regardless, so an unauthenticated caller can't even learn "an order
    // just changed".
    app.get(`${api}/events/board`, requireAuth, (req, res) => {
        res.status(200);
        res.set({
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        });
        // flushHeaders (not res.flush) sends the headers immediately,
        // before any body bytes — needed so the client's EventSource
        // actually opens the connection instead of waiting on a response
        // that never seems to start.
        if (typeof res.flushHeaders === "function") res.flushHeaders();

        res.write("retry: 3000\n\n");
        res.write(`data: ${JSON.stringify({ type: "orders-changed" })}\n\n`);
        if (typeof res.flush === "function") res.flush(); // compression module's flush — see setupMiddleware()'s SSE exemption

        boardEventClients.add(res);
        req.on("close", () => {
            boardEventClients.delete(res);
        });
    });

    // ── TIMETABLES ───────────────────────────────────────────────────────

    app.get(`${api}/timetables`, (req, res) => {
        try {
            const all = db.list(COL.timetables);
            const unique = [...new Set(all.map(d => d.className))];
            res.json(unique);
        } catch (e) {
            res.status(500).json({ error: "Failed to list timetables" });
        }
    });

    app.post(`${api}/timetables`, csrf.requireCsrf, requireAdmin, V.validate(V.createTimetableSchema), (req, res) => {
        const { name, info, seats } = req.body;

        const fileId = generateFileId();
        const data = {
            className: name,
            fileId,
            data: {},
            calendar: "",
            currentWeek: new Date().toISOString(),
            info: info || "",
            attributes: [],
            // Floorplan (design doc §7.4, persistence hazard #6): every new
            // table gets a real `seats` value up front — 4 unless the
            // caller specified one — so the capacity check in
            // applyBookingToTimetable() below never silently skips it the
            // way it would for `seats === undefined` (that undefined case
            // is reserved for pre-floorplan tables, kept "accept any party
            // size" for backwards compatibility). `layout: null` means
            // "not placed yet" (design §4.1) — the table shows up in the
            // "Nezařazené stoly" fallback list until an admin drags it onto
            // a room in the *Rozložení* editor.
            seats: typeof seats === "number" ? seats : 4,
            layout: null,
            // go-live Task 6 (spec §11): reservations cover all 7 days now,
            // so a new table's permanentHours map starts with a row for
            // every weekday including Sat/Sun ("5"/"6"), not just Po-Pá.
            permanentHours: { "0": {}, "1": {}, "2": {}, "3": {}, "4": {}, "5": {}, "6": {} }
        };

        db.set(COL.timetables, fileId, data);
        res.json({ success: true, fileId });
    });

    app.get(`${api}/timetables/:name`, V.validateParams(V.paramsName), (req, res) => {
        try {
            const found = db.list(COL.timetables).find(d => d.className === req.params.name);
            if (!found) return res.status(404).json({ error: "Not found" });

            // SECURITY (go-live Task 4 review fix): stays public (renderer.js
            // needs this with no login for availability), but only an
            // authenticated caller — any logged-in staff/driver session, not
            // just admin — gets the customer data stored on booking slots
            // (guest names, phones, preorders, receipt ids). Unauthenticated
            // callers get a whitelisted occupancy-only view. See
            // sanitizeTimetableForPublic's header comment.
            const isStaff = !!getAuthenticatedUserIfAny(req);
            res.json(isStaff ? found : sanitizeTimetableForPublic(found));
        } catch {
            res.status(500).json({ error: "Server error" });
        }
    });

    app.put(`${api}/timetables/:name`, csrf.requireCsrf, requireAdmin, V.validateParams(V.paramsName), V.validate(V.timetablePutSchema), (req, res) => {
        try {
            const found = db.list(COL.timetables).find(d => d.className === req.params.name);
            if (!found) return res.status(404).json({ error: "Not found" });

            const updated = {
                ...found,
                ...req.body,
                className: found.className, // never let body overwrite the name via this route
                // SECURITY/CORRECTNESS: never let the body overwrite fileId
                // either. This record's fileId IS the SQLite row key
                // (db.set(COL.timetables, found.fileId, updated) below), and
                // several other routes (applyBookingToTimetable,
                // kitchen/indoor/status, kitchen/indoor/remove,
                // kitchen/reservation/mark-paid, kitchen/reservation/pay-
                // online) look records up by whatever `fileId` value they
                // read back off a previously-stored record and then write
                // right back to that same key. Before this fix, a client
                // sending {"fileId": "anything"} in this PUT body (the
                // frontend itself does this — see persistTimetable() in
                // inner.js, which always includes `fileId: t.fileId`) would
                // silently corrupt the stored fileId field; the very next
                // write through any of those other routes would then create
                // a brand-new orphaned row under the bogus key instead of
                // updating the real one — reproduced during testing: two
                // rows with the same className, one holding stale data, the
                // booking silently landing on the wrong/duplicate row.
                fileId: found.fileId,
            };
            db.set(COL.timetables, found.fileId, updated);
            res.json({ success: true });
        } catch {
            res.status(500).json({ error: "Server error" });
        }
    });

    app.delete(`${api}/timetables/file/:fileId`, csrf.requireCsrf, requireAdmin, V.validateParams(V.paramsFileId), (req, res) => {
        const ok = db.remove(COL.timetables, req.params.fileId);
        if (!ok) return res.status(404).json({ error: "Not found" });
        res.json({ success: true });
    });

    app.delete(`${api}/timetables`, csrf.requireCsrf, requireAdmin, V.validate(V.deleteTimetableByNameSchema), (req, res) => {
        try {
            const { name } = req.body || {};

            if (!name) {
                db.removeAll(COL.timetables);
                return res.json({ success: true, deleted: "all" });
            }

            const found = db.list(COL.timetables).find(d => d.className === name);
            if (!found) return res.status(404).json({ error: "Not found" });

            db.remove(COL.timetables, found.fileId);
            res.json({ success: true });
        } catch {
            res.status(500).json({ error: "Server error" });
        }
    });

    // POST — rename a table IN PLACE (same record, same fileId).
    //
    // This replaces a client-side create-under-new-name + copy-everything-over
    // + delete-the-old dance that never actually issued the delete, so every
    // rename silently left a duplicate record behind — and, once tables gained
    // floorplan placements, two tables stacked on the exact same spot with the
    // orphan still bookable.
    //
    // Renaming in place is not just a tidier fix, it removes the failure mode
    // the old flow had by construction: there is no window in which both names
    // exist, nothing has to be copied (so nothing can be copied *partially*),
    // and reservations stay exactly where they are because this is literally
    // the same row. `fileId` is deliberately preserved — it is the record's
    // stable identity and other routes (DELETE /timetables/file/:fileId, the
    // frontend's persistTimetable) address the table by it.
    //
    // Walk-in orders are the one thing that keys off the NAME rather than the
    // fileId (COL.indoorOrders rows carry a plain `tableName` string, and the
    // admin overview matches them with `o.tableName === name`). An unpaid one
    // left under the old name would vanish from the overview and become
    // uncollectable, so open orders are carried over to the new name in the
    // same transaction. PAID orders are deliberately left alone: they are
    // historical records, their receipts already say "Stůl <old name>", and
    // rewriting them would falsify what was actually served and settled.
    app.post(`${api}/timetables/:name/rename`, csrf.requireCsrf, requireAdmin, V.validateParams(V.paramsName), V.validate(V.renameTimetableSchema), (req, res) => {
        try {
            const oldName = req.params.name;
            const newName = String(req.body.newName).trim();

            if (!newName) return res.status(400).json({ error: "Název nesmí být prázdný" });

            const found = db.list(COL.timetables).find(d => d.className === oldName);
            if (!found) return res.status(404).json({ error: "Stůl nenalezen" });

            // No-op rename: succeed without touching storage, so a save with an
            // unchanged name can't fail the duplicate check against itself.
            if (newName === oldName) {
                return res.json({ success: true, fileId: found.fileId, className: oldName, ordersMoved: 0 });
            }

            const clash = db.list(COL.timetables).find(d => d.className === newName);
            if (clash) return res.status(409).json({ error: `Stůl „${newName}" už existuje` });

            const openOrders = db
                .list(COL.indoorOrders)
                .filter(o => o && o.tableName === oldName && o.paymentStatus !== "paid");

            // One transaction so a crash midway can't leave the table renamed
            // while its open orders still point at a name nothing answers to.
            db.getDb().transaction(() => {
                db.set(COL.timetables, found.fileId, { ...found, className: newName });
                for (const order of openOrders) {
                    db.set(COL.indoorOrders, order.id, { ...order, tableName: newName });
                }
            })();

            // The kitchen board shows the table name on every open ticket, so
            // it has to be told the name it is displaying just changed.
            if (openOrders.length > 0) broadcastBoardEvent();

            res.json({ success: true, fileId: found.fileId, className: newName, ordersMoved: openOrders.length });
        } catch (e) {
            console.error("Table rename error:", e);
            res.status(500).json({ error: "Přejmenování se nezdařilo" });
        }
    });

    // Czech has three plural forms for counted nouns, so "2 míst" is simply
    // wrong where "2 místa" is correct. Mirrors seatsLabel() in
    // src/js/floorplan.js, which does the same job for the seat-count
    // sublabel drawn on every table in the floorplan — the two strings sit
    // side by side in the customer's experience (they read the table's
    // "2 místa" on the plan, then hit this error), so they must agree.
    function czechSeats(n) {
        if (n === 1) return "1 místo";
        if (n >= 2 && n <= 4) return `${n} místa`;
        return `${n} míst`;
    }

    // ── Shared helper: write a set of hour-slots into a timetable record ──
    // Floorplan (design doc §7.3): `guests` is the party size. When the
    // table has a `seats` value set, a party larger than that is rejected
    // outright — before any slot is written — with a Czech error naming the
    // limit. Tables with `seats` unset (every table that existed before
    // this feature, per design §9's backwards-compatibility requirement)
    // have no cap: `data.seats ?? Infinity` makes `guests > Infinity`
    // always false, so old data keeps behaving exactly as it did before
    // this parameter existed.
    async function applyBookingToTimetable({ tableName, dateStr, dayIndex, startHour, duration, guestName, order, orderTotal, phone, guests }) {
        const data = db.list(COL.timetables).find(d => d.className === tableName);
        if (!data) return { ok: false, error: "Stůl nenalezen" };

        const seatLimit = typeof data.seats === "number" ? data.seats : Infinity;
        if (typeof guests === "number" && guests > seatLimit) {
            return { ok: false, error: `Tento stůl má jen ${czechSeats(seatLimit)}` };
        }

        if (!data.data) data.data = {};
        if (!data.data[dateStr]) data.data[dateStr] = [];
        if (!data.data[dateStr][dayIndex]) data.data[dateStr][dayIndex] = {};

        const abbreviation = guestName.split(/\s+/).map(w => w[0]).join("").slice(0, 3).toUpperCase();

        for (let h = startHour; h < startHour + duration; h++) {
            if (data.data[dateStr][dayIndex][h]) {
                return { ok: false, error: `Slot ${h} už není volný` };
            }
        }

        for (let h = startHour; h < startHour + duration; h++) {
            data.data[dateStr][dayIndex][h] = {
                content: guestName,
                abbreviation,
                isPermanent: false,
                // go-live Task 4 (spec §6): the reservation-reminder scanner
                // (reminderScannerTick, near the bottom of this file) reads
                // this phone straight off the slot — it has no other way to
                // find "who booked this" later, since it runs long after the
                // request/pendingVerifications context that created the
                // booking is gone. `reminderSent` starts unset/false and is
                // flipped once the reminder actually goes out.
                ...(phone ? { phone } : {}),
                // Floorplan (design doc §7.3): party size, stored next to
                // `content`/`phone` so it's available wherever the rest of
                // the slot's customer data is (admin table detail, kitchen
                // board). Deliberately NOT added to sanitizeTimetableForPublic's
                // per-slot whitelist — party size is customer data, same
                // category as the guest's name/phone.
                ...(typeof guests === "number" ? { guests } : {}),
                ...(order && order.length > 0 ? { order, orderTotal, isPaid: false } : {})
            };
        }

        db.set(COL.timetables, data.fileId, data);
        // A reservation-attached food order shows up on the kitchen board
        // (collectIndoorOrderEvents() only emits slots that carry `.order`
        // — see its header comment) — a plain table-only reservation with
        // no food doesn't, so only broadcast when there's actually an
        // order attached.
        if (order && order.length > 0) broadcastBoardEvent();
        return { ok: true };
    }

    // SECURITY: SMS costs real money and can be used to bomb a victim's
    // phone, so this route gets two layers of rate limiting on top of the
    // existing per-phone resendCooldownMs below (30s between *consecutive*
    // sends to the same number) — see security.js for the reasoning:
    //   - smsIpLimiter:    caps how many send-code requests one IP can fire
    //   - smsPhoneLimiter: caps how many codes one phone number can receive
    //                      per hour, regardless of which IP(s) requested them
    app.post(`${api}/reservations/send-code`, security.smsIpLimiter, security.smsPhoneLimiter, V.validate(V.sendCodeSchema), async (req, res) => {
        const { phone, tableName, dateStr, dayIndex, startHour, duration, guestName, order, orderTotal, guests } = req.body || {};

        // SECURITY: dayIndex/startHour/duration are already type/range-
        // checked by V.sendCodeSchema (0–6 / 0–23 / 1–24) before this
        // handler runs — this closes a real DoS: applyBookingToTimetable()
        // below runs `for (let h = startHour; h < startHour + duration; h++)`,
        // so an unbounded duration like 1e9 would previously make the server
        // spin a billion-iteration loop on a single request, synchronously
        // blocking the event loop for every other client.

        // GO-LIVE (settings.js): reject up front — before an SMS is ever
        // sent — when reservations are paused, this date is a closed day,
        // the weekday itself doesn't take reservations, or the requested
        // hour/duration falls outside that weekday's configured range. The
        // client UI already hides these slots (renderer.js), but the server
        // is the actual authority; checking this early specifically avoids
        // spending real SMS money on a booking that verify-and-book would
        // reject anyway.
        const slotCheck = settingsStore.isReservationSlotOpen(settingsStore.getSettings(), dateStr, dayIndex, startHour, duration);
        if (!slotCheck.ok) return res.status(400).json({ error: slotCheck.reason });

        // Floorplan (design doc §7.3): the party-size/capacity check for the
        // same reason as the slot check directly above — applyBookingToTimetable
        // enforces it too (it is the real authority, and the only one that runs
        // inside the booking write), but discovering "this table only seats 4"
        // AFTER the guest has received an SMS and typed the code back in wastes
        // real SMS money and strands them at the last step of the flow. The
        // client already greys these tables out, so reaching here means either
        // a stale page or a hand-crafted request; both deserve the cheap early
        // answer rather than the expensive late one.
        if (typeof guests === "number") {
            const targetTable = db.list(COL.timetables).find(d => d.className === tableName);
            if (targetTable && typeof targetTable.seats === "number" && guests > targetTable.seats) {
                return res.status(400).json({ error: `Tento stůl má jen ${czechSeats(targetTable.seats)}` });
            }
        }

        const cleanPhone = normalizePhone(phone);
        if (!cleanPhone) return res.status(400).json({ error: "Zadejte telefonní číslo" });

        // Food order attached to the reservation is optional — but if one was
        // sent, price it against the live menu now (server-side, ignoring any
        // client-sent price/total) so what gets stored in pendingVerifications
        // — and later written to the timetable at verify-and-book — is already
        // trustworthy. The client can't tamper with it between these two steps
        // since it's held server-side, keyed only by phone number.
        let pricedOrder = order;
        let pricedOrderTotal = orderTotal;
        if (Array.isArray(order) && order.length > 0) {
            const priced = priceOrderItems(order);
            if (priced.error) return res.status(400).json({ error: priced.error });
            pricedOrder = priced.items;
            pricedOrderTotal = priced.total;
        }

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

        try {
            const result = await sendVerificationSms(cleanPhone, code);

            pendingVerifications.set(cleanPhone, {
                code,
                expiresAt: Date.now() + SERVER_CONFIG.sms.codeTtlMs,
                attemptsLeft: SERVER_CONFIG.sms.maxAttempts,
                lastSentAt: Date.now(),
                // `phone` (already SMS-verified by definition of this flow)
                // rides along in the payload so it lands on the timetable
                // slot itself at booking time (applyBookingToTimetable) —
                // that's the only place the reservation-reminder scanner
                // (go-live Task 4) can find it later. `guests` (floorplan,
                // design doc §7.3) rides along the same way so the capacity
                // check happens at the actual booking write (verify-and-
                // book), not just here at send-code time — settings/table
                // data can't really change seat counts mid-verification,
                // but re-checking at write time matches how every other
                // constraint on this flow (slot availability, settings) is
                // already re-validated in verify-and-book rather than
                // trusted from send-code.
                payload: { tableName, dateStr, dayIndex, startHour, duration, guestName, order: pricedOrder, orderTotal: pricedOrderTotal, phone: cleanPhone, guests }
            });

            res.json({ success: true, simulated: !!result.simulated });
        } catch (e) {
            console.error("SMS send failed:", e.message);
            res.status(500).json({ error: "Nepodařilo se odeslat SMS. Zkontrolujte telefonní číslo." });
        }
    });

    app.post(`${api}/reservations/verify-and-book`, V.validate(V.verifyAndBookSchema), async (req, res) => {
        const { phone, code } = req.body || {};
        const cleanPhone = normalizePhone(phone);
        if (!cleanPhone) return res.status(400).json({ error: "Chybí telefon nebo kód" });

        const pending = pendingVerifications.get(cleanPhone);
        if (!pending) return res.status(400).json({ error: "Nejprve si vyžádejte ověřovací kód" });

        if (Date.now() > pending.expiresAt) {
            pendingVerifications.delete(cleanPhone);
            return res.status(400).json({ error: "Kód vypršel, vyžádejte si nový" });
        }

        if (pending.attemptsLeft <= 0) {
            pendingVerifications.delete(cleanPhone);
            return res.status(400).json({ error: "Příliš mnoho pokusů, vyžádejte si nový kód" });
        }

        if (String(code).trim() !== pending.code) {
            pending.attemptsLeft -= 1;
            return res.status(400).json({ error: "Nesprávný kód", attemptsLeft: pending.attemptsLeft });
        }

        pendingVerifications.delete(cleanPhone);

        // GO-LIVE (settings.js): re-check the slot is still open at the
        // moment of booking, not just at send-code time — settings (pause/
        // closed day/hours) can change during the up-to-5-minute window the
        // customer has to enter the SMS code. This is the actual booking
        // write, so it's the last and most important place this is
        // enforced; the client UI and the send-code check above are both
        // advisory only.
        const { dateStr, dayIndex, startHour, duration } = pending.payload;
        const slotCheck = settingsStore.isReservationSlotOpen(settingsStore.getSettings(), dateStr, dayIndex, startHour, duration);
        if (!slotCheck.ok) return res.status(400).json({ error: slotCheck.reason });

        try {
            const result = await applyBookingToTimetable(pending.payload);
            if (!result.ok) return res.status(409).json({ error: result.error });

            // go-live Task 4 (spec §6): reservation-booked confirmation SMS —
            // separate from (and behind a different toggle than) the
            // verification-code SMS above. Fire-and-forget: not awaited, and
            // notify.sendSms() itself never rejects, so this can never delay
            // or fail the booking response.
            const notifSettings = settingsStore.getSettings();
            if (notifSettings.notifications.smsReservationConfirmed) {
                const { tableName, dateStr: bookedDateStr, startHour: bookedStartHour } = pending.payload;
                const [y, m, d] = bookedDateStr.split("-");
                const dateLabel = `${Number(d)}.${Number(m)}.${y}`;
                const timeLabel = `${Number(bookedStartHour) + 7}:00`;
                notify
                    .sendSms(cleanPhone, `Rezervace potvrzena: stůl ${tableName}, ${dateLabel} v ${timeLabel}.`)
                    .catch(e => console.error("Reservation-confirmed SMS crashed unexpectedly:", e));
            }

            res.json({ success: true });
        } catch (e) {
            console.error(e);
            res.status(500).json({ error: "Nepodařilo se uložit rezervaci" });
        }
    });

    // ============================================================================
    // REORDER ("Objednat znovu") — one-tap re-order of a past delivery order.
    // docs/superpowers/specs/2026-07-25-reorder-design.md §7 is the frozen
    // contract these four routes implement verbatim. All the actual logic
    // (token sign/verify, pending-code store, recent-order selection/preview)
    // lives in reorder.js — these routes are deliberately thin wiring:
    // validate → normalize phone → call the module → respond. See reorder.js's
    // header comment for why its tokens are signed with a key DERIVED from
    // JWT_SECRET (auth.deriveSecret("reorder-token-v1")) rather than JWT_SECRET
    // itself — that's spec §5's guarantee that a reorder_token pasted by hand
    // into the auth_token cookie fails signature verification outright, so
    // this feature can never become a privilege-escalation path to the full
    // staff/admin session `requireAuth` grants.
    //
    // CSRF: none of the four routes below mount csrf.requireCsrf. That
    // mirrors POST /users/login, POST /drivers/login and POST /logout above
    // (search this file for "csrf.requireCsrf" — it is applied only to
    // staff/admin/driver routes that act on the strength of an EXISTING
    // auth_token session cookie; see csrf.js's header comment, "Mount
    // explicitly on the specific state-changing routes that act on the
    // strength of the auth cookie"). Working through why that same rule
    // lands here too, route by route:
    //   - send-code: no cookie is read or written at all. Identical in kind
    //     to POST /reservations/send-code just above, which has never had
    //     CSRF protection.
    //   - verify: WRITES the reorder_token cookie, but there is no
    //     *pre-existing* session for a forged cross-site request to ride on
    //     — this route is the bootstrap step that creates one, exactly like
    //     POST /users/login creates auth_token without CSRF protection. A
    //     cross-site attacker forging this request can, at absolute worst,
    //     cause the victim's OWN browser to end up verified as the
    //     victim's OWN phone number (the attacker doesn't know the SMS code,
    //     so they cannot pin the victim's cookie to a phone number the
    //     attacker controls) — there's no confused-deputy action being
    //     performed on anyone's behalf, just a same-origin cookie write the
    //     victim was always entitled to trigger themselves.
    //   - recent: a GET with no side effects — CSRF is a state-changing-
    //     request concern and does not apply here in any framework.
    //   - forget: state-changing, but the "state" is exactly one thing: THIS
    //     BROWSER'S OWN cookie, gated additionally by sameSite:"strict" on
    //     that same cookie (see reorder.js's reorderCookieOptions()) — a
    //     cross-site-initiated request cannot carry the reorder_token cookie
    //     at all under "strict", so the browser will not even attempt the
    //     request as "logged in" to begin with. There is no other resource
    //     (no order data, no other user's anything) this route can touch.
    // Net: adding requireCsrf here would add friction to public,
    // unauthenticated-by-design flows without closing any gap that isn't
    // already closed by (a) not trusting any pre-existing session and (b)
    // sameSite:"strict" on the one cookie these routes read or write.
    // ============================================================================

    // SECURITY: same two-layer rate limiting as POST /reservations/send-code
    // above, and DELIBERATELY the SAME limiter instances (not new ones) — see
    // security.js. Sharing smsIpLimiter/smsPhoneLimiter means reorder and
    // reservations draw from one combined per-IP and one combined per-phone
    // SMS budget, so this route can't be used to farm extra verification
    // codes, or to top up an SMS-bombing run against one phone number that
    // the reservation flow's own limiter would otherwise have capped.
    app.post(`${api}/reorder/send-code`, security.smsIpLimiter, security.smsPhoneLimiter, V.validate(V.reorderSendCodeSchema), async (req, res) => {
        const { phone } = req.body || {};
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

        try {
            // Send first, store second — mirrors POST /reservations/send-code's
            // own ordering just above: only remember a code as "pending" once
            // it has actually gone out, so a transport failure never leaves a
            // phantom pending code a customer was never told about.
            const result = await sendReorderCodeSms(cleanPhone, code);
            reorder.putPendingCode(cleanPhone, code);

            // SECURITY (spec §7 — the whole point of this route): respond
            // IDENTICALLY whether or not this phone number has ever placed an
            // order. This endpoint is unauthenticated by construction — proving
            // control of the phone is exactly what happens AFTER this step —
            // so if the response ever differed based on order history, an
            // anonymous POST would become a free oracle for "does this person
            // order from this restaurant", which is precisely the customer PII
            // this whole feature exists to protect. That's why there is no
            // db.list(COL.orders) / order lookup of any kind anywhere in this
            // handler: the guarantee is architectural (the data is never
            // fetched here), not just "remember to word the response the same".
            res.json({ success: true, simulated: !!result.simulated });
        } catch (e) {
            console.error("Reorder SMS send failed:", e.message);
            res.status(500).json({ error: "Nepodařilo se odeslat SMS. Zkontrolujte telefonní číslo." });
        }
    });

    app.post(`${api}/reorder/verify`, V.validate(V.reorderVerifySchema), (req, res) => {
        const { phone, code } = req.body || {};
        const cleanPhone = normalizePhone(phone);
        if (!cleanPhone) return res.status(400).json({ error: "Chybí telefon nebo kód" });

        // checkPendingCode mirrors verify-and-book's own failure shape exactly
        // (no pending code / expired / too many attempts / wrong code + how
        // many attempts remain) — see reorder.js for the Czech reason strings,
        // which are the same ones verify-and-book uses above.
        const result = reorder.checkPendingCode(cleanPhone, code);
        if (!result.ok) {
            return res.status(400).json({ error: result.reason, attemptsLeft: result.attemptsLeft });
        }

        // Success: this browser has now proven control of cleanPhone. Issue the
        // reorder cookie — signed with reorder.js's own derived secret (spec
        // §5), NOT auth.js's session cookie/JWT_SECRET, so this can never be
        // mistaken for (or escalated into) a staff/admin/driver session.
        res.cookie(reorder.REORDER_COOKIE_NAME, reorder.signReorderToken(cleanPhone), reorder.reorderCookieOptions());
        res.json({ success: true });
    });

    app.get(`${api}/reorder/recent`, (req, res) => {
        // No middleware (spec §7) — this route reads and verifies the cookie
        // itself, the same hand-rolled "optional auth" pattern
        // getAuthenticatedUserIfAny() below uses for the staff auth_token
        // cookie, except here an invalid/missing token is a hard 401 rather
        // than a soft "treat as anonymous", since the entire response IS the
        // customer's private order history.
        const token = req.cookies?.[reorder.REORDER_COOKIE_NAME];
        const verified = token && reorder.verifyReorderToken(token);
        if (!verified) return res.status(401).json({ error: "Ověřte prosím své telefonní číslo" });

        // SECURITY (spec §7): the phone comes FROM THE VERIFIED TOKEN and only
        // from there — never from a query param or request body. There is no
        // route anywhere in this feature that accepts a caller-supplied phone
        // number and returns order data in the same request; that pairing is
        // exactly what would let anyone read anyone else's order history just
        // by guessing/knowing a phone number.
        const allOrders = db.list(COL.orders);
        const recent = reorder.selectRecentOrders(allOrders, verified.phone, reorder.RECENT_LIMIT);

        // Re-price every line through priceOrderItems — the SAME pricing
        // funnel every order route in this app uses — one line at a time, per
        // spec §6.1: priceOrderItems() is all-or-nothing (first bad line wins),
        // which is right for checkout and useless for a preview. previewOrder()
        // calls this once per line so a sold-out/removed dish only knocks out
        // that one line instead of hiding the whole past order.
        const orders = recent.map(order => reorder.previewOrder(order, raw => priceOrderItems([raw])));

        res.json({ orders });
    });

    app.post(`${api}/reorder/forget`, (req, res) => {
        // clearCookie needs the same attributes (minus maxAge) that were used
        // when setting the cookie, or some browsers won't actually remove it —
        // exactly the same reasoning as auth.clearSessionCookie() above.
        const { maxAge, ...opts } = reorder.reorderCookieOptions();
        res.clearCookie(reorder.REORDER_COOKIE_NAME, opts);
        res.json({ success: true });
    });

    // ── ORDERS (delivery) ───────────────────────────────────────────────

    const VALID_PAYMENT_METHODS = ["cash", "card_on_delivery", "online_card"];

    app.post(`${api}/orders`, V.validate(V.createOrderSchema), async (req, res) => {
        const { customerName, address, psc, phone, items, note, paymentMethod, email } = req.body || {};

        const settings = settingsStore.getSettings();

        // GO-LIVE (settings.js): reject up front when delivery is paused or
        // simply closed right now (outside today's configured hours, or
        // today is a closed day) — before any pricing/order-creation work.
        // isDeliveryOpenNow() itself distinguishes "paused" from "closed
        // now" in its returned reason.
        const deliveryCheck = settingsStore.isDeliveryOpenNow(settings);
        if (!deliveryCheck.ok) return res.status(400).json({ error: deliveryCheck.reason });

        // Server-side pricing: never trust client-sent item prices/total —
        // recompute both from the live menu, keyed off item id/name + qty only.
        const priced = priceOrderItems(items);
        if (priced.error) return res.status(400).json({ error: priced.error });

        // GO-LIVE (settings.js, Task 2 — delivery rules): re-quote the
        // delivery fee/minimum-order/PSČ-whitelist eligibility server-side —
        // the client's delivery.js mirrors this logic for UX, but is
        // strictly advisory. quoteDelivery() re-checks `delivery.paused` too
        // (belt-and-braces alongside isDeliveryOpenNow above, which already
        // covers hours/closed-day/pause), and returns the fee to charge
        // (accounting for the free-above threshold) when ok.
        const quote = settingsStore.quoteDelivery(settings, priced.total, psc);
        if (!quote.ok) return res.status(400).json({ error: quote.reason });

        const method = VALID_PAYMENT_METHODS.includes(paymentMethod) ? paymentMethod : "cash";

        const id = generateFileId();
        const order = {
            id,
            customerName: customerName.trim(),
            address: address.trim(),
            psc: String(psc || "").trim(),
            phone: (phone || "").trim(),
            // go-live Task 4 (spec §6): persisted so the order-confirmed
            // e-mail (below) and any future re-notification can reach the
            // customer — validation already accepted this field (see
            // createOrderSchema in validation.js), it just went unused
            // server-side until now. Optional — orders created before this
            // change (or with no email typed at checkout) simply have "".
            email: (email || "").trim(),
            note: (note || "").trim(),
            items: priced.items,
            // itemsTotal is the cart subtotal (before delivery fee) — kept
            // alongside `total` so receipts/admin can always show a subtotal
            // + fee breakdown without re-deriving it from `items` by hand.
            // `total` (subtotal + deliveryFee) is the actual payable amount
            // everywhere downstream: GoPay/simulated-payment amount, the
            // receipt's total, and every admin/driver/kitchen total display
            // that just reads `order.total`.
            itemsTotal: priced.total,
            deliveryFee: quote.fee,
            total: Math.round((priced.total + quote.fee) * 100) / 100,
            status: "pending",
            kitchenStatus: "pending",
            claimedBy: null,
            claimedByName: null,
            createdAt: new Date().toISOString(),
            claimedAt: null,
            // ── Payment ──
            paymentMethod: method,               // "cash" | "card_on_delivery" | "online_card"
            paymentStatus: "unpaid",             // "unpaid" | "paid" | "refunded"
            gatewayTransactionId: null,
            receiptId: null,                     // set once a receipt is issued at payment time
        };

        db.set(COL.orders, id, order);
        broadcastBoardEvent(); // new delivery order — visible on the kitchen board immediately, regardless of payment method

        // go-live Task 4 (spec §6): order-confirmed SMS/e-mail — fired for
        // every payment method (the customer should hear "we got your
        // order" regardless of how they're paying), NOT awaited so a slow/
        // failing SMS or SMTP call can never delay this response.
        sendOrderConfirmedNotifications(order, settings, req);

        if (method !== "online_card") {
            // Cash / card-on-delivery: nothing more to do here — the driver
            // marks it paid on handoff (see /orders/:id/mark-paid below).
            return res.json({ success: true, order });
        }

        // Online prepay: create a gateway payment (real GoPay if configured,
        // simulated otherwise) and hand back a redirect URL for the client to
        // send the customer to. `returnUrl` is optional — same override
        // pattern as the indoor/reservation pay-online routes — so the
        // delivery page can send GoPay back to itself (to resume polling)
        // instead of falling back to the generic .../app default.
        try {
            const payment = await initiateGatewayPayment({
                req,
                kind: "delivery",
                target: { orderId: id },
                amountCzk: order.total,
                // Include the "Doprava" line here too — GoPay's payment
                // items are just display metadata, but they should still sum
                // to amountCzk (order.total, which already includes the
                // delivery fee) rather than silently omitting it.
                items: deliveryReceiptItems(order),
                description: `Rozvoz — objednávka ${id}`,
                orderNumber: id,
                returnUrl: req.body?.returnUrl,
            });
            order.gatewayTransactionId = payment.gatewayTransactionId;
            db.set(COL.orders, id, order);
            res.json({ success: true, order, redirectUrl: payment.redirectUrl, simulated: payment.simulated });
        } catch (e) {
            console.error("Payment creation failed:", e);
            res.status(500).json({ error: "Nepodařilo se zahájit platbu" });
        }
    });

    // POST — driver/waiter marks a cash/card-on-delivery order as paid at handoff.
    // (Online-card orders get marked paid via the gateway webhook instead —
    // see /payments/gopay/webhook below, not this route.)
    app.post(`${api}/orders/:id/mark-paid`, csrf.requireCsrf, requireAuth, V.validateParams(V.paramsId), (req, res) => {
        const order = db.get(COL.orders, req.params.id);
        if (!order) return res.status(404).json({ error: "Objednávka nenalezena" });
        if (order.paymentMethod === "online_card") {
            return res.status(400).json({ error: "Online platby se potvrzují automaticky přes platební bránu" });
        }
        order.paymentStatus = "paid";
        const receipt = createReceiptForOrder({
            kind: "delivery",
            items: deliveryReceiptItems(order), // dish lines + "Doprava" line when deliveryFee > 0
            total: order.total,
            paymentMethod: order.paymentMethod,
            existingReceiptId: order.receiptId,
            description: `Rozvoz — objednávka ${order.id}`,
        });
        order.receiptId = receipt.id;
        db.set(COL.orders, order.id, order);
        broadcastBoardEvent();
        res.json({ success: true, order, receiptId: receipt.id });
    });

    // GoPay calls this when a payment's status changes. It may notify via
    // POST (JSON/form body containing the payment id) or GET (?id=...) —
    // both are handled the same way. We look the id up in the `payments`
    // collection (populated by initiateGatewayPayment), then — critically —
    // re-fetch the payment's *actual* state from GoPay's status API rather
    // than trusting anything in the notification itself, and only then
    // propagate paid/failed/refunded to the right order or reservation slot.
    async function gopayWebhookHandler(req, res) {
        const gatewayTransactionId = String(
            (req.query && req.query.id) || (req.body && (req.body.id || req.body.paymentId)) || ""
        );

        if (!gatewayTransactionId) {
            console.warn("💳 [Webhook] GoPay notification missing payment id", { query: req.query, body: req.body });
            return res.status(400).json({ error: "Missing payment id" });
        }

        const record = db.get(COL.payments, gatewayTransactionId);
        if (!record) {
            console.warn(`💳 [Webhook] Unknown GoPay payment id: ${gatewayTransactionId}`);
            // 200 anyway — GoPay retries on non-2xx, and there is genuinely
            // nothing to do with an id we never created a payment record for.
            return res.status(200).json({ received: true, known: false });
        }

        try {
            let state;
            if (record.simulated) {
                // No real gateway to ask for simulated payments — this GET/POST
                // hitting the webhook *is* the simulated confirmation (see the
                // console log printed when the payment was created).
                state = "PAID";
            } else {
                const status = await gopay.getPaymentStatus(SERVER_CONFIG.payments, gatewayTransactionId);
                state = status.state;
            }

            const newStatus = await applyGatewayPaymentState(record, state);
            console.log(`💳 [Webhook] Payment ${gatewayTransactionId} (${record.kind}) -> ${state} (order status: ${newStatus})`);
            res.json({ received: true });
        } catch (e) {
            console.error("💳 [Webhook] Failed to verify/apply GoPay payment status:", e);
            res.status(500).json({ error: "Failed to process webhook" });
        }
    }

    app.post(`${api}/payments/gopay/webhook`, V.validate(V.gopayWebhookBodySchema), gopayWebhookHandler);
    app.get(`${api}/payments/gopay/webhook`, gopayWebhookHandler);

    // GET — lets the frontend poll payment status after returning from the
    // gateway. Public (no session yet at that point), but deliberately
    // narrow: only ever returns payment status fields, never customer PII.
    app.get(`${api}/payments/:orderId/status`, V.validateParams(V.paramsOrderId), (req, res) => {
        const order = db.get(COL.orders, req.params.orderId) || db.get(COL.indoorOrders, req.params.orderId);
        if (!order) return res.status(404).json({ error: "Objednávka nenalezena" });
        res.json({
            orderId: order.id,
            paymentStatus: order.paymentStatus,
            paymentMethod: order.paymentMethod || null,
            // Not PII (an opaque id, no customer data) — included so an
            // unauthenticated customer polling this after returning from the
            // gateway can link straight to their printable receipt once paid.
            receiptId: order.receiptId || null,
        });
    });

    // GET — companion to the route above, keyed by GoPay transaction id
    // instead of order id. This is the only way to poll a reservation-
    // attached payment (those have no single "order id" — see the
    // `payments` collection's kind:"reservation" target). Also PII-free.
    app.get(`${api}/payments/tx/:gatewayTransactionId/status`, V.validateParams(V.paramsGatewayTxId), (req, res) => {
        const record = db.get(COL.payments, req.params.gatewayTransactionId);
        if (!record) return res.status(404).json({ error: "Platba nenalezena" });
        res.json({ gatewayTransactionId: record.id, kind: record.kind, status: record.status });
    });

    // GET — full order list, including customer name/address/phone. Staff-only.
    app.get(`${api}/orders`, requireAuth, (req, res) => {
        try {
            const orders = db.list(COL.orders);
            orders.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
            res.json(orders);
        } catch {
            res.status(500).json({ error: "Failed to list orders" });
        }
    });

    app.post(`${api}/orders/:id/claim`, csrf.requireCsrf, requireDriver, V.validateParams(V.paramsId), V.validate(V.claimOrderSchema), (req, res) => {
        const { driverId, driverName } = req.body || {};

        const order = db.get(COL.orders, req.params.id);
        if (!order) return res.status(404).json({ error: "Objednávka nenalezena" });

        if (order.status === "claimed") {
            return res.status(409).json({ error: "Objednávku už převzal jiný řidič", order });
        }

        order.status = "claimed";
        order.claimedBy = driverId;
        order.claimedByName = driverName;
        order.claimedAt = new Date().toISOString();

        db.set(COL.orders, order.id, order);
        broadcastBoardEvent(); // claim status change — both the driver list (this order drops off "unclaimed") and the kitchen board show it

        // go-live Task 4 (spec §6): "on the way" SMS — fire-and-forget, not
        // awaited, so a slow/failing SMS never delays this response to the
        // driver's app.
        const claimNotifSettings = settingsStore.getSettings().notifications;
        if (claimNotifSettings.smsOrderOnTheWay && order.phone) {
            notify
                .sendSms(order.phone, `Objednávka č. ${order.id} je na cestě.`)
                .catch(e => console.error("On-the-way SMS crashed unexpectedly:", e));
        }

        res.json({ success: true, order });
    });

    app.post(`${api}/orders/:id/kitchen-status`, csrf.requireCsrf, requireAuth, V.validateParams(V.paramsId), V.validate(V.kitchenStatusSchema), (req, res) => {
        const { status } = req.body || {};

        const order = db.get(COL.orders, req.params.id);
        if (!order) return res.status(404).json({ error: "Objednávka nenalezena" });

        order.kitchenStatus = status;
        db.set(COL.orders, order.id, order);
        broadcastBoardEvent();
        res.json({ success: true, order });
    });

    // SECURITY (audit 2026-07-29, finding F2): requireStaff, not requireAuth —
    // deleting orders is not part of a driver's job. See requireStaff's
    // comment in auth.js for why this is not requireAdmin (the kitchen page's
    // delete button is used by non-admin staff).
    app.delete(`${api}/orders/:id`, csrf.requireCsrf, requireStaff, V.validateParams(V.paramsId), (req, res) => {
        const ok = db.remove(COL.orders, req.params.id);
        if (!ok) return res.status(404).json({ error: "Objednávka nenalezena" });
        broadcastBoardEvent();
        res.json({ success: true });
    });

    // ── KITCHEN BOARD ────────────────────────────────────────────────────
    // NOTE: this board includes full delivery order PII (customerName,
    // address, phone) via `delivery`, so — like GET /orders — it requires a
    // staff session. kitchen.js already sends credentials:'include' and
    // expects staff to have logged in once via /admin or /driver in the
    // same browser (see its apiFetch comment), so this doesn't change the
    // intended flow, it just closes the unauthenticated read that used to
    // exist alongside it.

    app.get(`${api}/kitchen/orders`, requireAuth, (req, res) => {
        try {
            const indoor = [];

            for (const data of db.list(COL.timetables)) {
                indoor.push(...collectIndoorOrderEvents(data));
            }

            for (const o of db.list(COL.indoorOrders)) {
                indoor.push({
                    kind: "walkin",
                    id: o.id,
                    tableName: o.tableName,
                    guestName: o.guestName || "",
                    dateStr: (o.createdAt || "").slice(0, 10),
                    startHour: null,
                    endHour: null,
                    order: (o.items || []).map(i => ({ item: i.item, qty: i.qty, price: i.price })),
                    orderTotal: o.total,
                    kitchenStatus: o.kitchenStatus || "pending",
                    createdAt: o.createdAt
                });
            }

            indoor.sort((a, b) => {
                const aKey = a.createdAt || `${a.dateStr}`;
                const bKey = b.createdAt || `${b.dateStr}`;
                return bKey.localeCompare(aKey);
            });

            const delivery = db.list(COL.orders);
            delivery.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

            res.json({ indoor, delivery });
        } catch (e) {
            console.error("Kitchen board load failed:", e);
            res.status(500).json({ error: "Failed to load kitchen orders" });
        }
    });

    app.post(`${api}/kitchen/indoor/status`, csrf.requireCsrf, requireAuth, V.validate(V.kitchenIndoorStatusSchema), (req, res) => {
        const { fileId, dateStr, dayIndex, startHour, endHour, status } = req.body || {};
        // SECURITY: dayIndex/startHour/endHour are bounded (0–6 / 0–23 / 0–23)
        // by V.kitchenIndoorStatusSchema before this runs — the loop below
        // would otherwise let an unbounded endHour (e.g. 1e9) spin the event
        // loop for a very long time on a single request (DoS).
        try {
            const data = db.get(COL.timetables, fileId);
            if (!data) return res.status(404).json({ error: "Rezervace nenalezena" });
            const hoursObj = data.data?.[dateStr]?.[dayIndex];
            if (!hoursObj) return res.status(404).json({ error: "Rezervace nenalezena" });

            for (let h = startHour; h <= endHour; h++) {
                if (hoursObj[h]) hoursObj[h].kitchenStatus = status;
            }

            db.set(COL.timetables, fileId, data);
            broadcastBoardEvent();
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: "Nepodařilo se změnit stav" });
        }
    });

    app.post(`${api}/kitchen/indoor/remove`, csrf.requireCsrf, requireAuth, V.validate(V.kitchenIndoorRemoveSchema), (req, res) => {
        const { fileId, dateStr, dayIndex, startHour, endHour } = req.body || {};
        try {
            const data = db.get(COL.timetables, fileId);
            if (!data) return res.status(404).json({ error: "Rezervace nenalezena" });
            const hoursObj = data.data?.[dateStr]?.[dayIndex];
            if (!hoursObj) return res.status(404).json({ error: "Rezervace nenalezena" });

            for (let h = startHour; h <= endHour; h++) {
                if (hoursObj[h]) {
                    delete hoursObj[h].order;
                    delete hoursObj[h].orderTotal;
                    delete hoursObj[h].kitchenStatus;
                }
            }

            db.set(COL.timetables, fileId, data);
            broadcastBoardEvent();
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: "Nepodařilo se odstranit objednávku" });
        }
    });

    // POST — waiter marks a reservation-attached order as paid. Same
    // fileId/dateStr/dayIndex/startHour/endHour addressing as kitchen/indoor/status,
    // so it marks every hour slot the booking occupies at once.
    app.post(`${api}/kitchen/reservation/mark-paid`, csrf.requireCsrf, requireAuth, V.validate(V.kitchenReservationMarkPaidSchema), (req, res) => {
        const { fileId, dateStr, dayIndex, startHour, endHour } = req.body || {};
        try {
            const data = db.get(COL.timetables, fileId);
            if (!data) return res.status(404).json({ error: "Rezervace nenalezena" });
            const hoursObj = data.data?.[dateStr]?.[dayIndex];
            if (!hoursObj) return res.status(404).json({ error: "Rezervace nenalezena" });

            const primarySlot = hoursObj[startHour];
            let receipt = null;
            if (primarySlot && Array.isArray(primarySlot.order) && primarySlot.order.length > 0) {
                receipt = createReceiptForOrder({
                    kind: "reservation",
                    items: primarySlot.order,
                    total: primarySlot.orderTotal,
                    paymentMethod: "cash",
                    existingReceiptId: primarySlot.receiptId,
                    description: `Rezervace ${data.className} — ${dateStr}`,
                });
            }

            for (let h = startHour; h <= endHour; h++) {
                if (hoursObj[h]) {
                    hoursObj[h].isPaid = true;
                    if (receipt) hoursObj[h].receiptId = receipt.id;
                }
            }

            db.set(COL.timetables, fileId, data);
            broadcastBoardEvent();
            res.json({ success: true, receiptId: receipt ? receipt.id : null });
        } catch (e) {
            res.status(500).json({ error: "Nepodařilo se označit jako zaplaceno" });
        }
    });

    // POST — starts an online GoPay payment for a reservation-attached food
    // order. Same fileId/dateStr/dayIndex/startHour/endHour addressing as
    // mark-paid above (targets every hour slot the booking occupies). No
    // auth — the guest pays from their own booking confirmation, not staff.
    // The amount charged is the orderTotal that was already server-priced
    // against the menu back when the reservation was booked (see
    // priceOrderItems() in /reservations/send-code) — not re-derived from
    // anything in this request.
    app.post(`${api}/kitchen/reservation/pay-online`, V.validate(V.kitchenReservationPayOnlineSchema), async (req, res) => {
        const { fileId, dateStr, dayIndex, startHour, endHour, returnUrl } = req.body || {};
        try {
            const data = db.get(COL.timetables, fileId);
            if (!data) return res.status(404).json({ error: "Rezervace nenalezena" });
            const hoursObj = data.data?.[dateStr]?.[dayIndex];
            const slot = hoursObj?.[startHour];
            if (!slot || !Array.isArray(slot.order) || slot.order.length === 0) {
                return res.status(404).json({ error: "Objednávka k rezervaci nenalezena" });
            }
            if (slot.isPaid) return res.status(400).json({ error: "Objednávka je již zaplacena" });

            const payment = await initiateGatewayPayment({
                req,
                kind: "reservation",
                target: { fileId, dateStr, dayIndex, startHour, endHour },
                amountCzk: slot.orderTotal,
                items: slot.order,
                description: `Rezervace ${data.className} — ${dateStr}`,
                orderNumber: `${fileId}-${dateStr}-${dayIndex}-${startHour}`,
                returnUrl,
            });

            res.json({
                success: true,
                redirectUrl: payment.redirectUrl,
                simulated: payment.simulated,
                gatewayTransactionId: payment.gatewayTransactionId,
            });
        } catch (e) {
            console.error("Reservation online payment failed:", e);
            res.status(500).json({ error: "Nepodařilo se zahájit platbu" });
        }
    });

    // ── INDOOR ORDERS (staff-placed) ─────────────────────────────────────

    app.post(`${api}/indoor-orders`, csrf.requireCsrf, requireAuth, V.validate(V.createIndoorOrderSchema), (req, res) => {
        const { tableName, guestName, items } = req.body || {};

        // Server-side pricing — same rule as delivery orders: client sends
        // item + qty, price/total always come from the live menu.
        const priced = priceOrderItems(items);
        if (priced.error) return res.status(400).json({ error: priced.error });

        const id = generateFileId();
        const order = {
            id,
            tableName: tableName.trim(),
            guestName: (guestName || "").trim(),
            items: priced.items,
            total: priced.total,
            kitchenStatus: "pending",
            createdAt: new Date().toISOString(),
            // Walk-in/table orders are usually settled physically at the
            // table (cash or a card terminal) — paymentMethod stays null for
            // that case, same as before. Optionally payable online too, via
            // /indoor-orders/:id/pay-online below (e.g. a QR code at the table).
            paymentStatus: "unpaid", // "unpaid" | "paid"
            gatewayTransactionId: null,
            receiptId: null,         // set once a receipt is issued at payment time
        };

        db.set(COL.indoorOrders, id, order);
        broadcastBoardEvent(); // new walk-in/table order — visible on the kitchen board immediately
        res.json({ success: true, order });
    });

    // POST — waiter marks a walk-in table order as paid (cash / card terminal).
    app.post(`${api}/indoor-orders/:id/mark-paid`, csrf.requireCsrf, requireAuth, V.validateParams(V.paramsId), (req, res) => {
        const order = db.get(COL.indoorOrders, req.params.id);
        if (!order) return res.status(404).json({ error: "Objednávka nenalezena" });
        order.paymentStatus = "paid";
        const receipt = createReceiptForOrder({
            kind: "indoor",
            items: order.items,
            total: order.total,
            paymentMethod: order.paymentMethod || "cash",
            existingReceiptId: order.receiptId,
            description: `Stůl ${order.tableName} — objednávka ${order.id}`,
        });
        order.receiptId = receipt.id;
        db.set(COL.indoorOrders, order.id, order);
        broadcastBoardEvent();
        res.json({ success: true, order, receiptId: receipt.id });
    });

    // POST — starts an online GoPay payment for a table order (e.g. guest
    // scans a QR code at the table and pays from their phone). No auth
    // required — guests, not just staff, can trigger this — but the order
    // must exist and not already be paid.
    app.post(`${api}/indoor-orders/:id/pay-online`, V.validateParams(V.paramsId), V.validate(V.payOnlineReturnUrlSchema), async (req, res) => {
        const order = db.get(COL.indoorOrders, req.params.id);
        if (!order) return res.status(404).json({ error: "Objednávka nenalezena" });
        if (order.paymentStatus === "paid") return res.status(400).json({ error: "Objednávka je již zaplacena" });

        try {
            const payment = await initiateGatewayPayment({
                req,
                kind: "indoor",
                target: { orderId: order.id },
                amountCzk: order.total,
                items: order.items,
                description: `Stůl ${order.tableName} — objednávka ${order.id}`,
                orderNumber: order.id,
                returnUrl: req.body?.returnUrl,
            });
            order.gatewayTransactionId = payment.gatewayTransactionId;
            order.paymentMethod = "online_card";
            db.set(COL.indoorOrders, order.id, order);
            broadcastBoardEvent();
            res.json({
                success: true,
                redirectUrl: payment.redirectUrl,
                simulated: payment.simulated,
                gatewayTransactionId: payment.gatewayTransactionId,
            });
        } catch (e) {
            console.error("Indoor online payment failed:", e);
            res.status(500).json({ error: "Nepodařilo se zahájit platbu" });
        }
    });

    app.get(`${api}/indoor-orders`, requireAuth, (req, res) => {
        try {
            const orders = db.list(COL.indoorOrders);
            orders.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
            res.json(orders);
        } catch {
            res.status(500).json({ error: "Failed to list indoor orders" });
        }
    });

    app.post(`${api}/indoor-orders/:id/kitchen-status`, csrf.requireCsrf, requireAuth, V.validateParams(V.paramsId), V.validate(V.kitchenStatusSchema), (req, res) => {
        const { status } = req.body || {};

        const order = db.get(COL.indoorOrders, req.params.id);
        if (!order) return res.status(404).json({ error: "Objednávka nenalezena" });

        order.kitchenStatus = status;
        db.set(COL.indoorOrders, order.id, order);
        broadcastBoardEvent();
        res.json({ success: true, order });
    });

    // SECURITY (audit 2026-07-29, finding F2): same reasoning as
    // DELETE /orders/:id above — drivers have no business deleting table orders.
    app.delete(`${api}/indoor-orders/:id`, csrf.requireCsrf, requireStaff, V.validateParams(V.paramsId), (req, res) => {
        const ok = db.remove(COL.indoorOrders, req.params.id);
        if (!ok) return res.status(404).json({ error: "Objednávka nenalezena" });
        broadcastBoardEvent();
        res.json({ success: true });
    });

    // ── DRIVERS ──────────────────────────────────────────────────────────

    app.get(`${api}/drivers`, requireAuth, (req, res) => {
        try {
            const drivers = db.list(COL.drivers).map(({ password, ...safe }) => safe);
            res.json(drivers);
        } catch {
            res.status(500).json({ error: "Failed to list drivers" });
        }
    });

    app.post(`${api}/drivers`, csrf.requireCsrf, requireAdmin, V.validate(V.createDriverSchema), async (req, res) => {
        const { name, username, password } = req.body || {};

        const id = generateFileId();
        const hashed = await hashPassword(password);
        const driver = { id, name, username, password: hashed, createdAt: new Date().toISOString() };

        db.set(COL.drivers, id, driver);
        const { password: _, ...safe } = driver;
        res.json(safe);
    });

    // NOTE: driver.js currently authenticates via POST /users/login (drivers
    // are just user accounts with isDriver:true) — this route is kept for
    // completeness/back-compat but issues the same session cookie so either
    // login path works.
    //
    // SECURITY (this route + /users/login below): brute-force hardening —
    //   - loginLimiter: strict per-IP rate limit (security.js)
    //   - per-account lockout: N consecutive bad attempts locks this
    //     username for a cooldown, even from a different IP, and is applied
    //     to nonexistent usernames too so the lockout itself never becomes
    //     a new enumeration oracle
    //   - identical 401 body + a dummy bcrypt compare whether the account
    //     exists or the password was wrong, so timing/response can't be
    //     used to tell "no such driver" from "wrong password"
    //   - every attempt (success or failure) is written to the login_audit
    //     collection — see GET /api/security/login-audit below
    app.post(`${api}/drivers/login`, security.loginLimiter, V.validate(V.driverLoginSchema), async (req, res) => {
        const { username, password } = req.body || {};

        const ip = req.ip;
        const scope = "driver";

        if (security.isAccountLocked(scope, username)) {
            security.logLoginAudit({ scope, identifier: username, success: false, ip, reason: "locked" });
            return res.status(423).json({ error: "Účet je dočasně uzamčen kvůli opakovaným neúspěšným pokusům o přihlášení. Zkuste to prosím znovu za pár minut." });
        }

        try {
            const found = db.list(COL.drivers).find(d => d.username === username);
            const ok = found ? await comparePassword(password, found.password) : await security.dummyCompare(password);

            if (!found || !ok) {
                security.recordFailedLogin(scope, username);
                security.logLoginAudit({ scope, identifier: username, success: false, ip, reason: found ? "bad_password" : "no_such_account" });
                return res.status(401).json({ error: "Nesprávné jméno nebo heslo" });
            }

            security.clearFailedLogins(scope, username);
            security.logLoginAudit({ scope, identifier: username, success: true, ip });

            const { password: _, ...safe } = found;
            issueSessionCookie(res, { id: found.id, name: found.name, isAdmin: false, isDriver: true });
            res.json(safe);
        } catch (e) {
            console.error("Driver login error:", e);
            res.status(500).json({ error: "Server error" });
        }
    });

    // ── MENU ─────────────────────────────────────────────────────────────

    app.get(`${api}/menu`, (req, res) => {
        try {
            res.json(db.get(COL.menu, MENU_SINGLETON_ID) || {});
        } catch {
            res.status(500).json({ error: "Failed to load menu" });
        }
    });

    // Optional per-item vatRate (12% food / 21% drinks / 0% exempt) — items
    // without one default to 12 wherever it's read (resolveVatRate), so
    // pre-existing menu data with no vatRate field keeps working unchanged.
    // Explicit values are still validated here so bad data can never enter
    // the menu in the first place.
    app.put(`${api}/menu`, csrf.requireCsrf, requireAdmin, V.validate(V.menuPutSchema), (req, res) => {
        try {
            const menu = req.body || {};
            for (const categoryId of Object.keys(menu)) {
                const dishes = menu[categoryId];
                if (!Array.isArray(dishes)) continue;
                for (const dish of dishes) {
                    if (!dish || dish.vatRate === undefined || dish.vatRate === null || dish.vatRate === "") continue;
                    const rate = Number(dish.vatRate);
                    if (!VALID_VAT_RATES.includes(rate)) {
                        return res.status(400).json({
                            error: `Neplatná sazba DPH u položky "${dish.name || dish.id || "?"}" (povoleno 0, 12, 21)`,
                        });
                    }
                    dish.vatRate = rate; // normalize to a number
                }
            }
            db.set(COL.menu, MENU_SINGLETON_ID, menu);
            res.json({ success: true });
        } catch {
            res.status(500).json({ error: "Failed to save menu" });
        }
    });

    // ── COMBOS ("Zvýhodněná menu") ────────────────────────────────────────
    // Combo menus (spec: docs/superpowers/specs/2026-07-22-combo-menus-
    // design.md) — configurable set menus ("Menu 1: polévka + hlavní jídlo +
    // nápoj") that customers can customize (swap/remove a slot, add paid
    // extras, attach a note) when ordering. Stored the exact same way as the
    // menu itself: one singleton record holding the WHOLE array, full-
    // replace on PUT. See priceOrderItems()'s COMBO_ITEM_ID_PREFIX branch
    // further up for how a cart line actually consumes one of these.
    app.get(`${api}/combos`, (req, res) => {
        try {
            res.json(db.get(COL.combos, COMBOS_SINGLETON_ID) || []);
        } catch {
            res.status(500).json({ error: "Failed to load combos" });
        }
    });

    // Full-object replace, same pattern/auth chain as PUT /menu. Shape/limits
    // (slots 1–10, extras 0–10, swaps 0–20, string length caps, price ≥ 0,
    // vatRate 0|12|21) are enforced entirely by V.combosPutSchema — nothing
    // left for a route-level loop to double-check here (unlike PUT /menu's
    // vatRate loop, which exists only because dishSchema deliberately leaves
    // vatRate loosely typed for legacy-coordination reasons — combosPutSchema
    // is a brand-new shape with exactly one producer, so it's fully typed
    // there instead).
    app.put(`${api}/combos`, csrf.requireCsrf, requireAdmin, V.validate(V.combosPutSchema), (req, res) => {
        try {
            db.set(COL.combos, COMBOS_SINGLETON_ID, req.body || []);
            res.json({ success: true });
        } catch {
            res.status(500).json({ error: "Failed to save combos" });
        }
    });

    // ── DAILY MENU (polední menu — go-live Task 3, spec §5) ──────────────
    // One record per calendar date (collection COL.dailyMenu, id "YYYY-MM-DD"),
    // shape { date, items: [{id, name, price, vatRate}] }. See priceOrderItems()
    // above for how an order actually consumes one of these (DAILY_ITEM_ID_PREFIX)
    // and settingsStore.isDailyMenuWindowOpen() for the enabled/from/to gate.

    // Reads the auth cookie (if any) WITHOUT rejecting the request when it's
    // missing/invalid — used by routes that are public by default but need
    // "is this caller logged in at all?" (or, via getAdminUserIfAny below,
    // "...logged in as an admin specifically?") as a yes/no fact rather than
    // a hard gate on the whole route. GET /timetables/:name (go-live Task 4
    // review fix — see sanitizeTimetableForPublic's header comment) uses this
    // one directly: ANY authenticated staff/driver session, not just admin,
    // should see the unredacted record, since inner.js/kitchen.js/driver.js
    // sessions all legitimately need real guest names/phones/preorders to do
    // their job.
    function getAuthenticatedUserIfAny(req) {
        const token = req.cookies?.[AUTH_COOKIE_NAME];
        const user = token && verifyToken(token);
        return user || null;
    }

    // Same non-gating pattern as getAuthenticatedUserIfAny above, narrowed to
    // "...and are they an admin?" — used only by GET /daily-menu's `?date=`
    // branch below, which needs admin specifically (the no-`?date=` path
    // stays fully public, same as GET /menu / GET /settings).
    function getAdminUserIfAny(req) {
        const user = getAuthenticatedUserIfAny(req);
        return (user && user.isAdmin) ? user : null;
    }

    app.get(`${api}/daily-menu`, (req, res) => {
        try {
            const requestedDate = typeof req.query.date === "string" ? req.query.date.trim() : "";

            if (requestedDate) {
                // Admin-only override (spec §5: "admin may pass ?date= to
                // fetch any date regardless of window" — for the editor to
                // load/copy any day, at any time of day). Any date shape
                // (not just today's) is allowed here; the enabled/from/to
                // window only gates the PUBLIC (no ?date=) path below.
                if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) {
                    return res.status(400).json({ error: "Neplatné datum (YYYY-MM-DD)" });
                }
                if (!getAdminUserIfAny(req)) {
                    return res.status(403).json({ error: "Vyžadována administrátorská oprávnění" });
                }
                const record = db.get(COL.dailyMenu, requestedDate);
                return res.json(record || { date: requestedDate, items: [] });
            }

            // Public path: only ever today's record, and only while the
            // configured window is open — otherwise an empty list, exactly
            // as if there were no specials today (spec §5: "auto-hidden
            // outside its time window or when empty", design §0).
            const settings = settingsStore.getSettings();
            const windowCheck = settingsStore.isDailyMenuWindowOpen(settings);
            if (!windowCheck.ok) {
                return res.json({ items: [] });
            }

            const today = settingsStore.formatDateStrLocal(new Date());
            const record = db.get(COL.dailyMenu, today);
            res.json(record || { items: [] });
        } catch (e) {
            console.error("Failed to load daily menu:", e);
            res.status(500).json({ error: "Nepodařilo se načíst polední menu" });
        }
    });

    // Full-object replace for one date's record, same pattern as PUT /menu.
    // Items without a client-sent id (a brand-new row from the admin's "+
    // Přidat položku" button) get one generated here — stable within this
    // record from then on (spec §5: "IDs ... stable within the record").
    app.put(`${api}/daily-menu`, csrf.requireCsrf, requireAdmin, V.validate(V.dailyMenuPutSchema), (req, res) => {
        try {
            const { date, items } = req.body;
            const withIds = items.map(item => ({
                id: (item.id != null && String(item.id).trim()) ? String(item.id) : generateFileId(10),
                name: item.name,
                price: item.price,
                vatRate: item.vatRate,
            }));
            const record = { date, items: withIds };
            db.set(COL.dailyMenu, date, record);
            res.json({ success: true, dailyMenu: record });
        } catch (e) {
            console.error("Failed to save daily menu:", e);
            res.status(500).json({ error: "Nepodařilo se uložit polední menu" });
        }
    });

    // ── SETTINGS (hours, closed days, pause, delivery rules, notifications) ──
    // See settings.js for the canonical shape/defaults/deep-merge and the
    // enforcement helpers used by the reservation/order routes above.

    // Public, no auth — clients (reservation page, delivery page) need
    // hours/fees/pause state to render correctly; nothing here is secret.
    app.get(`${api}/settings`, (req, res) => {
        try {
            res.json(settingsStore.getSettings());
        } catch (e) {
            console.error("Failed to load settings:", e);
            res.status(500).json({ error: "Nepodařilo se načíst nastavení" });
        }
    });

    // Full-object replace, same pattern as PUT /menu / PUT /timetables/:name
    // — admin's Nastavení panel always sends the whole settings object back
    // (fetched from GET, then edited), so req.body here already carries
    // every section even where a given Task-1 admin form doesn't expose a
    // particular field (e.g. delivery.fee/minOrder — those are Task 2's
    // admin UI, but already part of the settings shape per spec §2).
    app.put(`${api}/settings`, csrf.requireCsrf, requireAdmin, V.validate(V.settingsSchema), (req, res) => {
        try {
            const saved = settingsStore.saveSettings(req.body);
            res.json({ success: true, settings: saved });
        } catch (e) {
            console.error("Failed to save settings:", e);
            res.status(500).json({ error: "Nepodařilo se uložit nastavení" });
        }
    });

    // ── SALES STATS ───────────────────────────────────────────────────────

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
        try {
            const days = Math.max(1, parseInt(req.query.days, 10) || 30);
            const since = new Date();
            since.setDate(since.getDate() - days);
            since.setHours(0, 0, 0, 0);

            const itemStats = {};
            const addItem = (name, qty, price) => {
                const cleanName = (name || "").trim();
                if (!cleanName) return;
                const q = Number(qty) || 0;
                if (!itemStats[cleanName]) itemStats[cleanName] = { count: 0, revenue: 0 };
                itemStats[cleanName].count += q;
                itemStats[cleanName].revenue += (Number(price) || 0) * q;
            };

            // 1) Delivery orders
            for (const order of db.list(COL.orders)) {
                const created = new Date(order.createdAt);
                if (isNaN(created.getTime()) || created < since) continue;
                for (const item of order.items || []) addItem(item.name, item.qty, item.price);
            }

            // 2) Table-reservation food orders
            for (const data of db.list(COL.timetables)) {
                for (const ev of collectTableOrderEvents(data, since)) {
                    for (const item of ev.order || []) addItem(item.item, item.qty, item.price);
                }
            }

            // 3) Walk-in indoor orders
            for (const order of db.list(COL.indoorOrders)) {
                const created = new Date(order.createdAt);
                if (isNaN(created.getTime()) || created < since) continue;
                for (const item of order.items || []) addItem(item.item, item.qty, item.price);
            }

            const items = Object.entries(itemStats)
                .map(([name, s]) => ({ name, count: s.count, revenue: Math.round(s.revenue * 100) / 100 }))
                .sort((a, b) => b.count - a.count);

            res.json({ days, since: since.toISOString(), items });
        } catch (e) {
            console.error("Sales stats failed:", e);
            res.status(500).json({ error: "Failed to compute sales stats" });
        }
    });

    // ── RECEIPTS (účtenky) ──────────────────────────────────────────────
    // Receipts themselves are created by createReceiptForOrder() at the
    // moment an order/reservation food order is marked paid — see the
    // "RECEIPTS" section above and its call sites (mark-paid routes +
    // applyGatewayPaymentState). These are read-only lookup/listing routes.

    // GET — staff list, newest first. Optional ?from=&to= (ISO date or
    // datetime strings) filter on issuedAt.
    app.get(`${api}/receipts`, requireAuth, (req, res) => {
        try {
            let receipts = db.list(COL.receipts);
            const { from, to } = req.query || {};
            if (from) {
                const fromDate = new Date(from);
                if (!isNaN(fromDate.getTime())) receipts = receipts.filter(r => new Date(r.issuedAt) >= fromDate);
            }
            if (to) {
                const toDate = new Date(to);
                if (!isNaN(toDate.getTime())) receipts = receipts.filter(r => new Date(r.issuedAt) <= toDate);
            }
            receipts.sort((a, b) => new Date(b.issuedAt) - new Date(a.issuedAt));
            res.json(receipts);
        } catch (e) {
            console.error("Failed to list receipts:", e);
            res.status(500).json({ error: "Failed to list receipts" });
        }
    });

    // GET — single receipt as JSON. Deliberately public/unauthenticated:
    // customers need to be able to open their own receipt link (e.g. from
    // an SMS/email confirmation) without a staff session. Safe because the
    // id is a long random string (see generateReceiptId), not the
    // sequential display number — nobody can guess another customer's id.
    app.get(`${api}/receipts/:receiptId`, V.validateParams(V.paramsReceiptId), (req, res) => {
        const receipt = db.get(COL.receipts, req.params.receiptId);
        if (!receipt) return res.status(404).json({ error: "Účtenka nenalezena" });
        res.json(receipt);
    });

    // GET — printable standalone HTML page, same public/unguessable-id
    // reasoning as above. No dependency on the app's own JS/CSS.
    app.get(`${SERVER_CONFIG.basePath}/uctenka/:receiptId`, (req, res) => {
        const receipt = db.get(COL.receipts, req.params.receiptId);
        if (!receipt) return res.status(404).send(renderReceiptNotFoundHtml());
        res.send(renderReceiptHtml(receipt));
    });

    // ── DATA EXPORT (backup) ─────────────────────────────────────────────
    // Storage is now a single SQLite file, so "export" just means "download
    // that file". We checkpoint the WAL into the main .db file first so the
    // downloaded copy is complete and self-contained (no separate -wal/-shm
    // files needed), then stream it straight down.
    app.get(`${api}/export`, requireAdmin, (req, res) => {
        try {
            // Flush any pending writes sitting in the WAL file into app.db
            // itself, so the single file we send is fully up to date.
            db.getDb().pragma("wal_checkpoint(TRUNCATE)");

            const stamp = new Date().toISOString().replace(/[:.]/g, "-");
            res.download(db.DB_PATH, `app-backup-${stamp}.db`, (err) => {
                if (err) {
                    console.error("Export download failed:", err);
                    if (!res.headersSent) {
                        res.status(500).json({ error: "Failed to export data" });
                    }
                }
            });
        } catch (e) {
            console.error("Export failed:", e);
            res.status(500).json({ error: "Failed to export data" });
        }
    });

    // ── USERS ────────────────────────────────────────────────────────────

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
        try {
            const users = db.list(COL.users).map(({ password, ...safe }) => safe);
            res.json(users);
        } catch (e) {
            res.status(500).json({ error: "Failed to list users" });
        }
    });

    // SECURITY: see the extended comment on POST /drivers/login above — same
    // rate-limit + lockout + audit-log + timing/enumeration hardening here.
    app.post(`${api}/users/login`, security.loginLimiter, V.validate(V.loginSchema), async (req, res) => {
        const { abbreviation, password } = req.body || {};
        // SECURITY: V.loginSchema forces `abbreviation` through z.string()
        // before this handler runs — an object/array-typed `abbreviation`
        // (which would previously just silently never match any stored
        // user via `u.abbreviation === abbreviation`, falling through to
        // the dummy-compare 401 path) is now rejected up front with a clean
        // 400 instead.
        const ip = req.ip;
        const scope = "user";

        if (security.isAccountLocked(scope, abbreviation)) {
            security.logLoginAudit({ scope, identifier: abbreviation, success: false, ip, reason: "locked" });
            return res.status(423).json({ error: "Účet je dočasně uzamčen kvůli opakovaným neúspěšným pokusům o přihlášení. Zkuste to prosím znovu za pár minut." });
        }

        try {
            const found = db.list(COL.users).find(u => u.abbreviation === abbreviation);
            const ok = found ? await comparePassword(password, found.password) : await security.dummyCompare(password);

            if (!found || !ok) {
                security.recordFailedLogin(scope, abbreviation);
                security.logLoginAudit({ scope, identifier: abbreviation, success: false, ip, reason: found ? "bad_password" : "no_such_account" });
                return res.status(401).json({ error: "Nesprávné jméno nebo heslo" });
            }

            security.clearFailedLogins(scope, abbreviation);
            security.logLoginAudit({ scope, identifier: abbreviation, success: true, ip });

            const { password: _, ...safe } = found;
            issueSessionCookie(res, found);
            res.json(safe);
        } catch (e) {
            console.error("User login error:", e);
            res.status(500).json({ error: "Server error" });
        }
    });

    app.post(`${api}/logout`, (req, res) => {
        clearSessionCookie(res);
        res.json({ success: true });
    });

    // ── SECURITY / LOGIN AUDIT ───────────────────────────────────────────
    // Newest-first view of every login attempt (success or failure) across
    // both /users/login and /drivers/login, so break-in attempts are
    // visible to staff. Admin-only; never includes passwords (see
    // security.js logLoginAudit — only identifier/success/ip/reason/at are
    // ever written).
    app.get(`${api}/security/login-audit`, requireAdmin, (req, res) => {
        try {
            const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 200));
            res.json(security.getRecentLoginAudit(limit));
        } catch (e) {
            console.error("Failed to load login audit log:", e);
            res.status(500).json({ error: "Failed to load login audit log" });
        }
    });

    app.post(`${api}/users`, csrf.requireCsrf, requireAdmin, V.validate(V.createUserSchema), async (req, res) => {
        const { name, abbreviation, password, isAdmin, isDriver } = req.body;

        const id = generateFileId();
        const hashed = await hashPassword(password);
        const user = {
            id,
            name,
            abbreviation,
            password: hashed,
            isAdmin: !!isAdmin,
            isDriver: !!isDriver,
            createdAt: new Date().toISOString()
        };

        db.set(COL.users, id, user);
        const { password: _, ...safe } = user;
        res.json(safe);
    });
}

// ============================================================================
// GENERIC ERROR HANDLER
// ============================================================================
// SECURITY: must be registered LAST (after every route/middleware) — Express
// only routes to a 4-arg middleware as an error handler, and only for errors
// that reach it (thrown synchronously in a route, passed to next(err), or
// raised by a body-parser like express.json()). Without this, an unexpected
// exception anywhere (a bad JSON body, a null-deref in a route, whatever)
// falls through to Express's default handler, which — outside of
// NODE_ENV=production — echoes the real error message and full stack trace
// straight into the HTTP response. That's an information-disclosure bug on
// its own (internal file paths, dependency versions, sometimes fragments of
// request data) on a server that's now publicly reachable on Render.
//
// Two error shapes are specifically distinguished so the client gets a
// sensible status code instead of a blanket 500:
//   - express.json()'s built-in limit rejection: err.type === "entity.too.large"
//     (from the size limits above) → 413.
//   - Malformed JSON body (client sent invalid JSON, not "too big"):
//     express.json() throws a SyntaxError with err.status === 400 /
//     err.type === "entity.parse.failed" → 400, not a 500/crash.
// Everything else is logged server-side (with the real error) and answered
// with a single generic Czech 500 — never the error's own .message/.stack.
function setupErrorHandlers() {
    // 404 for any /api/* path that didn't match a route above, so an
    // unknown API endpoint gets a clean Czech JSON 404 instead of falling
    // through to the static/HTML routes or Express's default HTML 404 page.
    app.use(`${SERVER_CONFIG.basePath}/api`, (req, res) => {
        res.status(404).json({ error: "Požadovaný koncový bod nebyl nalezen" });
    });

    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
        if (res.headersSent) return next(err);

        if (err && err.type === "entity.too.large") {
            return res.status(413).json({ error: "Požadavek je příliš velký" });
        }

        // body-parser (used internally by express.json()) tags every body-
        // reading failure with `.type`; malformed JSON specifically is
        // "entity.parse.failed" with status 400 — see node_modules/body-
        // parser/lib/read.js. Falls back to catching any other SyntaxError
        // with an explicit 400 status as a second safety net.
        if (err && (err.type === "entity.parse.failed" || (err instanceof SyntaxError && err.status === 400))) {
            return res.status(400).json({ error: "Neplatný formát požadavku (JSON)" });
        }

        console.error("Unhandled request error:", err);
        res.status(500).json({ error: "Na serveru došlo k neočekávané chybě" });
    });
}

// ============================================================================
// RESERVATION REMINDERS (go-live Task 4, spec §6) — scans TODAY's timetable
// slots for bookings starting within the next 2 hours that haven't been
// reminded yet, sends one SMS each, and marks reminderSent on the slot so a
// later tick never double-sends. Entirely gated by
// settings.notifications.smsReservationReminder (default OFF — reminders
// cost real SMS money, spec explicitly calls this out).
//
// Slot shape (written by applyBookingToTimetable): data[dateStr][dayIndex]
// [hourIndex] = { content, abbreviation, isPermanent, phone, ... }. Only
// non-permanent slots carry a `phone` (permanent/admin-assigned slots were
// never SMS-verified, so there's no number to remind) — isPermanent and
// missing-phone slots are skipped without any error.
// ============================================================================

function reminderScannerTick() {
    try {
        const settings = settingsStore.getSettings();
        if (!settings.notifications.smsReservationReminder) return;

        const now = new Date();
        const todayStr = settingsStore.formatDateStrLocal(now);
        const REMINDER_HORIZON_MS = 120 * 60 * 1000; // 2 hours

        for (const record of db.list(COL.timetables)) {
            const dayData = record && record.data && record.data[todayStr];
            if (!dayData) continue;

            let changed = false;
            for (const dayIndexKey of Object.keys(dayData)) {
                const hours = dayData[dayIndexKey];
                if (!hours || typeof hours !== "object") continue;

                for (const hourKey of Object.keys(hours)) {
                    const slot = hours[hourKey];
                    if (!slot || slot.isPermanent || !slot.phone || slot.reminderSent) continue;

                    // hourIndex 1-12 -> real clock hour (8:00-20:00), same
                    // convention as RESERVATION_HOURS in renderer.js.
                    const hour = Number(hourKey) + 7;
                    if (!Number.isFinite(hour)) continue;

                    const slotStart = new Date(`${todayStr}T${String(hour).padStart(2, "0")}:00:00`);
                    const diffMs = slotStart.getTime() - now.getTime();
                    if (diffMs < 0 || diffMs > REMINDER_HORIZON_MS) continue;

                    const tableName = record.className || "stůl";
                    const timeLabel = `${hour}:00`;
                    notify
                        .sendSms(slot.phone, `Připomínáme rezervaci dnes v ${timeLabel}, stůl ${tableName}.`)
                        .catch(e => console.error("Reservation reminder SMS crashed unexpectedly:", e));

                    slot.reminderSent = true;
                    changed = true;
                }
            }

            if (changed) db.set(COL.timetables, record.fileId, record);
        }
    } catch (e) {
        console.error("Reservation reminder scanner tick failed:", e);
    }
}

// ============================================================================
// START
// ============================================================================

async function start() {
    console.log("Starting server...");

    await initializeData();

    setupMiddleware();
    setupAPIRoutes();
    setupErrorHandlers(); // must run after every other app.use/route registration — see comment above setupErrorHandlers()

    setInterval(() => {
        const now = Date.now();
        for (const [phone, entry] of pendingVerifications) {
            if (now > entry.expiresAt) pendingVerifications.delete(phone);
        }
    }, 60 * 1000);

    if (!smsIsConfigured()) {
        console.warn("⚠️  Twilio not configured (TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN/TWILIO_FROM_NUMBER) — verification codes will be logged to the console instead of sent as real SMS.");
    }

    if (!paymentsAreConfigured()) {
        console.warn(`⚠️  GoPay not configured (GOPAY_GOID/GOPAY_CLIENT_ID/GOPAY_CLIENT_SECRET) — online-card payments will be simulated and logged to the console instead of hitting a real gateway (sandbox: ${SERVER_CONFIG.payments.sandbox}).`);
    } else {
        console.log(`💳 GoPay configured — ${SERVER_CONFIG.payments.sandbox ? "SANDBOX" : "PRODUCTION"} (goid ${SERVER_CONFIG.payments.goid})`);
    }

    if (!notify.isEmailConfigured()) {
        console.warn("⚠️  SMTP not configured (SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS/SMTP_FROM) — confirmation e-mails will be logged to the console instead of actually sent.");
    }

    // go-live Task 4 (spec §6): reservation reminder scanner — ticks every 5
    // minutes, sends a reminder SMS ~2h before a booked slot's start time.
    // unref() so this interval alone never keeps the process alive (matches
    // the pendingVerifications cleanup interval above, which doesn't unref()
    // only because nothing else here relies on that — this one explicitly
    // should not block a graceful shutdown). Guarded entirely inside
    // reminderScannerTick() by the smsReservationReminder toggle (default
    // off) and its own try/catch, so a bad tick never crashes the process
    // or stops future ticks.
    const reminderIntervalMs = Number(process.env.RESERVATION_REMINDER_INTERVAL_MS) || 5 * 60 * 1000;
    setInterval(reminderScannerTick, reminderIntervalMs).unref();

    // Performance optimization design (2026-07-23) §4: SSE heartbeat for
    // GET ${API_PREFIX}/events/board — a bare `: ping` comment line every
    // 25s, just to keep any intermediary proxy/load balancer from deciding
    // an idle-but-healthy connection has gone stale and closing it.
    // unref()'d for the same reason as the interval above: it alone should
    // never keep the process alive/block a graceful shutdown.
    setInterval(() => {
        for (const client of boardEventClients) {
            try {
                client.write(": ping\n\n");
            } catch (e) {
                boardEventClients.delete(client);
            }
        }
    }, 25 * 1000).unref();

    console.log("💾 SQLite database:", db.DB_PATH);

    app.listen(SERVER_CONFIG.port, "0.0.0.0", () => {
        console.log("Server running on port", SERVER_CONFIG.port);
    });
}

start();
