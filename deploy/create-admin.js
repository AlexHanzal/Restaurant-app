// ============================================================================
// deploy/create-admin.js — creates a staff account with isAdmin:true directly
// in SQLite, for the one moment the admin panel cannot help: a brand-new
// install with no admin yet.
//
// THE GAP THIS CLOSES (finding L3): initializeData() in src/server/server.js
// seeds the menu, combos and settings singletons on a fresh database, but
// never a user. The only write to the `users` collection is POST /api/users,
// and that route sits behind requireAdmin (src/server/server.js, "-- USERS
// --" section) -- a completely empty database has no admin to satisfy that
// guard, so there is no way in through the API at all. Before this script,
// the only fix was hand-writing a bcrypt hash into SQLite with a Node
// one-liner, which is exactly the kind of step that quietly diverges from
// what the app actually does (see the record shape below) the day someone
// forgets to keep it in sync by hand. README.md's "The first admin account"
// section used to document that workaround; it now documents this script.
//
// Deliberately reuses src/server/db.js instead of talking to SQLite
// directly, for the same reason deploy/seed-floorplan.js does (see its own
// header): the `records` table shape and its migration live in ONE place,
// and a second hand-rolled writer here could not help but drift from it --
// the JSON `data` column, the generated/indexed columns in db.js's
// migrate(), all of it. Same category of tool as seed-floorplan.js: a one-
// off operator command run by hand from the project root, not wired into
// any request path.
//
// Usage:
//   node deploy/create-admin.js
//   node deploy/create-admin.js --name "Jana Novakova" --abbreviation jn
//   node deploy/create-admin.js --help
//
// The password is NEVER accepted as a command-line argument -- see
// PASSWORD_ARG_PATTERN below for why -- only via an interactive prompt (echo
// suppressed) or the CREATE_ADMIN_PASSWORD environment variable for
// unattended installs (a deploy pipeline that already pulled the password
// from a secrets manager, not a human typing it into a shell).
// ============================================================================

const crypto = require("crypto");
const readline = require("readline");
const { parseArgs } = require("util");
const bcrypt = require("bcryptjs");
const db = require("../src/server/db");

// Mirrored from server.js's SERVER_CONFIG.collections.users, the same way
// auth.js's ACCOUNT_COLLECTIONS and harness.js's COL are -- server.js is the
// application's entrypoint (it calls app.listen() at module load, starts a
// real server the instant it's required), so nothing in it can be required
// from a standalone CLI script the way db.js's pure storage layer can.
const COL_USERS = "users";

// Mirrors BCRYPT_COST in src/server/auth.js. Not imported from there:
// auth.js's module load resolves JWT_SECRET (and throws outright if
// NODE_ENV=production and none is set -- see resolveJwtSecret()) and picks
// the session-cookie name, neither of which this script needs. Requiring it
// here would make "create the first admin" fail on a secret that exists for
// a completely unrelated purpose. If BCRYPT_COST ever changes in auth.js,
// change it here too -- the comment there points back at this file.
const BCRYPT_COST = 12;

// Mirrors generateFileId() in src/server/server.js exactly: same charset,
// same length, same CSPRNG call (crypto.randomInt, not Math.random() -- see
// that function's own SECURITY comment on why predictability matters for
// ids that end up embedded in URLs elsewhere in the app). server.js cannot
// be required from here (see COL_USERS above), so this is a deliberate
// duplication, not an oversight -- keep it in sync if generateFileId() ever
// changes, or an admin created by this script would carry an id in a shape
// POST /api/users would never actually produce.
const ID_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
function generateId(length = 12) {
    let out = "";
    for (let i = 0; i < length; i++) out += ID_CHARS[crypto.randomInt(0, ID_CHARS.length)];
    return out;
}

