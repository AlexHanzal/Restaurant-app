const test = require("node:test");
const assert = require("node:assert");
const idem = require("../../src/server/idempotency");

// Minimal in-memory stand-in for db.js's get/set/list/remove/insertIfAbsent/
// compareAndSwap contract — same shape the eet-queue tests use, extended for
// the reserve-before-act primitives idempotency.js now needs (finding L1).
function fakeDb() {
    const store = new Map();
    return {
        get: (c, id) => store.get(`${c}:${id}`) || null,
        set: (c, id, v) => { store.set(`${c}:${id}`, v); return v; },
        list: c => [...store.entries()].filter(([k]) => k.startsWith(`${c}:`)).map(([, v]) => v),
        remove: (c, id) => store.delete(`${c}:${id}`),
        // Mirrors db.js's INSERT ... ON CONFLICT DO NOTHING: creates the row
        // only if absent, reports whether THIS call created it.
        insertIfAbsent(c, id, v) {
            const k = `${c}:${id}`;
            if (store.has(k)) return false;
            store.set(k, v);
            return true;
        },
        // Mirrors db.js's UPDATE ... WHERE data = ?: swaps only if the
        // current value is still byte-identical (by JSON serialisation, the
        // same comparison the real UPDATE does) to `expected`.
        compareAndSwap(c, id, expected, next) {
            const k = `${c}:${id}`;
            if (!store.has(k)) return false;
            if (JSON.stringify(store.get(k)) !== JSON.stringify(expected)) return false;
            store.set(k, next);
            return true;
        },
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

// The key is reserved BEFORE the handler runs (that's the whole fix), so a
// throw can no longer leave "nothing" behind — it leaves the reservation,
// unresolved. That is deliberate: releasing it needs a response, which a
// throw does not produce. See idempotency.js's header, scenario 4.
test("a handler that throws leaves the key reserved, not answered, and blocks an immediate retry", () => {
    const db = fakeDb();
    assert.throws(() => run(db, "sale-0004-abcd", () => { throw new Error("handler blew up"); }));

    const stored = db.get(COL, "sale-0004-abcd");
    assert.ok(stored, "the reservation must survive the throw");
    assert.strictEqual(stored.status, null, "not a stored response — just a claim");

    // For all this module can tell, the first attempt might still be
    // unwinding through Express's error handler on its way to a real
    // response. Re-running here would be the exact double execution the
    // finding is about, so this must be blocked, not retried immediately.
    const second = run(db, "sale-0004-abcd", () => { throw new Error("must not run twice"); });
    assert.strictEqual(second.handlerRan, false);
    assert.strictEqual(second.res.statusCode, 429);
});

// Mirrors what actually happens in production: Express 5 auto-catches a
// thrown/rejected route handler and hands it to server.js's single
// error-handling middleware (setupErrorHandlers), which still answers via
// res.status(500).json(...) on the SAME res object idempotency.js wrapped.
// That wrapped res.json is what actually resolves the reservation — this
// test drives it by hand since the unit harness has no Express to do it.
test("the app's global error handler resolves a thrown handler's reservation like any other non-2xx", () => {
    const db = fakeDb();
    const req = fakeReq("sale-0006-abcd");
    const res = fakeRes();

    assert.throws(() => {
        idem.middleware({ db, col: COL })(req, res, () => { throw new Error("boom"); });
    });

    // server.js's error middleware: console.error(...) then res.status(500).json(...).
    res.status(500).json({ error: "Na serveru došlo k neočekávané chybě" });

    assert.strictEqual(db.get(COL, "sale-0006-abcd"), null, "released, not permanently poisoned");

    const retry = run(db, "sale-0006-abcd", r => r.json({ success: true, order: { id: "AAA" } }));
    assert.strictEqual(retry.handlerRan, true, "a genuine retry after the crash must be a fresh attempt");
});

// THE concurrency test (Step 6 requires this to fail against the old
// check-then-act code). Constructed deliberately: the first request reserves
// the key and is left mid-flight (its handler ran but never answered) before
// the second, duplicate request arrives.
test("a concurrent duplicate is blocked, not re-executed, while the first attempt is still in flight", () => {
    const db = fakeDb();
    const key = "sale-0007-abcd";

    const req1 = fakeReq(key);
    const res1 = fakeRes();
    let firstHandlerCalls = 0;
    idem.middleware({ db, col: COL })(req1, res1, () => { firstHandlerCalls++; });
    assert.strictEqual(firstHandlerCalls, 1, "the first request should execute");
    assert.strictEqual(res1.sent, null, "the first attempt has not answered yet — this IS the race window");

    // A second, genuinely concurrent request for the same key arrives before
    // the first has produced any response at all.
    const req2 = fakeReq(key);
    const res2 = fakeRes();
    let secondHandlerCalls = 0;
    idem.middleware({ db, col: COL })(req2, res2, () => { secondHandlerCalls++; });

    assert.strictEqual(secondHandlerCalls, 0, "the duplicate must NOT execute a second time");
    assert.strictEqual(res2.statusCode, 429);

    // The first attempt now finishes for real.
    res1.json({ success: true, order: { id: "AAA" } });
    assert.strictEqual(db.get(COL, key).status, 200);

    // A third request, arriving after the first genuinely completed, must
    // replay rather than execute — proving the 429 above meant "try again",
    // not "give up", and that exactly one execution ever produced an order.
    const third = run(db, key, () => { throw new Error("must not run — this must be a replay"); });
    assert.strictEqual(third.handlerRan, false);
    assert.strictEqual(third.res.sent.order.id, "AAA");
});

test("a reservation still within its lease is treated as in-flight, not abandoned", () => {
    const db = fakeDb();
    const key = "sale-0009-abcd";
    db.set(COL, key, { key, status: null, body: null, at: new Date().toISOString() });

    const { res, handlerRan } = run(db, key, () => { throw new Error("must not run"); });
    assert.strictEqual(handlerRan, false);
    assert.strictEqual(res.statusCode, 429);
});

// The other half of requirement (a): a reservation can never be a life
// sentence for a key. A process that reserved a key and then genuinely died
// (no throw, no response, nothing — a hard crash) leaves exactly this shape
// behind, and the ONLY way back is a lease that eventually expires.
test("an abandoned reservation past its lease is reclaimed by the next attempt (crash recovery)", () => {
    const db = fakeDb();
    const key = "sale-0008-abcd";
    db.set(COL, key, {
        key, status: null, body: null,
        at: new Date(Date.now() - idem.RESERVATION_LEASE_MS - 1000).toISOString(),
    });

    const { res, handlerRan } = run(db, key, r => r.json({ success: true, order: { id: "AAA" } }));
    assert.strictEqual(handlerRan, true, "a reservation whose owner is provably gone must not poison the key forever");
    assert.strictEqual(res.sent.order.id, "AAA");
    assert.strictEqual(db.get(COL, key).status, 200);
});

// Same policy prune() already applies to completed records: a corrupt
// timestamp is treated as "not young", never as immortal.
test("a pending reservation with a corrupt timestamp is treated as abandoned, same policy as prune", () => {
    const db = fakeDb();
    const key = "sale-0010-abcd";
    db.set(COL, key, { key, status: null, body: null, at: "not a date" });

    const { handlerRan } = run(db, key, r => r.json({ success: true }));
    assert.strictEqual(handlerRan, true);
});

test("a release failure on a non-2xx response still lets that response through", () => {
    const db = fakeDb();
    db.remove = () => { throw new Error("disk full"); };
    // Mirrors the existing "store failure" test but for the release path:
    // failing to release must never turn a real (if unsuccessful) response
    // into something worse.
    const { res, handlerRan } = run(db, "sale-0011-abcd", r => r.status(400).json({ error: "Neplatná data" }));
    assert.strictEqual(handlerRan, true);
    assert.deepStrictEqual(res.sent, { error: "Neplatná data" });
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
