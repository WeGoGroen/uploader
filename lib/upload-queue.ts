/**
 * Upload-wachtrij die buiten React leeft, zodat lopende uploads gewoon
 * doorgaan (én zichtbaar blijven) als je tussendoor naar een andere pagina
 * navigeert. Componenten lezen 'm via useSyncExternalStore.
 *
 * Snelheid zit in twee dingen:
 *  1. Het bestand gaat rechtstreeks naar Dropbox via een kortlopende
 *     uploadlink — geen omweg via onze server, dus één netwerk-hop i.p.v.
 *     twee, en geen ~4,5MB-limiet per aanroep (dus geen chunk-gedoe voor
 *     normale foto's/scans).
 *  2. Meerdere bestanden gaan tegelijk omhoog (tot MAX_PARALLEL).
 * De oude server-route blijft als terugval, zodat een geblokkeerde directe
 * verbinding de upload niet onmogelijk maakt.
 */

import { compressImage, isCompressibleImage, mayCompressFolder } from "@/lib/image-compress";
import { tijdslimiet } from "@/lib/tijdslimiet";
import { vraagUploadLink } from "@/lib/upload-links";
import {
  bewaarUpload,
  bewaarUploadSessie,
  leesUploadSessie,
  openstaandeUploads,
  vergeetUpload,
  vergeetUploadSessie,
} from "@/lib/upload-store";

export type DropboxStatus = "uploading" | "done" | "error";

export interface UploadTask {
  id: string;
  /** Dropbox-map van het adres, bv. "/Automatie NEN2580/Damrak 1, Amsterdam". */
  folderPath: string;
  /** Submap: Optimized, RAW, Additionals of Photo's. */
  folder: string;
  name: string;
  /** ClickUp-gebruiker die deze upload startte, voor zover bekend. */
  account?: string | null;
  pct: number;
  dropbox: DropboxStatus;
  dropboxError?: string;
  /** Bespaarde bytes door de foto te verkleinen (0 = niet verkleind). */
  savedBytes?: number;
  /** Geschatte resterende tijd in seconden, of null zolang dat nog niet te
      zeggen valt (te weinig gemeten). */
  etaSeconds?: number | null;
}

/**
 * Parallelisme op gewicht i.p.v. op aantal bestanden. "3 bestanden tegelijk"
 * behandelde 60 foto's van 800KB hetzelfde als 3 video's van 100MB — de
 * uplink stond bij fotoseries grotendeels leeg.
 *
 * Het gewicht is precies het aantal verbindingen dat een taak openzet: een
 * foto er één, een groot bestand er CHUNK_PARALLEL (zijn blokken gaan immers
 * tegelijk). Binnen het budget past dus één video plus twee foto's, of zes
 * foto's — nooit meer dan zes verbindingen tegelijk.
 *
 * Twaalf stond hier eerder, met de gedachte dat elke foto vooral wáchttijd
 * is. Die vlieger gaat maar half op: de wachttijd loopt inderdaad parallel,
 * maar de bytes delen één uplink, dus twaalf tegelijk kruipen samen naar 40%
 * en dan is er níets af. Valt de verbinding weg, dan is al dat verstuurde
 * werk weg. Met zes is dezelfde serie even snel klaar, maar zijn er onderweg
 * steeds bestanden écht binnen. Bovendien is twaalf gelijktijdig schrijven in
 * dezelfde map precies waar Dropbox met 429 (too_many_write_operations) op
 * antwoordt, en elke 429 kost wachttijd plus een herkansing.
 */
const PARALLEL_BUDGET = 6;
// Boven deze grens accepteert een enkele Dropbox-upload het bestand niet meer
// in één keer; dan valt de upload terug op de chunked server-route.
const DIRECT_UPLOAD_MAX = 140 * 1024 * 1024;
const SERVER_UPLOAD_MAX = 4 * 1024 * 1024;
// Dropbox eist voor concurrent-sessies blokken van precies een veelvoud van
// 4MB (behalve het laatste); 4MB is meteen ook de bovengrens van wat een
// Vercel-functie per aanroep aanneemt.
const CHUNK_SIZE = 4 * 1024 * 1024;
/** Aantal blokken dat tegelijk omhoog gaat bij een groot bestand. */
const CHUNK_PARALLEL = 4;
/** Zie hierboven: een groot bestand kost precies zoveel verbindingen. */
const GEWICHT_GROOT = CHUNK_PARALLEL;
/**
 * Bovengrens voor de blokgrootte op de directe weg naar Dropbox. Veel groter
 * dan de 4MB die via onze server past, want daar geldt de Vercel-limiet niet
 * — minder rondjes over het netwerk en dus sneller.
 */
const DIRECT_CHUNK_MAX = 16 * 1024 * 1024;
/**
 * Vanaf deze grootte gaat een bestand in parallelle blokken omhoog i.p.v. als
 * één stroom. Eén verbinding trekt op 4G/5G de uplink zelden vol, dus hoe
 * eerder blokken beginnen hoe beter — maar onder de drie blokken weegt het
 * opzetten van een sessie (start + close + finish) niet op tegen de winst.
 * Drie blokken van 4MB is dus de ondergrens.
 *
 * Stond op 24MB, waardoor een 360-panorama van 20MB als één lange POST ging.
 */
const PARALLEL_VANAF = 3 * CHUNK_SIZE;

/**
 * De blokgrootte voor dit bestand.
 *
 * Eén vaste maat werkt niet aan beide kanten: met 16MB-blokken gaat een
 * bestand van 20MB in twee blokken, waarvan er één 4MB is — dan staan er twee
 * werkers te wachten op een derde die er niet is. Delen door het aantal
 * werkers geeft ieder werk, afgerond naar beneden op de 4MB die Dropbox voor
 * concurrent-sessies eist, en begrensd zodat een video van 2GB niet in blokken
 * van 128MB gaat (één hapering kost dan 128MB opnieuw).
 */
