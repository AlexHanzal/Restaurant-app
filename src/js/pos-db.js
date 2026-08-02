// ============================================================================
// pos-db.js — the till's local database and the sale state machine.
//
// Offline-first POS, spec docs/superpowers/specs/2026-08-02-offline-first-
// pos-design.md §3.1. Every table order and every payment is written HERE
// first, always, network or not. pos-sync.js drains it to the server later.
//
// ── Why this is not Dexie ───────────────────────────────────────────────
//
// The original brief asked for Dexie.js. Three things pointed the other
// way and none of them is about Dexie being bad:
//
//   1. This project has zero frontend dependencies, no bundler and no build
//      step — the convention eet.js and gopay.js state explicitly.
//   2. CSP is `script-src 'self'`, so a CDN copy would be blocked outright;
//      using Dexie means committing a vendored third-party file.
//   3. The whole surface needed here is one table with a status field.
//
// The public API below is deliberately Dexie-shaped (`table.put`, `.get`,
// `.where`) so swapping the real thing in later is a drop-in rather than a
// rewrite.
//
// ── Why the pure parts are separated ────────────────────────────────────
//
// The state machine and the backoff schedule decide when real money gets
// re-sent. They are plain functions over plain objects, exported for
// `node --test`, because a rule that governs money should be testable
// without a browser.
// ============================================================================

