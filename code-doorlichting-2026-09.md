# Code-doorlichting uploader — september 2026

Doorgenomen: de hele codebase (±40.000 regels zonder `package-lock.json`): de
uploadwachtrij en het mediascherm, alle 84 API-routes en de middleware, de
serverbibliotheken (`lib/dropbox.ts`, Mediatask, ClickUp, SharePoint, Redis,
mail, health) en de client-side pagina's en componenten.

Ook gedraaid: `npm test` (36 bestanden, 376 tests groen, 3 overgeslagen),
`npm run lint` (10 fouten, 12 waarschuwingen; zie *Onderhoud*).

Elke bevinding hieronder is in de code nagelopen; regelnummers verwijzen naar de
stand van `main` op 29 september 2026 (commit `26468ba`).

**Inmiddels verwerkt:** U1 t/m U4 (mislukt-knop op /media, automatisch herstel,
wake lock, herkansingslink), plus een fout die daarbij boven kwam: de
hervat-melding stond in de layout buiten de rechten-provider en verscheen
daardoor nooit.

---

## Stand van zaken t.o.v. `media-upload-verbeterpunten.md`

Die doorlichting noemde punten 6–10 en 13–21 "nog open". Dat is nog steeds zo,
op één na:

| Punt | Staat nu |
| --- | --- |
| 6 · mislukte upload op /media doodlopend | Verwerkt (U1) |
| 7 · wake lock | Verwerkt (U3) |
| 8 · herstel bij `online`/terug in beeld | Verwerkt (U2) |
| 9 · verkleinen lijkt stilstand | Open — verkleinrij staat op `uploading` 0% |
| 10 · geen ETA op /media | Open — `etaSeconds` wordt berekend maar niet getoond; ETA na hervatten klopt niet (`uploaded = alGedaan`, `startedAt` = nu) |
| 13 · gelijke namen overschrijven stil | Open — `mode: "overwrite"` overal |
| 14 · verkleinen: canvas/oriëntatie/EXIF | Open — `lib/image-compress.ts` ongewijzigd op deze punten |
| 15 · hele bestand naar IndexedDB, quota stil | Open |
| 16 · wees in IndexedDB bij opnieuw kiezen | Open — `enqueue` (`:256`) haalt de oude regel uit beeld maar niet uit de opslag; vergelijking op `.HEIC`-naam terwijl de taak na verkleinen `.jpg` heet |
| 17 · twee tabbladen, één sessie | Open |
| 18 · dropbox-routes accepteren elk pad | Open — zie *Beveiliging M1/M2* |
| 19 · foutcontrole maakt een deellink | Open — `fileExists` → `/api/dropbox/files` → `getOrCreateSharedLink` |
| 20 · serverterugval voor grote bestanden | Open — `uploadChunked` is bovendien niet hervatbaar |
| 21 · weinig tests | Deels — `blok-indeling.test.ts` en `upload-herkansen.test.ts` dekken nu de blokindeling, het gewicht, de herkansingsregels en de wachttijd |

---

## Beveiliging

### Hoog

**B1. Fallback-sessiesleutel maakt sessies vervalsbaar** — `lib/auth.ts:134`
`secret: process.env.SESSION_SECRET || "wegogroen-fallback-secret"`. Staat
`SESSION_SECRET` niet in Vercel (hij is nergens gedocumenteerd, er is geen
`.env.example` en de health-check kijkt er niet naar), dan kan iedereen een
cookie met `rol: "beheerder"` ondertekenen. De hele app plus de Dropbox staat
dan open.
*Fix:* hard falen bij ontbrekend of kort geheim; een controle in `lib/health.ts`.

**B2. Dropbox-OAuth-callback zonder `state` en zonder sessie** —
`app/api/auth/dropbox/login/route.ts`, `dropbox/callback/route.ts:26-76`
De callback staat open in de middleware, controleert geen `state` en geen
sessie, en doet `storeRefreshToken(...)` voor het hele team. Wie de `client_id`
kent (die staat in de redirect-URL) koppelt zijn eigen Dropbox aan onze
callback en alle uploads gaan voortaan naar dat account. De toelichting in
`middleware.ts` ("beveiligd met de state-parameter") klopt hier niet.
*Fix:* random `state` in een httpOnly-cookie zetten bij `/login`, alleen voor
beheerders; in de callback `state` timing-safe vergelijken en dezelfde
beheerderssessie eisen.