// -- ACCOUNT CREATION (the part tests import directly) --------------------
//
// Same shape POST /api/users produces (src/server/server.js), field for
// field: `id`, `name`, `abbreviation`, `password` (bcrypt hash, never the
// plaintext), `isAdmin`, `isDriver`, `createdAt`. isAdmin is always true and
// isDriver always false here -- this script exists to create an ADMIN, not a
// general staff account; POST /api/users (once an admin exists to call it)
// already covers every other combination.
//
// Bounds mirror validation.js's createUserSchema (reqStr(150)/reqStr(100)/
// passwordSchema(200, 4, ...)) so this script can never write a record the
// live app's own validation would have rejected at creation time.
//
// Returns { ok: true, user } (password stripped, same as every route in
// server.js that echoes a user back) or { ok: false, error } with a Czech
// message. Never throws for a bad/duplicate input -- only for a genuine
// storage failure -- so the CLI wrapper's error handling stays a single path.
async function createAdmin({ name, abbreviation, password }) {
    const trimmedName = typeof name === "string" ? name.trim() : "";
    const trimmedAbbr = typeof abbreviation === "string" ? abbreviation.trim() : "";

    if (!trimmedName) return { ok: false, error: "Jméno je povinné." };
    if (trimmedName.length > 150) return { ok: false, error: "Jméno je příliš dlouhé (max 150 znaků)." };
    if (!trimmedAbbr) return { ok: false, error: "Zkratka je povinná." };
    if (trimmedAbbr.length > 100) return { ok: false, error: "Zkratka je příliš dlouhá (max 100 znaků)." };
    if (typeof password !== "string" || password.length < 1) return { ok: false, error: "Heslo je povinné." };
    if (password.length < 4) return { ok: false, error: "Heslo je příliš krátké (min. 4 znaky)." };
    if (password.length > 200) return { ok: false, error: "Heslo je příliš dlouhé (max 200 znaků)." };

    // `abbreviation` is the login identifier (POST /users/login looks a user
    // up by it -- src/server/server.js -- via db.findBy(COL.users,
    // "abbreviation", ...), which returns exactly ONE record). Two rows
    // sharing one makes login ambiguous: whichever row db.findBy's "oldest
    // row wins" tie-break happens to return is the only one that can ever
    // log in, silently locking out whoever holds the other account's
    // password. This codebase has already been bitten by exactly this shape
    // of bug once, with duplicate timetable className values (see db.js's
    // findBy() header) -- refuse it here before it can happen to logins too.
    if (db.findBy(COL_USERS, "abbreviation", trimmedAbbr)) {
        return { ok: false, error: `Účet se zkratkou "${trimmedAbbr}" už existuje. Zkratka musí být jedinečná, protože se používá jako přihlašovací jméno.` };
    }

    const hashed = await bcrypt.hash(password, BCRYPT_COST);
    const user = {
        id: generateId(),
        name: trimmedName,
        abbreviation: trimmedAbbr,
        password: hashed,
        isAdmin: true,
        isDriver: false,
        createdAt: new Date().toISOString(),
    };
    db.set(COL_USERS, user.id, user);

    const { password: _discard, ...safe } = user;
    return { ok: true, user: safe };
}

// Every existing admin in the database, for the "you already have one, are
// you sure?" check in the CLI below. Not exported for any deeper reason than
// that the CLI needs it too and re-deriving it there would just be
// db.list(COL_USERS).filter(...) copy-pasted twice.
function listAdmins() {
    return db.list(COL_USERS).filter(u => u && u.isAdmin);
}

// -- CLI WRAPPER (argument parsing, prompting, printing -- no logic of its
// own) -----------------------------------------------------------------

// SECURITY: the password must never arrive as argv. Two independent, both
// sufficient reasons: (1) most shells persist argv into a history file
// (~/.bash_history and equivalents) that outlives the terminal session, and
// (2) while the process runs, its full command line -- including this
// argument -- is visible to every other user on the machine via `ps aux` /
// Task Manager / `/proc/<pid>/cmdline`, not just the one who ran it. Both
// are real on the box this app deploys to: "one machine can run several
// restaurants from one checkout" (see the SQLITE_PATH section below) means
// other logins on that machine are the expected case, not a hypothetical
// one. Matches --password, --pass, --p, and the short forms, with or
// without an `=value` -- broad on purpose, because a narrow pattern only
// catches the one spelling it was written for.
const PASSWORD_ARG_PATTERN = /^--?(password|pass|p)(=.*)?$/i;

