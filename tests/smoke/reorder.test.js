// ============================================================================
// reorder.test.js — end-to-end smoke coverage for the "Objednat znovu"
// verification flow (POST /reorder/send-code -> POST /reorder/verify ->
// GET /reorder/recent), against a REAL spawned server and a REAL temp
// SQLite DB.
//
// Before this file there was NO smoke coverage of these routes at all — see
// server.js's own comment above them (spec §7) for the full route list.
// This file exists primarily as the regression guard for finding M3
// (2026-08-11 audit): pending SMS-verification codes used to live in a bare
// in-memory Map (reorder.js's `pendingCodes`), lost on every restart. The
// "survives a restart" case below is the direct proof the fix works; the
// rest of the suite exists so that case sits inside real coverage of the
// flow it is restarting in the middle of, rather than testing persistence
// in a vacuum.
//
// BUDGET: same shared smsIpLimiter (20/hour/IP) and smsPhoneLimiter
// (5/hour/phone) as tests/smoke/reservations.test.js — see that file's own
// note. Each describe block below gets its OWN spawned server so the two
// files' budgets never combine.
// ============================================================================

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert");

const harness = require("../helpers/harness");
const reorder = require("../../src/server/reorder");

const COL = harness.COL;

let phoneCounter = 0;
function nextPhone() {
    phoneCounter += 1;
    return `+42060100${String(phoneCounter).padStart(4, "0")}`;
}

