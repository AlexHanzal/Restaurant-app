// ============================================================================
// MINIFY-ON-SERVE (esbuild, no bundling)
// ============================================================================
//
// Performance optimization design (2026-07-23), §2:
// docs/superpowers/specs/2026-07-23-performance-optimization-design.md
//
// server.js mounts createMinifyMiddleware(frontendPath) BEFORE
// express.static (see setupMiddleware()), for both places the frontend
// directory is served from (under SERVER_CONFIG.basePath, and — if
// basePath is ever falsy — bare at "/"). This middleware:
//
//   - only looks at GET/HEAD requests for *.js / *.css
//   - resolves the request path safely under `frontendRoot` (rejects any
//     path-traversal attempt — never serves a file outside that directory)
//   - skips already-minified files (*.min.js) — nothing to do there
//   - runs esbuild.transformSync({ minify: true }) on the raw source and
//     caches the result in memory, keyed by absolute path + the file's
//     mtimeMs — editing a source file on disk and refreshing the browser
//     re-minifies automatically (mtime changed -> cache entry invalidated)
//   - sets a strong ETag (sha256 of the MINIFIED output) and honors
//     If-None-Match with a 304
//   - sets Cache-Control: public, max-age=3600 (much shorter than the
//     fonts/images policy in server.js, because editing a source file DOES
//     change what this route returns)
//
// On ANY failure (esbuild syntax error, unreadable file, unsupported
// content, esbuild itself missing) this middleware logs a warning ONCE per
// file (keyed by path+mtime, so a fixed-then-broken-again file still gets a
// fresh warning) and calls next() — express.static (mounted right after
// this) then serves the raw, un-minified file instead. The page must never
// break because of a minification problem.
//
// Source files on disk stay fully commented; only the bytes sent over the
// wire are minified. Dev workflow is unchanged: edit -> refresh.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

let esbuild = null;
let esbuildLoadError = null;
try {
    esbuild = require("esbuild");
} catch (e) {
    esbuildLoadError = e;
}

const CONTENT_TYPES = {
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
};

// In-memory cache: absolute file path -> { mtimeMs, code, contentType, etag }.
// Never expired on a timer — mtimeMs is the invalidation key, so a restart
// (fresh empty Map) or an on-disk edit are the only two ways an entry ever
// goes stale, and both are handled (restart: cache starts empty; edit: the
// mtimeMs comparison in minifyFile() below misses and re-minifies).
const cache = new Map();

// Warn at most once per (path, mtime) pair — an esbuild error on a file
// that never changes would otherwise log on every single request for it.
const warnedOnce = new Set();
function warnOnce(key, message, err) {
    if (warnedOnce.has(key)) return;
    warnedOnce.add(key);
    console.warn(message, err && err.message ? err.message : err || "");
}

function minifyFile(absPath, ext) {
    const stat = fs.statSync(absPath);
    const cached = cache.get(absPath);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached;

    const source = fs.readFileSync(absPath, "utf8");
    const loader = ext === ".js" ? "js" : "css";
    const result = esbuild.transformSync(source, { minify: true, loader });
    const code = result.code;
    const etag = `"${crypto.createHash("sha256").update(code).digest("hex")}"`;

    const entry = { mtimeMs: stat.mtimeMs, code, contentType: CONTENT_TYPES[ext], etag };
    cache.set(absPath, entry);
    return entry;
}

// Builds the middleware for one frontend root directory. Call once per
// express.static mount point (server.js mounts this both under basePath
// and — in the bare-path fallback branch — at "/"; see setupMiddleware()).
function createMinifyMiddleware(frontendRoot) {
    const rootResolved = path.resolve(frontendRoot);

    return function minifyMiddleware(req, res, next) {
        if (req.method !== "GET" && req.method !== "HEAD") return next();

        // req.path is already relative to wherever this middleware was
        // mounted (express strips the mount prefix), exactly like
        // express.static's own behavior right below it.
        const urlPath = req.path || "";
        const ext = path.extname(urlPath).toLowerCase();
        if (ext !== ".js" && ext !== ".css") return next();
        if (urlPath.toLowerCase().endsWith(".min.js")) return next(); // already minified

        if (!esbuild) {
            warnOnce("__no_esbuild__", "⚠️  minify.js: esbuild is not available — serving raw static files instead.", esbuildLoadError);
            return next();
        }

        // SECURITY: resolve safely under rootResolved, reject traversal.
        // decodeURIComponent first so an encoded "..%2f" etc. can't sneak
        // a ".." past a naive string check. A malformed %-escape just falls
        // through to express.static, which will 400/404 it on its own.
        let decodedPath;
        try {
            decodedPath = decodeURIComponent(urlPath);
        } catch {
            return next();
        }
        const absPath = path.resolve(rootResolved, "." + decodedPath);
        if (absPath !== rootResolved && !absPath.startsWith(rootResolved + path.sep)) {
            return next(); // traversal attempt — let express.static's own handling take it from here
        }

        let entry;
        try {
            if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) return next();
            entry = minifyFile(absPath, ext);
        } catch (e) {
            // Covers both a read failure and an esbuild transform (syntax)
            // error — either way, never break the page: fall through to
            // express.static, which serves the raw, un-minified file.
            let mtimeKey = absPath;
            try { mtimeKey = `${absPath}:${fs.statSync(absPath).mtimeMs}`; } catch {}
            warnOnce(mtimeKey, `⚠️  minify.js: failed to minify ${absPath}, serving raw file instead:`, e);
            return next();
        }

        res.set("Cache-Control", "public, max-age=3600");
        res.set("ETag", entry.etag);

        if (req.headers["if-none-match"] === entry.etag) {
            return res.status(304).end();
        }

        res.set("Content-Type", entry.contentType);
        res.send(entry.code);
    };
}

module.exports = { createMinifyMiddleware };
