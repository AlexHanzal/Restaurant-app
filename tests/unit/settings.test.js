// ============================================================================
// settings.test.js — settings.js's DEFAULT_SETTINGS shape, cross-checked
// against validation.js's settingsSchema.
//
// docs/superpowers/plans/2026-08-08-delivery-routing.md Task 3: the
// delivery.routing defaults added here MUST stay in lockstep with the
// (`.strict()`) schema in validation.js, or PUT /api/settings 400s for every
// admin the moment the settings panel round-trips the object it just
// fetched. See "a full settings round-trip survives the strict schema"
// below — that's the regression guard for exactly this failure mode.
// ============================================================================

const test = require("node:test");
const assert = require("node:assert");
const os = require("os");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

// db.js resolves DB_PATH at require time, so this has to be set first —
// same pattern as tests/unit/db-patch.test.js and tests/unit/geocode.test.js.
const TMP_DB = path.join(os.tmpdir(), `settings-${process.pid}-${crypto.randomBytes(6).toString("hex")}.db`);
process.env.SQLITE_PATH = TMP_DB;

const db = require("../../src/server/db");
const settings = require("../../src/server/settings");

test.after(() => {
    try { db.getDb().close(); } catch { /* already closed */ }
    for (const suffix of ["", "-wal", "-shm"]) {
        try { fs.unlinkSync(TMP_DB + suffix); } catch { /* never existed */ }
    }
});

// ── delivery.routing defaults ───────────────────────────────────────────

test("delivery.routing has the documented defaults", () => {
    const s = settings.getSettings();
    assert.deepStrictEqual(s.delivery.routing, {
        enabled: true,
        maxStops: 3,
        groupRadiusM: 800,
        batchWindowMinutes: 10,
        ageGraceMinutes: 30,
        agePriorityKmPerMinute: 0.5,
        batchBonusKm: 1.5,
        originLat: null,
        originLon: null,
    });
});

test("maxStops is capped at 6 — planBatch brute-forces permutations", () => {
    const V = require("../../src/server/validation");
    const base = settings.getSettings();
    const withStops = n => ({ ...base, delivery: { ...base.delivery, routing: { ...base.delivery.routing, maxStops: n } } });
    assert.strictEqual(V.settingsSchema.safeParse(withStops(6)).success, true);
    assert.strictEqual(V.settingsSchema.safeParse(withStops(7)).success, false);
    assert.strictEqual(V.settingsSchema.safeParse(withStops(1)).success, false);
});

test("a full settings round-trip survives the strict schema", () => {
    // The regression this guards: inner.js PUTs back the WHOLE settings
    // object it fetched. A default added without a matching schema entry
    // makes every settings save 400 the moment an admin opens the panel.
    const V = require("../../src/server/validation");
    const result = V.settingsSchema.safeParse(settings.getSettings());
    assert.strictEqual(result.success, true,
        result.success ? "" : JSON.stringify(result.error.issues, null, 2));
});
