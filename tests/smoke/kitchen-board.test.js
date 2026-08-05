// ============================================================================
// kitchen-board.test.js — GET /api/kitchen/orders retires finished tickets
// without ever hiding outstanding work.
//
// tests/unit/kitchen-board.test.js covers the rule itself. This covers the
// WIRING, which is the part that can silently go wrong: the route builds its
// `indoor` array field-by-field in a loop and its `delivery` array separately,
// so filtering one and forgetting the other, or filtering the wrong list, is
// an easy mistake that no unit test of a pure function would catch.
// ============================================================================

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert");
const bcrypt = require("bcryptjs");

const harness = require("../helpers/harness");

const COL = harness.COL;

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

function agoIso(ms) {
    return new Date(Date.now() - ms).toISOString();
}

function indoorOrder(id, createdAt, kitchenStatus) {
    return {
        id,
        tableName: "Stůl K",
        guestName: "",
        items: [{ id: "dish1", item: "Svíčková", name: "Svíčková", qty: 1, price: 150, vatRate: 21 }],
        total: 150,
        kitchenStatus,
        createdAt,
        source: "staff",
        paymentStatus: "unpaid",
        gatewayTransactionId: null,
        receiptId: null,
    };
}

function deliveryOrder(id, createdAt, kitchenStatus) {
    return {
        id,
        customerName: "Zákazník",
        phone: "+420700000000",
        address: "Ulice 1",
        psc: "12000",
        items: [{ id: "dish1", name: "Svíčková", qty: 1, price: 150, vatRate: 21 }],
        itemsTotal: 150,
        deliveryFee: 0,
        total: 150,
        status: "pending",
        kitchenStatus,
        createdAt,
        paymentMethod: "cash",
        paymentStatus: "unpaid",
        gatewayTransactionId: null,
        receiptId: null,
    };
}

async function loginAsAdmin(baseUrl) {
    const res = await fetch(`${baseUrl}/reservation/api/users/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ abbreviation: "board-admin", password: "B0ardTest!Pass123" }),
    });
    if (res.status !== 200) assert.fail(`admin login failed: ${res.status} ${await res.text()}`);
    const all = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    const cookie = all.length ? all[0].split(";")[0] : (res.headers.get("set-cookie") || "").split(";")[0];
    assert.ok(cookie, "login response did not set a session cookie");
    return cookie;
}

describe("kitchen board retires finished tickets only", () => {
    let h;
    let cookie;

    before(async () => {
        h = await harness.start();

        harness.seedRecord(h.dbPath, COL.users, "boardAdmin1", {
            id: "boardAdmin1",
            abbreviation: "board-admin",
            password: bcrypt.hashSync("B0ardTest!Pass123", 12),
            name: "Board Admin",
            isAdmin: true,
            isDriver: false,
        });

        // Indoor: one of each case.
        harness.seedRecord(h.dbPath, COL.indoorOrders, "in-fresh-done", indoorOrder("in-fresh-done", agoIso(2 * HOUR), "completed"));
        harness.seedRecord(h.dbPath, COL.indoorOrders, "in-old-done", indoorOrder("in-old-done", agoIso(30 * DAY), "completed"));
        harness.seedRecord(h.dbPath, COL.indoorOrders, "in-old-pending", indoorOrder("in-old-pending", agoIso(30 * DAY), "pending"));

        // Delivery: the same three, because this list is built separately in
        // the route and filtering only one of the two is the likely slip.
        harness.seedRecord(h.dbPath, COL.orders, "del-fresh-done", deliveryOrder("del-fresh-done", agoIso(2 * HOUR), "completed"));
        harness.seedRecord(h.dbPath, COL.orders, "del-old-done", deliveryOrder("del-old-done", agoIso(30 * DAY), "completed"));
        harness.seedRecord(h.dbPath, COL.orders, "del-old-pending", deliveryOrder("del-old-pending", agoIso(30 * DAY), "pending"));

        cookie = await loginAsAdmin(h.baseUrl);
    });

    after(async () => {
        await h.stop();
    });

    test("month-old finished tickets are gone from both lists, recent ones remain", async () => {
        const res = await fetch(`${h.api}/kitchen/orders`, { headers: { cookie } });
        assert.strictEqual(res.status, 200);
        const board = await res.json();

        const indoorIds = board.indoor.map(o => o.id);
        const deliveryIds = board.delivery.map(o => o.id);

        assert.ok(indoorIds.includes("in-fresh-done"), "a 2-hour-old finished table order should still show");
        assert.ok(!indoorIds.includes("in-old-done"), "a month-old finished table order should have retired");

        assert.ok(deliveryIds.includes("del-fresh-done"), "a 2-hour-old finished delivery should still show");
        assert.ok(!deliveryIds.includes("del-old-done"), "a month-old finished delivery should have retired — is the delivery list filtered too?");
    });

    // THE ONE THAT MATTERS — age must never retire outstanding work.
    test("a month-old ticket that is still pending is never hidden", async () => {
        const res = await fetch(`${h.api}/kitchen/orders`, { headers: { cookie } });
        const board = await res.json();

        assert.ok(
            board.indoor.map(o => o.id).includes("in-old-pending"),
            "an unfinished table order dropped off the board — the kitchen would never learn about it"
        );
        assert.ok(
            board.delivery.map(o => o.id).includes("del-old-pending"),
            "an unfinished delivery order dropped off the board"
        );
    });
});
