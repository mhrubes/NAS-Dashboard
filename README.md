# nas-dashboard

Domácí rozcestník: jedna stránka s kartami (ikona, název, popis, odkaz) na aplikace běžící na NASu. U každé karty svítí tečka, zda aplikace odpovídá. Seznam se **upravuje přímo na stránce** (tlačítko „Upravit“, po přihlášení), bez zásahu do souborů nebo Gitu.

Bez externích závislostí: čistý Node.js. Zobrazení je veřejné v síti, úpravy vyžadují heslo.

## Nasazení na NAS

```sh
cd /share/CACHEDEV1_DATA/Public/docker
docker run --rm -v "$PWD":/git -w /git alpine/git clone https://github.com/mhrubes/NAS-Dashboard.git
cd NAS-Dashboard
mkdir -p data && chmod 777 data

{
  docker run --rm -v "$PWD":/app -w /app node:22-alpine node scripts/hash.js 'SilneHeslo'
  echo "APP_PORT=1000"
  echo "COOKIE_SECURE=false"
  echo "TRUST_PROXY=false"
} > .env
chmod 600 .env

docker compose up -d --build
```

Stránka běží na `http://IP_NAS:1000`. Heslo `SilneHeslo` nahraď vlastním, slouží jen pro úpravy.

## Viditelnost aplikací

Každá aplikace má příznak `"visible"` (výchozí `true`, tedy i u nově přidané). Skrytá aplikace (`false`) se **běžným uživatelům vůbec nezobrazí a server ji ani neposílá**: nepřihlášený `GET /api/apps` vrací jen viditelné. Název, popis ani URL skryté aplikace se tedy z prohlížeče nezjistí.

- V režimu úprav jsou vidět všechny aplikace, skryté jsou ztlumené se štítkem „Skrytá“. Tlačítko **Skrýt / Zobrazit** na kartě přepne viditelnost jedním klikem, ve formuláři je zaškrtávátko „Zobrazit na rozcestníku“.
- Po **Hotovo** vidí i přihlášený jen viditelné aplikace, tedy stránku tak, jak ji vidí ostatní. Skupina, ve které jsou všechny aplikace skryté, se nezobrazí vůbec.
- Pokud jsou všechny aplikace skryté, běžný uživatel uvidí hlášku „Žádné aplikace nejsou zobrazené“.

## Úprava seznamu v prohlížeči

1. Klikni na **✎ Upravit** a přihlas se.
2. **+ Přidat aplikaci**: název, popis, URL, ikona (emoji), skupina (po kliknutí se nabídnou existující, při psaní se filtrují, nový název vytvoří novou skupinu) a **pozice ve skupině** (na začátek, mezi dvě konkrétní aplikace nebo na konec).
3. Na kartě: **Upravit** (stejný formulář i s pozicí a skupinou, ostatní karty se podle toho posunou), **↑ / ↓** (rychlý posun o jedno místo), **Skrýt / Zobrazit**, **Smazat**.
4. U názvu skupiny: **↑ / ↓** posune celou skupinu (sekci) i s kartami, **Přejmenovat** změní její název.
5. **Přeřazení tažením:** kartu chytni myší a pusť ji **před nebo za jinou kartu** (podle toho, ve které polovině karty ji pustíš; karta přejde i do skupiny cílové karty), na **nadpis skupiny** (na začátek skupiny) nebo na **volné místo skupiny** (na její konec). Tlačítka ↑ / ↓ zůstávají pro dotyková zařízení.
6. **Export** stáhne celý seznam (včetně skrytých aplikací) jako JSON, **Import** ho načte ze souboru: buď **přidá** jen nové aplikace (shoda podle názvu a adresy se přeskočí), nebo **nahradí** celý seznam. Obsah souboru se při uložení ověří stejně jako ruční úpravy.
7. **Nadpis** změní titulek a podtitulek stránky. **Hotovo** režim úprav ukončí.

### Hledání a skupiny

- Pole **Hledat** v hlavičce filtruje karty podle názvu, popisu, skupiny i adresy bez ohledu na diakritiku a velikost písmen. Klávesa **`/`** do něj skočí odkudkoli, **Enter** otevře první nález, **Esc** hledání smaže.
- Skupinu **sbalíš** kliknutím na její nadpis (u sbalené je vidět počet karet). Stav se pamatuje v prohlížeči. Při hledání se skupiny s nálezy rozbalí samy.

Změny se ukládají hned do `data/apps.json` na NASu (přežijí restart i aktualizaci). Při prvním startu se vytvoří výchozí seznam ze `seed/apps.json`.

### Zápis URL

`{host}` se v odkazu nahradí adresou, přes kterou stránku otevřeš (IP NASu nebo název), takže stejný záznam funguje odkudkoli:

```
http://{host}:3000
```

Povolené jsou jen odkazy `http://` a `https://`.

### Domácí a externí adresa

