// ============================================================================
// restaurace.config.js — VŠECHNO, co se liší restauraci od restaurace
// ============================================================================
//
// JAK TO POUŽÍT
//   1. Zkopíruj tenhle soubor:  cp restaurace.config.example.js restaurace.config.js
//   2. Vyplň hodnoty níž.
//   3. Restartuj server.
//
// Tenhle soubor NENÍ v gitu (viz .gitignore) — každá restaurace má svůj.
//
// CO TU NENÍ: hesla a klíče. JWT_SECRET, Twilio, SMTP, GoPay a EET
// certifikáty patří do souboru `.env` (vzor je v `.env.example`). Díky tomu
// se tenhle soubor dá poslat mailem nebo ukázat zákazníkovi, aniž by na tom
// cokoli záviselo.
//
// KDYŽ TENHLE SOUBOR NEEXISTUJE, aplikace jede na výchozích hodnotách a
// funguje úplně normálně. Nic se nerozbije.
//
// KDYŽ V NĚM UDĚLÁŠ CHYBU (třeba barvu "zelená" místo "#1a5c3a"), server
// odmítne nastartovat a napíše, které pole je špatně. To je záměr — lepší
// spadnout při nasazení než v pátek večer.
// ============================================================================

module.exports = {

    // ── 1. VZHLED ───────────────────────────────────────────────────────
    brand: {
        // Celý název. Objevuje se v titulku okna na každé stránce.
        name: "Restaurace U Kalicha",

        // Krátký název vlevo nahoře na každé stránce. Držte se ~15 znaků,
        // delší se na mobilu láme.
        wordmark: "U Kalicha",

        // Hlavní barva: tlačítka, ceny, zvýraznění. Musí být #rgb nebo
        // #rrggbb — jiný zápis server odmítne.
        accent: "#1a5c3a",
        // Tmavší odstín téhle barvy, použije se při najetí myší.
        accentHover: "#14472c",
        // Velmi světlý tón téže barvy, použije se jako pozadí zvýrazněných
        // bloků. Musí být světlý, jinak na něm nebude vidět text.
        accentSoft: "#e8f1ec",

        // Aplikace pro personál (přidá se na plochu tabletu v provozovně).
        pwa: {
            name: "Pokladna — U Kalicha",
            shortName: "Pokladna",      // pod ikonou na ploše, ~12 znaků
            themeColor: "#111111",      // barva pozadí ikony a lišty
            iconLetter: "K",            // právě JEDEN znak uvnitř ikony
        },
    },

    // ── 2. ÚDAJE O FIRMĚ ────────────────────────────────────────────────
    // Tiskne se na účtenky a doplňuje se do tří právních stránek
    // (obchodní podmínky, ochrana osobních údajů, reklamační řád).
    // Majitel je pak může měnit i v admin panelu → Nastavení.
    business: {
        name: "U Kalicha s.r.o.",
        ico: "12345678",                 // přesně 8 číslic
        dic: "CZ12345678",               // "CZ" + 8 až 10 číslic, nebo "" když není plátce
        address: "Na Bojišti 12, 128 00 Praha 2",
        email: "info@ukalicha.cz",
        phone: "+420 601 234 567",

        // true = plátce DPH (na účtence bude rozpis DPH).
        // false = na účtence bude "Nejsme plátci DPH" a žádný rozpis.
        vatPayer: true,

        // Datum účinnosti právních stránek, "RRRR-MM-DD". Nech "" a doplní
        // se dnešní datum — jenže pak se každý den mění. Až text projde
        // právník, nastav sem pevné datum.
        termsEffectiveDate: "2026-09-01",
    },

    // ── 3. CO SI TAHLE RESTAURACE KOUPILA ───────────────────────────────
    // false = stránka vrací 404, API odmítá, záložka v panelu zmizí.
    // Aspoň jedna musí být true.
    features: {
        reservations:  true,   // rezervace stolů na webu
        delivery:      true,   // rozvoz + stránka pro řidiče
        tableOrdering: true,   // QR kódy na stolech, host si objedná sám
        pos:           true,   // pokladna, obsluha stolů, přehled prodejů
        dailyMenu:     true,   // polední menu
        eet:           false,  // hlášení tržeb finanční správě
    },

    // ── 4. VÝCHOZÍ HODNOTY ──────────────────────────────────────────────
    // POZOR: tohle se použije JEN při úplně prvním spuštění na prázdné
    // databázi. Jakmile majitel něco změní v panelu → Nastavení, platí jeho
    // hodnota a tenhle soubor už do toho nemluví — ani po aktualizaci.
    //
    // Otevírací doba, svátky, půdorys místností a SMS přepínače se nastavují
    // v panelu, ne tady.
    defaults: {
        delivery: {
            fee: 59,                      // poplatek za dovoz v Kč
            minOrder: 250,                // pod tuhle částku objednávku nevezme
            freeAbove: 700,               // nad tuhle částku je dovoz zdarma (0 = nikdy)
            pscWhitelist: ["12000", "12800"], // kam rozvážíme; prázdné pole = všude
            etaMinutes: 45,               // orientační doba doručení
        },
        dailyMenu: {
            from: "11:00",
            to: "14:00",
        },
    },

    // ── 5. TECHNICKÉ ────────────────────────────────────────────────────
    server: {
        // Cesta, pod kterou aplikace běží. Měň jen když víš proč — musí
        // začínat lomítkem a nesmí jím končit.
        basePath: "/reservation",
    },
};

// ============================================================================
// CO TENHLE SOUBOR UDĚLAT NEMŮŽE — projdi po nasazení ručně
// ============================================================================
//
//   1. Vytvořit přihlášení pro majitele: v tomhle repozitáři NENÍ žádný
//      hotový skript, který by to udělal za tebe. Postup je v README.md,
//      sekci „The first admin account": buď obnov databázi, která už účet
//      obsahuje, nebo vlož záznam do kolekce `users` ručně s bcrypt hashem
//      hesla (README má přesný tvar záznamu i příklad, kde ho v kódu najít).
//   2. Naimportovat jídelní lístek:       panel → Menu
//   3. Nakreslit rozložení stolů:         panel → Rozložení
//   4. Převést EET certifikát .p12 → PEM: PRED-NAHRANIM.md, sekce „EET 2.0
//      před spuštěním" (úplně na konci souboru), první bod.
//   5. Vytisknout QR kódy ke stolům (jen když je v Nastavení zapnuté
//      "Povolit objednávky u stolu", tj. features.tableOrdering: true výš):
//      panel → Rozložení → tlačítko "Tisknout QR kódy všech stolů".
//   6. Projít zbytek EET kontrolního seznamu před ostrým spuštěním (ID
//      jednotky, přepnutí z playground na ostré prostředí, testovací
//      tržba, text účtenky, sledování logů): tamtéž, celá sekce „EET 2.0
//      před spuštěním" — zbytek PRED-NAHRANIM.md se týká jednorázové
//      přípravy původního repozitáře pro nahrání na GitHub, ne nasazení
//      u zákazníka, a s tímhle krokem nesouvisí.
//
// ============================================================================