export function blokGrootte(fileSize: number): number {
  const perWerker = Math.floor(fileSize / CHUNK_PARALLEL / CHUNK_SIZE) * CHUNK_SIZE;
  return Math.min(DIRECT_CHUNK_MAX, Math.max(CHUNK_SIZE, perWerker));
}

let tasks: UploadTask[] = [];
const listeners = new Set<() => void>();
const pending: { task: UploadTask; file: File }[] = [];
let runningWeight = 0;
let seq = 0;

// Eigen rijtje voor het verkleinen van foto's, los van de uploadslots.
// Vroeger gebeurde het verkleinen bínnen een uploadslot: terwijl de CPU een
// HEIC decodeerde deed dat netwerkslot niets. Nu werkt de compressie vooruit
// en krijgen de uploadslots alleen bestanden die klaar zijn om te versturen.
const compressPending: { task: UploadTask; file: File }[] = [];
let compressing = 0;
// Drie tegelijk: met twaalf uploadslots was verkleinen bij een serie van
// twintig foto's de nieuwe flessenhals — de slots stonden te wachten op de
// CPU. Hoger niet: elke verkleining houdt een gedecodeerde foto in het
// geheugen, en dat is op een iPad de grens waar Safari tabbladen wegruimt.
const COMPRESS_PARALLEL = 3;

function emit() {
  // Nieuwe array-referentie: useSyncExternalStore vergelijkt op identiteit.
  tasks = [...tasks];
  for (const l of listeners) l();
}

/**
 * Voortgang bijwerken inclusief een schatting van de resterende tijd. De
 * snelheid wordt over de hele upload gemiddeld i.p.v. over de laatste
 * seconde: dat geeft een rustig aflopende schatting in plaats van een getal
 * dat bij elke hapering heen en weer springt.
 */
const startedAt = new Map<string, number>();

function setProgress(id: string, done: number, total: number) {
  const start = startedAt.get(id);
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  let etaSeconds: number | null = null;
  if (start && done > 0) {
    const elapsed = (Date.now() - start) / 1000;
    // Pas schatten na een seconde en wat data; daarvoor is de meting ruis.
    if (elapsed > 1 && done > 256 * 1024) {
      const bytesPerSecond = done / elapsed;
      etaSeconds = Math.max(0, (total - done) / bytesPerSecond);
    }
  }
  patch(id, { pct, etaSeconds });
}