**B3. Google-callback: `state` is de accountnaam** —
`app/api/auth/google/callback/route.ts:24,69`
`storeRefreshToken(accountName, …)` met `accountName` uit `state`. Zo hang je
een willekeurige Google-agenda aan de naam van een collega.
*Fix:* zelfde aanpak als B2 (random nonce + HMAC over de naam + sessiecontrole).

**B4. Publieke namenlijst verraadt wie nog op 0000 zit** —
`app/api/auth/accounts/route.ts:15` + `lib/personeel.ts:78-80`
`codeGewijzigd` gaat mee in de openbare route en de startcode wordt zonder hash
geaccepteerd. Eén poging is genoeg; de pogingslimiet helpt niet. Via
`metRollen()` kan dat account bovendien beheerder zijn.
*Fix:* `codeGewijzigd` uit de publieke route; een sessie op de startcode alleen
`/api/auth/code` toestaan.

**B5. Iedere medewerker kan elk account bijwerken** —
`app/api/clickup/accounts/route.ts:36-117`
GET controleert `isBeheerder()`, POST niet: `body.name` is vrij, dus mailadres
of ClickUp-token van een collega omzetten kan met elke sessie.
*Fix:* alleen het eigen account, of beheerder.

**B6. Mediatask-credentials: vrije URL, voor iedereen** —
`app/api/mediatask/credentials/route.ts`
Geen beheerderscheck; `baseUrl` wordt direct gefetcht en daarna opgeslagen.
Vanaf dan stuurt `mediataskFetch` de gedeelde én persoonlijke tokens van alle
collega's naar die host.
*Fix:* `isBeheerder()` verplicht; `baseUrl` alleen uit env of tegen een
allowlist.

### Middel

**B7. Dropbox-routes accepteren elk pad** (= verbeterpunt 18) —
`dropbox/delete-file`, `dropbox/files` (maakt ook een deellink van élke map),
`dropbox/upload-file` (bestandsnaam ongesaneerd), `dropbox/upload-chunk`,
`dropbox/upload-link`, `clickup/attach-document`, `mediatask/pointclouds`.
Alleen `dropbox/media-inhoud` controleert via `isMediaProjectmap`.
*Fix:* één `lib/pad-controle.ts` (`onderAutomatieRoot(pad)`: prefix
`/Automatie Energielabels|NEN2580|Media`, incl. `Afgerond`, geen `..`,
`sanitizePathSegment` op bestandsnamen) en die in al deze routes afdwingen.

**B8. Volledig account-token naar de browser** — `dropbox/session-token`
Elke sessie (30 dagen, gedeelde iPad) krijgt het hele Dropbox-token.
*Fix:* alleen voor `rechten.nen`/`media` en alleen op de route waar hij nodig
is; eventueel loggen wie hem ophaalt.

**B9. Productrechten worden nergens server-side afgedwongen** —
`lib/rechten-server.ts` noemt het "een zachte grens"; `dropbox/folder`,
`clickup/create-task`, `mediatask/orders` en `mediatask/pointclouds`
controleren niets. *Fix:* `vereisRecht("nen")`-helper met 403.

**B10. `/api/health/laatste` staat open** — `middleware.ts:47` matcht
`/api/health` als prefix; `health/laatste/route.ts` heeft geen eigen check en
lekt storingsdetails. *Fix:* exact matchen of sessie eisen.

**B11. `isValidSession` werkt niet meer met het huidige sessieformaat** —
`lib/auth.ts:107-124`
Doet `Number(expiresAt)` op de base64-JSON-payload → `NaN` → altijd `false`.
Gevolg in `health`, `opnames/herinnering`, `opnames/herstel`: handmatig draaien
met een sessie kan niet, en het cron-geheim wordt niet timing-safe vergeleken.
*Fix:* `leesSessie` gebruiken, `isValidSession` weg, `timingSafeEqual` op het
cron-geheim.

