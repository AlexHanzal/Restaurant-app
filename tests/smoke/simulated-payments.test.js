// ============================================================================
// simulated-payments.test.js — a production deploy must never confirm a fake
// payment (see tests/unit/payment-mode.test.js for the reasoning).
//
// Runs the server with NODE_ENV=production and NO GoPay credentials, which is
// exactly the misconfiguration that used to be exploitable: .env.example ships
// GOPAY_* empty, and the only thing that flagged it was a console.warn nobody
// reads after the first boot.
//
// Two production details this suite has to work with, neither of which is the
// thing under test:
//   - httpsRedirect() 308s any plain-HTTP request in production, so every
//     request here sends `x-forwarded-proto: https`. The app sets
//     `trust proxy` to 1, which is what makes that header meaningful — it is
//     the same thing Render's edge does in front of the real deployment.
//   - JWT_SECRET is mandatory in production; the harness always sets one.
// ============================================================================

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert");

const harness = require("../helpers/harness");

const COL = harness.COL;

// Production means httpsRedirect() is live — without this header every request
// gets a 308 to https:// and the assertions below would all be testing the
// redirect rather than the routes.
const PROXY_HEADERS = { "x-forwarded-proto": "https" };

function tableRecord(fileId, className) {
    return {
        className,
        fileId,
        data: {},
        calendar: "",
        currentWeek: new Date().toISOString(),
        info: "",
        attributes: [],
        seats: 4,
        layout: null,
        permanentHours: { "0": {}, "1": {}, "2": {}, "3": {}, "4": {}, "5": {}, "6": {} },
    };
}

describe("production never confirms a simulated payment", () => {
    let h;
    const ORDER_ID = "prodOrder0001";
    const SIMULATED_TX = "SIMULATED-prodTx0001";

    before(async () => {
        h = await harness.start({ env: { NODE_ENV: "production" } });

        harness.seedRecord(h.dbPath, COL.timetables, "prodTable0001", tableRecord("prodTable0001", "Stůl P"));

        harness.seedRecord(h.dbPath, COL.indoorOrders, ORDER_ID, {
            id: ORDER_ID,
            tableName: "Stůl P",
            guestName: "",
            items: [{ id: "dish1", item: "Svíčková", name: "Svíčková", qty: 1, price: 150, vatRate: 21 }],
            total: 150,
            kitchenStatus: "pending",
            createdAt: new Date().toISOString(),
            pricedOffline: false,
            offlineServerTotal: null,
            offlinePricingReason: null,
            clientSaleId: null,
            source: "staff",
            paymentStatus: "unpaid",
            gatewayTransactionId: null,
            receiptId: null,
        });

        // A simulated payment record that predates the guard — the realistic
        // case, since after the fix the server refuses to mint one at all.
        // Confirming THIS is the actual privilege the hole granted.
        harness.seedRecord(h.dbPath, COL.payments, SIMULATED_TX, {
            id: SIMULATED_TX,
            kind: "indoor",
            target: { orderId: ORDER_ID },
            amountCzk: 150,
            status: "pending",
            simulated: true,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        });
    });

    after(async () => {
        await h.stop();
    });

    test("pay-online refuses instead of handing back a fake transaction", async () => {
        const res = await fetch(`${h.api}/indoor-orders/${ORDER_ID}/pay-online`, {
            method: "POST",
            headers: { "content-type": "application/json", ...PROXY_HEADERS },
            body: JSON.stringify({}),
            redirect: "manual",
        });

        assert.strictEqual(res.status, 503, `expected 503, got ${res.status}`);
        const body = await res.json();
        assert.match(body.error, /Online platby/i);
        // No transaction id may leak out — handing one back is precisely what
        // let a guest drive the webhook below.
        assert.strictEqual(body.gatewayTransactionId, undefined);
        assert.strictEqual(body.redirectUrl, undefined);
        assert.strictEqual(body.simulated, undefined);
    });

    test("the unauthenticated webhook will not mark a simulated payment paid", async () => {
        const res = await fetch(
            `${h.api}/payments/gopay/webhook?id=${encodeURIComponent(SIMULATED_TX)}`,
            { headers: PROXY_HEADERS, redirect: "manual" }
        );

        // 200 on purpose: a real gateway retries anything else, and there is
        // genuinely nothing to do. The point is what did NOT happen.
        assert.strictEqual(res.status, 200);

        const order = harness.readRecord(h.dbPath, COL.indoorOrders, ORDER_ID);
        assert.strictEqual(order.paymentStatus, "unpaid", "order was marked paid by a simulated webhook");
        assert.strictEqual(order.receiptId, null, "a receipt was issued for a payment nobody made");

        const payment = harness.readRecord(h.dbPath, COL.payments, SIMULATED_TX);
        assert.strictEqual(payment.status, "pending", "simulated payment was promoted to paid");
    });
});

// ============================================================================
// The other half of the boundary. A guard that also broke local development
// would just get reverted the first time someone tried to work on payments
// without a GoPay account, so the dev fallback has to keep working exactly as
// it did — which is what makes "unavailable" a production-only outcome rather
// than a removal of the feature.
// ============================================================================

describe("development still simulates payments end to end", () => {
    let h;
    const ORDER_ID = "devOrder0001";

    before(async () => {
        // No NODE_ENV override — the harness runs "test", i.e. not production.
        h = await harness.start();

        harness.seedRecord(h.dbPath, COL.indoorOrders, ORDER_ID, {
            id: ORDER_ID,
            tableName: "Stůl D",
            guestName: "",
            items: [{ id: "dish1", item: "Svíčková", name: "Svíčková", qty: 1, price: 150, vatRate: 21 }],
            total: 150,
            kitchenStatus: "pending",
            createdAt: new Date().toISOString(),
            pricedOffline: false,
            offlineServerTotal: null,
            offlinePricingReason: null,
            clientSaleId: null,
            source: "staff",
            paymentStatus: "unpaid",
            gatewayTransactionId: null,
            receiptId: null,
        });
    });

    after(async () => {
        await h.stop();
    });

    test("pay-online mints a simulated transaction and the webhook confirms it", async () => {
        const start = await fetch(`${h.api}/indoor-orders/${ORDER_ID}/pay-online`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({}),
        });
        if (start.status !== 200) {
            assert.fail(`expected 200, got ${start.status}: ${await start.text()}`);
        }
        const started = await start.json();
        assert.strictEqual(started.simulated, true);
        assert.match(started.gatewayTransactionId, /^SIMULATED-/);

        const hook = await fetch(
            `${h.api}/payments/gopay/webhook?id=${encodeURIComponent(started.gatewayTransactionId)}`
        );
        assert.strictEqual(hook.status, 200);

        const order = harness.readRecord(h.dbPath, COL.indoorOrders, ORDER_ID);
        assert.strictEqual(order.paymentStatus, "paid");
        assert.ok(order.receiptId, "a simulated confirmation should still issue a receipt in dev");
    });
});