function patch(id: string, changes: Partial<UploadTask>) {
  tasks = tasks.map((t) => (t.id === id ? { ...t, ...changes } : t));
  for (const l of listeners) l();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSnapshot(): UploadTask[] {
  return tasks;
}

const EMPTY: UploadTask[] = [];
export function getServerSnapshot(): UploadTask[] {
  return EMPTY;
}

/** Haalt één bestand uit de lijst — gebruikt nadat het uit Dropbox is
    verwijderd, zodat de map niet ten onrechte "klaar" blijft. */
export function removeTask(folderPath: string, folder: string, name: string) {
  for (const t of tasks) {
    if (t.folderPath === folderPath && t.folder === folder && t.name === name) void vergeetUpload(t.id);
  }
  tasks = tasks.filter((t) => !(t.folderPath === folderPath && t.folder === folder && t.name === name));
  emit();
}

/** Vergeet afgeronde uploads van één adres (bv. bij het openen van een nieuw adres). */
export function clearFinished(folderPath: string) {
  tasks = tasks.filter((t) => t.folderPath !== folderPath || t.dropbox === "uploading");
  emit();
}

/**
 * Haalt alles weg wat bij één opname hoort: uit de lijst in beeld én uit de
 * bewaarde uploads.
 *
 * Allebei is nodig. Alleen uit de lijst halen laat het bestand in IndexedDB
 * staan, en hervatOpenstaandeUploads() leest dat bij het volgende bezoek
 * gewoon terug — dan staat de verwijderde opname er weer, en precies dát was
 * de klacht. Alleen de opslag leegmaken laat de regel staan tot je ververst.
 *
 * Ook de opslag wordt zelfstandig doorzocht en niet alleen op de taken die nu
 * in beeld staan: het hervatten is asynchroon, dus wie snel genoeg verwijdert
 * zou anders langs een nog niet ingeladen upload heen lopen.
 *
 * Geeft terug hoeveel er weg zijn, zodat de aanroeper kan zeggen wat er is
 * gebeurd in plaats van het te moeten gokken.
 */
export async function vergeetTakenVoor(
  hoortErbij: (item: { folderPath: string }) => boolean
): Promise<number> {
  const ids = new Set(tasks.filter(hoortErbij).map((t) => t.id));
  if (ids.size > 0) {
    tasks = tasks.filter((t) => !ids.has(t.id));
    emit();
  }

  // De uploads die bewaard staan maar (nog) niet in beeld zijn.
  for (const bewaard of await openstaandeUploads()) {
    if (hoortErbij(bewaard)) ids.add(bewaard.id);
  }
  for (const id of ids) await vergeetUpload(id);

  return ids.size;
}

export function enqueue(
  folderPath: string,
  folder: string,
  file: File,
  /** Wie deze upload start; belandt ook in de opslag, zodat de naam een
      herstart van de app overleeft. */
  account?: string | null
) {
  const task: UploadTask = {
    id: `${Date.now()}-${seq++}`,
    folderPath,
    folder,
    name: file.name,
    account: account ?? null,
    pct: 0,
    dropbox: "uploading",
  };
  // Zelfde bestandsnaam opnieuw uploaden: oude regel vervangen i.p.v. dubbel tonen.
  tasks = [...tasks.filter((t) => !(t.folderPath === folderPath && t.folder === folder && t.name === file.name)), task];
  emit();
  // Meteen vastleggen: als de iPad het tabblad afsluit terwijl dit nog
  // loopt, pakken we 'm bij de volgende keer openen weer op.
  void bewaarUpload({ id: task.id, folderPath, folder, name: file.name, file, account: account ?? null });
  routeer(task, file);
}

/**
 * Zet een bestand op het juiste rijtje: eerst verkleinen (foto's), of direct
 * de uploadwachtrij in. Eén plek, zodat ook hervatte en opnieuw geprobeerde
 * uploads door de compressie gaan — anders zou een hervatte fotoserie
 * ineens de originelen versturen.
 */
function routeer(task: UploadTask, file: File) {
  if (mayCompressFolder(task.folder) && isCompressibleImage(file)) {
    compressPending.push({ task, file });
    pumpCompress();
  } else {
    pending.push({ task, file });
    pump();
  }
}

function pumpCompress() {
  while (compressing < COMPRESS_PARALLEL && compressPending.length > 0) {
    const next = compressPending.shift()!;
    compressing++;
    void (async () => {
      let file = next.file;
      // compressImage geeft bij elk probleem het origineel terug; de extra
      // vangrail hier is voor het geval zelfs dat misgaat — een mislukte
      // verkleining mag nooit de upload blokkeren.
      try {
        file = await compressImage(next.file);
        if (file !== next.file) {
          patch(next.task.id, { name: file.name, savedBytes: next.file.size - file.size });
        }
      } catch {
        file = next.file;
      }
      pending.push({ task: next.task, file });
      pump();
    })().finally(() => {
      compressing--;
      pumpCompress();
    });
  }
}

/**
 * Hervat uploads die bij een vorige sessie zijn blijven liggen. Een half
 * verstuurd bestand wordt opnieuw vanaf het begin gestuurd — Dropbox
 * overschrijft dan gewoon, dus er ontstaan geen dubbele bestanden.
 */
/**
 * Geeft de ids van de hervatte uploads terug (niet alleen het aantal), zodat
 * de melding in beeld precies díe uploads kan volgen — welk adres, welk
 * bestand en hoe het aflopt. Met alleen een getal was er geen manier om te
 * zien waar die uploads bij hoorden.
 */
export async function hervatOpenstaandeUploads(): Promise<string[]> {
  const openstaand = await openstaandeUploads();
  const hervat: string[] = [];
  let nieuw = 0;
  for (const u of openstaand) {
    // Idempotent: elke openstaande upload komt altijd in de uitkomst, ook als
    // hij al liep. Anders kreeg een tweede aanroep (React die het effect
    // opnieuw uitvoert, of gewoon een remount) een lege lijst terug en verdween
    // de melding uit beeld terwijl de upload gewoon doorging — je zag dan niet
    // dát er iets mislukt was.
    hervat.push(u.id);
    if (tasks.some((t) => t.id === u.id)) continue;
    const task: UploadTask = {
      id: u.id,
      folderPath: u.folderPath,
      folder: u.folder,
      name: u.name,
      account: u.account ?? null,
      pct: 0,
      dropbox: "uploading",
      };
    tasks = [...tasks, task];
    routeer(task, u.file);
    nieuw++;
  }
  if (nieuw > 0) emit();
  return hervat;
}

/**
 * Zet mislukte uploads opnieuw in de wachtrij en maakt ze alsnog af.
 *
 * Het bestand staat nog in IndexedDB (bij een fout wordt het bewust niet
 * opgeruimd), dus dit hoeft niets aan de gebruiker te vragen — geen bestand
 * opnieuw opzoeken op de iPad, geen opname heropenen. Eén klik en de opdracht
 * loopt af waar hij gebleven was.
 *
 * Geeft terug hoeveel er daadwerkelijk opnieuw gestart zijn: staat het bestand
 * er niet meer (ouder dan een dag, of opslag geweigerd), dan valt er niets te
 * hervatten en moet de melding dat eerlijk zeggen.
 */
export async function probeerOpnieuw(ids: string[]): Promise<number> {
  const set = new Set(ids);
  const bewaard = await openstaandeUploads();
  let gestart = 0;

  for (const u of bewaard) {
    if (!set.has(u.id)) continue;
    const bestaand = tasks.find((t) => t.id === u.id);
    // Al bezig? Dan niet nog een keer in de rij zetten.
    if (bestaand?.dropbox === "uploading") continue;

    // Staat hij niet meer in deze sessie (melding weggeklikt, pagina ververst),
    // dan alsnog aanmaken — anders zou "opnieuw proberen" stil niets doen.
    const task: UploadTask = bestaand ?? {
      id: u.id,
      folderPath: u.folderPath,
      folder: u.folder,
      name: u.name,
      account: u.account ?? null,
      pct: 0,
      dropbox: "uploading",
      };
    if (bestaand) {
      patch(u.id, {
        dropbox: "uploading",
        pct: 0,
        dropboxError: undefined,
            etaSeconds: null,
      });
    } else {
      tasks = [...tasks, task];
    }
    routeer(task, u.file);
    gestart++;
  }

  if (gestart > 0) emit();
  return gestart;
}

/** Haalt taken op id uit de lijst — voor het wegklikken van de hervat-melding. */
export function forgetTasks(ids: string[]) {
  const set = new Set(ids);
  for (const t of tasks) if (set.has(t.id)) void vergeetUpload(t.id);
  tasks = tasks.filter((t) => !set.has(t.id));
  emit();
}

function gewicht(file: File): number {
  return file.size >= PARALLEL_VANAF ? GEWICHT_GROOT : 1;
}

function pump() {
  for (;;) {
    if (pending.length === 0) return;
    // Het eerste bestand dat nog in het budget past. Een grote video vooraan
    // mag de foto's erachter niet laten wachten — die passen er wél naast.
    let idx = pending.findIndex((p) => runningWeight + gewicht(p.file) <= PARALLEL_BUDGET);
    if (idx === -1) {
      // Niets past meer; staat er helemaal niets te lopen, dan toch de
      // eerste nemen — er moet altijd íéts kunnen starten.
      if (runningWeight > 0) return;
      idx = 0;
    }
    const next = pending.splice(idx, 1)[0];
    const w = gewicht(next.file);
    runningWeight += w;
    void runTask(next.task, next.file).finally(() => {
      runningWeight -= w;
      pump();
    });
  }
}

async function runTask(task: UploadTask, file: File) {
  // Verkleinen is hier al gebeurd (zie pumpCompress): dit slot is puur netwerk.
  const fullPath = `${task.folderPath}/${task.folder}/${file.name}`;
  startedAt.set(task.id, Date.now());
  try {
    if (file.size < PARALLEL_VANAF) {
      // Klein genoeg om in één keer te sturen; blokken opzetten zou hier
      // alleen maar extra rondjes kosten.
      await uploadDirect(task, file, fullPath);
    } else if (file.size <= DIRECT_UPLOAD_MAX) {
      // Video's en grote foto's: parallelle blokken, met de enkele stroom als
      // terugval zodat een geblokkeerde sessie de upload niet onmogelijk maakt.
      try {
        await uploadChunkedDirect(task, file, fullPath);
      } catch {
        await uploadDirect(task, file, fullPath);
      }
    } else {
      // Te groot voor één aanroep: parallelle blokken, anders via onze server.
      try {
        await uploadChunkedDirect(task, file, fullPath);
      } catch {
        await uploadChunked(task, file, fullPath);
      }
    }
    patch(task.id, { dropbox: "done", pct: 100, etaSeconds: null });
    startedAt.delete(task.id);
    void vergeetUpload(task.id);
  } catch (err) {
    // De upload kan tóch geslaagd zijn (netwerk-hik ná aankomst) — pas
    // "mislukt" tonen als het bestand echt niet in de map staat.
    const reallyThere = await fileExists(task.folderPath, task.folder, file.name);
    if (reallyThere) {
      patch(task.id, { dropbox: "done", pct: 100 });
      void vergeetUpload(task.id);
      return;
    }
    // Bewust níét vergeten bij een fout: zo kan een volgende keer openen het
    // alsnog oppakken in plaats van dat het bestand stilletjes verdwijnt.
    patch(task.id, {
      dropbox: "error",
      dropboxError: err instanceof Error ? err.message : "Uploaden mislukt",
    });
  }
}

/** Rechtstreeks naar Dropbox — de snelle weg. */
async function uploadDirect(task: UploadTask, file: File, fullPath: string) {
  // Eén link per bestand, maar wel per serie opgehaald: zie lib/upload-links.ts.
  const link = await vraagUploadLink(fullPath);
  if (!link) {
    // Geen link te krijgen: via de server proberen zodat de opname doorgaat.
    await uploadViaServer(task, file);
    return;
  }

  await metBlokRetry(() =>
    verstuurXhr({
      url: link,
      body: file,
      headers: { "Content-Type": "application/octet-stream" },
      onProgress: (verzonden, totaal) => setProgress(task.id, verzonden, totaal),
      melding: (status) => `Dropbox weigerde het bestand (gaf ${status})`,
    })
  );
}

/** Terugval: via onze server (geldt ook voor bestanden > 4MB via chunks). */
async function uploadViaServer(task: UploadTask, file: File) {
  if (file.size > SERVER_UPLOAD_MAX) {
    await uploadChunked(task, file, `${task.folderPath}/${task.folder}/${file.name}`);
    return;
  }
  const form = new FormData();
  form.append("path", `${task.folderPath}/${task.folder}`);
  form.append("file", file);
  await metBlokRetry(() =>
    verstuurXhr({
      url: "/api/dropbox/upload-file",
      body: form,
      onProgress: (verzonden, totaal) => setProgress(task.id, verzonden, totaal),
      melding: (_status, body) => {
        try {
          return (JSON.parse(body).error as string) ?? "Uploaden mislukt";
        } catch {
          return "Uploaden mislukt";
        }
      },
    })
  );
}

/**
 * Snelste weg voor grote scans: rechtstreeks naar Dropbox mét een
 * kortlopend token, in grote blokken die tegelijk omhoog gaan. Omdat onze
 * server er niet tussen zit, geldt de ~4,5MB-limiet per aanroep niet en
 * kunnen de blokken veel groter — minder rondjes, dus sneller.
 *
 * Het token blijft in het geheugen van dit tabblad en wordt nooit opgeslagen.
 * Lukt het ophalen niet (bv. sessie verlopen), dan valt de upload terug op de
 * route via onze server.
 */
/** Zelfde escaping als server-side: headers mogen geen niet-ASCII bevatten. */
/**
 * Verdeelt een bestand in blokken en zegt welke er nog moeten. Losse functie
 * omdat een fout hier niet zichtbaar misgaat maar een stil beschadigd bestand
 * oplevert: een blok op de verkeerde positie schrijft de video kapot.
 */
export function blokIndeling(
  fileSize: number,
  chunkSize: number,
  klaar: number[]
): { alle: [number, number][]; resterend: [number, number][]; alGedaan: number } {
  const alle: [number, number][] = [];
  for (let o = 0; o < fileSize; o += chunkSize) {
    alle.push([o, Math.min(o + chunkSize, fileSize)]);
  }
  // Alleen posities die echt bij een blok horen tellen mee; een bewaarde
  // positie uit een andere blokindeling zou anders bytes doen overslaan.
  const geldig = new Set(alle.map(([from]) => from));
  const gedaan = new Set(klaar.filter((from) => geldig.has(from)));
  const resterend = alle.filter(([from]) => !gedaan.has(from));
  const alGedaan = alle
    .filter(([from]) => gedaan.has(from))
    .reduce((tot, [from, to]) => tot + (to - from), 0);
  return { alle, resterend, alGedaan };
}

/**
 * Zet het blok dat de sessie sluit apart van de blokken die parallel mogen.
 *
 * Bij een concurrent-sessie moet het blok dat het bestand compleet maakt
 * `close: true` meesturen, anders weigert finish met
 * "concurrent_session_not_closed". Maar zodra dat blok binnen is, is de sessie
 * dicht: elke append die dán nog onderweg is, krijgt van Dropbox een 409
 * "closed" terug.
 *
 * En precies dat gebeurde. De werkers pakten de blokken op volgorde, dus het
 * sluitende blok ging als laatste de deur uit — maar het is ook het kleinste
 * (de rest na de hele veelvouden), dus het was er vaak als eerste, terwijl er
 * nog drie blokken van 16MB onderweg waren. Die sneuvelden dan alle drie, en
 * 409 is geen fout waar opnieuw proberen iets aan verandert.
 *
 * Een video is het enige wat hier langskomt dat groot genoeg is om in blokken
 * te gaan; foto's blijven onder de grens. Vandaar dat dit zich liet zien als
 * "video's uploaden lukt niet" en de rest gewoon werkte.
 */
export function afsluitBlok(
  fileSize: number,
  resterend: [number, number][]
): { parallel: [number, number][]; sluit: [number, number] | null } {
  const idx = resterend.findIndex(([, to]) => to === fileSize);
  if (idx === -1) return { parallel: resterend, sluit: null };
  return { parallel: resterend.filter((_, i) => i !== idx), sluit: resterend[idx] };
}

/**
 * Een antwoord dat we niet wilden: statuscode én wat er in de body stond.
 *
 * Eerder werd de fout als losse tekst doorgegeven en er met een reguliere
 * expressie weer uit gevist ("gaf 429"). Dat werkte zolang niemand een melding
 * herschreef — en wie dat wel deed zette ongemerkt alle herkansingen uit. Nu
 * dragen de fouten hun eigen gegevens.
 */
export class UploadFout extends Error {
  constructor(
    public status: number,
    public body: string,
    /** Wat de server in Retry-After meegaf, in seconden. */
    public retryAfter: number | null = null,
    melding?: string
  ) {
    super(melding ?? `Uploaden mislukt — gaf ${status}`);
    this.name = "UploadFout";
  }
}

/** Netwerk weg, stilgevallen of afgebroken: herhalen heeft altijd zin. */
export class NetwerkFout extends Error {
  constructor(melding = "Netwerkfout bij uploaden") {
    super(melding);
    this.name = "NetwerkFout";
  }
}

/**
 * De code die Dropbox zélf gaf.
 *
 * Onze eigen chunk-route verpakt élke Dropbox-fout als een 502, dus daar zegt
 * de buitenste status niets. Staat de code van Dropbox in de body, dan telt
 * die: een 409 ("closed", "incorrect_offset") wordt bij een herhaling precies
 * hetzelfde antwoord, en dat is twee keer 4MB voor niets op een verbinding
 * waar het toch al niet vlot ging.
 */
function dropboxStatus(err: UploadFout): number {
  const vanDropbox = /failed: (\d{3})/.exec(err.body);
  return vanDropbox ? Number(vanDropbox[1]) : err.status;
}

/**
 * Heeft het zin dit nog eens te proberen? Alleen bij netwerkfouten, 429 en
 * 5xx — een 401 of een 409 op het pad blijft meteen fataal, daar lost wachten
 * niets aan op.
 */
export function magOpnieuw(err: unknown): boolean {
  if (err instanceof NetwerkFout) return true;
  if (err instanceof UploadFout) {
    const status = dropboxStatus(err);
    return status === 429 || status >= 500;
  }
  // Fouten die alleen tekst dragen, van code die nog niet door verstuurXhr
  // loopt.
  return blokFoutHerstelbaar(err);
}

/**
 * Is de uploadsessie zelf stuk? Dan heeft hervatten geen zin en moet het
 * bestand opnieuw beginnen. Bij elke andere fout zijn de blokken die Dropbox
 * al binnen heeft gewoon nog geldig — en die opnieuw sturen is precies het
 * werk dat we willen besparen.
 */
export function sessieOnbruikbaar(err: unknown): boolean {
  if (!(err instanceof UploadFout)) return false;
  // Alleen een 409: dát is de status waarmee Dropbox iets over de sessie zelf
  // zegt. Een 401 (token verlopen) noemt ook "expired", maar daar is de sessie
  // niets mis mee — die hoeft alleen een vers token. Op status vergeten te
  // letten zou een video van 800MB weggooien om een token van vier uur oud.
  if (dropboxStatus(err) !== 409) return false;
  return /not_found|incorrect_offset|closed|expired|invalid/i.test(err.body);
}

/**
 * Herkansingen per blok. Eén netwerk-hik op blok 5 van 8 gooide voorheen de
 * hele poging weg; nu krijgt dat ene blok gewoon nog een kans terwijl de rest
 * blijft staan.
 */
const BLOK_POGINGEN = 5;
const WACHT_MAX_MS = 60_000;

/**
 * Hoe lang wachten voor de volgende poging.
 *
 * Retry-After wint: zegt Dropbox "wacht vijftien seconden", dan is drie keer
 * binnen vier seconden terugkomen drie keer dezelfde 429. Zonder die header
 * verdubbelt de wachttijd per poging, met een willekeurige marge erbovenop —
 * anders komen tien uploads die samen een 429 kregen ook weer samen terug, en
 * lokken ze precies dezelfde fout opnieuw uit.
 */
export function wachttijd(poging: number, retryAfter: number | null): number {
  if (retryAfter && retryAfter > 0) return Math.min(retryAfter * 1000, WACHT_MAX_MS);
  const basis = Math.min(1000 * 2 ** (poging - 1), 20_000);
  return basis + Math.round(Math.random() * basis * 0.5);
}

function wachtEven(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Zelfde beoordeling, maar op de tékst van een melding — voor fouten die hun
 * statuscode niet apart dragen. Zie dropboxStatus() voor het waarom van de
 * blik door onze eigen 502 heen.
 */
export function blokFoutHerstelbaar(err: unknown): boolean {
  const melding = err instanceof Error ? err.message : "";
  const vanDropbox = /failed: (\d{3})/.exec(melding);
  if (vanDropbox) return /^(429|5\d\d)$/.test(vanDropbox[1]);
  return /Netwerkfout/.test(melding) || /gaf (429|5\d\d)/.test(melding);
}

async function metBlokRetry<T>(doe: () => Promise<T>): Promise<T> {
  for (let poging = 1; ; poging++) {
    try {
      return await doe();
    } catch (err) {
      if (poging >= BLOK_POGINGEN || !magOpnieuw(err)) throw err;
      await wachtEven(wachttijd(poging, err instanceof UploadFout ? err.retryAfter : null));
    }
  }
}

/**
 * Zo lang mag een lopende upload stilstaan voordat we hem afbreken.
 *
 * Een harde tijdslimiet kan hier niet: een video van 800MB mag best een half
 * uur duren. Wat niet mag is stílstaan. Een XHR op een dood mobiel kanaal
 * blijft namelijk hangen zonder ooit onload of onerror te geven — de taak
 * rondde dan nooit af, en omdat pump() het slot pas vrijgeeft als de taak áf
 * is, zette één zo'n upload de hele wachtrij stil. Alles op "bezig", 0%, voor
 * altijd; precies het beeld waarmee "de uploader loopt vast" begint.
 */
const STILSTAND_MS = 45_000;
/** Na de laatste byte wachten we op antwoord. Dropbox mag daar bij het
    afronden van een groot bestand even over doen. */
const ANTWOORD_MS = 120_000;
/** Kleine JSON-aanroepen naar onze eigen server. */
const KORT_MS = 20_000;
/**
 * Een blok van 4MB via onze server. Fetch geeft geen voortgang bij het
 * versturen, dus hier kan alleen een harde grens — ruim genomen, want op een
 * trage uplink duurt 4MB al gauw een paar minuten. Het is een noodrem tegen
 * blijven hangen, geen tijdsbudget.
 */
const BLOK_ANTWOORD_MS = 5 * 60_000;

interface VerstuurOpties {
  url: string;
  body: Blob | ArrayBuffer | FormData | null;
  headers?: Record<string, string>;
  onProgress?: (verzonden: number, totaal: number) => void;
  /** Vertaalt een foutantwoord naar een melding voor in beeld. */
  melding?: (status: number, body: string) => string;
}

/** Eén verzoek met bestandsinhoud, mét bewaking op stilstand. */
function verstuurXhr({ url, body, headers = {}, onProgress, melding }: VerstuurOpties): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let afgerond = false;
    let bewaker: ReturnType<typeof setTimeout> | null = null;

    const stop = () => {
      if (bewaker) clearTimeout(bewaker);
      bewaker = null;
    };
    const eenmalig = (fn: () => void) => {
      if (afgerond) return;
      afgerond = true;
      stop();
      fn();
    };
    const bewaak = (ms: number, waarom: string) => {
      stop();
      bewaker = setTimeout(() => {
        eenmalig(() => {
          xhr.abort();
          reject(new NetwerkFout(`Netwerkfout: ${waarom}`));
        });
      }, ms);
    };

    xhr.open("POST", url);
    for (const [naam, waarde] of Object.entries(headers)) xhr.setRequestHeader(naam, waarde);

    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      bewaak(STILSTAND_MS, "de upload stond stil");
      onProgress?.(e.loaded, e.total);
    };
    // Alles verstuurd: vanaf hier wachten we op de server, niet op de uplink.
    xhr.upload.onloadend = () => bewaak(ANTWOORD_MS, "geen antwoord na het versturen");
    xhr.onload = () =>
      eenmalig(() => {
        if (xhr.status >= 200 && xhr.status < 300) return resolve(xhr.responseText);
        const tekst = xhr.responseText ?? "";
        const naSeconden = Number(xhr.getResponseHeader("Retry-After"));
        reject(
          new UploadFout(
            xhr.status,
            tekst,
            Number.isFinite(naSeconden) && naSeconden > 0 ? naSeconden : null,
            melding?.(xhr.status, tekst)
          )
        );
      });
    xhr.onerror = () => eenmalig(() => reject(new NetwerkFout()));
    xhr.ontimeout = () => eenmalig(() => reject(new NetwerkFout("Netwerkfout: tijd verstreken")));

    // Ook vóór de eerste byte: een verbinding die niet opgezet wordt hangt net
    // zo hard als een verbinding die halverwege stilvalt.
    bewaak(STILSTAND_MS, "de verbinding kwam niet op gang");
    xhr.send(body);
  });
}

