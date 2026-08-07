// ============================================================================
// preflight.js — startup guard + boot summary for running several
// restaurants as separate processes out of ONE checkout ("one box, N
// processes"). Self-contained: depends on nothing but node:path, so it can
// run before anything else is wired up.
//
// WHY THIS EXISTS
//
// Every per-restaurant path in this app falls back to something resolved
// against process.cwd(), and in that deployment every instance shares one
// cwd — the checkout:
//
//   brand.js    RESTAURANT_CONFIG unset → <checkout>/restaurace.config.js
//   db.js       SQLITE_PATH unset       → <checkout>/data/app.db
//   server.js   EET_CERT_PEM unset      → <checkout>/secrets/eet-cert.pem
//
// Forget one variable for one restaurant and nothing throws. It boots, it
// serves, and it is wrong in one of three ways that are all invisible from
// the outside:
//
//   - two restaurants that both forget SQLITE_PATH share one database,
//     merging orders, customers and staff logins;
//   - a missing RESTAURANT_CONFIG boots on built-in defaults, so the branding
//     is wrong and EVERY feature is on, including ones that customer never
//     bought;
//   - a missing EET path signs sales with another restaurant's pokladní
//     certifikát, filing them under the wrong DIČ.
//
// The rest of this codebase's config handling (see brand.js) is built on
// "fail loudly at deploy time rather than at 19:00 on Friday". These three
// paths were the hole in that. This module closes it.
//
// THE GUARD IS OPT-IN, DELIBERATELY. It activates only when
// RESTAURANT_INSTANCE is set. A single-restaurant install has always
// resolved these paths from cwd and must keep booting unchanged — making
// the checks unconditional would break every existing deployment on its
// next restart, which is a worse failure than the one being prevented.
// Setting RESTAURANT_INSTANCE is the operator saying "this process is one
// of several", and that is exactly when sharing a default becomes a bug.
// ============================================================================

const path = require("path");

// Lowercase slug: safe as a systemd instance name (restaurace@<slug>.service),
// safe in a file path, and safe in a log line. The newline case matters more
// than it looks — an instance name is echoed into the journal, and a value
// containing \n could forge a second log line.
const INSTANCE_RE = /^[a-z0-9][a-z0-9-]*$/;

function isBlank(value) {
    return typeof value !== "string" || value.trim() === "";
}

/**
 * Validates the environment of one instance.
 *
 * @param {object} env  process.env (or a stand-in, for tests)
 * @returns {{ ok: boolean, errors: string[] }} every problem at once —
 *          reporting one per restart would make bringing up a new restaurant
 *          a guessing game.
 */
function checkInstance(env) {
    const source = env || {};
    const instance = source.RESTAURANT_INSTANCE;

    // Not a named instance → single-restaurant install → today's behaviour.
    if (isBlank(instance)) return { ok: true, errors: [] };

    const errors = [];

    if (!INSTANCE_RE.test(instance)) {
        errors.push(
            `RESTAURANT_INSTANCE má být krátký název malými písmeny bez mezer ` +
            `(např. "ukalicha" nebo "u-kalicha"), nalezeno: ${JSON.stringify(instance)}`
        );
    }

    // Absolute, not merely set: a relative path still resolves against the
    // shared checkout, which is the very bug this guard exists to catch.
    const requireAbsolute = (name, why) => {
        const value = source[name];
        if (isBlank(value)) {
            errors.push(
                `${name} není nastaveno. ${why} Bez něj by se použila sdílená ` +
                `cesta v adresáři aplikace, kterou sdílejí všechny restaurace.`
            );
            return;
        }
        if (!path.isAbsolute(value.trim())) {
            errors.push(
                `${name} musí být absolutní cesta (začínat lomítkem). ` +
                `Relativní cesta se vyhodnotí vůči sdílenému adresáři aplikace, ` +
                `takže by ukazovala na data jiné restaurace. Nalezeno: ${JSON.stringify(value)}`
            );
        }
    };

    requireAbsolute("SQLITE_PATH", "Je to databáze téhle restaurace.");
    requireAbsolute("RESTAURANT_CONFIG", "Je to konfigurační soubor téhle restaurace.");

    // Only when EET is actually switched on — an instance that does not
    // report sales has no certificate to point at.
    if (source.EET_ENABLED === "true") {
        requireAbsolute("EET_CERT_PEM", "Je to pokladní certifikát téhle restaurace.");
        requireAbsolute("EET_KEY_PEM", "Je to privátní klíč k pokladnímu certifikátu téhle restaurace.");
    }

    return { ok: errors.length === 0, errors };
}

/**
 * The line(s) printed at boot. With a dozen processes writing into one
 * journal, "Server running on port 4001" identifies nothing — and this is
 * the first thing anyone reads when a restaurant phones in, so it has to
 * show which configuration actually took effect rather than which one was
 * intended.
 *
 * Reads only the named fields below. Never add a credential here: the
 * journal is not a secret store, and `journalctl` output gets pasted into
 * chats and bug reports.
 *
 * @returns {string[]} lines, ready to console.log one by one
 */
function buildBootSummary(info) {
    const i = info || {};
    const lines = [];

    const label = isBlank(i.instance) ? "" : ` [${i.instance}]`;
    lines.push(`── Restaurace${label}: ${i.brandName || "(bez názvu)"} ─────────────`);
    lines.push(`   Port:       ${i.port}   Cesta: ${i.basePath}   Časové pásmo: ${i.timezone}`);
    lines.push(`   Databáze:   ${i.dbPath}`);
    lines.push(
        `   Konfigurace: ${i.configPath}` +
        (i.configLoaded ? "" : "   ← nenačtena, běží na výchozích hodnotách")
    );

    const features = i.features || {};
    const on = Object.keys(features).filter(name => features[name] === true);
    lines.push(`   Funkce:     ${on.length ? on.join(", ") : "(žádná)"}`);

    if (i.eetEnabled) {
        lines.push(`   EET:        ZAPNUTO — ${i.eetPlayground
            ? "testovací prostředí (playground), tržby se NEevidují"
            : "OSTRÝ provoz, tržby se hlásí finanční správě"}`);
    } else {
        lines.push(`   EET:        vypnuto`);
    }

    return lines;
}

module.exports = { checkInstance, buildBootSummary };
