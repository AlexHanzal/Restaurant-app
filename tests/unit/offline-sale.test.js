const test = require("node:test");
const assert = require("node:assert");
const offline = require("../../src/server/offline-sale");

const LIMITS = { maxItems: 50, maxQty: 50 };
const NOW = Date.parse("2026-08-02T21:00:00.000Z");
const minutesAgo = n => new Date(NOW - n * 60 * 1000).toISOString();
const hoursAgo = n => new Date(NOW - n * 60 * 60 * 1000).toISOString();

// ── resolvePaidAt (spec §4.2) ───────────────────────────────────────────

test("no paidAt behaves exactly as before — server clock, full ISO with ms", () => {
    const r = offline.resolvePaidAt(undefined, NOW);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.issuedAt, "2026-08-02T21:00:00.000Z");
    // createReceiptForOrder's contract, and what eet-queue.js's
    // millisecond-strip regex expects to be handed.
    assert.match(r.issuedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
});

test("a real offline sale from earlier this evening is accepted", () => {
    const r = offline.resolvePaidAt(minutesAgo(215), NOW);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.issuedAt, "2026-08-02T17:25:00.000Z");
});

test("a non-UTC offset is preserved as the same instant", () => {
    const r = offline.resolvePaidAt("2026-08-02T19:40:00+02:00", NOW);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.issuedAt, "2026-08-02T17:40:00.000Z");
});

test("small clock drift into the future is tolerated", () => {
    const r = offline.resolvePaidAt(new Date(NOW + 60 * 1000).toISOString(), NOW);
    assert.strictEqual(r.ok, true);
});

test("a timestamp meaningfully in the future is rejected", () => {
    const r = offline.resolvePaidAt(new Date(NOW + 10 * 60 * 1000).toISOString(), NOW);
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /budoucnosti/);
});

test("older than 72 hours is rejected — that is a bug, not a late sync", () => {
    assert.strictEqual(offline.resolvePaidAt(hoursAgo(71), NOW).ok, true);
    const tooOld = offline.resolvePaidAt(hoursAgo(73), NOW);
    assert.strictEqual(tooOld.ok, false);
    assert.match(tooOld.error, /72 hodin/);
});

test("garbage is rejected rather than coerced", () => {
    for (const bad of ["yesterday", "", 1754168400000, {}, "2026-13-45T99:99:99Z"]) {
        // "" is the one exception — absent and empty both mean "use now".
        const r = offline.resolvePaidAt(bad, NOW);
        if (bad === "") assert.strictEqual(r.ok, true);
        else assert.strictEqual(r.ok, false, `${JSON.stringify(bad)} should be rejected`);
    }
});

test("a New Year's Eve sale keeps its own year", () => {
    const nye = Date.parse("2027-01-01T10:00:00.000Z");
    const r = offline.resolvePaidAt("2026-12-31T23:50:00.000Z", nye);
    assert.strictEqual(r.ok, true);
    // This is the value nextReceiptNumber() receives, and it must draw from
    // the 2026 counter rather than opening 2027 with someone else's sale.
    assert.strictEqual(new Date(r.issuedAt).getUTCFullYear(), 2026);
});

// ── validateClientPricing (spec §4.3 guards) ────────────────────────────

const CART = [
    { id: "pilsner", name: "Pilsner Urquell 0,5", qty: 3, price: 55, vatRate: 21 },
    { id: "kofola", name: "Kofola 0,3", qty: 1, price: 35, vatRate: 21 },
];

test("a well-formed snapshot passes and reports its own total", () => {
    const r = offline.validateClientPricing(CART, 200, LIMITS);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.total, 200);
    assert.strictEqual(r.items.length, 2);
});

test("a total that disagrees with the lines is rejected, not rewritten", () => {
    const r = offline.validateClientPricing(CART, 20, LIMITS);
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /nesouhlasí/);
});

test("float arithmetic alone never causes a mismatch", () => {
    const cart = [
        { id: "a", qty: 1, price: 0.1 },
        { id: "b", qty: 1, price: 0.2 },
    ];
    assert.strictEqual(offline.validateClientPricing(cart, 0.3, LIMITS).ok, true);
});