function safeArg(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (c) =>
    "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")
  );
}

/**
 * Grote bestanden in parallelle blokken rechtstreeks naar Dropbox.
 *
 * Hervatbaar: het sessie-id en de blokken die Dropbox al binnen heeft worden
 * op het apparaat bewaard. Sluit de iPad tijdens een video van 100MB die op
 * 80% zat, dan gaan bij het heropenen alleen de resterende blokken omhoog in
 * plaats van het hele bestand opnieuw. Blijkt de sessie niet meer geldig
 * (Dropbox ruimt ze na verloop van tijd op), dan begint hij alsnog schoon —
 * daarom de tweede poging hieronder.
 */
async function uploadChunkedDirect(task: UploadTask, file: File, fullPath: string) {
  try {
    await chunkedDirectPoging(task, file, fullPath, true);
  } catch (err) {
    const bewaard = await leesUploadSessie(task.id);
    // Alleen een tweede poging als er ook echt iets te hergebruiken viel;
    // anders was dit gewoon een mislukte upload en heeft herhalen geen zin.
    if (!bewaard) throw err;

    /*
      En dan hervatten, niet opnieuw beginnen.

      Dit gooide de sessie altijd weg en stuurde het hele bestand nóg een keer.
      Bij een video van 800MB op 4G is dat een half uur werk dat de prullenbak
      in gaat om een hapering op één blok — terwijl de blokken die Dropbox al
      binnen heeft gewoon geldig blijven. Alleen als de sessie zélf stuk is
      (verlopen, of op een verkeerde positie) valt er niets te hervatten.
    */
    const opnieuwBeginnen = sessieOnbruikbaar(err);
    if (opnieuwBeginnen) await vergeetUploadSessie(task.id);
    await chunkedDirectPoging(task, file, fullPath, !opnieuwBeginnen);
  }
}

