# Jedna konfigurační složka pro každou restauraci — návrh

_2026-08-06. Cíl: nasadit tuhle aplikaci další restauraci znamená vyplnit
jeden soubor, ne prohledávat dvacet._

## 1. Problém

Dnes jsou hodnoty specifické pro konkrétní restauraci roztroušené na čtyřech
místech a tři z nich se navzájem překrývají:

| Kde | Co tam je | Jak se to mění |
|---|---|---|
| `.env` | tajné klíče, `BUSINESS_NAME`/`ICO`/`DIC`/`ADDRESS`, Twilio, SMTP, GoPay, EET, `TZ`, `PORT` | editace souboru |
| DB (`settings/restaurant`) | otevírací doba, poplatek za rozvoz, minimální objednávka, PSČ, ETA, polední menu, SMS přepínače, půdorys | klikání v panelu |
| Natvrdo v kódu | wordmark `Restaurace` (8× HTML), `<title>`, akcentní barva `#e30613`, `manifest.json`, `basePath: "/reservation"`, `/reservation/` v `<script src>` | editace kódu |
| Jen DB | menu, kombinace, stoly, účty personálu | admin UI / skript |

Identita podniku existuje **dvakrát** (`.env` i panel), a nic je nedrží
v souladu: účtenky čtou `.env`, právní stránky čtou panel. Přejmenování
restaurace v panelu tiše nechá staré jméno na účtenkách.

## 2. Řešení

Nový soubor **`restaurace.config.js`** v kořeni repozitáře. Není v gitu
(stejně jako `.env`); vedle něj je commitnutý plně vyplněný
`restaurace.config.example.js`, který se kopíruje pro každého zákazníka.

**Klíčová vlastnost, na které stojí celý návrh: když soubor neexistuje,
aplikace se chová přesně jako dnes.** Loader spadne zpět na současné
natvrdo zapsané hodnoty. Díky tomu existující nasazení ani stávající testy
nepoznají, že se něco změnilo.

### 2.1 Tvar souboru

```js
module.exports = {
  // ── 1. BRANDING ────────────────────────────────────────────
  brand: {
    name:        "Restaurace U Kalicha",  // celé jméno, <title> stránek
    wordmark:    "U Kalicha",             // krátké, vlevo nahoře na každé stránce
    accent:      "#1a5c3a",               // hlavní barva (tlačítka, ceny)
    accentHover: "#14472c",               // tmavší odstín pro hover
    accentSoft:  "#e8f1ec",               // světlý tón pro pozadí
    pwa: { name: "Pokladna — U Kalicha", shortName: "Pokladna",
           themeColor: "#111111", iconLetter: "K" },
  },

  // ── 2. PRÁVNÍ IDENTITA (účtenky + 3 právní stránky) ────────
  business: {
    name: "U Kalicha s.r.o.", ico: "12345678", dic: "CZ12345678",
    address: "Na Bojišti 12, 128 00 Praha 2",
    email: "info@ukalicha.cz", phone: "+420 601 234 567",
    vatPayer: true, termsEffectiveDate: "2026-09-01",
  },

  // ── 3. CO SI ZÁKAZNÍK KOUPIL ───────────────────────────────
  features: { reservations: true, delivery: true, tableOrdering: true,
              pos: true, dailyMenu: true, eet: false },

  // ── 4. VÝCHOZÍ HODNOTY (majitel je pak mění v panelu) ──────
  defaults: {
    delivery: { fee: 59, minOrder: 250, freeAbove: 700,
                pscWhitelist: ["12000", "12800"], etaMinutes: 45,
                days: { "0": { open: true, from: "10:30", to: "21:00" }, /* … */ } },
    reservations: { days: { "0": { open: true, fromHour: 1, toHour: 12 }, /* … */ } },
    tableOrdering: { days: { /* … */ } },
    dailyMenu: { from: "11:00", to: "14:00" },
    notifications: { smsOrderConfirmed: true, smsReservationReminder: false, /* … */ },
    floorplan: { rooms: [ /* tvary místností — nebo [] a nakreslit v panelu */ ] },
  },

  // ── 5. TECHNICKÉ ───────────────────────────────────────────
  server: { basePath: "/reservation" },
};
```