**B12. Inrichtingsroute zonder beheerderscheck** — `sharepoint/config`
POST/DELETE: elke medewerker kan de SharePoint-site omzetten.

**B13. Login zonder Redis heeft geen pogingslimiet** — `auth/login/route.ts:36-47`
Alle limietlogica staat achter `if (redis)`. *Fix:* fail-closed zonder Redis.

**B14. Reflected XSS in de openbare OAuth-pagina's** —
`dropbox/callback:32,86`, `google/callback:27,63,73`: `${error}`,
`${String(err)}` en `${accountName}` ongeëscaped in HTML.

**B15. Dienst-token = lees- en deelrecht op de héle Dropbox** —
`intern/deellink`, `intern/opleverbestanden`, `intern/projectmap` accepteren
elk pad; `lib/intern-auth.ts` belooft "uitsluitend binnen een projectmap".
*Fix:* dezelfde root-controle als `intern/archiveren`.

### Laag

- Concepten van anderen overschrijven/verwijderen (`drafts`): `accountName` en
  `id` worden klakkeloos overgenomen.
- Onafgevangen `request.json()` → 500 i.p.v. 400 in o.a. `dropbox/delete-file`,
  `dropbox/files`, `dropbox/folder`, `clickup/create-task`, `scan-check`,
  `mail/eponline` (daar veroorzaakt de 500 Resend-retries).
- `clickup/webhook` heeft geen tijdvenster (replay), `eponline` wel.
- Ongebonden invoer: `scan-check` onbegrensd aantal data-URL's naar Anthropic
  (kosten); `mediatask/orders` geeft vrije `extraPhotoUrls` door.
- `intern/bestand-plaatsen:44` vergelijkt "Afgerond" hoofdlettergevoelig,
  `lib/media-pad.ts` niet.
- `middleware.ts` is in Next 16 deprecated ten gunste van `proxy.ts`; werkt
  nog, wel migreren.

**Goed beschermd:** alle 31 `/api/intern/*`-routes (constant-time tokencheck,
padgrenzen in de schrijfroutes), `clickup/webhook` (HMAC + claim),
`mail/eponline` (Svix met venster), `auth/login` (PBKDF2, constant-time,
httpOnly/secure), `dropbox/media-inhoud`, de leesroutes achter de sessie.

---

## Uploadflow (`lib/upload-queue.ts`, `upload-store.ts`, `MediaFlow.tsx`)

De structuur is goed: stilstandbewaking, `Retry-After`, gewicht i.p.v. aantal,
tokencache, hervatbare sessies en het losse sluitblok zijn allemaal netjes
gedaan en getest. Wat blijft:

**U1. Mislukt op /media is een doodlopende weg** (Hoog; = punt 6)
`MediaFlow.tsx:1164`: alleen "mislukt". `dropboxError` staat in de taak maar
wordt niet getoond, `probeerOpnieuw` wordt niet geïmporteerd, en `UploadResume`
verbergt zichzelf op `/media` (`UploadResume.tsx:52`) met als reden dat de
knop daar al staat — dat is niet zo.
*Fix:* per regel de fout + knop "Opnieuw" (`probeerOpnieuw([t.id])`), en
"Alles opnieuw" bij de stap.

**U2. Geen automatisch herstel** (Hoog; = punt 8)
Geen `online`- of `visibilitychange`-listener in de wachtrij. Wat sneuvelt in
de kelder blijft "mislukt" tot iemand klikt.
*Fix:* bij `online` en terug in beeld `probeerOpnieuw` op de foutregels, met
een teller per taak.

**U3. Wake lock** (Hoog; = punt 7, plus een nieuwe)
`MediaFlow.tsx:515-547`: `bezigTotaal` telt alleen de huidige projectmap. Na
`afronden()` (`setFolder(null)`) is dat 0 en gaat de lock los terwijl het
slotscherm net zei dat de uploads doorlopen. Verder: afhankelijk van het aantal
(los/aan per afgerond bestand) en geen heraanvraag bij `visibilitychange`.
*Fix:* lock in een layout-component op `alleTaken.some(uploading)`, boolean,
met heraanvraag zodra de pagina weer zichtbaar is.