async function chunkedDirectPoging(
  task: UploadTask,
  file: File,
  fullPath: string,
  hervatten: boolean
) {
  const haalToken = async (): Promise<string> => {
    const res = await fetch("/api/dropbox/session-token", {
      cache: "no-store",
      signal: tijdslimiet(KORT_MS),
    }).catch(() => null);
    if (!res?.ok) throw new Error("no-token");
    return ((await res.json()) as { token: string }).token;
  };

  let token = await haalToken();

  /**
   * Een token is een paar uur geldig; een video van twee gigabyte op 4G is dat
   * soms ook. Verloopt het onderweg, dan gaf elk volgend blok een 401 — geen
   * fout om op te wachten, dus de hele poging sneuvelde. Eén vers token en
   * verder waar we waren is het hele antwoord.
   */
  const metVersToken = async <T>(doe: () => Promise<T>): Promise<T> => {
    try {
      return await doe();
    } catch (err) {
      if (!(err instanceof UploadFout) || err.status !== 401) throw err;
      token = await haalToken();
      return doe();
    }
  };

  const dbx = async (endpoint: string, arg: unknown, body?: BodyInit | null) => {
    let r: Response;
    try {
      r = await fetch(`https://content.dropboxapi.com/2/files/${endpoint}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/octet-stream",
          // Niet-ASCII (bv. een accent in de bestandsnaam) mag niet rauw in een
          // header; safeArg doet dezelfde escaping als de append hieronder.
          "Dropbox-API-Arg": safeArg(arg),
        },
        body: body ?? null,
        signal: tijdslimiet(ANTWOORD_MS),
      });
    } catch {
      // fetch gooit een kale TypeError bij een netwerkfout of tijdslimiet.
      throw new NetwerkFout();
    }
    if (!r.ok) {
      const tekst = await r.text().catch(() => "");
      const naSeconden = Number(r.headers.get("Retry-After"));
      throw new UploadFout(
        r.status,
        tekst,
        Number.isFinite(naSeconden) && naSeconden > 0 ? naSeconden : null,
        `Dropbox ${endpoint} gaf ${r.status}`
      );
    }
    return r;
  };

  const blok = blokGrootte(file.size);

  // Een bewaarde sessie is alleen bruikbaar met dezelfde blokindeling; met een
  // andere blokgrootte wijzen de bewaarde posities naar de verkeerde plek.
  const bewaard = hervatten ? await leesUploadSessie(task.id) : null;
  const bruikbaar = bewaard && bewaard.chunkSize === blok ? bewaard : null;

  let sessionId: string;
  if (bruikbaar) {
    sessionId = bruikbaar.sessionId;
  } else {
    const started = await metBlokRetry(() =>
      dbx("upload_session/start", { close: false, session_type: { ".tag": "concurrent" } })
    );
    ({ session_id: sessionId } = (await started.json()) as { session_id: string });
    await bewaarUploadSessie({ id: task.id, sessionId, chunkSize: blok, klaar: [] });
  }

  const { resterend: ranges, alGedaan } = blokIndeling(file.size, blok, bruikbaar?.klaar ?? []);
  const klaar = new Set<number>(bruikbaar?.klaar ?? []);

  // De blokken die er al waren tellen mee in de balk, anders zou een hervatte
  // upload van 80% weer bij 0% beginnen te tekenen.
  let uploaded = alGedaan;
  let next = 0;
  // Bytes die op dit moment onderweg zijn, per werker. Zonder deze
  // tussenstand zou de balk pas per voltooid blok verspringen — grote sprongen
  // en een schatting die lang op hetzelfde getal blijft staan.
  const inFlight = new Map<number, number>();
  const report = () =>
    setProgress(task.id, uploaded + [...inFlight.values()].reduce((a, b) => a + b, 0), file.size);
  report();

  async function stuurBlok(workerId: number, from: number, to: number, sluit: boolean) {
    const arg = { cursor: { session_id: sessionId, offset: from }, close: sluit };
    try {
      await metVersToken(() =>
        metBlokRetry(() =>
          verstuurXhr({
            url: "https://content.dropboxapi.com/2/files/upload_session/append_v2",
            body: file.slice(from, to),
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/octet-stream",
              "Dropbox-API-Arg": safeArg(arg),
            },
            onProgress: (verzonden) => {
              inFlight.set(workerId, verzonden);
              report();
            },
            melding: (status) => `Dropbox append gaf ${status}`,
          }).finally(() => inFlight.delete(workerId))
        )
      );
    } catch (err) {
      // Een herkansing op het sluitende blok kan "closed" terugkrijgen: de
      // vorige poging was dan wél aangekomen en heeft de sessie al dichtgedaan.
      // Doorgaan naar finish; die controleert de lengte en klapt alsnog als er
      // echt iets ontbreekt.
      const alDicht =
        sluit && err instanceof UploadFout && err.status === 409 && /closed/.test(err.body);
      if (!alDicht) throw err;
    }
    uploaded += to - from;
    klaar.add(from);
    // Meteen vastleggen: juist een afgebroken sessie moet dit terugvinden.
    void bewaarUploadSessie({ id: task.id, sessionId, chunkSize: blok, klaar: [...klaar] });
    report();
  }

  // Het sluitende blok gaat er alleen doorheen, ná de rest — zie afsluitBlok.
  const { parallel, sluit } = afsluitBlok(file.size, ranges);

  async function worker(workerId: number) {
    for (;;) {
      const i = next++;
      if (i >= parallel.length) return;
      const [from, to] = parallel[i];
      await stuurBlok(workerId, from, to, false);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CHUNK_PARALLEL, parallel.length) }, (_, w) => worker(w))
  );
  if (sluit) await stuurBlok(0, sluit[0], sluit[1], true);

  // Afronden staat aan het éínd van een lange upload — juist daar is het token
  // het oudst.
  await metVersToken(() =>
    metBlokRetry(() =>
      dbx("upload_session/finish", {
        cursor: { session_id: sessionId, offset: file.size },
        commit: { path: fullPath, mode: "overwrite", autorename: false, mute: true },
      })
    )
  );
  await vergeetUploadSessie(task.id);
}

/**
 * Grote bestanden (RAW-scans) in blokken, maar wél parallel: Dropbox'
 * "concurrent" sessie laat blokken in willekeurige volgorde en tegelijk
 * binnenkomen. Vroeger ging blok voor blok na elkaar, waarbij elke ronde de
 * volle heen-en-weer-tijd kostte; nu lopen er CHUNK_PARALLEL tegelijk, wat
 * bij een trage/verre verbinding het grootste verschil maakt. Dropbox eist
 * hierbij dat start en finish zonder data gaan en dat elk blok behalve het
 * laatste een veelvoud van 4MB is — vandaar de vaste CHUNK_SIZE.
 */
async function uploadChunked(task: UploadTask, file: File, fullPath: string) {
  /** Eén aanroep naar onze eigen chunk-route, met tijdslimiet en nette fout. */
  const chunkRoute = async (query: string, body: BodyInit | null, ruimMs = ANTWOORD_MS) => {
    let res: Response;
    try {
      res = await fetch(`/api/dropbox/upload-chunk?${query}`, {
        method: "POST",
        body,
        signal: tijdslimiet(ruimMs),
      });
    } catch {
      // fetch gooit een kale TypeError bij een netwerkfout of tijdslimiet.
      throw new NetwerkFout();
    }
    if (!res.ok) {
      const tekst = await res.text().catch(() => "");
      let melding = `Uploaden mislukt — gaf ${res.status}`;
      try {
        const data = JSON.parse(tekst) as { error?: string };
        if (data.error) melding = `${data.error} (gaf ${res.status})`;
      } catch {}
      const naSeconden = Number(res.headers.get("Retry-After"));
      throw new UploadFout(
        res.status,
        tekst,
        Number.isFinite(naSeconden) && naSeconden > 0 ? naSeconden : null,
        melding
      );
    }
    return res;
  };

  const startRes = await metBlokRetry(() =>
    chunkRoute("action=start-concurrent", null, KORT_MS)
  );
  const { sessionId } = (await startRes.json()) as { sessionId: string };

  const ranges: [number, number][] = [];
  for (let o = 0; o < file.size; o += CHUNK_SIZE) ranges.push([o, Math.min(o + CHUNK_SIZE, file.size)]);

  let uploaded = 0;
  let next = 0;
  async function stuurBlok(from: number, to: number, sluit: boolean) {
    const chunk = await file.slice(from, to).arrayBuffer();
    try {
      await metBlokRetry(() =>
        chunkRoute(
          `action=append&sessionId=${encodeURIComponent(sessionId)}&offset=${from}${
            sluit ? "&close=1" : ""
          }`,
          chunk,
          BLOK_ANTWOORD_MS
        )
      );
    } catch (err) {
      // Zelfde uitzondering als bij de directe weg: een herkansing op het
      // sluitende blok kan "closed" terugkrijgen omdat de vorige poging al
      // aankwam. Finish controleert daarna alsnog of alles er staat.
      // Onze route verpakt de 409 van Dropbox als een 502, dus kijken we naar
      // de code die Dropbox zelf gaf.
      const alDicht =
        sluit && err instanceof UploadFout && dropboxStatus(err) === 409 && /closed/.test(err.body);
      if (!alDicht) throw err;
    }
    uploaded += to - from;
    setProgress(task.id, uploaded, file.size);
  }

  // Het sluitende blok als laatste en alleen — zie afsluitBlok.
  const { parallel, sluit } = afsluitBlok(file.size, ranges);
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= parallel.length) return;
      const [from, to] = parallel[i];
      await stuurBlok(from, to, false);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CHUNK_PARALLEL, parallel.length) }, worker));
  if (sluit) await stuurBlok(sluit[0], sluit[1], true);

  await metBlokRetry(() =>
    chunkRoute(
      `action=finish&sessionId=${encodeURIComponent(sessionId)}&offset=${file.size}&path=${encodeURIComponent(
        fullPath
      )}`,
      new ArrayBuffer(0)
    )
  );
}


async function fileExists(folderPath: string, folder: string, name: string): Promise<boolean> {
  try {
    const res = await fetch("/api/dropbox/files", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: `${folderPath}/${folder}` }),
      // Zonder tijdslimiet houdt deze controle het uploadslot bezet: de taak
      // rondt pas af als dit antwoord er is, en pump() wacht daarop.
      signal: tijdslimiet(KORT_MS),
    });
    const data = await res.json();
    return ((data.files ?? []) as { name: string }[]).some((f) => f.name === name);
  } catch {
    return false;
  }
}