test("bad quantities are rejected", () => {
    for (const qty of [0, -1, 2.5, 51, "3", NaN]) {
        const r = offline.validateClientPricing([{ id: "a", qty, price: 10 }], 10, LIMITS);
        assert.strictEqual(r.ok, false, `qty ${qty} should be rejected`);
    }
});

test("bad prices are rejected", () => {
    for (const price of [-1, Infinity, NaN, "free"]) {
        const r = offline.validateClientPricing([{ id: "a", qty: 1, price }], 0, LIMITS);
        assert.strictEqual(r.ok, false, `price ${price} should be rejected`);
    }
});

test("a zero-price line is allowed — a comped drink is still a line", () => {
    const r = offline.validateClientPricing([{ id: "a", qty: 1, price: 0 }], 0, LIMITS);
    assert.strictEqual(r.ok, true);
});

test("empty and oversized carts are rejected", () => {
    assert.strictEqual(offline.validateClientPricing([], 0, LIMITS).ok, false);
    const huge = Array.from({ length: 51 }, () => ({ id: "a", qty: 1, price: 1 }));
    assert.strictEqual(offline.validateClientPricing(huge, 51, LIMITS).ok, false);
});

// ── resolvePricing (spec §4.3) ─────────────────────────────────────────

const CLIENT = { items: [{ id: "pilsner", name: "Pilsner", qty: 2, price: 55 }], total: 110 };

test("agreement uses the server's own resolved lines", () => {
    const live = { items: [{ id: "pilsner", name: "Pilsner Urquell 0,5", qty: 2, price: 55, vatRate: 21 }], total: 110 };
    const r = offline.resolvePricing({ live, client: CLIENT });
    assert.strictEqual(r.pricedOffline, false);
    assert.strictEqual(r.total, 110);
    // Server metadata wins when nothing drifted — the name and vatRate here
    // feed the receipt and its DPH breakdown.
    assert.strictEqual(r.items[0].name, "Pilsner Urquell 0,5");
    assert.strictEqual(r.items[0].vatRate, 21);
});

test("price drift keeps what the guest paid and flags it", () => {
    const live = { items: [{ id: "pilsner", name: "Pilsner Urquell 0,5", qty: 2, price: 60, vatRate: 21 }], total: 120 };
    const r = offline.resolvePricing({ live, client: CLIENT });
    assert.strictEqual(r.pricedOffline, true);
    assert.strictEqual(r.total, 110, "the guest paid 110, so the receipt and EET must say 110");
    assert.strictEqual(r.serverTotal, 120, "but the drift is recorded for ops");
    assert.strictEqual(r.items[0].price, 55);
    assert.strictEqual(r.items[0].vatRate, 21, "server-resolved VAT rate survives the overwrite");
    assert.strictEqual(r.reason, "price drift");
});

test("a sale is accepted even when live pricing rejects it outright", () => {
    // The invariant: sync must never permanently reject a sale that has
    // already been paid for. An item going soldOut after the sale must not
    // strand real money.
    const live = { error: 'Položka "Pilsner Urquell 0,5" je vyprodaná.' };
    const r = offline.resolvePricing({ live, client: CLIENT });
    assert.strictEqual(r.pricedOffline, true);
    assert.strictEqual(r.total, 110);
    assert.strictEqual(r.serverTotal, null);
    assert.match(r.reason, /vyprodaná/);
});

test("a changed item shape falls back to the snapshot wholesale", () => {
    const live = { items: [], total: 0 };
    const r = offline.resolvePricing({ live, client: CLIENT });
    assert.strictEqual(r.pricedOffline, true);
    assert.strictEqual(r.total, 110);
    assert.strictEqual(r.reason, "item shape changed");
});

test("a quantity change also counts as drift", () => {
    const live = { items: [{ id: "pilsner", name: "Pilsner", qty: 3, price: 55 }], total: 165 };
    const r = offline.resolvePricing({ live, client: CLIENT });
    assert.strictEqual(r.pricedOffline, true);
    assert.strictEqual(r.total, 110);
});
