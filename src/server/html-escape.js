// ============================================================================
// html-escape.js — the one HTML escaper this app uses.
//
// Lived inline in server.js until brand.js needed it too. brand.js cannot
// require server.js (server.js requires brand.js — that's a cycle) and unit
// tests require brand.js directly without booting a server, so the function
// moved into its own zero-dependency module rather than being copied into
// both and left to drift.
// ============================================================================

function escapeHtml(str) {
    return String(str == null ? "" : str).replace(/[&<>"']/g, ch => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[ch]));
}

module.exports = { escapeHtml };