Každá aplikace může mít kromě hlavní adresy (`url`) i **externí adresu** (`urlExternal`, nepovinná), třeba `https://faktura.example.com`. Která se použije, rozhoduje adresa, přes kterou stránku otevřeš:

- **domácí síť** (použije se `url`): `localhost`, soukromé IP (`10.x`, `192.168.x`, `172.16–31.x`, `169.254.x`), IPv6 `::1`, `fc00::/7` a `fe80::`, názvy končící `.local`, `.lan`, `.home`, `.internal`, `.home.arpa` a jednoslovné názvy (např. `nas`),
- **jinde** (veřejný název nebo IP): použije se `urlExternal`, a pokud není vyplněná, tak `url`.

Stav (tečka) se zjišťuje na adrese, která se právě používá. V režimu úprav je u karty vidět i externí adresa.

## Automatické odhlášení při nečinnosti

Po přihlášení se vlevo dole zobrazí kolečko s odpočtem (min:s). Každou sekundu nečinnosti ubývá, i když přepneš na jinou záložku nebo okno. Pohyb myší, psaní, kliknutí, dotyk nebo scroll odpočet vrátí na plnou hodnotu `SESSION_TIMEOUT_MIN`. Posledních 30 s kolečko zežloutne, posledních 10 s zčervená. Po vypršení tě stránka odhlásí a zavře rozepsaný formulář.

Odpočet se počítá z časové značky, takže je přesný i v neaktivní záložce. Server relaci obnovuje při aktivitě nejvýš jednou za 10 s (`/api/keepalive`) a drží 15 s rezervu, aby tě neodhlásil dřív než stránka.

## Tečka se stavem

Prohlížeč každých 5 s (jen když je záložka vidět) zkusí otevřít spojení na adresu aplikace. Zelená pulzující tečka = port odpovídá, červená = ne. U zelené je vidět **doba odezvy** (např. `23 ms`), po najetí na tečku i čas poslední kontroly. Tlačítko ↻ zkontroluje stav hned (poté 10 s odpočet). Neověřuje funkčnost aplikace, jen dostupnost portu. U karty jde vypnout (zaškrtávátko ve formuláři).

## API

| Metoda | Cesta | Přístup | Popis |
|---|---|---|---|
| GET | `/api/apps` | veřejné | seznam aplikací (nepřihlášenému jen s `visible != false`, přihlášenému všechny) |
| PUT | `/api/apps` | přihlášení | uložení celého seznamu (validace názvu, URL, délek; `visible` je boolean, výchozí `true`) |
| POST | `/api/login` | veřejné | `{password}`, nastaví cookie, max. 5 pokusů / 15 min |
| POST | `/api/logout` | veřejné | smaže cookie |
| GET | `/api/me` | přihlášení | kontrola relace, vrací `timeoutSec` a `remainingSec` |
| POST | `/api/keepalive` | přihlášení | obnoví relaci při aktivitě uživatele |
| GET | `/api/health` | veřejné | healthcheck, vrací `{ok, version}` |

## ENV

| Proměnná | Význam |
|---|---|
| `APP_PASSWORD_HASH` | `salt:hash` ze `scripts/hash.js` (povinné) |
| `SESSION_SECRET` | klíč pro podpis cookie (povinné) |
| `APP_PORT` | port na NASu, default `1000` |
| `SESSION_TIMEOUT_MIN` | odhlášení po nečinnosti v minutách, default `5` (platí kladná čísla do 1440, i desetinná) |
| `COOKIE_SECURE` | `true` za HTTPS |
| `TRUST_PROXY` | `true` za reverzní proxy |
| `DATA_DIR` | složka s `apps.json` (v kontejneru `/data`) |

## Verze

Verze aplikace je jen v `package.json` (`"version"`). Zobrazuje se v patičce stránky („NAS Dashboard v1.2.0“), vypisuje ji server při startu a vrací ji `GET /api/health`. Zvýšit ji jde bez ruční úpravy souboru:

```sh
npm version patch --no-git-tag-version   # 1.2.0 -> 1.2.1 (minor: nové funkce, major: nekompatibilní změna)
```

Po zvýšení stačí commit, na NASu `git pull` a `docker compose up -d --build`. Podle čísla v patičce poznáš, která verze na NASu opravdu běží.

## Aktualizace

```sh
cd /share/CACHEDEV1_DATA/Public/docker/NAS-Dashboard
docker run --rm -v "$PWD":/git -w /git alpine/git -c safe.directory=/git pull
docker compose up -d --build
```

## Bezpečnost

- Veřejně čitelné jsou jen názvy a odkazy. Nevystavuj stránku na internet, prozradila by, jaké služby na NASu běží.
- Uložit změny může jen přihlášený (podepsaná cookie, `HttpOnly`, `SameSite=Strict`, klouzavá platnost podle `SESSION_TIMEOUT_MIN`).
- Vstupy se validují na serveru (délky, povinné položky, formát URL).
