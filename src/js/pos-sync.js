// ============================================================================
// pos-sync.js — drains the local sale queue to the server.
//
// Offline-first POS, spec §3.3. This file replays the EXISTING routes —
// POST /indoor-orders and POST /indoor-orders/:id/mark-paid — carrying an
// Idempotency-Key. There is deliberately no second server endpoint for
// offline sales: one guarded path to money, exercised identically online
// and off.
//
// It never talks to EET. eet-queue.js on the server already owns retry,
// backoff, deadline escalation and health reporting for that, and it
// already survives outages. Getting the sale to the server is the whole job.
// ============================================================================

(function (root) {
    "use strict";

    const POSDB = root.POSDB;

    // ── Why navigator.onLine is only ever used to SKIP ──────────────────
    //
    // `onLine === true` means "attached to a network". It does not mean the
    // internet works, and a bar's access point with a dead uplink reports
    // exactly that — which is the single most common way a till is offline
    // in practice. So `true` is never treated as evidence of anything; the
    // only proof of connectivity is a request that actually succeeded.
    // `false`, on the other hand, is reliable: there is genuinely no
    // network, so skipping the attempt saves a guaranteed failure and the
    // backoff step it would have cost.
    function definitelyOffline() {
        return typeof navigator !== "undefined" && navigator.onLine === false;
    }

    // The other half of the same idea. Because `onLine === true` proves
    // nothing, the STATUS the staff see must come from whether the server
    // actually answered, not from whether the device has a network.
    //
    // Without this the pill reads "Online" while the till is sitting in
    // offline mode with a dead server — the device has Wi-Fi, so onLine is
    // true — which is the pill lying about the one thing it exists to
    // report. null means "no attempt yet", and is treated as optimistic.
    let serverReachable = null;

    function noteContact(ok) {
        serverReachable = !!ok;
    }

    // True only when we have positive evidence the server is unreachable.
    function serverUnreachable() {
        return definitelyOffline() || serverReachable === false;
    }

    const SYNC_TAG = "pos-drain";
    const POLL_MS = 30 * 1000;

    // A getter, not a value: inner.js's API_URL is rewritten by tryConnect()
    // when the staff point the app at a different backend, and a drain that
    // captured the old one at configure() time would keep posting a shift's
    // sales at a server nobody is using any more.
    let getApiUrl = null;
    let getCsrfToken = null;   // async () => token
    let onChange = null;       // called after any queue mutation, for the UI
    let onAuthRequired = null; // called when the drain hits a 401
    let onCsrfStale = null;    // called on 403 so the host can drop its cached token
    let draining = false;
    let timer = null;

    function configure(options) {
        getApiUrl = options.getApiUrl;
        getCsrfToken = options.getCsrfToken;
        onChange = options.onChange || function () {};
        onAuthRequired = options.onAuthRequired || function () {};
        onCsrfStale = options.onCsrfStale || function () {};
    }

    function notify() {
        try { onChange(); } catch (e) { /* a UI callback must never stall the queue */ }
    }

    async function post(path, body, idempotencyKey) {
        // A token is fetched per drain rather than reused. A queue that sat
        // through a two-hour outage is holding a token from before it, and
        // the server will have rotated or expired it.
        const token = await getCsrfToken();
        const res = await fetch(`${getApiUrl()}${path}`, {
            method: "POST",
            credentials: "include",
            headers: {
                "Content-Type": "application/json",
                "x-csrf-token": token || "",
                "Idempotency-Key": idempotencyKey,
            },
            body: JSON.stringify(body),
        });

        // The server answered — whatever it said, the network is up. This
        // is the only kind of evidence of connectivity this file accepts.
        noteContact(true);

        let payload = null;
        try { payload = await res.json(); } catch (e) { payload = null; }
        return { status: res.status, ok: res.ok, payload };
    }

    // How to react to a given response. Split out so the policy is legible
    // in one place instead of scattered through the drain loop.
    //
    //   401 — the session expired during the outage. NOT a reason to drop
    //         the barman to the login gate mid-service, and emphatically
    //         not a reason to touch the queue. Ask for a sign-in and retry.
    //   403 — usually a stale CSRF token; the next drain fetches a fresh
    //         one, so this is transient.
    //   429 — rate limited. Backing off is exactly the right response.
    //   other 4xx — the server considered this request and rejected it.
    //         Retrying cannot change that answer. Surface it to a human.
    //   5xx / network — transient by definition.
    function classify(status) {
        if (status === 401) return "auth";
        if (status === 403 || status === 429) return "retry";
        if (status >= 400 && status < 500) return "fail";
        return "retry";
    }

    // Performs ONE step and reports both the new sale and what happened, so
    // the loop can tell "the server rejected this sale" (keep going — the
    // network is clearly fine) apart from "the network died" (stop).
    async function syncOne(sale) {
        const step = POSDB.pendingStep(sale);

        if (step === "create") {
            const res = await post("/indoor-orders", {
                tableName: sale.tableName,
                guestName: sale.guestName,
                items: sale.items,
                total: sale.total,
                offlineSale: true,
                clientSaleId: sale.clientId,
            }, sale.clientId);

            if (res.ok && res.payload && res.payload.order) {
                return { sale: POSDB.advanceSale(sale, "created", { serverOrderId: res.payload.order.id }), outcome: "advanced" };
            }
            return handleFailure(sale, res);
        }

        if (step === "settle") {
            const res = await post(`/indoor-orders/${encodeURIComponent(sale.serverOrderId)}/mark-paid`, {
                paidAt: sale.paidAt,
            }, `${sale.clientId}:paid`);

            if (res.ok && res.payload) {
                return {
                    sale: POSDB.advanceSale(sale, "settled", {
                        receiptId: res.payload.receiptId || null,
                        receiptNumber: res.payload.receiptNumber || null,
                    }),
                    outcome: "advanced",
                };
            }
            return handleFailure(sale, res);
        }

        return { sale, outcome: "done" };
    }

    function handleFailure(sale, res) {
        const kind = classify(res.status);
        const message = (res.payload && res.payload.error) || `HTTP ${res.status}`;

        if (kind === "auth") {
            onAuthRequired();
            return { sale: POSDB.advanceSale(sale, "retry", { error: "Přihlášení vypršelo" }), outcome: "blocked" };
        }
        if (kind === "fail") {
            // The server considered this and said no. The network is fine,
            // so the rest of the queue still deserves its turn.
            return { sale: POSDB.advanceSale(sale, "fail", { error: `${res.status}: ${message}` }), outcome: "rejected" };
        }
        if (res.status === 403) {
            // Almost always a CSRF token minted before the outage. Clear it
            // so the next attempt fetches a fresh one instead of replaying
            // the same stale header until the backoff cap.
            onCsrfStale();
        }
        return { sale: POSDB.advanceSale(sale, "retry", { error: message }), outcome: "blocked" };
    }

    // Serial and oldest-first. Parallel drains would multiply the failure
    // modes for no gain — the server is a single SQLite writer — and would
    // make the ordering of a table's two steps harder to reason about.
    async function drain() {
        if (draining) return { skipped: "already draining" };
        if (definitelyOffline()) return { skipped: "offline" };

        draining = true;
        let synced = 0;
        let failed = 0;

        let blocked = false;

        try {
            const due = await POSDB.drainable(Date.now());
            for (const sale of due) {
                let current = sale;

                // Keep stepping this sale while it advances. A sale has two
                // server calls, and stopping after the first would leave a
                // paid tab sitting in `created` — money taken, order on the
                // server, payment unreported — until the next 30s tick, for
                // no reason at all: the create call just proved the network
                // works.
                for (;;) {
                    let result;
                    try {
                        result = await syncOne(current);
                    } catch (e) {
                        // fetch() itself threw — no network, DNS failure,
                        // TLS problem. Always transient from the queue's
                        // point of view; the sale keeps its money and its
                        // place in line.
                        noteContact(false);
                        result = { sale: POSDB.advanceSale(current, "retry", { error: String((e && e.message) || e) }), outcome: "blocked" };
                    }

                    current = result.sale;
                    await POSDB.sales.put(current);
                    notify();

                    if (result.outcome === "advanced" && POSDB.pendingStep(current)) continue;
                    if (result.outcome === "blocked") blocked = true;
                    break;
                }

                if (current.state === POSDB.STATE.SYNCED) synced++;
                if (current.state === POSDB.STATE.FAILED) failed++;

                // Only a network-shaped failure stops the pass. A sale the
                // server actively rejected says nothing about the next one,
                // and halting there would strand a whole shift's queue
                // behind one bad row.
                if (blocked) break;
            }
        } finally {
            draining = false;
        }

        return { synced, failed, blocked };
    }

    // Background Sync lets the queue drain with the app closed — the reason
    // the spec chose Android/Chrome. Registration is best-effort: where it
    // is unavailable the three foreground triggers below still cover every
    // case in which the app is actually open.
    async function requestBackgroundSync() {
        try {
            if (!("serviceWorker" in navigator) || !("SyncManager" in root)) return false;
            const reg = await navigator.serviceWorker.ready;
            if (!reg.sync) return false;
            await reg.sync.register(SYNC_TAG);
            return true;
        } catch (e) {
            return false;
        }
    }

    // Four triggers, because no single one is reliable: none of them is
    // redundant with the others.
    //
    //   1. on enqueue     — the common case; the network is usually fine
    //   2. `online`       — fires on reconnect, but lies in both directions
    //   3. a 30s poll     — catches the "onLine never changed but the
    //                       uplink came back" case, which `online` misses
    //   4. Background Sync — the app is closed, e.g. the tablet was locked
    function start() {
        if (timer) return;
        root.addEventListener("online", () => { drain(); });
        timer = setInterval(() => { drain(); }, POLL_MS);
        drain();
    }

    function stop() {
        if (timer) clearInterval(timer);
        timer = null;
    }

    // Called by inner.js the moment a tab is closed and paid.
    async function enqueuePaid(sale) {
        await POSDB.sales.put(sale);
        notify();
        requestBackgroundSync();
        return drain();
    }

    root.POSSync = {
        configure,
        start,
        stop,
        drain,
        enqueuePaid,
        requestBackgroundSync,
        classify,
        definitelyOffline,
        serverUnreachable,
        noteContact,
        SYNC_TAG,
        POLL_MS,
    };
}(typeof self !== "undefined" ? self : this));
