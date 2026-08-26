/**
 * Bewaart nog niet afgeronde uploads op het apparaat zelf, zodat ze een
 * herstart overleven. Op een iPad sluit Safari een tabblad gewoon af zodra je
 * een tijdje in een andere app zit — zonder deze opslag verdwijnen lopende
 * uploads dan stilletjes en merk je dat pas als de map halfvol blijkt.
 *
 * IndexedDB en niet localStorage: alleen IndexedDB kan het bestand zelf
 * (een Blob) bewaren; localStorage doet uitsluitend tekst.
 */

const DB_NAAM = "wgg-uploads";
const OPSLAG = "openstaand";
/**
 * Scanbestanden uit de Optimized-map, apart bewaard tot ze als puntenwolk bij
 * Mediatask hangen.
 *
 * Waarom een tweede opslag en niet dezelfde: een upload naar Dropbox is klaar
 * zodra het bestand er staat, maar naar Mediatask gaat het bestand pas als de
 * order bestaat — en die wordt aangemaakt aan het eind van de pagina. Zonder
 * deze opslag was de scan na een herlaadbeurt uit het geheugen verdwenen en
 * kon hij alleen nog handmatig aangeleverd worden.
 */
const SCANS = "scans";
/**
 * Voortgang van een lopende Dropbox-uploadsessie, los van het bestand zelf.
 *
 * Bewust een aparte opslag: een record in "openstaand" bevat de hele video,
 * en dat record bij elk voltooid blok herschrijven zou betekenen dat een
 * bestand van 100MB tien keer opnieuw naar schijf gaat. Deze records zijn een
 * paar honderd bytes.
 */
const SESSIES = "uploadsessies";
/** Ouder dan dit ruimen we op: dan is de opname allang op een andere manier afgerond. */
const MAX_LEEFTIJD_MS = 24 * 60 * 60 * 1000;

export interface BewaardeUpload {
  id: string;
  folderPath: string;
  folder: string;
  name: string;
  file: File;
  /** Wie deze upload startte — nodig om op het dashboard te tonen van wie het
      werk is, ook nadat het tabblad tussendoor is afgesloten. */
  account?: string | null;
  bewaardOp: number;
}

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") return resolve(null);
    const req = indexedDB.open(DB_NAAM, 3);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(OPSLAG)) {
        req.result.createObjectStore(OPSLAG, { keyPath: "id" });
      }
      if (!req.result.objectStoreNames.contains(SCANS)) {
        req.result.createObjectStore(SCANS, { keyPath: "id" });
      }
      if (!req.result.objectStoreNames.contains(SESSIES)) {
        req.result.createObjectStore(SESSIES, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    // Privémodus of geweigerde opslag: dan werkt de app gewoon door, alleen
    // zonder hervatten. Nooit de upload zelf laten sneuvelen hierop.
    req.onerror = () => resolve(null);
  });
}

async function metOpslag<T>(
  modus: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest,
  naam: string = OPSLAG
): Promise<T | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(naam, modus);
      const req = fn(tx.objectStore(naam));
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function bewaarUpload(u: Omit<BewaardeUpload, "bewaardOp">): Promise<void> {
  await metOpslag("readwrite", (s) => s.put({ ...u, bewaardOp: Date.now() }));
}

export async function vergeetUpload(id: string): Promise<void> {
  await metOpslag("readwrite", (s) => s.delete(id));
  // De sessievoortgang hoort bij dit bestand; laten staan zou een dode
  // verwijzing achterlaten die bij een volgend id nooit meer opgeruimd wordt.
  await vergeetUploadSessie(id);
}

/** Alle openstaande uploads, zonder de verlopen exemplaren. */
export async function openstaandeUploads(): Promise<BewaardeUpload[]> {
  const alle = (await metOpslag<BewaardeUpload[]>("readonly", (s) => s.getAll())) ?? [];
  const grens = Date.now() - MAX_LEEFTIJD_MS;
  const vers: BewaardeUpload[] = [];
  for (const u of alle) {
    if (u.bewaardOp < grens) void vergeetUpload(u.id);
    else vers.push(u);
  }
  return vers;
}

/**
 * Waar een half verstuurde upload gebleven was. `klaar` bevat de
 * beginposities van de blokken die Dropbox al binnen heeft, zodat een
 * hervatting alleen de rest hoeft te sturen.
 */
export interface UploadSessie {
  id: string;
  sessionId: string;
  /** Blokgrootte van die poging; wijkt die af, dan kloppen de posities niet. */
  chunkSize: number;
  klaar: number[];
  bewaardOp: number;
}

export async function leesUploadSessie(id: string): Promise<UploadSessie | null> {
  const sessie = await metOpslag<UploadSessie | undefined>("readonly", (s) => s.get(id), SESSIES);
  if (!sessie) return null;
  // Een sessie die te lang ligt is bij Dropbox allang verlopen; dan liever
  // opnieuw beginnen dan een reeks foutmeldingen op een dode sessie.
  if (sessie.bewaardOp < Date.now() - MAX_LEEFTIJD_MS) {
    await vergeetUploadSessie(id);
    return null;
  }
  return sessie;
}

export async function bewaarUploadSessie(
  sessie: Omit<UploadSessie, "bewaardOp">
): Promise<void> {
  await metOpslag("readwrite", (s) => s.put({ ...sessie, bewaardOp: Date.now() }), SESSIES);
}

export async function vergeetUploadSessie(id: string): Promise<void> {
  await metOpslag("readwrite", (s) => s.delete(id), SESSIES);
}