**U4. Herkansingslink voor media wijst naar het verkeerde scherm** (Middel)
`UploadResume.tsx:36-40`: `opnameLink` kent alleen NEN en energielabel; een
mediapad ("/Automatie Media/…") gaat naar `/energielabel?addr=`. `/media?addr=`
werkt al (`MediaFlow.tsx:228`).

**U5. Opnieuw kiezen laat een wees achter en dubbelt na verkleinen** (Middel; = 16)
`enqueue` (`:256`) filtert de oude regel uit beeld maar roept geen
`vergeetUpload` aan; de lopende XHR van de oude taak wordt ook niet afgebroken,
dus twee uploads schrijven tegelijk naar hetzelfde pad. Na verkleinen heet de
taak `.jpg` en matcht de vergelijking op de `.HEIC`-naam niet meer.

**U6. Verkleinen/wachten niet te onderscheiden, geen ETA** (Middel; = 9, 10)
Elke taak start als `uploading` 0%. *Fix:* `fase: "verkleinen" | "wachten" |
"uploaden"` op `UploadTask`, gezet in `routeer`/`pumpCompress`/`pump`; in
MediaFlow `formatEta(t.etaSeconds)` tonen. Bij hervatten de klok laten lopen
over wat er in déze poging verstuurd is.

**U7. Progress-storm** (Middel)
`setProgress` patcht bij elk XHR-progress-event van zes verbindingen en maakt
een nieuwe array, dus Sidebar, MediaFlow (incl. `lopendeOpnames`-memo),
energielabel en documenten hertekenen allemaal. *Fix:* alleen patchen als `pct`
of afgeronde ETA verandert, of throttle op ~250 ms.

**U8. Foutcontrole maakt een deellink** (Laag; = 19)
`fileExists` → `/api/dropbox/files` → `getOrCreateSharedLink`. Splits listen
van deellink maken (bv. `?link=0`).

**U9. Serverterugval niet hervatbaar** (Laag; = 20)
`uploadChunked` gebruikt de sessie-opslag niet en begint bij elke poging bij
nul. Begrens deze weg op bestanden waarvoor hij realistisch is.

**U10. Opslag** (Laag; = 15, 17)
Hele bestand naar IndexedDB ongeacht grootte; quota-fouten stil (`metOpslag`);
geen eigenaarsclaim bij meerdere tabbladen (`navigator.locks`).
`MAX_LEEFTIJD_MS` van 24 uur is kort: een mislukte video van vrijdagavond is
maandag weg en "Upload afmaken" zegt dan dat het bestand niet meer op het
apparaat staat.

**U11. Kleinigheden**
- `verstuurXhr`: `xhr.upload.onloadend` vuurt ook na `onerror`/abort en zet dan
  nog een bewaker van 120 s die niets meer doet — geen bug, wel een timer die
  blijft hangen.
- `chunkedDirectPoging`: bij een 401 halen vier werkers tegelijk een nieuw
  token (`metVersToken` dedupliceert niet).