function printHelp() {
    console.log(`
Založí administrátorský účet přímo v databázi -- pro instalace, kde ještě
žádný účet neexistuje a přihlášení do administrace (a tedy i "Uživatelé",
kudy se jinak účty zakládají) proto není možné.

Použití:
  node deploy/create-admin.js [--name "Jméno"] [--abbreviation zkratka] [--force]
  node deploy/create-admin.js --help

Volby:
  --name           Jméno administrátora. Bez této volby se skript zeptá.
  --abbreviation   Přihlašovací zkratka (musí být jedinečná). Bez této
                   volby se skript zeptá.
  --force          Nezastavovat se na potvrzení, i když v databázi už
                   nějaký administrátorský účet existuje.
  --help, -h       Zobrazí tuhle nápovědu.

Heslo:
  Heslo se NIKDY nezadává jako argument příkazové řádky -- zůstalo by v
  historii shellu a bylo by vidět v seznamu procesů. Skript se na něj zeptá
  interaktivně (bez zobrazování na obrazovce, zadává se dvakrát kvůli
  překlepu), nebo pro neobsluhovanou instalaci nastavte proměnnou prostředí
  CREATE_ADMIN_PASSWORD.

Databáze:
  Skript zapisuje do databáze podle proměnné prostředí SQLITE_PATH -- přesně
  jako běžící server (src/server/db.js). Cesta se vždy vypíše před jakýmkoli
  zápisem: jeden stroj může obsluhovat víc restaurací, každou s vlastní
  databází, a založení účtu v té nesprávné by si nikdo hned nevšiml.

Příklad:
  SQLITE_PATH=/srv/restaurace-brno/data/app.db node deploy/create-admin.js
`.trim() + "\n");
}

// Plain (echoed) prompt -- used for name/abbreviation/confirmation, none of
// which are secret.
function promptVisible(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer);
        });
    });
}

// Hidden (echo-suppressed) prompt -- used for the password only. There is no
// built-in Node API for this; the standard workaround is raw-mode stdin with
// manual line handling, which is what this is. Falls back to a plain (still
// non-secret-persisting, just visible) prompt when stdin is not a TTY --
// piped input has nothing to "suppress" on screen, and setRawMode does not
// exist on a non-TTY stream at all.
//
// Control bytes are recognized by CODE POINT (charCodeAt), never by
// embedding the raw control character as a string literal in source -- some
// editors/tools in a typical deploy pipeline normalize or strip literal
// control bytes on save, which would silently turn e.g. the Ctrl-C case
// into an empty string that matches everything. Numeric comparison has no
// such failure mode.
const CODE_CR = 13; // Enter -- raw-mode stdin delivers it as CR, not LF
const CODE_LF = 10; // accepted too, in case a platform differs
const CODE_EOF = 4; // Ctrl-D
const CODE_INTERRUPT = 3; // Ctrl-C
const CODE_BACKSPACE = 8; // \b, some terminals
const CODE_DELETE = 127; // DEL, what most terminals actually send for backspace

function promptHidden(question) {
    if (!process.stdin.isTTY) return promptVisible(question);

    return new Promise((resolve) => {
        process.stdout.write(question);
        const stdin = process.stdin;
        let input = "";

        function cleanup() {
            stdin.setRawMode(false);
            stdin.pause();
            stdin.removeListener("data", onData);
        }

        function onData(chunk) {
            const char = chunk.toString("utf8");
            const code = char.charCodeAt(0);

            if (code === CODE_CR || code === CODE_LF || code === CODE_EOF) {
                cleanup();
                process.stdout.write("\n");
                resolve(input);
                return;
            }
            if (code === CODE_INTERRUPT) {
                cleanup();
                process.stdout.write("\n");
                process.exit(130);
                return;
            }
            if (code === CODE_BACKSPACE || code === CODE_DELETE) {
                input = input.slice(0, -1);
                return;
            }
            input += char;
        }

        stdin.setRawMode(true);
        stdin.resume();
        stdin.setEncoding("utf8");
        stdin.on("data", onData);
    });
}

async function promptPasswordWithConfirmation() {
    for (let attempt = 1; attempt <= 3; attempt++) {
        const first = await promptHidden("Heslo: ");
        const second = await promptHidden("Heslo znovu: ");
        if (first === second) return first;
        console.error(`Hesla se neshodují, zkuste to znovu (pokus ${attempt}/3).`);
    }
    console.error("Heslo se třikrát neshodlo. Ukončuji bez založení účtu.");
    process.exit(1);
}

