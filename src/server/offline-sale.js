// ============================================================================
// offline-sale.js — the two rules that make a sale taken with no network
// safe to accept later.
//
// Zero dependencies and completely pure, same convention as settings.js /
// csrf.js / reorder.js: every limit arrives as an argument, nothing is read
// from server.js, nothing touches the database. That is what keeps these
// two decisions — both of which have tax consequences — testable with
// `node --test` and no server at all.
//
// See docs/superpowers/specs/2026-08-02-offline-first-pos-design.md §4.2/§4.3.
// ============================================================================

// A tablet's clock is not the server's. A couple of minutes of drift is
// normal and must not reject a real sale; a timestamp meaningfully in the
// future is a broken clock, and reporting a tržba that has not happened yet
// is worse than refusing it.
const FUTURE_SKEW_MS = 2 * 60 * 1000;

// Past this, "late sync" stops being a plausible explanation. A tablet left
// in a drawer over a long weekend still fits; anything older is a bug, and
// a bug deserves a human rather than a confident wrong tax report.
const MAX_AGE_MS = 72 * 60 * 60 * 1000;

// Money comparisons are done in whole haléře. 0.1 + 0.2 !== 0.3 in float,
// and "the client's total disagrees with the server's" must never be true
// merely because of that.
function toHaler(value) {
    return Math.round(Number(value) * 100);
}

function round2(value) {
    return Math.round(Number(value) * 100) / 100;
}

// ── §4.2 — when did the money actually change hands? ────────────────────
//
// Returns { ok: true, issuedAt } with a full ISO string (milliseconds
// included — createReceiptForOrder's contract), or { ok: false, error }
// with a Czech message suitable for returning to the client.
//
// Normalising to UTC "Z" here is deliberate and safe: it preserves the
// instant, and it hands eet-queue.js exactly the shape its millisecond-strip
// regex expects. The warning in that file's header — never round-trip a
// caller's timestamp through Date — is about not rewriting a string someone
// else authored. This function IS the author.
function resolvePaidAt(raw, now = Date.now()) {
    if (raw === undefined || raw === null || raw === "") {
        return { ok: true, issuedAt: new Date(now).toISOString() };
    }
    if (typeof raw !== "string") {
        return { ok: false, error: "Neplatný čas platby" };
    }

    const parsed = Date.parse(raw);
    if (!Number.isFinite(parsed)) {
        return { ok: false, error: "Neplatný čas platby" };
    }
    if (parsed > now + FUTURE_SKEW_MS) {
        return { ok: false, error: "Čas platby je v budoucnosti" };
    }
    if (parsed < now - MAX_AGE_MS) {
        return { ok: false, error: "Čas platby je starší než 72 hodin — zpracujte ručně" };
    }

    return { ok: true, issuedAt: new Date(parsed).toISOString() };
}

// ── §4.3 — whose prices win? ───────────────────────────────────────────
//
// Validates the snapshot a tablet priced its sale against. This path trusts
// client numbers, so the numbers themselves are checked even though the
// caller is already an authenticated staff member.
//
// Returns { ok: true, items, total } or { ok: false, error }.
function validateClientPricing(rawItems, rawTotal, { maxItems, maxQty }) {
    if (!Array.isArray(rawItems) || rawItems.length === 0) {
        return { ok: false, error: "Košík je prázdný" };
    }
    if (rawItems.length > maxItems) {
        return { ok: false, error: "Příliš mnoho položek v objednávce" };
    }

    const items = [];
    let sumHaler = 0;

    for (const raw of rawItems) {
        if (!raw || typeof raw !== "object") {
            return { ok: false, error: "Neplatná položka objednávky" };
        }

        const qty = Number(raw.qty);
        if (!Number.isInteger(qty) || qty <= 0 || qty > maxQty) {
            return { ok: false, error: `Neplatné množství u položky (1–${maxQty} ks)` };
        }

        const price = Number(raw.price);
        if (!Number.isFinite(price) || price < 0) {
            return { ok: false, error: "Neplatná cena položky" };
        }

        sumHaler += toHaler(price) * qty;
        items.push({ ...raw, qty, price: round2(price) });
    }

    // The total is not merely recomputed from the lines — it is REQUIRED to
    // agree with them. A client that sends lines summing to 240 and a total
    // of 24 is broken or lying, and either way the sale should not be
    // silently rewritten to one of the two numbers.
    const totalHaler = toHaler(rawTotal);
    if (!Number.isFinite(Number(rawTotal)) || totalHaler !== sumHaler) {
        return { ok: false, error: "Součet položek nesouhlasí s celkovou částkou" };
    }

    return { ok: true, items, total: round2(sumHaler / 100) };
}

// Decides what the order is actually priced at, given the live server
// pricing (which may have failed outright) and the validated client
// snapshot.
//
// Returns { items, total, pricedOffline, serverTotal, reason }.
//
// The invariant this function exists to protect, stated plainly:
//
//   SYNC MUST NEVER BE ABLE TO PERMANENTLY REJECT A SALE THAT HAS ALREADY
//   BEEN PAID FOR.
//
// priceOrderItems enforces *availability* — soldOut dishes, sold-out
// combos, the daily-menu serving window. Those gates are right for a live
// order and catastrophic for a replayed one: applied to a beer sold at
// 19:40 and synced at 23:15, they reject the request forever. The tablet
// retries, the gate fails again, and a sale that took real cash can never
// be reported. Money changed hands; the receipt and the EET total have to
// record what happened, not what the menu says now.
function resolvePricing({ live, client }) {
    // Live pricing failed — an item went sold out, the daily-menu window
    // closed, a combo was withdrawn. The snapshot is the only remaining
    // record of the transaction, so it stands.
    if (!live || live.error) {
        return {
            items: client.items,
            total: client.total,
            pricedOffline: true,
            serverTotal: null,
            reason: live && live.error ? `live pricing rejected: ${live.error}` : "no live pricing",
        };
    }

    const liveItems = Array.isArray(live.items) ? live.items : [];
    const sameShape = liveItems.length === client.items.length;
    const agrees = sameShape && liveItems.every((liveItem, i) => {
        const clientItem = client.items[i];
        return toHaler(liveItem.price) === toHaler(clientItem.price)
            && Number(liveItem.qty) === Number(clientItem.qty);
    });

    if (agrees) {
        // Nothing drifted. Take the server's own resolved lines — same
        // prices, but with the names and VAT rates it looked up itself.
        return {
            items: liveItems,
            total: round2(live.total),
            pricedOffline: false,
            serverTotal: round2(live.total),
            reason: null,
        };
    }

    // Prices drifted between the sale and the sync. Keep the server's
    // resolved metadata — `name` and `vatRate` drive the receipt and its
    // DPH breakdown, and the client's cached copy of those may be stale in
    // ways that matter more than the price does — but overwrite the money
    // with what the guest actually paid. priceOrderItems maps 1:1 over its
    // input, so index alignment holds whenever the shapes match.
    const items = sameShape
        ? liveItems.map((liveItem, i) => ({ ...liveItem, price: client.items[i].price, qty: client.items[i].qty }))
        : client.items;

    return {
        items,
        total: client.total,
        pricedOffline: true,
        serverTotal: round2(live.total),
        reason: sameShape ? "price drift" : "item shape changed",
    };
}

module.exports = {
    resolvePaidAt,
    validateClientPricing,
    resolvePricing,
    FUTURE_SKEW_MS,
    MAX_AGE_MS,
};