Skutečný soubor má nad každým polem český komentář: co dělá, co se stane při
špatné hodnotě. Na konci je komentářový checklist šesti věcí, které soubor
udělat nemůže (§7).

### 2.2 Co do souboru nepatří

**Tajné hodnoty zůstávají v `.env`.** `JWT_SECRET`, Twilio, SMTP, GoPay, cesty
k EET certifikátům. Tenhle soubor je tím pádem bez tajemství — dá se poslat
mailem, ukázat zákazníkovi, commitnout omylem bez následků. `.env` zůstává
jediné místo, kde únik něco stojí.

**Provozní ladění zůstává v `.env`**: `SMS_DAILY_CAP`, `LOGIN_LOCKOUT_*`,
`LOGIN_AUDIT_*`, `RESERVATION_REMINDER_INTERVAL_MS`, `SQLITE_PATH`, `PORT`, `TZ`.
Nemění se od restaurace k restauraci, mění se podle hostingu.

## 3. Přednost: config seeduje, panel pak vyhrává

Pro cokoliv, co má obrazovku v admin panelu (doba, poplatky, PSČ, půdorys,
SMS přepínače), platí:

```
Prázdná DB   → zapíše se config.defaults          → DB = 59
Majitel v panelu změní na 65                      → DB = 65
Nasadíš novou verzi                               → DB zůstává 65
```

Realizace: `initializeData()` dostane jeden blok — **pokud v DB vůbec není
záznam settings**, zapíše se `config.defaults`. Existující instalace záznam
mají, takže se jich to nikdy nedotkne.

Pro věci, které panel nemá (branding, barvy, `basePath`, PWA, feature
přepínače), se config aplikuje při **každém startu**. Není s čím kolidovat.

### 3.1 Identita podniku — sjednocení

`config.business` se stává primárním zdrojem. `SERVER_CONFIG.business`
v `server.js` ho čte místo dnešních natvrdo zapsaných výchozích hodnot;
proměnné `BUSINESS_*` z `.env` **stále přebíjejí**, pokud jsou nastavené,
takže současné nasazení se nerozbije. Zároveň `config.business` seeduje
`settings.business` v DB, takže právní stránky i účtenky startují ze stejné
hodnoty.

Rozpor "účtenky čtou `.env`, právní stránky čtou panel" tímhle **nemizí** —
jen startuje ze stejného místa. Skutečné sjednocení (aby účtenky četly panel)
je samostatná změna a do tohohle návrhu nepatří; je zaznamenané v §8.

## 4. Loader — `src/server/brand.js` (nový)

Jediná nová serverová jednotka. Stejný „black box" vzor jako `settings.js`
nebo `validation.js`: závisí jen na `settings.mergeDefaults`, nic si nedrží
o zbytku aplikace.

Odpovědnost:

1. `require()` konfiguračního souboru; když neexistuje, prázdný objekt.
   Cesta je `<cwd>/restaurace.config.js`, přebitelná proměnnou
   **`RESTAURANT_CONFIG`** (absolutní cesta). Ta existuje kvůli smoke testům —
   harness spouští server s `cwd` = kořen repozitáře, takže bez přepínače by
   test musel zapisovat konfigurační soubor do skutečného repozitáře. Hodí se
   i v provozu, když jeden stroj hostí víc instancí.
2. Hloubkový merge přes vestavěné výchozí hodnoty (= dnešní chování) pomocí
   `mergeDefaults()`, které `settings.js` už má. Starší config soubor,
   kterému chybí nově přidaný klíč, tak funguje dál.