- `startedAt` wordt bij een fout niet opgeruimd.
- Zwevende docblokken boven `blokIndeling` (`:537-547`, over "Snelste weg voor
  grote scans" en "Zelfde escaping als server-side") horen bij andere functies;
  de kop van het bestand noemt `MAX_PARALLEL`, dat niet meer bestaat.
- `dropboxStatus()` en `blokFoutHerstelbaar()` bevatten dezelfde regex twee keer.

---

## Serverbibliotheken

### Hoog

**S1. `listFolderFiles` volgt `has_more`/`cursor` niet** — `lib/dropbox.ts:844-872`
Eén `list_folder`-aanroep, geen `/continue`. Elke andere listing in het bestand
pagineert wél. Gevolgen: `voegBijlageGToe` (`:790`) controleert met deze lijst
of Bijlage G al ligt en uploadt daarna met `overwrite` — de ingevulde bijlage
van de adviseur kan zo overschreven worden; `stuurScansVanuitDropbox`,
`stuurMediaVanuitDropboxMap`, `getFolderLinkWithCount` en `addStreetViewPhotos`
missen bestanden of tellen te laag; `fileExists` in de wachtrij meldt in een
volle fotomap ten onrechte "mislukt".
*Fix:* één `async function* listFolderEntries(token, path, recursive)` die
`/continue` volgt, en alle listings daarop bouwen.

**S2. Zoekfout = "niet gevonden" → tweede projectmap** — `lib/dropbox.ts:719-721`
`findProjectFolder(...).catch(() => null)` en dan `?? projectFolderPath(...)`.
Een 429 of time-out tijdens het zoeken maakt precies de dubbele map die de
toelichting erboven wil voorkomen. Zelfde patroon in `sharepoint-sync.ts:223-228`.
*Fix:* fout laten propageren (of één herkansing) en `null` strikt reserveren
voor "echt niet gevonden".

**S3. `naamUitUrl` breekt op spaties** — `mediatask-pointclouds.ts:266`,
`mediatask-media.ts:64`
`/filename%3D%22([^%]+)%22/` stopt bij de eerste `%20`. Bestanden met een
spatie of accent worden niet als "al aanwezig" herkend en gaan bij elke
afrond-klik of herstelronde opnieuw naar Mediatask.
*Fix:* querystring eerst decoderen, dan `filename[*]=` matchen; test met spatie
en umlaut.

### Middel

- **S4.** `lib/health.ts:276-313` leest de SharePoint-overdrachtstatus uit de
  mapnaam (`statusFromName`), maar die status leeft sinds de bolletjes-opruiming
  in Redis (`getFolderStatuses`). De controle zegt daardoor altijd "nog geen
  overdrachten gedaan".
- **S5.** Async batch-jobs: `createFolders` (`:369-388`) keert stil terug bij
  `failed` of na tien rondes; `archiveerProjectmappen` (`:1778-1791`) herkent
  `failed` niet en pollt 260 s door.
- **S6.** Geen 429/`Retry-After`-afhandeling server-side; `upload-chunk`
  vertaalt een Dropbox-429 naar een 502 zonder `Retry-After`, terwijl de
  wachtrij daar juist op stuurt.
- **S7.** Read-modify-write op JSON-blobs in Redis zonder lock
  (`clickup.ts:214-279`, `koppelingen.ts:51-59`): twee gelijktijdige wijzigingen
  verliezen er één. De toelichting op `:244` ("Redis-override wint") is in
  tegenspraak met `:194-205` (env wint).
- **S8.** Geen time-outs op uitgaande fetches in `dropbox.ts`, `clickup.ts`,
  `mediatask.ts`, `microsoft.ts`, `google-calendar.ts`, `mail.ts`. Een hang
  verbruikt de hele `maxDuration`; in `health.ts` betekent dat geen herkansing
  en een late ochtendmail.
- **S9.** Zeven handgeschreven `list_folder`-lussen in `dropbox.ts`;
  `summarizeProjectFolders` is een deelverzameling van `detailProjectFolders`;
  `sharepoint-sync.ts:244-254` kopieert `maakSubmappen`; `mediatask-media.ts` en
  `mediatask-pointclouds.ts` dupliceren ±120 regels.
- **S10.** `vindBestaandeDraft` (`mediatask.ts:327`) slikt fouten
  (`listOrders().catch(() => [])`) en maakt dan juist het duplicaat dat de
  docstring wil voorkomen; kijkt bovendien alleen naar pagina 1.
- **S11.** Redis-hapering legt Mediatask (`mediatask.ts:94`) en SharePoint
  (`microsoft.ts:142`) plat in plaats van terug te vallen op env, zoals
  `clickup.ts:170-177` wél doet.

### Laag

- `safeHeaderJson` (`dropbox.ts:29`) bevat letterlijk U+007F en U+FFFF in de
  regex in plaats van `\u007f-￿`; een formatter "repareert" dat ongemerkt.
- `sanitizePathSegment` filtert geen controletekens en geen afsluitende punt;
  `projectFolderPath` geeft `"Straat 1, "` bij lege woonplaats. Geen test.
- `new Uint8Array(content)` kopieert de Buffer (dubbel geheugen per blok).
- `vergeetToegangstoken` wist alleen op de eigen instantie; warme instanties
  gebruiken na herkoppelen het oude token tot het verloopt.
- Dood: `getFileDirectLinks` (geen aanroepers, maakt permanente publieke
  links); bolletjes-strip in `sharepoint-sync.ts:441-446`.
- `laz-reader.ts:60-87`: geen minimale-lengtecheck (afgekapt bestand →
  `RangeError`).

---

## Front-end

### Hoog

**F1. Opname verwijderen zonder bevestiging, inclusief de bewaarde bestanden** —
`app/opnames/page.tsx:298-304, 358-364`
Eén tik roept `verwijderOpname` aan: serverconcept weg, lokale kopie weg en via
`vergeetTakenVoor` ook de bestanden uit IndexedDB. Een mislukte upload is dan
definitief niet meer te herkansen. Elders hanteert de app zelf een tweede tik
("op een iPad is een misklik zo gebeurd", `nen/documenten/page.tsx:387`).

**F2. Energielabel: ander adres kiezen overschrijft een hervat concept** —
`app/energielabel/page.tsx:981`
`selectAddress` zet `setDraftId(null)` maar laat `pendingDraftIdRef` staan. Het
save-effect (`:705`) valt terug op die ref en schrijft de nieuwe adresstaat met
lege velden onder het oude id — lokaal meteen, naar de server na 800 ms. Wie
via `?draft=` hervat, "Terug naar adres" doet en een afspraak aantikt, wist zo
alle ingevulde velden. `resetSearch` reset de ref wél (`:1272`).

### Middel

- **F3.** Side-effects binnen state-updaters: `energielabel/page.tsx:1109-1141`
  roept `setDropboxFolder`/`setTitel`/… aan binnen `setAddress((prev) => …)`;
  `nen/page.tsx:285-306` start fetches in een updater. In StrictMode dubbel.
- **F4.** `ScanCheck.tsx:166-335`: niet te annuleren (geen cancelled-vlag of
  AbortController; `onRecord` na unmount), en alle metingen plus zes canvassen
  van 1400² als data-URL op de main thread. Op een iPad bevriest de UI.
- **F5.** Polling loopt door in achtergrondtabbladen: `energielabel:784-791`
  (15 s, vier fetches), `nen/documenten:742-760`, `ScanStatus.tsx:45`.
  `useDropboxInhoud` in MediaFlow doet het wél goed — trek dat los als
  `usePolling`.
- **F6.** Adres zoeken: `try/finally` zonder `catch` (unhandled rejection, geen
  melding) en geen annulering van oudere zoekresponsen — op drie plekken.
- **F7.** `nen/documenten/page.tsx:171-200`: `_raw.dp`-bestanden worden bij elke
  ververs-beurt stil uit Optimized verwijderd; de melding zegt "leeggehouden"
  ook als de delete faalde.
- **F8.** "Annuleren" in het energielabelformulier (`resetSearch`) wist ook de
  lokale back-up, zonder bevestiging.
- **F9.** `energielabel/page.tsx:2247`: taak aanmaken wordt alleen geblokkeerd
  bij lopende uploads, niet bij mislukte — het bestand ontbreekt dan stil in
  de ClickUp-taak.
- **F10.** `energielabel/page.tsx:2134` zet `meta?.account.username` als eigenaar
  op de upload, de rest van de app gebruikt `useIkBen()`.
- **F11.** Tikdoelen onder 44 px, juist bij de destructieve knoppen
  (`.doc-file-del` 30×30, `.dbx-strip-refresh` 26×26, `.compass-close`,
  `.media-lopend-weg`).

### Laag

- `MediaFlow.tsx:509-513`: "Vorige" naar het adresscherm ververst `sessies`
  niet; de opname waar je net uit stapte mist dan in "Openstaande opnames".
- Callback-ref voor de vaste kop wordt elke render nieuw gemaakt →
  ResizeObserver per render (drie plekken).
- `ScanCheck.tsx:328-335`: `gestart.current` wordt nooit gereset; een tweede
  export toont de oude analyse (`key={optimizedFile.name}` lost het op).
- Modals hebben geen `aria-modal`, focus-trap of begin-focus; alleen
  `CompassPicker` sluit op Escape.
- `app/page.tsx:197-209` geeft geen melding bij een mislukte klaar-melding;
  `resumedRef` in energielabel wordt geschreven maar nooit gelezen.

### Structuur (extracties die echt lonen)

- **Adres zoeken** staat drie keer bijna letterlijk gelijk (energielabel, nen,
  MediaFlow; ±900 regels): `useAdresZoeken()` + `<AdresZoeker>`.
- **Adreskaart met bewerken** (energielabel, nen) → `<AdresKaart>`.
- **Dropbox-balk** (vier plekken) → `<DropboxStrip>`.
- **Dubbele helpers**: `formatEta` (2×), `houseNumber` (3×) → `lib/address-format.ts`.
- **Energielabel**: `CompassPicker` en `renderField` naar eigen componenten
  scheelt ±600 regels.
- **Dashboard ≡ TodayAppointments**: BAG-check-effect en
  `findDraft`/`hasMediataskOrder`/`hasClickUpTask` zijn identiek.

---

## Onderhoud en kwaliteit

- **Lint staat op `continue-on-error`** in CI en heeft 10 fouten, allemaal
  `react-hooks/set-state-in-effect` (energielabel:805, instellingen:774,
  login:91, nen:143/266, opnames:72, page:212, MediaFlow:155/297) plus
  `@next/next/no-html-link-for-pages` in `opnames/page.tsx:217`. Die zijn
  klein om op te lossen; daarna kan lint blokkerend worden.
- **`tsc --noEmit` slaagt alleen na `next build`**: `LayoutProps<"/">` in
  `app/layout.tsx` komt uit de gegenereerde typen. Geen bug, wel goed om te
  weten voor wie los typecheckt.
- **Geen `.env.example`, README is de create-next-app-boilerplate.** De app
  gebruikt 35 omgevingsvariabelen; welke verplicht zijn (`SESSION_SECRET`!)
  staat nergens. Dat maakt B1 realistisch.
- **Redis is optioneel maar in de praktijk vereist**: zonder Redis geen
  pogingslimiet (B13), geen tokencache, geen Dropbox-koppeling via de knop.
  Beter: hard eisen in productie.
- **Vitest** waarschuwt over `vitest.config.ts` als CommonJS; `.mts` of
  `"type": "module"` haalt dat weg.
- **Losse bestanden in de root**: `voorbeeld-bag-rapport.pdf`, `clickup-map.json`,
  `clickup-required-fields.json` en vijf `scripts/*.mjs` zonder toelichting.
  Een `docs/` of `tools/` met een regel uitleg per bestand.

---

## Aanbevolen volgorde

| # | Wat | Waarom eerst |
| --- | --- | --- |
| 1 | B1 `SESSION_SECRET` verplicht + B2/B3 OAuth-`state` | Volledige overname van app en Dropbox mogelijk |
| 2 | B4 startcode uit de publieke lijst, B5/B6 beheerderschecks | Eén poging of één POST is nu genoeg |
| 3 | B7/B8/B15 padcontrole in alle Dropbox-routes (één helper) | Dezelfde grens die de intern-routes al hebben |
| 4 | S1 paginerende listing + S2 zoekfout niet slikken | Overschrijven van Bijlage G en dubbele projectmappen |
| 5 | U1/U2/U3 mislukt-knop, herstel bij `online`, wake lock | De opnemer kan zichzelf redden op locatie |
| 6 | F1/F2 bevestiging bij verwijderen, `pendingDraftIdRef` | Dataverlies met één tik |
| 7 | B11 `isValidSession` weg, S3 `naamUitUrl`, S4 health-status | Kleine fixes met duidelijk effect |
| 8 | Lint blokkerend maken, `.env.example`, README | Voorkomt dat 1 terugkomt |

Punten 1–3 en 7 zijn elk een paar uur; 4 en 5 een dag; de extracties onder
*Structuur* zijn losse opschoonrondes en horen niet in dezelfde PR als de
beveiligingsfixes.
