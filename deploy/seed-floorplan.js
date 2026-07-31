// ============================================================================
// deploy/seed-floorplan.js — idempotent CLI helper that places the four
// tables the owner's reference floorplan images show (`stul`, `stul 2`,
// `stůl 3`, `stůl 4`) into the two rooms seeded by settings.js's
// buildDefaultSettings() (`main`, `upstairs`) and sets their seat counts.
//
// docs/superpowers/specs/2026-07-27-floorplan-table-picking-design.md §9:
// every table that predates this feature has neither `seats` nor `layout`,
// so a fresh/existing install shows an empty floorplan canvas plus a
// "Nezařazené stoly" fallback list until something places the tables. This
// script is that something, for the four tables that exist in THIS
// restaurant's database today — it is not a general-purpose "seed any
// table" tool, and it is not wired into any request path (nothing in
// server.js calls it); it is a one-off operator command, run by hand from
// the project root, same category as deploy/create-admin.js.
//
// IDEMPOTENT — run it as many times as you like:
//   - A table that already has a non-null `layout` (an admin placed or
//     moved it in the *Rozložení* editor, or a previous run of this same
//     script already placed it) is left completely alone. This is the one
//     rule design §9 requires: re-running this script must never clobber an
//     owner's edit.
//   - A table name in PLACEMENTS that doesn't exist in the database yet is
//     reported and skipped, not created — this script only places existing
//     tables, it never calls POST /timetables.
//
// Coordinates are hand-picked to match the owner-supplied reference images'
// composition, positioned relative to the room/fixture layout in design
// doc §4.2:
//   - room "main" (1000x430 units, KUCHYŇ block spanning the top): two
//     same-size 4-seat squares side by side in the lower-left area, below
//     the kitchen. `stul`'s coordinates below are the exact worked example
//     from design doc §4.1 (a table record with a `layout` set).
//   - room "upstairs" (300x490 units, SCHODY block at the top-left): a
//     4-seat square below the stairs on the left, and a smaller 2-seat
//     square below and to the right of it.
//
// Usage (from the project root, against whichever data/app.db SQLITE_PATH
// points at — see db.js):
//   node deploy/seed-floorplan.js
// ============================================================================

const db = require("../src/server/db");

const COLLECTION = "timetables";

// className -> the seats/layout this script assigns it. Keyed by the exact
// table names that exist in the reference database (note "stul"/"stul 2"
// have no diacritics, but "stůl 3"/"stůl 4" do — these are real, distinct
// className values, not a typo).
const PLACEMENTS = {
    "stul": {
        seats: 4,
        layout: { room: "main", x: 60, y: 170, w: 160, h: 165 },
    },
    "stul 2": {
        seats: 4,
        layout: { room: "main", x: 280, y: 170, w: 160, h: 165 },
    },
    "stůl 3": {
        seats: 4,
        layout: { room: "upstairs", x: 20, y: 270, w: 130, h: 130 },
    },
    "stůl 4": {
        seats: 2,
        layout: { room: "upstairs", x: 170, y: 320, w: 90, h: 90 },
    },
};

// Czech counts nouns in three forms, so "4 míst" is wrong where "4 místa" is
// right. Mirrors czechSeats() in src/server/server.js and seatsLabel() in
// src/js/floorplan.js — the owner reads this script's output and then sees the
// same counts on the plan, so they must not disagree.
function czechSeats(n) {
    if (n === 1) return "1 místo";
    if (n >= 2 && n <= 4) return `${n} místa`;
    return `${n} míst`;
}

function main() {
    const all = db.list(COLLECTION);

    let placed = 0;
    let skippedAlreadyPlaced = 0;
    let notFound = 0;

    for (const [name, placement] of Object.entries(PLACEMENTS)) {
        const record = all.find(t => t.className === name);

        if (!record) {
            console.log(`PŘESKOČENO (nenalezeno): stůl "${name}" v databázi neexistuje.`);
            notFound++;
            continue;
        }

        // The one idempotency rule design §9 requires: never overwrite a
        // placement that's already there, whether an admin set it by hand
        // in the *Rozložení* editor or a previous run of this script placed
        // it already.
        if (record.layout) {
            console.log(`PŘESKOČENO (už umístěno): stůl "${name}" už má rozložení.`);
            skippedAlreadyPlaced++;
            continue;
        }

        const updated = {
            ...record,
            seats: placement.seats,
            layout: placement.layout,
        };
        db.set(COLLECTION, record.fileId, updated);
        console.log(`UMÍSTĚNO: stůl "${name}" -> místnost "${placement.layout.room}", ${czechSeats(placement.seats)}.`);
        placed++;
    }

    console.log(`\nHotovo. Umístěno: ${placed}, přeskočeno (už umístěno): ${skippedAlreadyPlaced}, nenalezeno: ${notFound}.`);
}

main();
