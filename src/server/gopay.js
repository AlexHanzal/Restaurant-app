// ============================================================================
// gopay.js — GoPay Payments REST API v3 client (OAuth2 client_credentials)
// ============================================================================
//
// Talks directly to GoPay's REST API using Node's built-in `fetch` (Node 22+)
// — no SDK / axios dependency, per project convention. Field names and flows
// verified against GoPay's official technical documentation (doc.gopay.com)
// and the reference PHP/Python SDKs (github.com/gopaycommunity):
//
//   POST /oauth2/token              — client_credentials grant, HTTP Basic
//                                      auth with clientId:clientSecret,
//                                      returns a bearer token valid 30 min.
//   POST /payments/payment          — create a payment, returns gw_url to
//                                      redirect the payer to.
//   GET  /payments/payment/:id      — current payment state (source of truth
//                                      — never trust a webhook body's state).
//   POST /payments/payment/:id/refund — full or partial refund.
//
// All monetary amounts GoPay's API deals in are in the smallest currency
// unit — for CZK that's haléře (1 Kč = 100 haléřů) — so every function here
// takes/returns amounts in "amountCzk" (whole crowns, may have decimals)
// and converts to haléře internally.
//
// This module is intentionally stateless w.r.t. credentials: every call
// takes a `config` object shaped like SERVER_CONFIG.payments
// ({ goid, clientId, clientSecret, sandbox }) as its first argument, so it
// has no hidden dependency on server.js and stays easy to test in isolation.
// The only module-level state is an in-memory OAuth token cache (tokens are
// bearer credentials tied to clientId/environment, not to a request, so
// reusing one until shortly before it expires is both correct and avoids
// hammering GoPay's auth endpoint on every payment).
// ============================================================================

const SANDBOX_BASE_URL = "https://gw.sandbox.gopay.com/api";
const PRODUCTION_BASE_URL = "https://gate.gopay.cz/api";

// Card, Google Pay and Apple Pay are the standard "let the gateway's own
// UI pick" set; bank transfer ("BANK_ACCOUNT") is included too since it's
// commonly offered alongside cards for CZ customers. GoPay's payment page
// itself lets the payer choose among whatever's in this list.
const DEFAULT_PAYMENT_INSTRUMENTS = ["PAYMENT_CARD", "GPAY", "APPLE_PAY", "BANK_ACCOUNT"];

// clientId+environment -> { accessToken, expiresAt }
const tokenCache = new Map();

function baseUrl(config) {
    return config.sandbox ? SANDBOX_BASE_URL : PRODUCTION_BASE_URL;
}

// GoPay amounts are integers in haléře. Guards against float rounding
// weirdness (e.g. 129.9 * 100 producing 12989.999999999998).
function czkToHalere(amountCzk) {
    return Math.round((Number(amountCzk) || 0) * 100);
}

async function getAccessToken(config) {
    const cacheKey = `${config.clientId}:${config.sandbox ? "sandbox" : "prod"}`;
    const cached = tokenCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
        return cached.accessToken;
    }

    const basicAuth = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");
    const res = await fetch(`${baseUrl(config)}/oauth2/token`, {
        method: "POST",
        headers: {
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization: `Basic ${basicAuth}`,
        },
        // "payment-all" (not just "payment-create") since we also need this
        // token to call the status and refund endpoints.
        body: new URLSearchParams({ grant_type: "client_credentials", scope: "payment-all" }).toString(),
    });

    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }

    if (!res.ok) {
        throw new Error(`GoPay OAuth token request failed (${res.status}): ${json.error_description || json.message || text}`);
    }

    // Refresh 60s before actual expiry (default 1800s/30min) so we never
    // fire a request with a token that dies mid-flight.
    const ttlMs = Math.max(0, (json.expires_in || 1800) - 60) * 1000;
    tokenCache.set(cacheKey, { accessToken: json.access_token, expiresAt: Date.now() + ttlMs });
    return json.access_token;
}

async function gopayRequest(config, path, { method = "GET", jsonBody, formBody } = {}) {
    const token = await getAccessToken(config);
    const headers = { Accept: "application/json", Authorization: `Bearer ${token}` };
    let body;

    if (formBody) {
        headers["Content-Type"] = "application/x-www-form-urlencoded";
        body = new URLSearchParams(formBody).toString();
    } else if (jsonBody) {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(jsonBody);
    }

    const res = await fetch(`${baseUrl(config)}${path}`, { method, headers, body });
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }

    if (!res.ok) {
        const msg = json.error_description || json.message || json.errors || text || `HTTP ${res.status}`;
        const err = new Error(`GoPay API error on ${method} ${path} (${res.status}): ${JSON.stringify(msg)}`);
        err.status = res.status;
        err.body = json;
        throw err;
    }
    return json;
}

// Creates a payment. `items` is optional line-item metadata (each
// { name, price, qty } in the app's usual shape — price is per unit, in
// whole CZK). Returns the fields callers actually need: the gateway's
// payment id, the URL to redirect the payer to, and the initial state
// (always "CREATED" for a fresh payment).
async function createPayment(config, { orderNumber, amountCzk, items, returnUrl, notificationUrl, description }) {
    const gopayItems = (items || [])
        .filter(it => it && (it.name || it.item))
        .map(it => {
            const gopayItem = {
                type: "ITEM",
                name: String(it.name || it.item).slice(0, 255),
                amount: czkToHalere(it.price),
                count: Math.max(1, Math.round(Number(it.qty)) || 1),
            };
            // vat_rate is optional metadata GoPay shows on its own payment
            // records — only send it when the item actually carries one
            // (menu items always do via priceOrderItems' resolveVatRate, but
            // this stays defensive for any other caller).
            if (it.vatRate !== undefined && it.vatRate !== null && it.vatRate !== "") {
                gopayItem.vat_rate = String(it.vatRate);
            }
            return gopayItem;
        });

    const payload = {
        payer: {
            default_payment_instrument: "PAYMENT_CARD",
            allowed_payment_instruments: DEFAULT_PAYMENT_INSTRUMENTS,
        },
        target: { type: "ACCOUNT", goid: config.goid },
        amount: czkToHalere(amountCzk),
        currency: "CZK",
        order_number: String(orderNumber),
        order_description: (description || `Objednávka ${orderNumber}`).slice(0, 255),
        callback: { return_url: returnUrl, notification_url: notificationUrl },
        lang: "CS",
    };
    if (gopayItems.length > 0) payload.items = gopayItems;

    const json = await gopayRequest(config, "/payments/payment", { method: "POST", jsonBody: payload });
    return { id: json.id, gw_url: json.gw_url, state: json.state, raw: json };
}

// Re-fetches a payment's authoritative state from GoPay. Always call this
// from the webhook handler instead of trusting whatever the notification
// itself claims — the notification is just a "something changed, go check"
// ping, not a signed assertion of the new state.
async function getPaymentStatus(config, paymentId) {
    return gopayRequest(config, `/payments/payment/${encodeURIComponent(paymentId)}`, { method: "GET" });
}

// Full or partial refund, amount in whole CZK (converted to haléře here).
// Returns { id, result } where result is "FINISHED" | "ACCEPTED" | "FAILED".
async function refundPayment(config, paymentId, amountCzk) {
    return gopayRequest(config, `/payments/payment/${encodeURIComponent(paymentId)}/refund`, {
        method: "POST",
        formBody: { amount: String(czkToHalere(amountCzk)) },
    });
}

module.exports = {
    SANDBOX_BASE_URL,
    PRODUCTION_BASE_URL,
    getAccessToken,
    createPayment,
    getPaymentStatus,
    refundPayment,
};