async function runCli() {
    const rawArgs = process.argv.slice(2);

    if (rawArgs.some((a) => PASSWORD_ARG_PATTERN.test(a))) {
        console.error(
            "Heslo se nesmí předávat jako argument příkazové řádky (--password / -p) --\n" +
            "zůstalo by v historii shellu a bylo by vidět v seznamu procesů komukoli\n" +
            "dalšímu na tomto stroji. Spusťte skript bez této volby: zeptá se hesla\n" +
            "interaktivně, nebo pro neobsluhovanou instalaci nastavte proměnnou\n" +
            "prostředí CREATE_ADMIN_PASSWORD."
        );
        process.exit(1);
    }

    let parsed;
    try {
        parsed = parseArgs({
            args: rawArgs,
            options: {
                name: { type: "string" },
                abbreviation: { type: "string" },
                force: { type: "boolean", default: false },
                help: { type: "boolean", short: "h", default: false },
            },
            allowPositionals: false,
        });
    } catch (e) {
        console.error(`Neplatné argumenty: ${e.message}`);
        printHelp();
        process.exit(1);
        return;
    }

    if (parsed.values.help) {
        printHelp();
        return;
    }

    // Printed FIRST, before any prompt or write -- see the "Databáze" section
    // of --help for why: silently creating an admin in the wrong
    // restaurant's database is exactly the failure this guards against.
    console.log(`Databáze: ${db.DB_PATH}`);

    // SECOND ADMIN GUARD -- decision and reasoning:
    //
    // This script is deliberately NOT limited to "only when the database has
    // zero users". A hard block there would defeat the other real use of a
    // CLI account-creation tool: break-glass recovery when the sole existing
    // admin is locked out (forgotten password, `active` flipped to false by
    // a fat-fingered click, JWT_SECRET rotated) -- the admin panel cannot
    // recover from any of those, and this script is then the ONLY way in,
    // exactly as it is on a genuinely empty database.
    //
    // What it does instead: if any admin already exists, say so out loud and
    // require an explicit confirmation before writing -- because the far more
    // likely reason to see this warning is not "recovery", it's "SQLITE_PATH
    // pointed at the wrong restaurant's database" (see the multi-restaurant
    // note above), and a second admin quietly appearing in someone else's
    // database is a bad way to discover that. --force skips the prompt for
    // scripted/unattended runs that have already made that judgment call.
    const existingAdmins = listAdmins();
    if (existingAdmins.length > 0 && !parsed.values.force) {
        console.warn(
            `Pozor: v této databázi už existuje ${existingAdmins.length} ` +
            `administrátorský účet (${existingAdmins.map((a) => a.abbreviation).join(", ")}).`
        );
        console.warn(
            "Tenhle skript je určený hlavně pro založení PRVNÍHO účtu při instalaci. " +
            "Pokud administrátor jen zapomněl heslo nebo je omylem deaktivovaný, zvažte " +
            "spíš opravu jeho účtu. Pokud je tohle skutečně nová instalace, zkontrolujte " +
            "prosím cestu k databázi výše -- jedno zařízení může obsluhovat víc restaurací."
        );

        if (process.env.CREATE_ADMIN_PASSWORD) {
            // Unattended run: no human at a keyboard to answer "ano", and
            // hanging on stdin forever would just look like a stuck deploy.
            // Fail loudly instead of silently blocking.
            console.error('Neobsluhovaný běh (CREATE_ADMIN_PASSWORD nastaveno) s existujícím administrátorem vyžaduje --force.');
            process.exit(1);
        }

        const answer = await promptVisible('Pokračovat a založit další administrátorský účet? Napište "ano": ');
        if (answer.trim().toLowerCase() !== "ano") {
            console.log("Zrušeno, nic nezapsáno.");
            process.exit(1);
        }
    }

    const name = parsed.values.name && parsed.values.name.trim()
        ? parsed.values.name
        : await promptVisible("Jméno: ");
    const abbreviation = parsed.values.abbreviation && parsed.values.abbreviation.trim()
        ? parsed.values.abbreviation
        : await promptVisible("Přihlašovací zkratka: ");

    let password = process.env.CREATE_ADMIN_PASSWORD;
    if (password) {
        console.log("Heslo načteno z proměnné prostředí CREATE_ADMIN_PASSWORD.");
    } else {
        password = await promptPasswordWithConfirmation();
    }

    const result = await createAdmin({ name, abbreviation, password });
    if (!result.ok) {
        console.error(`Chyba: ${result.error}`);
        process.exit(1);
        return;
    }

    console.log(`Hotovo. Administrátorský účet "${result.user.abbreviation}" (${result.user.name}) je založen a může se přihlásit.`);
}

// Guarded so `require("./create-admin")` (the tests) never launches prompts
// or calls process.exit -- only running this file directly does that. Same
// reasoning as any other file in this codebase that separates its testable
// core from its I/O shell.
if (require.main === module) {
    runCli().catch((e) => {
        console.error("Neočekávaná chyba:", e);
        process.exit(1);
    });
}

module.exports = { createAdmin, listAdmins, generateId, COL_USERS };
