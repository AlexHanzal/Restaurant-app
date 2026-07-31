// ============================================================================
// urlsafe.js — same-origin validation for client-supplied redirect URLs.
//
// Zero dependencies (Node's global URL only), same self-contained "black box"
// module pattern as settings.js/csrf.js/validation.js/reorder.js.
//
// Why this exists (audit 2026-07-29, finding F4):
//   Three payment routes accept a `returnUrl` from the request body and hand
//   it to GoPay as the post-payment redirect target:
//     POST ${api}/orders
//     POST ${api}/kitchen/reservation/pay-online
//     POST ${api}/indoor-orders/:id/pay-online
//   validation.js only bounds its LENGTH (z.string().max(500)), so any
//   absolute URL was accepted verbatim.
//
//   The attack that makes this worth fixing: an attacker creates a real,
//   payable order with returnUrl pointing at a site they control, receives a
//   genuine gate.gopay.cz redirect URL in the response, and shares THAT link.
//   The victim sees a real payment page on a real GoPay domain, pays, and is
//   then handed to the attacker's page — which can convincingly present
//   "platba selhala, zadejte kartu znovu". The app's own CSP form-action
//   directive cannot help: the redirect is issued by GoPay, not by us.
//
//   The fix is an allow-list of exactly one origin: our own. A legitimate
//   returnUrl only ever points back at this app (the delivery page sending
//   GoPay back to itself so it can resume polling), so nothing legitimate is
//   lost. Rejected values fall back to the server-side default in
//   gatewayCallbackUrls() rather than erroring the request — a hand-crafted
//   returnUrl is not worth failing a real customer's payment over, and the
//   default is always safe.
// ============================================================================

// Returns `candidate` unchanged when it resolves to exactly `ownOrigin`,
// otherwise null. Never throws.
//
// Uses URL resolution rather than string prefix matching, deliberately:
//   - a prefix check on "https://restaurace.example" also accepts
//     "https://restaurace.example.evil.test" (covered by a test)
//   - "//evil.example/x" is a valid protocol-relative URL that a naive
//     "doesn't start with http" check waves through (also covered)
// Comparing parsed .origin values collapses scheme, host AND port into one
// comparison, so a downgraded scheme or a different port is caught too.
function safeReturnUrl(ownOrigin, candidate) {
    if (typeof candidate !== "string" || !candidate) return null;
    if (typeof ownOrigin !== "string" || !ownOrigin) return null;

    let base;
    try {
        base = new URL(ownOrigin);
    } catch {
        return null; // caller gave us a nonsense origin — fail closed
    }

    let resolved;
    try {
        resolved = new URL(candidate, base);
    } catch {
        return null; // malformed candidate
    }

    // Non-http(s) schemes (javascript:, data:, file:) parse to an opaque
    // origin — the string "null" — which can never equal base.origin. The
    // explicit protocol check below is belt-and-braces so this stays correct
    // even if a future scheme were to expose a matching origin.
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return null;
    if (resolved.origin !== base.origin) return null;

    return candidate;
}

module.exports = { safeReturnUrl };