3. Validace. Při nevalidní hodnotě **server odmítne nastartovat** s českou
   hláškou, která jmenuje konkrétní pole. Hlasitá chyba při startu je lepší
   než zjištění v pátek v 19:00.
   - `brand.accent` / `accentHover` / `accentSoft`: `#` + 3 nebo 6 hex znaků
   - `brand.wordmark`, `brand.name`: neprázdný string
   - `brand.pwa.iconLetter`: právě 1 znak
   - `server.basePath`: začíná `/`, nekončí `/`
   - `features.*`: boolean; **aspoň jedna zapnutá**
   - `business.ico`: 8 číslic; `business.dic`: prázdné nebo `CZ` + 8–10 číslic
   - `business.termsEffectiveDate`: prázdné nebo `YYYY-MM-DD`
   - `defaults.delivery.pscWhitelist`: pole stringů z 5 číslic
   - `defaults.delivery.fee` / `minOrder` / `freeAbove` / `etaMinutes`: celá
     nezáporná čísla
4. Export zmrazeného objektu (`Object.freeze`, rekurzivně) + dvou pomocných
   funkcí: `renderTokens(raw)` a `styleTag()`.

## 5. Cesta do prohlížeče

Vaše CSP je `script-src 'self'` s hashem účtenkového skriptu a **bez**
`'unsafe-inline'` (`server.js`, `configureCsp()`). Vložit `<script>` s
konfigurací tedy nejde. `style-src` naopak `'unsafe-inline'` má. Z toho
plynou tři kanály:

**HTML.** Osm stránek dnes odchází přes `res.sendFile`. Přejdou na stejné
`{{TOKEN}}` renderování, jaké už používají právní stránky
(`makeLegalPageRoute`): `{{WORDMARK}}`, `{{BRAND_NAME}}`, `{{BASE}}`,
`{{BRAND_STYLE}}`. Token `{{BASE}}` zároveň řeší natvrdo zapsané
`/reservation/` v každém `<script src>`.

**Barva.** `{{BRAND_STYLE}}` se rozvine na `<style>` v `<head>`, který
přepisuje `--ds-accent`, `--ds-accent-hover`, `--ds-accent-soft`. Neupravuje
se `design.css` — ten se při odesílání minifikuje a cachuje, a hlavně by to
znamenalo ručně editovat CSS pro každého zákazníka.

**Feature přepínače pro JS.** `src/config.js` už každá stránka načítá. Stane
se z něj šablona odesílaná s rozvinutými tokeny, která vystaví
`window.APP_FEATURES` a `window.APP_BRAND`. Stejný postup, jaký už používá
`sw.js` s `__BASE_PATH__` — existující vzor, ne nový.

### 5.1 Únik nevyrenderovaných šablon

`express.static` obsluhuje `src/html/` celé, takže syrová šablona by byla
dosažitelná na `/reservation/html/index.html` s doslovným `{{WORDMARK}}`.
Kód tohle už blokuje přesně pro 3 právní stránky (`blockRawLegalTemplate`);
seznam se rozšíří na všech 8 souborů.

## 6. Feature přepínače

| Vypnuto | Účinek |
|---|---|
| `reservations` | `/app` vrací 404, rezervační API routy 404, odkazy skryté |
| `delivery` | `/delivery` i `/driver` 404, `POST /api/orders` 404 |
| `tableOrdering` | `/stul/:token` 404, `POST /table-orders` 404, QR záložka skrytá |
| `dailyMenu` | záložka poledního menu i API skryté |
| `eet` | vynutí `EET_ENABLED=false`, health endpoint skrytý |
| `pos` | skryje záložky Detail stolu / Objednat ke stolu / Prodeje, blokuje offline-sale routy |

Dvě vědomá omezení:

**`pos: false` nemůže vrátit 404 na `inner.html`**, protože tatáž stránka je
i admin panel, kde se spravuje menu, uživatelé a nastavení. Panel proto
zůstává dostupný vždy (rozhodnutí majitele, 2026-08-06).

