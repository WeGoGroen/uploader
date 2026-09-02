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
 * uplink stond bij fotoseries grotendeels leeg. Een klein bestand weegt 1,
 * een groot bestand (dat zelf al in parallelle blokken gaat) weegt 3: binnen
 * het budget passen dus 6 foto's, of 2 grote bestanden, of een mengsel.
 */
const PARALLEL_BUDGET = 6;
const GEWICHT_GROOT = 3;
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
/**
 * Blokgrootte voor de directe weg naar Dropbox. Veel groter dan de 4MB die
 * via onze server past, want daar geldt de Vercel-limiet niet — minder
 * rondjes over het netwerk en dus sneller. Blijft een veelvoud van 4MB,
 * zoals Dropbox voor concurrent-sessies vereist.
 */
const DIRECT_CHUNK_SIZE = 16 * 1024 * 1024;
/**
 * Vanaf deze grootte gaat een bestand in parallelle blokken omhoog i.p.v. als
 * één stroom. Video's zaten hier precies tussenin: ze bleven onder de
 * 140MB-grens en gingen dus als één lange POST, terwijl één verbinding op
 * 4G/5G de uplink zelden vol trekt. Onder deze grens weegt het opzetten van
 * een uploadsessie niet op tegen de winst.
 */
const PARALLEL_VANAF = 24 * 1024 * 1024;

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
const COMPRESS_PARALLEL = 2;

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
  const linkRes = await fetch("/api/dropbox/upload-link", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: fullPath }),
  });
  if (!linkRes.ok) {
    // Geen link te krijgen: via de server proberen zodat de opname doorgaat.
    await uploadViaServer(task, file);
    return;
  }
  const { link } = (await linkRes.json()) as { link: string };

  await metBlokRetry(
    () =>
      new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", link);
        xhr.setRequestHeader("Content-Type", "application/octet-stream");
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) setProgress(task.id, e.loaded, e.total);
        };
        xhr.onload = () =>
          xhr.status >= 200 && xhr.status < 300
            ? resolve()
            : reject(new Error(`Dropbox weigerde het bestand (gaf ${xhr.status})`));
        xhr.onerror = () => reject(new Error("Netwerkfout bij uploaden"));
        xhr.send(file);
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
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/dropbox/upload-file");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) setProgress(task.id, e.loaded, e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      let msg = "Uploaden mislukt";
      try {
        msg = JSON.parse(xhr.responseText).error ?? msg;
      } catch {}
      reject(new Error(msg));
    };
    xhr.onerror = () => reject(new Error("Netwerkfout bij uploaden"));
    xhr.send(form);
  });
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
 * Herkansingen per blok. Eén netwerk-hik op blok 5 van 8 gooide voorheen de
 * hele poging weg; nu krijgt dat ene blok gewoon nog een kans terwijl de rest
 * blijft staan. Alleen bij fouten waar herhalen zin heeft (netwerk, 429,
 * 5xx) — een 401 blijft meteen fataal, daar lost wachten niets aan op.
 */
const BLOK_POGINGEN = 3;

function wachtEven(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function blokFoutHerstelbaar(err: unknown): boolean {
  const melding = err instanceof Error ? err.message : "";
  return /Netwerkfout/.test(melding) || /gaf (429|5\d\d)/.test(melding);
}

async function metBlokRetry(stuur: () => Promise<void>): Promise<void> {
  for (let poging = 1; ; poging++) {
    try {
      return await stuur();
    } catch (err) {
      if (poging >= BLOK_POGINGEN || !blokFoutHerstelbaar(err)) throw err;
      await wachtEven(poging === 1 ? 1000 : 3000);
    }
  }
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
    // Alleen opnieuw beginnen als er ook echt iets te hergebruiken viel;
    // anders was dit gewoon een mislukte upload en heeft herhalen geen zin.
    if (!bewaard) throw err;
    await vergeetUploadSessie(task.id);
    await chunkedDirectPoging(task, file, fullPath, false);
  }
}

