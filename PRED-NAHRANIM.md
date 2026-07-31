# Před nahráním na GitHub — co je uvnitř a co musíš zkontrolovat

_Připraveno 2026-07-29. Cílem je **privátní** repozitář._

Tahle složka je připravená k nahrání. **Ale nenahrávej ji, dokud nevyřešíš sekci „Musíš zkontrolovat sám" níže** — jsou v ní soubory, které jsem nedokázal přečíst, takže nemůžu zaručit, že v nich nejsou hesla.

---

## Co JE uvnitř (59 souborů, vše přečteno a ověřeno)

| Co | Poznámka |
|---|---|
| `src/` | Celá aplikace — server, frontend, CSS, fonty. Proskenováno na natvrdo zapsaná hesla/klíče: **čisté**, všechny tajné hodnoty se čtou z `process.env`. |
| `package.json` | Beze změny. |
| `package-lock.json` | **Vygenerovaný znovu** — ten původní je v OneDrivu jen „cloud stub" a nejde přečíst. Nový vznikl z tvého `package.json`, takže odpovídá stejným verzím. |
| `.gitignore` | Nová verze — vylučuje `data/`, `*.db*`, `.env*`, `node_modules/`. |
| `.env.example` | **Nově vygenerovaný.** Původní `deploy/env.example` nejde přečíst, tak jsem udělal nový: prošel jsem všechna `process.env.*` v kódu, takže je kompletní. Obsahuje jen zástupné hodnoty. |
| `tests/unit/` | Dva nové unit testy (`urlsafe`, `smscap`) — 21 testů, všechny procházejí. |
| `docs/` | Bezpečnostní audit + plán oprav + 4 starší návrhové dokumenty, které šly přečíst. |
| `deploy/seed-floorplan.js` | Jediný soubor z `deploy/`, který šel přečíst. |
| `.impeccable/config.json` | Konfigurace nástroje, neškodná. |

---

## Co jsem ZÁMĚRNĚ vynechal

### `data/` — nikdy to nenahrávej

Obsahuje `app.db` + zálohy: **jména zákazníků, adresy, telefonní čísla, historii objednávek a bcrypt hashe hesel personálu.**

I do privátního repozitáře to nepatří. Privátní repozitář se sdílí, klonuje na notebooky, přidávají se do něj lidé — a jakmile se něco commitne, zůstává to v historii navždy, i když soubor později smažeš. Navíc máš na webu stránku o ochraně osobních údajů; kopie zákaznické databáze v gitu je přesně to, co slibuje, že se dít nebude.

`.gitignore` to už blokuje, ale ověř si to (viz kontrola níže).

### `node_modules/` — standardně se necommituje, `package-lock.json` stačí.

---

## ⚠️ Musíš zkontrolovat sám — soubory, které jsem NEDOKÁZAL přečíst

Tyhle soubory jsou v OneDrivu uložené jen v cloudu. Nešly přečíst ani zkopírovat, takže **nevím, co je v nich**, a odmítl jsem je nahrát naslepo. Publikovat soubor, který jsem neviděl, je přesně způsob, jak se omylem zveřejní heslo.

- `devnote.txt`
- `drafts.txt`
- `deploy/env.example` ← **nejrizikovější.** Má obsahovat jen vzory, ale často se stane, že tam někdo nechá skutečný klíč.
- `deploy/Caddyfile`
- `deploy/restaurace.service`
- `deploy/create-admin.js` ← může obsahovat výchozí heslo
- `deploy/backup.sh`
- `deploy/NASAZENI.md`
- `deploy/GO-LIVE-CHECKLIST.md`
- `tools/subset-font.js`, `tools/vacuum-db.js`
- `docs/CZ-PAYMENTS-SETUP.md` ← může obsahovat údaje ke GoPay
- Starší soubory v `docs/superpowers/`

### Jak je zpřístupnit

Ve Windows Exploreru otevři složku `Landing-app-1-main`, označ je, klikni pravým tlačítkem → **„Vždy zachovat na tomto zařízení"**. Počkej, až se u nich objeví zelené kolečko.

Pak je projdi očima — hledáš cokoli, co vypadá jako skutečný klíč, heslo, token nebo připojovací řetězec. Když budou čitelné, můžu je zkontrolovat za tebe a doplnit do složky.

**Když se ti to nechce řešit:** nahraj repozitář bez nich. Aplikace je bez těchhle souborů plně funkční — `.env.example`, který jsem vygeneroval, nahrazuje ten původní, a zbytek jsou nasazovací poznámky, které se dají doplnit později.

---

## Než uděláš `git push`

```bash
cd restaurace-github-ready
git init
git add -A
git status
```

**Podívej se na výpis `git status` a ujisti se, že tam NENÍ žádný `data/`, `.db` ani `.env`.** Pokud ano, zastav se — `.gitignore` nezabral.

Rychlá kontrola:

```bash
git status --porcelain | grep -Ei "data/|\.db|\.env$" || echo "CISTE - zadna databaze ani .env"
```

Teprve potom:

```bash
git commit -m "Restaurace - rezervace a rozvoz"
```

Repozitář na GitHubu vytvoř jako **Private**.

---

## Ještě jedna věc

`JWT_SECRET` a `CSRF_SECRET`, které máš na produkci, se do repozitáře nikdy nedostanou — ale pokud jsi je někdy dřív měl někde zapsané ve sdíleném souboru, je teď vhodná chvíle je vyměnit. Vygeneruj nové:

```bash
openssl rand -hex 32
```

Výměna `JWT_SECRET` odhlásí všechny přihlášené (personál se prostě znovu přihlásí) a zneplatní zákazníkům tokeny „Objednat znovu".