function post(server, path, body) {
    return fetch(`${server.api}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
}

// Mirrors reservations.test.js's readCode(): pulls the most recent
// verification code out of the child's simulated-SMS log line. Reorder's
// message text is distinct ("pro zobrazení vašich objednávek"), so this is
// anchored on that rather than reservations.test.js's "pro rezervaci" text —
// the two must never accidentally read each other's code.
function readCode(server, phone) {
    const lines = server.logs().split("\n").filter(l => l.includes(phone) && l.includes("ověřovací kód"));
    assert.ok(lines.length > 0, `no simulated verification SMS logged for ${phone}`);
    const match = /ověřovací kód pro zobrazení vašich objednávek: (\d{6})/.exec(lines[lines.length - 1]);
    assert.ok(match, `could not read a 6-digit code out of: ${lines[lines.length - 1]}`);
    return match[1];
}

async function sendCode(server, phone = nextPhone()) {
    const res = await post(server, "/reorder/send-code", { phone });
    return { res, phone };
}

// The whole flow up to a verified cookie. Returns the verify response plus
// whatever Set-Cookie header it carried, so callers can assert on either.
async function sendAndVerify(server, phone = nextPhone()) {
    await sendCode(server, phone);
    await new Promise(r => setTimeout(r, 50)); // let the child's log line land
    const code = readCode(server, phone);
    const res = await post(server, "/reorder/verify", { phone, code });
    return { res, phone, code };
}

describe("reorder verification flow", () => {
    let server;

    before(async () => {
        server = await harness.start();
    });

    after(async () => { if (server) await server.stop(); });

    test("send-code answers success without revealing whether the phone has ordered before", async () => {
        const { res } = await sendCode(server);
        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.strictEqual(body.success, true);
    });

    test("the correct code verifies and sets the reorder cookie", async () => {
        const { res, phone } = await sendAndVerify(server);
        assert.strictEqual(res.status, 200, await res.text());
        const setCookie = res.headers.get("set-cookie") || "";
        assert.match(setCookie, /reorder_token=/);
        assert.match(setCookie, /HttpOnly/i);

        // The row this verification consumed must be gone — one-time use,
        // same guarantee the reservation flow's pendingVerifications gave.
        const key = reorder.phoneMatchKey(phone);
        assert.strictEqual(harness.readRecord(server.dbPath, COL.reorderPendingCodes, key), null);
    });

    test("verifying without ever sending a code is refused", async () => {
        const res = await post(server, "/reorder/verify", { phone: nextPhone(), code: "123456" });
        assert.strictEqual(res.status, 400);
        assert.match((await res.json()).error, /Nejprve/);
    });

    test("a wrong code decrements attemptsLeft and reports it, without consuming the row", async () => {
        const { phone } = await sendCode(server);
        await new Promise(r => setTimeout(r, 50));
        readCode(server, phone); // just to confirm one was actually sent

        const wrong = await post(server, "/reorder/verify", { phone, code: "000000" });
        assert.strictEqual(wrong.status, 400);
        const body = await wrong.json();
        assert.match(body.error, /Nesprávný kód/);
        assert.strictEqual(body.attemptsLeft, 4);

        // The real code, sent moments ago, must still work — a wrong guess
        // must not have deleted the row.
        const right = await post(server, "/reorder/verify", { phone, code: readCode(server, phone) });
        assert.strictEqual(right.status, 200, await right.text());
    });

    test("attempts exhaust after 5 wrong guesses, and the 6th (even correct) is refused", async () => {
        const { phone } = await sendCode(server);
        await new Promise(r => setTimeout(r, 50));
        const code = readCode(server, phone);

        for (let i = 0; i < 5; i++) {
            const r = await post(server, "/reorder/verify", { phone, code: "000000" });
            assert.strictEqual(r.status, 400, `wrong-guess attempt ${i}`);
        }

        const afterExhaustion = await post(server, "/reorder/verify", { phone, code });
        assert.strictEqual(afterExhaustion.status, 400);
        assert.match((await afterExhaustion.json()).error, /Příliš mnoho pokusů/);
    });

    test("an expired code is refused, forced past its TTL directly in storage", async () => {
        // A real 5-minute wait would make this suite unusable; the row's
        // expiresAt is edited directly in the temp DB instead — cheaper and
        // exactly as faithful, since verify-and-book/verify never trust
        // anything but what is actually stored.
        const { phone } = await sendCode(server);
        await new Promise(r => setTimeout(r, 50));
        const code = readCode(server, phone);

        const key = reorder.phoneMatchKey(phone);
        const stored = harness.readRecord(server.dbPath, COL.reorderPendingCodes, key);
        assert.ok(stored, "the pending row must exist before it can be aged past its TTL");
        harness.seedRecord(server.dbPath, COL.reorderPendingCodes, key, { ...stored, expiresAt: Date.now() - 1 });

        const res = await post(server, "/reorder/verify", { phone, code });
        assert.strictEqual(res.status, 400);
        assert.match((await res.json()).error, /vypršel/);
        assert.strictEqual(harness.readRecord(server.dbPath, COL.reorderPendingCodes, key), null);
    });

    test("GET /reorder/recent requires a verified cookie", async () => {
        const res = await fetch(`${server.api}/reorder/recent`);
        assert.strictEqual(res.status, 401);
    });

    test("GET /reorder/recent answers for a browser that just verified, even with no past orders", async () => {
        const { res: verifyRes } = await sendAndVerify(server);
        const cookie = (verifyRes.headers.get("set-cookie") || "").split(";")[0];
        assert.ok(cookie, "verify must have set the reorder cookie");

        const res = await fetch(`${server.api}/reorder/recent`, { headers: { Cookie: cookie } });
        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual((await res.json()).orders, []);
    });
});

// ── FINDING M3: SURVIVES A RESTART ───────────────────────────────────────
// The whole point of this fix. Own describe block, own server (a PINNED temp
// DB, not the auto-generated one harness.start() otherwise uses, so a
// second server can be pointed at the exact same file), so a failure here
// never gets blamed on state left over by the suite above.
describe("reorder pending code survives a restart", () => {
    const os = require("os");
    const path = require("path");
    const crypto = require("crypto");
    const dbPath = path.join(os.tmpdir(), `reorder-m3-smoke-${process.pid}-${crypto.randomBytes(6).toString("hex")}.db`);

    test("a code requested before a crash still verifies after the process restarts", async () => {
        const phone = nextPhone();

        const first = await harness.start({ env: { SQLITE_PATH: dbPath } });
        try {
            const { res } = await sendCode(first, phone);
            assert.strictEqual(res.status, 200, await res.text());
            await new Promise(r => setTimeout(r, 50));
            var code = readCode(first, phone); // eslint-disable-line no-var
        } finally {
            await first.stop();
        }

        // A brand new process, same DB file — nothing here is the same Map
        // instance; if this passes, it can only be because the row survived
        // on disk.
        const second = await harness.start({ env: { SQLITE_PATH: dbPath } });
        try {
            const res = await post(second, "/reorder/verify", { phone, code });
            assert.strictEqual(res.status, 200, await res.text());
            assert.match(res.headers.get("set-cookie") || "", /reorder_token=/);
        } finally {
            await second.stop();
        }
    });
});
