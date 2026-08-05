// ============================================================================
// db-patch.test.js — db.patch() applies changes to what is STORED, not to a
// snapshot the caller read earlier.
//
// The bug this exists for: the pay-online routes read an order, then await a
// GoPay call (a real network round trip, ~1s), then write the order back. By
// the time that write lands, the in-memory copy is a second old — and a
// second is a long time on a kitchen board. If the cook tapped "hotovo" in
// that window, the write put kitchenStatus back to "pending" and the ticket
// reappeared, with nothing in any log to explain it.
//
// Everything else in this app is safe from this by construction:
// better-sqlite3 is synchronous and Node is single-threaded, so a read and a
// write with no `await` between them cannot interleave with another request.
// It is only the gateway calls that span one.
// ============================================================================

const test = require("node:test");
const assert = require("node:assert");
const os = require("os");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

// db.js resolves DB_PATH at require time, so this has to be set first.
const TMP_DB = path.join(os.tmpdir(), `db-patch-${process.pid}-${crypto.randomBytes(6).toString("hex")}.db`);
process.env.SQLITE_PATH = TMP_DB;

const db = require("../../src/server/db");

test.after(() => {
    try { db.getDb().close(); } catch { /* already closed */ }
    for (const suffix of ["", "-wal", "-shm"]) {
        try { fs.unlinkSync(TMP_DB + suffix); } catch { /* never existed */ }
    }
});

const COL = "patch_test_orders";

function seedOrder(id) {
    db.set(COL, id, {
        id,
        kitchenStatus: "pending",
        paymentStatus: "unpaid",
        gatewayTransactionId: null,
        total: 150,
    });
}

// THE ONE THAT MATTERS — the concurrent kitchen update, reproduced exactly:
// read a snapshot (the pre-await read), let another request change a
// different field (the cook tapping "hotovo"), then write the payment fields.
test("a concurrent change survives a patch that lands after it", () => {
    seedOrder("o1");

    const stale = db.get(COL, "o1");            // what pay-online read before its await
    db.patch(COL, "o1", { kitchenStatus: "completed" }); // the cook, mid-await

    const merged = db.patch(COL, "o1", {        // pay-online writing back
        gatewayTransactionId: "GP-123",
        paymentMethod: "online_card",
    });

    assert.strictEqual(merged.kitchenStatus, "completed", "the cook's update was clobbered");
    assert.strictEqual(merged.gatewayTransactionId, "GP-123");
    assert.strictEqual(merged.paymentMethod, "online_card");

    // And it is actually persisted, not just returned.
    const stored = db.get(COL, "o1");
    assert.strictEqual(stored.kitchenStatus, "completed");
    assert.strictEqual(stored.gatewayTransactionId, "GP-123");

    // The snapshot really was stale — this is what made the old code wrong.
    assert.strictEqual(stale.kitchenStatus, "pending");
});

test("fields the patch does not mention are left alone", () => {
    seedOrder("o2");
    const merged = db.patch(COL, "o2", { paymentStatus: "paid" });
    assert.strictEqual(merged.paymentStatus, "paid");
    assert.strictEqual(merged.total, 150);
    assert.strictEqual(merged.id, "o2");
});

// A record deleted while the gateway call was in flight must not be resurrected
// as a fragment consisting only of the payment fields.
test("patching a record that no longer exists returns null and creates nothing", () => {
    assert.strictEqual(db.patch(COL, "never-existed", { paymentStatus: "paid" }), null);
    assert.strictEqual(db.get(COL, "never-existed"), null);

    seedOrder("o3");
    db.remove(COL, "o3");
    assert.strictEqual(db.patch(COL, "o3", { paymentStatus: "paid" }), null);
    assert.strictEqual(db.get(COL, "o3"), null);
});