---

## EET 2.0 před spuštěním

Toto je kontrolní seznam pro **ostrý provoz** elektronické evidence tržeb
(implementace: `src/server/eet.js`, `src/server/eet-queue.js`; design
`docs/superpowers/specs/2026-07-31-eet2-integration-design.md`). Dokud
nezaškrtneš všechno níže, nespouštěj to na produkci — buď to nebude fungovat,
nebo (horší) to bude hlásit tržby špatně.

- [ ] **Pokladní certifikát vydán v MOJE daně a převeden na PEM.** Node neumí
      číst `.p12`, proto je nutná jednorázová konverze (ověřeno na testovacím
      `.p12`/PEM páru při psaní tohoto dokumentu):
      ```bash
      mkdir -p secrets
      openssl pkcs12 -in pokladni.p12 -clcerts -nokeys -out secrets/eet-cert.pem
      openssl pkcs12 -in pokladni.p12 -nocerts -nodes  -out secrets/eet-key.pem
      chmod 600 secrets/*.pem
      ```
      `secrets/` je v `.gitignore` — tyhle soubory se nikdy necommitují.
- [ ] **`EET_ID_JEDNOTKY` vyplněno hodnotou z DIS+.** Nejde si ji vymyslet —
      přiděluje ji portál. Musí mít aspoň 2 číslice a poslední musí být 1–4.
      Špatný formát (např. `1`) finanční správa **stále přijme**, ale vrátí
      varování kód 6 — takže žádná chybová hláška tě na problém neupozorní,
      je potřeba to zkontrolovat ručně proti tomu, co je v DIS+.
- [ ] **`EET_EIC` odpovídá EIČ v certifikátu.** Pokud necháš prázdné, použije
      se `BUSINESS_DIC` — zkontroluj, že to je opravdu totéž EIČ, pod kterým
      byl certifikát vydán.
- [ ] **`EET_PLAYGROUND=false` a `EET_ENABLED=true`.** `EET_PLAYGROUND` je
      **ten jediný přepínač**, který rozhoduje mezi testovacím prostředím
      (`pg.trzbyeet.gov.cz`) a ostrým (`trzbyeet.gov.cz`) — výchozí hodnota
      je bezpečná (`true`, tj. playground), takže dokud se to ručně
      nepřepne, nemůže omylem odejít ostrá tržba.
- [ ] **Testovací tržba v produkci v ověřovacím módu proběhla** (přes
      `eet.verifyConnection` / ruční test), než se pustí první skutečná
      platba.
- [ ] **Text účtenky při nedostupnosti EET potvrzen účetní.** EET 2.0 zrušilo
      BKP/PKP, takže co se má na účtenku vytisknout, když se tržbu nepodařilo
      nahlásit před vytištěním, plyne ze ZoET §20 — ne z technického
      rozhraní, a to je otázka pro účetní, ne něco, co se dá odvodit z kódu.
      Aktuální (**prozatímní**) texty v `src/server/server.js`:
      - `RECEIPT_EET_PENDING_NOTICE` (tržba čeká na odeslání):
        „Tržba je evidována v běžném režimu."
      - `RECEIPT_EET_FAILED_NOTICE` (tržba trvale selhala — nesmí tvrdit, že
        je evidovaná):
        „Tržba nebyla zaevidována u finanční správy."

      Obě jsou označené v kódu jako `PROVISIONAL DEFAULT` — dokud je účetní
      nepotvrdí (nebo nenahradí přesným zněním podle §20), jde o právní
      riziko, ne o hotovou věc.
- [ ] **`GET /api/eet/health` hlídán** (staff-only endpoint, vrací
      `{ enabled, mode, pending, confirmed, failed, overdue, oldestPending,
      lastError }`). Alert při **`overdue > 0`** — to znamená, že aspoň jedna
      tržba propásla zákonnou 48hodinovou lhůtu k nahlášení.
- [ ] **Účetní odsouhlasila hlášení bankovních převodů jako evidované
      tržby.** Funkce `isEvidovanaTrzba` (`src/server/eet-queue.js`, řádky
      32–34) aktuálně vrací `true` pro úplně každou potvrzenou platbu bez
      rozlišení způsobu platby — tedy i pro platby převodem na účet přes
      GoPay (`BANK_ACCOUNT`, jedna ze čtyř možností nabízených v
      `DEFAULT_PAYMENT_INSTRUMENTS`, `src/server/gopay.js`, vedle platby
      kartou, Google Pay a Apple Pay). Je to vědomé rozhodnutí majitele z
      2026-07-31, ne opomenutí v kódu — ale jde o daňovou otázku, kterou
      musí posoudit účetní, ne o něco, co plyne z techniky: **je platba
      bankovním převodem přes GoPay skutečně evidovaná tržba, nebo by měla
      být z hlášení vyloučena?** Pokud má být vyloučena, jde o jednořádkovou
      úpravu přímo v `isEvidovanaTrzba`.
- [ ] **Sledování částečných refundů.** GoPay neposkytuje skutečně vrácenou
      částku u částečné refundace, takže se u ní **automatický storno
      nevygeneruje** — vznikne jen nulová „marker" účtenka a do logu jde
      `console.error` ve tvaru
      `EET: PARTIAL refund on reservation ... needs MANUAL EET storno
      reporting ...`. Kdokoliv sleduje produkční logy, musí tohle chápat
      jako úkol: **skutečnou vrácenou částku nahlásit finanční správě ručně**
      (např. přes portál). Bez sledování logů se tohle ztratí a tržby budou
      tiše podhlášené.
