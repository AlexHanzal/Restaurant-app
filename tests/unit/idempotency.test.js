const test = require("node:test");
const assert = require("node:assert");
const idem = require("../../src/server/idempotency");

// Minimal in-memory stand-in for db.js's get/set/list/remove contract —
// same shape the eet-queue tests use.
function fakeDb() {
    const store = new Map();
    return {
        get: (c, id) => store.get(`${c}:${id}`) || null,
        set: (c, id, v) => { store.set(`${c}:${id}`, v); return v; },
        list: c => [...store.entries()].filter(([k]) => k.startsWith(`${c}:`)).map(([, v]) => v),
        remove: (c, id) => store.delete(`${c}:${id}`),
    };
}

const COL = "idempotency";

// Minimal Express req/res stand-ins. `res` records what was sent so a test
// can assert on both the status and the exact body.
function fakeReq(key) {
    return { get: name => (name.toLowerCase() === idem.HEADER && key !== undefined ? key : undefined) };
}

function fakeRes() {
    const res = {
        statusCode: 200,
        sent: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.sent = body; return this; },
    };
    res.json = res.json.bind(res);
    res.status = res.status.bind(res);
    return res;
}

// Runs the guard, then (if it called next) the "handler".
function run(db, key, handler) {
    const req = fakeReq(key);
    const res = fakeRes();
    let handlerRan = false;
    idem.middleware({ db, col: COL })(req, res, () => {
        handlerRan = true;
        handler(res);
    });
    return { res, handlerRan };
}

test("a request with no key always executes", () => {
    const db = fakeDb();
    const a = run(db, undefined, res => res.json({ order: "first" }));
    const b = run(db, undefined, res => res.json({ order: "second" }));
    assert.strictEqual(a.handlerRan, true);
    assert.strictEqual(b.handlerRan, true);
    assert.strictEqual(b.res.sent.order, "second");
    assert.strictEqual(db.list(COL).length, 0);
});

test("first call with a key executes and stores the response", () => {
    const db = fakeDb();
    const { res, handlerRan } = run(db, "sale-0001-abcd", r => r.json({ success: true, order: { id: "AAA" } }));
    assert.strictEqual(handlerRan, true);
    assert.deepStrictEqual(res.sent, { success: true, order: { id: "AAA" } });

    const stored = db.get(COL, "sale-0001-abcd");
    assert.strictEqual(stored.status, 200);
    assert.strictEqual(stored.body.order.id, "AAA");
});

test("replay returns the stored response and never runs the handler", () => {
    const db = fakeDb();
    run(db, "sale-0001-abcd", r => r.json({ success: true, order: { id: "AAA" } }));

    // The retry would have minted a different order id — proving the
    // handler is skipped rather than merely producing the same answer.
    const second = run(db, "sale-0001-abcd", r => r.json({ success: true, order: { id: "BBB" } }));

    assert.strictEqual(second.handlerRan, false, "handler must not run on replay");
    assert.strictEqual(second.res.sent.order.id, "AAA");
    assert.strictEqual(second.res.statusCode, 200);
});

test("distinct keys stay independent", () => {
    const db = fakeDb();
    run(db, "sale-0001-abcd", r => r.json({ order: { id: "AAA" } }));
    const other = run(db, "sale-0002-abcd", r => r.json({ order: { id: "BBB" } }));
    assert.strictEqual(other.handlerRan, true);
    assert.strictEqual(other.res.sent.order.id, "BBB");
    assert.strictEqual(db.list(COL).length, 2);
});

test("a non-2xx response is NOT stored — a transient failure must stay retryable", () => {
    const db = fakeDb();
    const first = run(db, "sale-0003-abcd", r => r.status(500).json({ error: "boom" }));
    assert.strictEqual(first.handlerRan, true);
    assert.strictEqual(db.get(COL, "sale-0003-abcd"), null);

    // The retry must reach the handler and be able to succeed.
    const second = run(db, "sale-0003-abcd", r => r.json({ success: true, order: { id: "AAA" } }));
    assert.strictEqual(second.handlerRan, true);
    assert.strictEqual(second.res.sent.order.id, "AAA");
});

test("a handler that throws stores nothing", () => {
    const db = fakeDb();
    assert.throws(() => run(db, "sale-0004-abcd", () => { throw new Error("handler blew up"); }));
    assert.strictEqual(db.get(COL, "sale-0004-abcd"), null);
});

test("a store failure still lets the response through", () => {
    const db = fakeDb();
    db.set = () => { throw new Error("disk full"); };
    // The sale is already committed by this point — turning that into a 500
    // the client retries anyway would be strictly worse than a missed key.
    const { res, handlerRan } = run(db, "sale-0005-abcd", r => r.json({ success: true }));
    assert.strictEqual(handlerRan, true);
    assert.deepStrictEqual(res.sent, { success: true });
});

test("malformed keys are rejected without running the handler", () => {
    const db = fakeDb();
    for (const bad of ["short", "x".repeat(129), "has spaces", "has/slash", "emoji-\u{1F37A}"]) {
        const { res, handlerRan } = run(db, bad, r => r.json({ success: true }));
        assert.strictEqual(handlerRan, false, `key ${JSON.stringify(bad)} should be rejected`);
        assert.strictEqual(res.statusCode, 400);
    }
    assert.strictEqual(db.list(COL).length, 0);
});

test("the real key shapes the drain uses are accepted", () => {
    assert.strictEqual(idem.isValidKey("6f1c9a2e-4b7d-4e21-9f3a-0c2d5e8b1a44"), true);
    assert.strictEqual(idem.isValidKey("6f1c9a2e-4b7d-4e21-9f3a-0c2d5e8b1a44:paid"), true);
});

test("prune drops entries past the cutoff and keeps the rest", () => {
    const db = fakeDb();
    const daysAgo = n => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
    db.set(COL, "old-key-0001", { key: "old-key-0001", status: 200, body: {}, at: daysAgo(40) });
    db.set(COL, "new-key-0001", { key: "new-key-0001", status: 200, body: {}, at: daysAgo(2) });
    db.set(COL, "bad-key-0001", { key: "bad-key-0001", status: 200, body: {}, at: "not a date" });

    const removed = idem.prune(db, COL, 30);
    assert.strictEqual(removed, 2);
    assert.strictEqual(db.get(COL, "new-key-0001").key, "new-key-0001");
    assert.strictEqual(db.get(COL, "old-key-0001"), null);
    assert.strictEqual(db.get(COL, "bad-key-0001"), null, "corrupt timestamps must not survive forever");
});
