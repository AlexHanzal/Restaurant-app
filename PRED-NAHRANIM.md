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