(function (root, factory) {
    const api = factory();
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root) root.POSDB = api;
}(typeof self !== "undefined" ? self : null, function () {
    "use strict";

    const DB_NAME = "pos";
    const DB_VERSION = 1;

    const STORE_SALES = "sales";
    const STORE_MENU = "menuCache";
    const STORE_SERVER_ORDERS = "serverOrders";
    const STORE_META = "meta";

    // Sale states. `failed` is terminal on purpose — see advanceSale.
    //
    // Note these describe the SALE, not its position in a queue. What the
    // sync worker needs next is derived from two independent facts — does
    // the server have this order, and has the money been taken — which is
    // why pendingStep() reads both rather than switching on the state.
    // An earlier draft made the states linear (open → paid → created) and
    // it had a hole big enough to lose a shift's kitchen tickets through:
    // an order submitted offline but not yet paid had no step at all, so
    // it would sit on the tablet forever and the kitchen would never see
    // it, even after the Wi-Fi came back.
    const STATE = {
        QUEUED: "queued",   // submitted by the barman, server does not have it
        CREATED: "created", // order exists server-side, tab still open
        PAID: "paid",       // money taken; may or may not have reached the server yet
        SYNCED: "synced",   // fully reported; receipt id and number known
        FAILED: "failed",   // needs a human, never retried automatically
    };

    const BACKOFF_BASE_MS = 1000;
    const BACKOFF_CAP_MS = 5 * 60 * 1000;

    // Synced sales are kept as a local audit trail, then pruned. Nothing in
    // any other state is EVER deleted automatically — an unsent sale is
    // money that has not been reported, and no cleanup routine gets to make
    // that disappear.
    const SYNCED_RETENTION_DAYS = 30;

    // ── Pure: backoff ───────────────────────────────────────────────────
    //
    // 1s, 2s, 4s ... capped at 5 minutes. The cap matters more than the
    // curve: a bar's Wi-Fi comes back in seconds or in hours, and a tablet
    // hammering a dead access point every second for an hour just burns
    // battery. Persisted as an absolute `nextAttemptAt` so a page reload
    // cannot reset a sale's backoff to zero and start the hammering again.
    function nextBackoffMs(attempts) {
        const n = Math.max(0, Number(attempts) || 0);
        return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * Math.pow(2, n));
    }

    // ── Pure: state machine ─────────────────────────────────────────────
    //
    // One row per sale advancing through two sync steps, rather than two
    // independent queue entries. Two entries would need an ordering
    // guarantee between them, and "the payment synced before its own order"
    // is a bug with no clean recovery.
    //
    // Returns a NEW sale object; never mutates its input.
    function advanceSale(sale, event, payload) {
        const next = Object.assign({}, sale);
        const data = payload || {};

        switch (event) {
            case "pay":
                // The barman closed the tab. This timestamp is the one that
                // eventually becomes dat_trzby — it is when the money
                // actually changed hands, not when the server hears about it.
                next.state = STATE.PAID;
                next.paidAt = data.paidAt || new Date().toISOString();
                next.paymentMethod = data.paymentMethod || next.paymentMethod || "cash";
                next.attempts = 0;
                next.nextAttemptAt = 0;
                next.lastError = null;
                break;

            case "created":
                // Only the ORDER reached the server. Whether the tab is
                // already paid is a separate fact, and stamping CREATED
                // over PAID here would lose it — the sale would look
                // settled while its money was still unreported.
                next.state = next.state === STATE.PAID ? STATE.PAID : STATE.CREATED;
                next.serverOrderId = data.serverOrderId || null;
                // Reset the backoff between the two steps: the first one
                // just proved the network works, so the second should not
                // inherit a five-minute wait earned before the outage ended.
                next.attempts = 0;
                next.nextAttemptAt = 0;
                next.lastError = null;
                break;

            case "settled":
                next.state = STATE.SYNCED;
                next.receiptId = data.receiptId || null;
                next.receiptNumber = data.receiptNumber || null;
                next.syncedAt = new Date().toISOString();
                next.attempts = 0;
                next.nextAttemptAt = 0;
                next.lastError = null;
                break;

            case "retry": {
                // A transient failure — offline, 5xx, timeout, 401 before
                // re-login. The state does not move; only the schedule does.
                const attempts = (Number(next.attempts) || 0) + 1;
                next.attempts = attempts;
                next.lastError = data.error || "network";
                next.nextAttemptAt = (data.now || Date.now()) + nextBackoffMs(attempts - 1);
                break;
            }

            case "fail":
                // Terminal, and deliberately so. A 4xx that is not
                // 401/403/429 means the server has considered this request
                // and rejected it — retrying cannot change that answer, and
                // a queue that retries forever hides the problem instead of
                // surfacing it. The row stays, visible, until a human deals
                // with it. It is never dropped.
                next.state = STATE.FAILED;
                next.lastError = data.error || "rejected";
                next.failedAt = new Date().toISOString();
                next.nextAttemptAt = 0;
                break;

            default:
                throw new Error(`Unknown sale event: ${event}`);
        }

        return next;
    }

    // Which step does this sale need next? `null` means nothing to do.
    //
    // Derived from what the SERVER is missing, not from a position in a
    // queue. An order submitted offline and never paid still owes the
    // server its "create" — otherwise the kitchen never learns about it,
    // even hours after the network came back.
    function pendingStep(sale) {
        if (!sale) return null;
        if (sale.state === STATE.SYNCED || sale.state === STATE.FAILED) return null;
        if (!sale.serverOrderId) return "create";
        if (sale.state === STATE.PAID) return "settle";
        return null; // on the server, tab still open — nothing owed
    }

    // Is this sale due for an attempt right now?
    function isDrainable(sale, now) {
        const at = Number(now) || Date.now();
        return pendingStep(sale) !== null && (Number(sale.nextAttemptAt) || 0) <= at;
    }

    // Two different things the staff need to know, kept separate because
    // they have different urgency and different remedies.
    //
    // Money taken that the server — and therefore the tax report — knows
    // nothing about. This is the number that blocks the end of a shift.
    function unsentMoneyCount(sales) {
        return (sales || []).filter(s => s && s.state === STATE.PAID).length;
    }

    // Everything the server is still missing, money or not. A queued but
    // unpaid order matters because the KITCHEN cannot see it either.
    function pendingCount(sales) {
        return (sales || []).filter(s => pendingStep(s) !== null).length;
    }

    // Sales that will never retry on their own. Surfaced separately: the
    // barman cannot fix these by waiting, so counting them with the rest
    // would make the pill nag about something waiting cannot resolve.
    function failedCount(sales) {
        return (sales || []).filter(s => s && s.state === STATE.FAILED).length;
    }

    function newSaleId() {
        if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
        // Plain-http dev only (crypto.randomUUID needs a secure context).
        // Never reached on a real till, which requires HTTPS for the
        // service worker anyway.
        return "s-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
    }

    function createSale({ tableName, guestName, items, total, deviceId }) {
        return {
            clientId: newSaleId(),
            deviceId: deviceId || null,
            tableName: tableName,
            guestName: guestName || "",
            items: items || [],
            total: Number(total) || 0,
            paymentMethod: null,
            createdAt: new Date().toISOString(),
            paidAt: null,
            state: STATE.QUEUED,
            serverOrderId: null,
            receiptId: null,
            receiptNumber: null,
            syncedAt: null,
            attempts: 0,
            nextAttemptAt: 0,
            lastError: null,
        };
    }

    // ── IndexedDB ───────────────────────────────────────────────────────

    let dbPromise = null;

    function promisify(request) {
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    function open() {
        if (dbPromise) return dbPromise;
        dbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(STORE_SALES)) {
                    const sales = db.createObjectStore(STORE_SALES, { keyPath: "clientId" });
                    // Drains walk pending work oldest-first; the UI counts
                    // by state. Both get an index rather than a full scan.
                    sales.createIndex("state", "state", { unique: false });
                    sales.createIndex("createdAt", "createdAt", { unique: false });
                }
                if (!db.objectStoreNames.contains(STORE_MENU)) db.createObjectStore(STORE_MENU, { keyPath: "key" });
                if (!db.objectStoreNames.contains(STORE_SERVER_ORDERS)) db.createObjectStore(STORE_SERVER_ORDERS, { keyPath: "id" });
                if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META, { keyPath: "key" });
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        return dbPromise;
    }

    async function tx(storeName, mode, fn) {
        const db = await open();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(storeName, mode);
            const store = transaction.objectStore(storeName);
            let result;
            try {
                result = fn(store);
            } catch (e) {
                reject(e);
                return;
            }
            transaction.oncomplete = () => resolve(result && result.then ? undefined : result);
            transaction.onerror = () => reject(transaction.error);
            transaction.onabort = () => reject(transaction.error);
        });
    }

    // Dexie-shaped table handle, so the real library is a drop-in later.
    function table(name) {
        return {
            put: value => tx(name, "readwrite", store => { store.put(value); return value; }),
            get: key => open().then(db => promisify(db.transaction(name, "readonly").objectStore(name).get(key))),
            all: () => open().then(db => promisify(db.transaction(name, "readonly").objectStore(name).getAll())),
            delete: key => tx(name, "readwrite", store => { store.delete(key); }),
            clear: () => tx(name, "readwrite", store => { store.clear(); }),
            where: (index, value) => open().then(db =>
                promisify(db.transaction(name, "readonly").objectStore(name).index(index).getAll(value))),
            bulkPut: values => tx(name, "readwrite", store => { (values || []).forEach(v => store.put(v)); }),
        };
    }

    const sales = table(STORE_SALES);
    const menuCache = table(STORE_MENU);
    const serverOrders = table(STORE_SERVER_ORDERS);
    const meta = table(STORE_META);

    // Sales needing a sync step, oldest first. Ordering is by createdAt
    // rather than by index order because a device's queue should drain in
    // the order the guests were actually served.
    async function drainable(now) {
        const at = Number(now) || Date.now();
        const all = await sales.all();
        return all
            .filter(s => isDrainable(s, at))
            .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    }

    async function pruneSynced(days) {
        const keepDays = Number(days) || SYNCED_RETENTION_DAYS;
        const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
        const all = await sales.all();
        let removed = 0;
        for (const sale of all) {
            if (sale.state !== STATE.SYNCED) continue; // never touch unsent money
            const at = Date.parse(sale.syncedAt || sale.createdAt);
            if (Number.isFinite(at) && at < cutoff) {
                await sales.delete(sale.clientId);
                removed++;
            }
        }
        return removed;
    }

    // Ask the browser to stop evicting this database under storage
    // pressure. The result is RETURNED rather than swallowed: on a till,
    // "the browser may throw your queue away" is an operational fact
    // somebody needs to see, not a detail to log and forget.
    async function requestPersistence() {
        if (!navigator.storage || !navigator.storage.persist) return { supported: false, persisted: false };
        try {
            const already = navigator.storage.persisted ? await navigator.storage.persisted() : false;
            const persisted = already || await navigator.storage.persist();
            return { supported: true, persisted };
        } catch (e) {
            return { supported: true, persisted: false, error: String(e) };
        }
    }

    async function deviceId() {
        const existing = await meta.get("deviceId");
        if (existing && existing.value) return existing.value;
        const value = newSaleId();
        await meta.put({ key: "deviceId", value });
        return value;
    }

    return {
        STATE,
        // pure — unit-tested
        nextBackoffMs,
        advanceSale,
        pendingStep,
        isDrainable,
        unsentMoneyCount,
        pendingCount,
        failedCount,
        createSale,
        newSaleId,
        // storage
        open,
        sales,
        menuCache,
        serverOrders,
        meta,
        drainable,
        pruneSynced,
        requestPersistence,
        deviceId,
        SYNCED_RETENTION_DAYS,
        BACKOFF_CAP_MS,
    };
}));
