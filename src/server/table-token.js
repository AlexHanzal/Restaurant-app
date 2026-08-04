// ============================================================================
// table-token.js — signed, per-table capability tokens for the customer QR
// self-order page (spec: docs/superpowers/specs/2026-08-04-table-qr-self-
// order-design.md §4.1).
//
// A table's QR code encodes  <basePath>/stul/<token> . The token is the
// ONLY thing standing between "anyone on the internet" and "can push an
// order onto this restaurant's kitchen board", so two properties matter:
//
//   1. It must be unguessable. A bare /stul/5 must do nothing.
//   2. It must be INCAPABLE of authenticating as staff.
//
// (2) is why the signing key is derived via auth.deriveSecret() and is NOT
// JWT_SECRET. requireAuth() accepts any signature-valid staff JWT, and
// several read routes sit behind requireAuth alone — a same-secret table
// token would therefore be a privilege escalation, not a scoped capability.
// The identical hazard is documented at length in auth.js:192 for reorder
// tokens; this module is the second instance of that pattern.
//
// A payload-shape check inside requireAuth (`if (payload.kind !== "table")`)
// would NOT be an acceptable substitute: it is one line a later refactor can
// delete without understanding why it was there. A different key cannot be
// refactored away by accident — verification fails at the signature level,
// before any field is inspected.
//
// The payload is the table's `fileId`, never its `className`. Tables can be
// renamed (POST /timetables/:name/rename, server.js:2957) and that route
// deliberately leaves fileId alone — so binding the token to fileId means
// RENAMING A TABLE DOES NOT INVALIDATE ITS PRINTED QR CODE. The current
// name is resolved from the record at order time.
//
// Env vars:
//   TABLE_QR_EPOCH — optional break-glass. Mixed into the derivation
//                    purpose, so changing it invalidates every printed code
//                    at once. Deliberately NOT wired to admin UI: this is
//                    the "someone photographed our QR sheet" lever, not a
//                    routine rotation schedule (spec decision D2 — the codes
//                    are printed once and never reprinted).
// ============================================================================

const crypto = require("crypto");
const auth = require("./auth");

// 16 bytes = 128 bits of forgery resistance, and keeps the URL short enough
// for a low QR version. Denser codes are measurably harder to scan off a
// printed card in restaurant lighting, which is the actual failure mode
// here — not brute force.
const SIG_BYTES = 16;

const PURPOSE = `table-qr-v1:${process.env.TABLE_QR_EPOCH || "1"}`;
const KEY = auth.deriveSecret(PURPOSE);

// Guards against a pathological input burning CPU in createHmac. Real
// fileIds are short system ids (see generateFileId() in server.js).
const MAX_FILE_ID_LEN = 128;

function sign(fileId) {
    return crypto
        .createHmac("sha256", KEY)
        .update(fileId)
        .digest()
        .subarray(0, SIG_BYTES)
        .toString("base64url");
}

function mintTableToken(fileId) {
    if (typeof fileId !== "string" || !fileId || fileId.length > MAX_FILE_ID_LEN) {
        throw new Error("mintTableToken: fileId must be a short non-empty string");
    }
    if (fileId.includes(".")) {
        // The token format is "<fileId>.<sig>" — a dot in the id would make
        // parsing ambiguous. generateFileId() never produces one; this is a
        // fail-loud guard in case that ever changes.
        throw new Error("mintTableToken: fileId must not contain '.'");
    }
    return `${fileId}.${sign(fileId)}`;
}

function verifyTableToken(token) {
    // Returns null for EVERY failure mode rather than throwing — this runs
    // on a public route against attacker-controlled input, and a thrown
    // exception there is a 500 that leaks the difference between "malformed"
    // and "well-formed but wrong".
    if (typeof token !== "string" || token.length > MAX_FILE_ID_LEN + 64) return null;

    const dot = token.indexOf(".");
    if (dot <= 0 || dot === token.length - 1) return null;

    const fileId = token.slice(0, dot);
    const provided = token.slice(dot + 1);
    if (fileId.length > MAX_FILE_ID_LEN || provided.includes(".")) return null;

    const expected = sign(fileId);

    // timingSafeEqual THROWS on a length mismatch, so the length check must
    // come first — and must not itself be the whole comparison.
    const a = Buffer.from(provided, "utf8");
    const b = Buffer.from(expected, "utf8");
    if (a.length !== b.length) return null;
    if (!crypto.timingSafeEqual(a, b)) return null;

    return fileId;
}

module.exports = { mintTableToken, verifyTableToken };
