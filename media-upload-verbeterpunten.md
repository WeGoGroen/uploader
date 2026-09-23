# Media-uploads: doorlichting en verbeterpunten

Doorgenomen: de hele keten van een media-opname, van het kiezen van bestanden tot
het bestand in Dropbox.

## Wat hiervan inmiddels aangepakt is

De punten hieronder staan zoals ze gevonden zijn — dat blijft de vindplaats. Deze
tabel zegt wat er daarna mee gedaan is.

| Punt | Staat |
| --- | --- |
| 1 · geen timeouts | Opgelost: stilstandbewaking op elke upload, tijdslimiet op elke fetch in het pad |
| 2 · de `close`-race | Opgelost op `main` (PR #3, `afsluitBlok`): het sluitende blok gaat alleen, ná de rest |
| 3 · tokenrefresh per aanroep | Opgelost: toegangstoken gecachet (geheugen + Redis), één refresh tegelijk |
| 4 · `Retry-After` genegeerd | Opgelost: header wordt gehonoreerd, exponentieel met jitter, vijf pogingen |
| 5 · twaalf tegelijk | Opgelost: budget naar zes, gewicht = aantal verbindingen |
| 11 · knop geblokkeerd tijdens klaarzetten | Opgelost: kiezen kan meteen, de wachtrij wacht zelf op het pad |
| 12 · Street View in de leveringsmap | Opgelost op `main` (PR #3) |
| — · uploadlink per bestand | Opgelost: links worden per serie in één aanvraag opgehaald |
| — · sessie weggooien bij een fout | Opgelost: hervatten tenzij de sessie zelf stuk is; een verlopen token haalt een vers token |
| — · blokgrootte vast op 16MB | Opgelost: beweegt mee met het bestand, zodat ook een 20MB-bestand vier werkers gebruikt |
| 6–10, 13–21 | Nog open |

Let op bij het teruglezen: de mappen heetten tijdens deze doorlichting nog
`in/Photo's`, `in/Video` en `in/360`. Op `main` zijn dat inmiddels
`In/Raw/Photo's`, `In/Raw/Video` en `In/Raw/360`, met daarnaast `OUT/…` voor de
bewerker. De waarnemingen veranderen daar niet door, de paden wel.

Bewust níét gedaan: foto's verkleinen in de media-mappen (dat raakt de levering
aan de makelaar) en de Vercel-regio verplaatsen.

| Onderdeel | Bestand |
| --- | --- |
| Scherm en stappen | `components/MediaFlow.tsx`, `lib/media-folders.ts`, `lib/media-sessie.ts` |
| Wachtrij en verzendwegen | `lib/upload-queue.ts` |
| Verkleinen | `lib/image-compress.ts` |
| Bewaren op het apparaat | `lib/upload-store.ts` |
| Hervatten / opnieuw proberen | `components/UploadResume.tsx`, `components/UploadPanel.tsx`, `lib/upload-overview.ts` |
| Serverkant | `app/api/dropbox/*`, `lib/dropbox.ts` |
| Doorgifte naar de bewerker | `app/api/intern/media-plaatsen/route.ts`, `lib/media-pad.ts` |

Er zijn vier wegen naar Dropbox, gekozen op bestandsgrootte (`runTask`,
`lib/upload-queue.ts:403`):

| Grootte | Weg |
| --- | --- |
| < 24 MB | één POST naar een tijdelijke uploadlink |
| 24 – 140 MB | parallelle blokken van 16 MB rechtstreeks naar Dropbox, terugval: één POST |
| > 140 MB | parallelle blokken, terugval: blokken van 4 MB via onze server |
| geen link te krijgen | via onze server (`/api/dropbox/upload-file`) |

De opzet is goed doordacht. De problemen zitten niet in de structuur maar in
randgevallen die op een iPad met 4G juist de regel zijn.

---

## Waarom het vastloopt

### 1. Niets heeft een timeout — één hangende verbinding zet de héle wachtrij vast

Geen enkele verbinding in dit pad heeft een tijdslimiet: niet de XHR's
(`upload-queue.ts:465`, `:493`, `:675`), niet de fetches naar `/api/dropbox/…`
(`:451`, `:609`, `:729`, `:791`).

Dat is op zichzelf al vervelend, maar het wordt erger door `pump()`:

```ts
void runTask(next.task, next.file).finally(() => {
  runningWeight -= w;   // upload-queue.ts:397
  pump();
});
```

Het slot komt pas vrij als `runTask` afrondt. Een XHR op een dode mobiele
verbinding vuurt nooit `onload` of `onerror` — hij blijft gewoon hangen. Dat slot
komt dus nooit vrij. Twee hangende video's (gewicht 6 + 6 = budget 12) of twaalf
hangende foto's, en er start **niets** meer. Alles staat op "bezig", 0%, voor
altijd. Dat is exact het beeld van "de uploader loopt vast".

**Aanpak**

- `xhr.timeout` + `xhr.ontimeout` op elke XHR, en `AbortSignal.timeout()` op elke
  fetch in dit pad.
- Een bewaker op stilstand: geen `progress`-event in bv. 30 seconden → `abort()`
  en behandelen als herstelbare fout. Alleen een harde timeout is niet genoeg,
  want een upload van 800 MB mag best twintig minuten duren; het gaat om
  *stilstand*, niet om duur.
- Een noodrem in `pump()`: een slot dat langer dan X bezet is, opruimen.

---

### 2. De `close`-race bij parallelle blokken — grote video's mislukken systematisch

```ts
const arg = { cursor: { session_id: sessionId, offset: from }, close: to === file.size };
// upload-queue.ts:672
```

Dropbox eist bij een concurrent-sessie dat de láátste append `close: true` zet.
Maar `close` betekent letterlijk: hierna mag er niets meer bij. En vier werkers
lopen hier door elkaar heen.

Het laatste blok is de rest van het bestand en dus meestal het kleinste — vaak
een paar MB tegenover 16 MB. Dat blok is daardoor eerder klaar dan de drie
blokken die vóór hem begonnen en nog onderweg zijn. De sessie sluit, de drie
blokken die daarna binnenkomen worden geweigerd, en `blokFoutHerstelbaar`
(`:558`) ziet geen 429 of 5xx → niet herstelbaar → de hele poging sneuvelt.

Wat er dan gebeurt maakt het compleet:

1. `uploadChunkedDirect` (`:590`) probeert het nog één keer, helemaal vanaf nul —
   dezelfde race, hetzelfde resultaat, maar wel het hele bestand nóg een keer
   over de mobiele verbinding.
2. Daarna de terugval: onder 140 MB één lange POST (`:415`), daarboven de
   serverroute (`:728`) — die dezelfde race heeft (`:752`).

Een video kan dus drie keer volledig omhoog gaan en drie keer stuklopen.

**Aanpak**

Geen `close` op een datablok. Alle blokken parallel zonder `close`, daarna één
lege append met `close: true` op offset = `file.size`, en dán pas `finish`. Dat
haalt de volgorde-afhankelijkheid er helemaal uit. Alternatief (kleiner, maar
trager): het laatste blok pas versturen als alle andere klaar zijn.

Dezelfde wijziging is nodig in de serverroute (`upload-queue.ts:752` en
`app/api/dropbox/upload-chunk/route.ts`).

---

### 3. Elke aanroep haalt een vers Dropbox-token op

```ts
export async function getSharedAccessToken(): Promise<string> {
  const { clientId, clientSecret, refreshToken } = await requireDropboxConfig();
  return refreshAccessToken(clientId, clientSecret, refreshToken);  // lib/dropbox.ts:153
}
```

Er is geen cache. Deze functie wordt op 69 plaatsen aangeroepen en doet elke keer
een volledige OAuth-ronde naar Dropbox.

Per foto is dat: tokenrefresh → uploadlink → upload. Twaalf foto's tegelijk is
twaalf tokenrefreshes in één burst. Bij de serverroute is het erger: één refresh
per blok van 4 MB, dus voor een video van 2 GB ruim vijfhonderd refreshes.

Dropbox beantwoordt zo'n burst met 429. Dan geeft `/api/dropbox/upload-link` een
502 (`route.ts:22`), valt `uploadDirect` terug op de serverroute (`:458`), en die
vraagt weer tokens aan. De terugval maakt de druk dus groter in plaats van
kleiner.

**Aanpak**

Token cachen tot kort voor het verloopt — `expires_in` is doorgaans 4 uur.
Redis is er al (`lib/redis.ts`, dezelfde plek waar het refresh-token staat), met
daarnaast een cache in het geheugen van de lambda. Dat scheelt een hele ronde op
élke Dropbox-aanroep in de app, niet alleen bij media.

---

### 4. 429 en `Retry-After` worden genegeerd

```ts
function blokFoutHerstelbaar(err: unknown): boolean {
  const melding = err instanceof Error ? err.message : "";
  return /Netwerkfout/.test(melding) || /gaf (429|5\d\d)/.test(melding);   // :558
}

await wachtEven(poging === 1 ? 1000 : 3000);   // :569, drie pogingen
```

Drie punten:

- Dropbox stuurt bij een 429 een `Retry-After`. Die wordt niet gelezen; er wordt
  1 en dan 3 seconden gewacht. Zegt Dropbox "wacht 15 seconden", dan lopen alle
  drie de pogingen binnen die 15 seconden stuk.
- `too_many_write_operations` is precies wat Dropbox stuurt bij veel gelijktijdige
  schrijfacties in dezelfde map — het staat zelfs al in de toelichting bij
  `createFolders` (`lib/dropbox.ts:236`). Twaalf foto's tegelijk in `in/Photo's`
  is dat geval.
- De herkenning gaat op de tékst van de foutmelding. Dat is broos: wie de melding
  in `uploadDirect` (`:475`) herformuleert, zet ongemerkt de herkansingen uit.
  Beter een echt fouttype met status en reden erin.

**Aanpak**: `Retry-After` honoreren, exponentieel met jitter, meer pogingen, en
het aantal gelijktijdige schrijfacties in dezelfde map omlaag (zie punt 5).

---

### 5. Twaalf tegelijk is te veel voor een uplink op locatie

```ts
const PARALLEL_BUDGET = 12;   // :64
```

De redenering in de toelichting klopt voor wachttijd, maar niet voor bandbreedte.
Twaalf uploads naar dezelfde host delen één HTTP/2-verbinding en dus één uplink.
Ze kruipen alle twaalf tegelijk naar 40% — en dan is er *niets* af. Valt de
verbinding weg, dan is alle verstuurde data weg. Met vier tegelijk zijn er na
dezelfde tijd acht foto's definitief binnen.

Daar komt bij dat twaalf gelijktijdige schrijfacties in dezelfde map precies de
429 uit punt 4 uitlokken.

**Aanpak**: budget naar 4–6. Voor de gebruiker voelt "8 van de 20 klaar" beter
dan "20 bezig, 0 klaar", en het is bij een afgebroken verbinding ook echt beter.

---

### 6. Een mislukte media-upload is een doodlopende weg

Op de mediapagina ziet een mislukt bestand er zo uit (`MediaFlow.tsx:984`):

```tsx
{t.dropbox === "error" ? "mislukt" : …}
```

Geen reden, geen knop. `t.dropboxError` staat wél in de wachtrij, maar wordt hier
nergens getoond.

En de enige plek met een "Opnieuw"-knop verbergt zichzelf juist op deze pagina:

```ts
const opDashboard = pad === "/" || pad.startsWith("/media");   // UploadResume.tsx:52
if (opDashboard || dismissed || tasks.length === 0) return null;
```

De toelichting erboven zegt dat op de mediapagina "dezelfde lijst mét dezelfde
knop" al in beeld staat. Dat klopt niet: de lijst in `MediaFlow` heeft geen knop.
De opnemer op locatie kan dus alleen nog handmatig opnieuw kiezen — of, als hij
het weet, via het dashboard, waar "Upload afmaken" wél staat
(`UploadPanel.tsx:189`).

**Aanpak**: per mislukte regel een "Opnieuw"-knop (`probeerOpnieuw([t.id])`, die
werkt al vanaf het bewaarde bestand) plus de foutmelding, en één knop "alle
mislukte opnieuw" bij de stap.

---

## Zichtbaar houden en zelf herstellen

### 7. Het wake lock wordt losgelaten en nooit teruggevraagd

```ts
useEffect(() => {
  if (bezigTotaal === 0) return;   // MediaFlow.tsx:402
  … wakeLock.request("screen") …
}, [bezigTotaal]);
```

Twee dingen:

- De afhankelijkheid is het *aantal* lopende uploads. Bij elk afgerond bestand
  wordt het lock losgelaten en opnieuw aangevraagd. Bij twintig foto's twintig
  keer, met telkens een gaatje ertussen.
- iOS geeft het lock vrij zodra de pagina uit beeld gaat, en er is geen
  `visibilitychange`-handler die het terugvraagt. Na één keer wegklikken valt het
  scherm dus alsnog in slaap — precies wanneer je het lock nodig had.

**Aanpak**: één lock zolang er *iets* loopt (boolean, geen aantal), opnieuw
aanvragen bij `visibilitychange` zodra de pagina weer zichtbaar is.

### 8. Geen herstel bij terugkomst in beeld of als het netwerk terug is

De wachtrij luistert nergens naar `online`/`offline` of `visibilitychange`. Wat
sneuvelt terwijl de iPad in de tas zit, blijft "mislukt" tot iemand handmatig
ingrijpt. Terwijl het bestand er nog staat en `probeerOpnieuw` het zo weer kan
oppakken.

**Aanpak**: bij `online` en bij terugkeer in beeld automatisch de mislukte taken
van dit apparaat opnieuw starten (met een teller, zodat een structureel kapotte
upload niet eindeloos rondjes draait).

### 9. Tijdens het verkleinen lijkt alles stil te staan

Een foto in de verkleinrij staat op `dropbox: "uploading"`, `pct: 0`. Bij twintig
foto's en drie tegelijk (`COMPRESS_PARALLEL`, `:108`) staan er dus zeventien
regels op "bezig, 0%" zonder dat er iets gebeurt. Dat is dezelfde aanblik als een
vastgelopen upload.

**Aanpak**: een eigen status ("voorbereiden…") voor bestanden die nog in de
verkleinrij staan.

### 10. Geen tijdsindicatie op de mediapagina

`etaSeconds` wordt netjes bijgehouden en getoond op de energielabel- en
NEN-pagina (`app/nen/documenten/page.tsx:625`), maar niet in `MediaFlow`. Bij een
video van 800 MB is "37%" zonder resterende tijd precies waarom iemand denkt dat
het hangt.

Let op bij het overnemen: na hervatten klopt de eerste schatting niet. `setProgress`
(`:124`) deelt de al gedane bytes door een klok die net is gestart, dus een
hervatte upload meldt eerst "nog 3 seconden". De klok moet starten bij wat er in
déze poging verstuurd is.

---

## Mediaspecifiek

### 11. De knop is geblokkeerd terwijl de map wordt klaargezet

```tsx
<button className="btn-dropbox" disabled={folderBusy}>   // MediaFlow.tsx:935
```

En dat klaarzetten is niet niks. `/api/dropbox/folder` → `ensureProjectFolder`
(`lib/dropbox.ts:570`) doet achter elkaar:

1. héél "Automatie Media" doorbladeren op zoek naar een bestaande map, daarna het
   archief erbij (`zoekInEenMap`, `:1171` — met paginering, dus meerdere rondes);
2. mappen aanmaken, per diepteniveau apart;
3. Street View- en luchtfoto's ophálen én uploaden;
4. een deellink maken.

`maxDuration` staat op 300 seconden. Zolang dit loopt kan de opnemer geen
bestanden kiezen.

**Aanpak**: de knop niet blokkeren — bestanden mogen alvast in de wachtrij, die
kan wachten op het pad. Street View voor media overslaan (zie punt 12) en het
zoeken naar een bestaande map cachen.

### 12. Street View-foto's landen in de leveringsmap

```ts
await addStreetViewPhotos(
  accessToken,
  `${path}/${kind === "nen" ? "Photo's" : kind === "media" ? "in/Photo's" : "Foto's"}`,
  …);   // lib/dropbox.ts:619
```

Voor een energielabel is automatisch beeldmateriaal dossiervorming. Bij media is
`in/Photo's` het aangeleverde eindproduct dat naar de makelaar gaat — daar horen
vier automatisch opgehaalde straat- en luchtfoto's niet tussen. Ze zorgen er
bovendien voor dat de map "niet leeg" lijkt.

### 13. Gelijke bestandsnamen overschrijven elkaar stil

Alles gaat omhoog met `mode: "overwrite"` (`:714`, `dropbox.ts:332`), en de
wachtrij haalt een gelijknamige regel weg (`:227`). Twee camera's die allebei bij
`IMG_0001` beginnen — bij 360-camera's eerder regel dan uitzondering — betekent
dus stil verlies van beeld.

**Aanpak**: voor de `in/`-mappen `autorename: true`, of in de wachtrij
waarschuwen bij een naam die al geüpload is.

### 14. Verkleinen: geheugen, oriëntatie en EXIF

`lib/image-compress.ts` is alleen actief voor de NEN- en energielabelmappen —
`mayCompressFolder` sluit `in/` uit (`:29`), dus media-uploads gaan onverkleind
omhoog. Dat is bewust en terecht. Drie punten blijven staan voor de andere
flows, en ze raken media indirect (het is dezelfde wachtrij en dezelfde iPad):

- De canvas wordt na gebruik niet vrijgegeven (`canvas.width = canvas.height = 0`).
  Op iOS blijft dat geheugen hangen, en dat is precies waar Safari het tabblad
  wegruimt — wat zich voordoet als "de app herstart midden in het uploaden".
- `createImageBitmap(file)` zonder `{ imageOrientation: "from-image" }` kan een
  gedraaide foto opleveren, afhankelijk van browserversie.
- Het canvas-pad gooit alle EXIF weg: opnamedatum en locatie verdwijnen.

---

## Opslag en meerdere tabbladen

### 15. Het hele bestand wordt eerst naar IndexedDB gekopieerd

```ts
void bewaarUpload({ …, file, … });   // :231
```

Dat gebeurt voor élk bestand, dus ook voor een video van 2 GB. Twee gevolgen:

- Het kopiëren loopt naast de upload en vecht om dezelfde I/O op het apparaat.
- Loopt het stuk op de quota, dan wordt dat stil ingeslikt (`metOpslag` vangt
  alles af, `upload-store.ts:83`). De app belooft dan hervatten dat er niet is —
  merkbaar pas als "Upload afmaken" nul teruggeeft.

**Aanpak**: boven een drempel (bv. 100 MB) alleen de metadata bewaren, en in
beeld eerlijk zeggen dat dit bestand bij een herstart opnieuw gekozen moet
worden. Quota-fouten doorgeven in plaats van slikken.

### 16. Opnieuw in de rij zetten laat een wees achter

```ts
tasks = [...tasks.filter(… t.name === file.name), task];   // :227
```

De oude taak verdwijnt uit beeld, maar niet uit IndexedDB — anders dan
`removeTask` (`:161`), dat wél `vergeetUpload` aanroept. Dat oude record wordt bij
de volgende keer openen door `hervatOpenstaandeUploads` weer opgepakt en
opnieuw geüpload. Dat verklaart spookuploads die "uit een vorige sessie" komen
terwijl er niets misging.

Bijkomend: na verkleinen heet de taak `.jpg` terwijl de vergelijking op de
oorspronkelijke `.HEIC`-naam kijkt — dezelfde foto komt dan twee keer in de lijst.

### 17. Twee tabbladen delen één uploadsessie

`UploadResume` staat in de root-layout (`app/layout.tsx:46`) en roept bij elke
montage `hervatOpenstaandeUploads()` aan. IndexedDB is gedeeld tussen tabbladen.
Twee tabbladen van de app pakken dus dezelfde taak op, gebruiken hetzelfde
Dropbox `session_id` en schrijven allebei in `uploadsessies` (`:701`). In het
beste geval dubbel werk over dezelfde uplink; in het slechtste twee werkers die
hetzelfde offset-bereik door elkaar schrijven.

**Aanpak**: een eigenaarsclaim per taak — `navigator.locks`, of een
`eigenaar`-veld met tijdstempel in het record dat elke paar seconden ververst
wordt.

---

## Beveiliging

### 18. De dropbox-routes accepteren elk pad

`/api/dropbox/upload-link`, `/api/dropbox/upload-file`, `/api/dropbox/delete-file`
en `/api/dropbox/files` nemen het pad over zoals het binnenkomt. En
`/api/dropbox/session-token` geeft een token op het **hele Dropbox-account** aan
de browser.

Dat is opvallend naast `/api/intern/media-plaatsen`, dat precies dit wél
dichtzet — inclusief de toelichting waaróm (`lib/media-pad.ts:8`):

> een link is een schrijfrecht op precies dat ene pad. Wordt er hier te ruim
> gedacht, dan is het dienst-token een schrijfrecht op de hele Dropbox geworden.

Aan de gebruikerskant geldt hetzelfde: iedere ingelogde gebruiker — of een XSS op
één pagina — kan nu overal in de bedrijfs-Dropbox schrijven en verwijderen.

**Aanpak**: dezelfde padcontrole in de dropbox-routes (alleen onder de drie
"Automatie …"-hoofdmappen, geen `..`), en de sessie-token-route beperken tot het
geval waarvoor hij bedoeld is (grote bestanden) met logging erop.

---

## Onderhoud

### 19. De foutcontrole maakt een schrijfactie

Loopt een upload stuk, dan kijkt `fileExists` (`:789`) of het bestand er tóch
staat — via `/api/dropbox/files`, en díé route maakt en passant een deellink aan
(`app/api/dropbox/files/route.ts:20`). Dus juist bij fouten, als Dropbox al
onder druk staat, komt er een schrijfactie bij. Splits het listen van het
maken van een deellink.

### 20. De serverterugval is voor grote bestanden onwerkbaar

`uploadChunked` (`:728`) stuurt blokken van 4 MB door onze functies. Voor een
video van 2 GB zijn dat 500+ aanroepen, elk met een eigen tokenrefresh en elk met
`maxDuration 60`. Die weg gaat in de praktijk niet slagen — maar wel pas ná een
half uur proberen. Beter: de directe weg robuust maken (punten 2–4) en de
serverroute begrenzen op bestanden waarvoor hij realistisch is.

### 21. Weinig vangnet in tests

Rond deze keten staat één testbestand (`lib/blok-indeling.test.ts`) — en dat is
een goede: het legt precies de logica vast waar een fout stil een kapot bestand
oplevert. De rest van de risicovolle logica is net zo goed te testen zonder
browser: welke fout herstelbaar is, de volgorde rond `close`, de gewichten in
`pump()`, en het opruimen van bewaarde uploads.

---

## Voorgestelde volgorde

| # | Wat | Waarom eerst |
| --- | --- | --- |
| 1 | Timeouts + stilstandbewaking (punt 1) | Haalt de permanente "bezig, 0%" weg — de hoofdklacht |
| 2 | `close` als losse laatste stap (punt 2) | Grote video's lopen nu systematisch stuk |
| 3 | Token cachen (punt 3) | Eén regel effect op de hele app, haalt 429-druk weg |
| 4 | `Retry-After` + backoff (punt 4) | Maakt herkansen pas echt werkend |
| 5 | Parallel naar 4–6 (punt 5) | Eén constante; minder 429 en echt afgeronde bestanden |
| 6 | Opnieuw-knop op /media (punt 6) | De opnemer kan zichzelf redden op locatie |

Punten 1 tot en met 5 zitten alle vijf in `lib/upload-queue.ts` en
`lib/dropbox.ts`, en raken ook de NEN- en energielabel-uploads — die gebruiken
dezelfde wachtrij.