async function chunkedDirectPoging(
  task: UploadTask,
  file: File,
  fullPath: string,
  hervatten: boolean
) {
  const res = await fetch("/api/dropbox/session-token", { cache: "no-store" });
  if (!res.ok) throw new Error("no-token");
  const { token } = (await res.json()) as { token: string };

  const dbx = async (endpoint: string, arg: unknown, body?: BodyInit | null) => {
    const r = await fetch(`https://content.dropboxapi.com/2/files/${endpoint}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/octet-stream",
        // Niet-ASCII (bv. een accent in de bestandsnaam) mag niet rauw in een
        // header; safeArg doet dezelfde escaping als de append hieronder.
        "Dropbox-API-Arg": safeArg(arg),
      },
      body: body ?? null,
    });
    if (!r.ok) throw new Error(`Dropbox ${endpoint} gaf ${r.status}`);
    return r;
  };

  // Een bewaarde sessie is alleen bruikbaar met dezelfde blokindeling; met een
  // andere blokgrootte wijzen de bewaarde posities naar de verkeerde plek.
  const bewaard = hervatten ? await leesUploadSessie(task.id) : null;
  const bruikbaar = bewaard && bewaard.chunkSize === DIRECT_CHUNK_SIZE ? bewaard : null;

  let sessionId: string;
  if (bruikbaar) {
    sessionId = bruikbaar.sessionId;
  } else {
    const started = await dbx("upload_session/start", {
      close: false,
      session_type: { ".tag": "concurrent" },
    });
    ({ session_id: sessionId } = (await started.json()) as { session_id: string });
    await bewaarUploadSessie({ id: task.id, sessionId, chunkSize: DIRECT_CHUNK_SIZE, klaar: [] });
  }

  const { alle: alleRanges, resterend: ranges, alGedaan } = blokIndeling(
    file.size,
    DIRECT_CHUNK_SIZE,
    bruikbaar?.klaar ?? []
  );
  const klaar = new Set<number>(bruikbaar?.klaar ?? []);
  void alleRanges;

  // De blokken die er al waren tellen mee in de balk, anders zou een hervatte
  // upload van 80% weer bij 0% beginnen te tekenen.
  let uploaded = alGedaan;
  let next = 0;
  // Bytes die op dit moment onderweg zijn, per werker. Zonder deze
  // tussenstand zou de balk pas per voltooid blok van 16MB verspringen —
  // grote sprongen en een schatting die lang op hetzelfde getal blijft staan.
  const inFlight = new Map<number, number>();
  const report = () =>
    setProgress(task.id, uploaded + [...inFlight.values()].reduce((a, b) => a + b, 0), file.size);
  report();

  async function worker(workerId: number) {
    for (;;) {
      const i = next++;
      if (i >= ranges.length) return;
      const [from, to] = ranges[i];
      // Het blok dat het bestand compleet maakt sluit de sessie af.
      const arg = { cursor: { session_id: sessionId, offset: from }, close: to === file.size };
      await metBlokRetry(
        () =>
          new Promise<void>((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open("POST", "https://content.dropboxapi.com/2/files/upload_session/append_v2");
            xhr.setRequestHeader("Authorization", `Bearer ${token}`);
            xhr.setRequestHeader("Content-Type", "application/octet-stream");
            xhr.setRequestHeader("Dropbox-API-Arg", safeArg(arg));
            xhr.upload.onprogress = (e) => {
              if (!e.lengthComputable) return;
              inFlight.set(workerId, e.loaded);
              report();
            };
            xhr.onload = () => {
              inFlight.delete(workerId);
              if (xhr.status >= 200 && xhr.status < 300) resolve();
              else reject(new Error(`Dropbox append gaf ${xhr.status}`));
            };
            xhr.onerror = () => {
              inFlight.delete(workerId);
              reject(new Error("Netwerkfout bij uploaden"));
            };
            xhr.send(file.slice(from, to));
          })
      );
      uploaded += to - from;
      klaar.add(from);
      // Meteen vastleggen: juist een afgebroken sessie moet dit terugvinden.
      void bewaarUploadSessie({
        id: task.id,
        sessionId,
        chunkSize: DIRECT_CHUNK_SIZE,
        klaar: [...klaar],
      });
      report();
    }
  }
  await Promise.all(Array.from({ length: Math.min(CHUNK_PARALLEL, ranges.length) }, (_, w) => worker(w)));

  await dbx("upload_session/finish", {
    cursor: { session_id: sessionId, offset: file.size },
    commit: { path: fullPath, mode: "overwrite", autorename: false, mute: true },
  });
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
  const startRes = await fetch("/api/dropbox/upload-chunk?action=start-concurrent", { method: "POST" });
  if (!startRes.ok) {
    const data = await startRes.json().catch(() => null);
    throw new Error(data?.error ?? "Uploadsessie starten mislukt");
  }
  const { sessionId } = (await startRes.json()) as { sessionId: string };

  const ranges: [number, number][] = [];
  for (let o = 0; o < file.size; o += CHUNK_SIZE) ranges.push([o, Math.min(o + CHUNK_SIZE, file.size)]);

  let uploaded = 0;
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= ranges.length) return;
      const [from, to] = ranges[i];
      const chunk = await file.slice(from, to).arrayBuffer();
      await metBlokRetry(async () => {
        let res: Response;
        try {
          res = await fetch(
            `/api/dropbox/upload-chunk?action=append&sessionId=${encodeURIComponent(sessionId)}&offset=${from}${
              to === file.size ? "&close=1" : ""
            }`,
            { method: "POST", body: chunk }
          );
        } catch {
          // fetch gooit een kale TypeError bij een netwerkfout; hernoemen
          // zodat metBlokRetry 'm als herstelbaar herkent.
          throw new Error("Netwerkfout bij uploaden");
        }
        if (!res.ok) {
          const data = await res.json().catch(() => null);
          // Statuscode altijd in de melding, zodat metBlokRetry netwerk- en
          // serverfouten kan herkennen als herstelbaar.
          throw new Error(
            data?.error ? `${data.error} (gaf ${res.status})` : `Uploaden mislukt — gaf ${res.status}`
          );
        }
      });
      uploaded += to - from;
      setProgress(task.id, uploaded, file.size);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CHUNK_PARALLEL, ranges.length) }, worker));

  const finishRes = await fetch(
    `/api/dropbox/upload-chunk?action=finish&sessionId=${encodeURIComponent(sessionId)}&offset=${
      file.size
    }&path=${encodeURIComponent(fullPath)}`,
    { method: "POST", body: new ArrayBuffer(0) }
  );
  if (!finishRes.ok) {
    const data = await finishRes.json().catch(() => null);
    throw new Error(data?.error ?? "Upload afronden mislukt");
  }
}


async function fileExists(folderPath: string, folder: string, name: string): Promise<boolean> {
  try {
    const res = await fetch("/api/dropbox/files", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: `${folderPath}/${folder}` }),
    });
    const data = await res.json();
    return ((data.files ?? []) as { name: string }[]).some((f) => f.name === name);
  } catch {
    return false;
  }
}