**Kuchyňská tabule NENÍ vázaná na `pos`.** `GET /kitchen/orders` obsluhuje
objednávky od stolu i rozvozové (`kitchen-board.js`), takže `/kitchen` a jeho
routy jsou dostupné, pokud je zapnuté **kterékoli** z `pos`, `delivery`,
`tableOrdering`. Vypnou se, teprve když jsou vypnuté všechny tři.

API odmítá s **404, ne 403**. Vypnutá funkce nemá oznamovat, že existuje.

Realizace: jedno middleware `requireFeature("delivery")` (přijímá i seznam ve
smyslu „aspoň jedna z"), nasazené na skupiny rout, plus podmíněná registrace
stránkových rout.

### 6.1 Odkazy na vypnuté stránky

Jediné odkazy mezi stránkami vedou z právních stránek na `/reservation/app`
(`obchodni-podminky.html`, `ochrana-osobnich-udaju.html`, `reklamace.html`,
každá 2×). Při `reservations: false` by vedly na 404. Přidává se token
`{{HOME}}`, který se rozvine na první zapnutou stránku v pořadí
rezervace → rozvoz → panel.

## 7. Co soubor udělat nemůže

Komentářový checklist na konci `restaurace.config.example.js`:

1. Vytvořit admin účet (`deploy/create-admin.js`)
2. Naimportovat menu (admin panel → Menu)
3. Nakreslit půdorys, pokud se nezkopíroval z jiné restaurace (panel → Rozložení)
4. Převést EET certifikát `.p12` → PEM (viz `PRED-NAHRANIM.md`)
5. Vytisknout a rozmístit QR kódy ke stolům (panel)
6. Projít go-live kontrolu podle `PRED-NAHRANIM.md`

## 8. Co tenhle návrh vědomě neřeší

- **Mřížka rezervačních hodin.** `fromHour: 1, toHour: 12` znamená 8:00–20:00;
  rozsah je zadrátovaný v `RESERVATION_HOURS` v `renderer.js`. Restaurace
  otevřená do půlnoci se tím vyjádřit nedá. Samostatná změna.
- **Účtenky vs. panel.** Viz §3.1 — účtenky dál čtou `SERVER_CONFIG.business`,
  ne živý panel.
- **Vlastní logo / obrázky.** Jen textový wordmark. PWA ikona je generovaná
  SVG s jedním písmenem.
- **Jazykové mutace.** UI zůstává česky.
- **Víc restaurací v jednom procesu.** Jeden proces = jedna restaurace,
  stejně jako dnes.

## 9. Dotčené soubory

**Nové (3):** `restaurace.config.example.js`, `src/server/brand.js`,
`tests/unit/brand.test.js`

**Změněné (15):** `src/server/server.js` (zdroj `basePath`, zdroj `business`,
8 stránkových rout, feature middleware, seedování, `manifest.json` routa),
`src/config.js`, `src/manifest.json`, `src/js/inner.js`,
`src/html/*.html` (8×), `.gitignore`, `.env.example`, `README.md`

`src/js/renderer.js` a `src/js/delivery.js` se **nemění** — mezi stránkami
nevedou žádné odkazy, které by generovaly (viz §6.1).

## 10. Ověření

- `npm run test:unit` a `npm run test:smoke` **beze změny a zeleně**, když
  konfigurační soubor neexistuje. Tohle je hlavní důkaz, že fallback funguje —
  harness spouští skutečný server, takže testy projdou celou cestou.
- Nové unit testy v `brand.test.js`: merge částečného configu, každé
  validační pravidlo (validní i nevalidní vstup), zmrazení objektu,
  chybějící soubor.
- Nový smoke test: server nastartovaný s konfiguračním souborem, který má
  `delivery: false`, vrací 404 na `/delivery` i na `POST /api/orders`, a
  přitom `/app` normálně funguje.
- Ruční kontrola: nastartovat s vyplněným configem a očima ověřit wordmark,
  barvu a `<title>` na všech 8 stránkách.
