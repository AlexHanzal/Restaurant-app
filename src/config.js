// ============================================================================
// FRONTEND CONFIGURATION - Restaurant System
// ============================================================================

// Configuration for the Restaurant System frontend
// This file should be included before renderer.js

// AUTO-CONFIGURATION: Try to detect backend server automatically
//
// UI-REDESIGN NOTE (Task 1): this used to special-case localhost/127.0.0.1
// to always point at port 3000, under the assumption that local dev runs
// the frontend and backend as two separate processes on two different
// ports. That's not how this codebase actually works — server.js always
// serves the frontend AND the API from the same single Express process,
// on whatever PORT it's started with (see SERVER_CONFIG.serveFrontend in
// server.js) — so hardcoding 3000 broke every local run started on a
// different port (e.g. the per-task throwaway test servers in the UI
// redesign plan: PORT=4101/4102/4103/4104) with a same-origin page that
// silently tried to fetch a backend that was never there. Same-origin is
// always correct here, in dev and in production alike.
function autoDetectBackend() {
    return window.location.origin;
}

// MANUAL CONFIGURATION: Set your backend server URL here
// Examples:
// const MANUAL_API_URL = 'http://localhost:3000';           // Local development
// const MANUAL_API_URL = 'http://192.168.1.100:3000';      // Local network server
// const MANUAL_API_URL = 'http://myserver.com:8080';       // Production server
// const MANUAL_API_URL = 'https://api.myschool.com';       // HTTPS production

const MANUAL_API_URL = null; // Set to null to use auto-detection

// ============================================================================
// APPLY CONFIGURATION
// ============================================================================

// Set the API base URL
if (MANUAL_API_URL) {
    window.API_BASE_URL = MANUAL_API_URL;
    console.log('📡 Using manual API URL:', MANUAL_API_URL);
} else {
    window.API_BASE_URL = autoDetectBackend();
    console.log('🔍 Auto-detected API URL:', window.API_BASE_URL);
}

// Optional: Test connection to backend
if (window.fetch) {
    fetch(window.API_BASE_URL + '/')
        .then(response => response.json())
        .then(data => {
            console.log('✅ Backend connection successful:', data.message);
            if (data.server) {
                console.log('🌐 Server info:', data.server);
            }
        })
        .catch(error => {
            console.warn('⚠️  Could not connect to backend:', error.message);
            console.log('🔧 Please check your API_BASE_URL configuration');
        });
}

// ============================================================================
// PER-RESTAURANT CONFIG (server-rendered)
// ============================================================================
// The {{TOKEN}} values below are substituted by server.js before this file
// is sent — see src/server/brand.js. This file is NOT loaded from disk by
// the browser as-is; it always goes through the render route.
//
// Why a served file instead of an inline <script>: the CSP is
// script-src 'self' with no 'unsafe-inline', so an inline block carrying
// these values would be blocked. Same reason sw.js gets its __BASE_PATH__
// substituted server-side.
//
// window.* rather than top-level const: classic <script> tags share ONE
// global lexical environment, so a top-level `const APP_FEATURES` here
// would collide with any same-named declaration in renderer.js/inner.js and
// silently kill whichever file loaded second.
window.APP_FEATURES = {{APP_FEATURES_JSON}};
window.APP_BRAND = {{APP_BRAND_JSON}};
