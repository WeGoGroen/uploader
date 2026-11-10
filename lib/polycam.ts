/**
 * Koppeling met de Polycam Content Management API (bèta, Enterprise-add-on).
 *
 * Gebruikt door de Polycam-stap van de energielabel-uploader: de laatste
 * scans tonen, een gekozen scan als LAS in de LAZ-map van het project zetten
 * en de deellink in het D8-veld van de juiste verdieping invullen.
 *
 * Let op: de documentatie (poly.cam/docs/api) was tijdens het bouwen niet
 * rechtstreeks te lezen. Paden en veldnamen komen uit de openbare
 * samenvattingen ervan. Daarom:
 *  - staan basis-URL en deellink-vorm in omgevingsvariabelen;
 *  - leest normaliseer* meerdere gangbare veldnamen, zodat een afwijkende
 *    naam niet meteen alles breekt;
 *  - staat elk pad op één plek hieronder, zodat een correctie klein blijft.
 */

export const POLYCAM_API_BASE = (process.env.POLYCAM_API_BASE ?? "https://poly.cam/api/v1").replace(/\/$/, "");

/** Waar een gedeelde scan te bekijken is; het capture-id komt erachter. */
const POLYCAM_DEELLINK_BASE = (process.env.POLYCAM_SHARE_BASE ?? "https://poly.cam/capture").replace(/\/$/, "");

export class PolycamNietIngesteld extends Error {
  constructor() {
    super("Polycam is niet gekoppeld (POLYCAM_API_TOKEN ontbreekt)");
  }
}

export class PolycamApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

export type ScanStatus = "klaar" | "bezig" | "mislukt";

export interface PolycamScan {
  id: string;
  naam: string;
  /** ISO-tijd; null als Polycam hem niet meegeeft. */
  gemaaktOp: string | null;
  status: ScanStatus;
  /** true = iedereen met de link kan kijken, false = privé, null = onbekend. */
  openbaar: boolean | null;
  voorbeeld: string | null;
}

export interface PolycamArtefact {
  /** Kleine letters, zonder punt: "las", "laz", "glb", … */
  formaat: string;
  url: string;
}

function polycamToken(): string {
  const token = process.env.POLYCAM_API_TOKEN;
  if (!token) throw new PolycamNietIngesteld();
  return token;
}

async function polycamFetch(pad: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${POLYCAM_API_BASE}${pad}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${polycamToken()}`,
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
    cache: "no-store",
  });
  if (!res.ok) {
    const tekst = await res.text().catch(() => "");
    throw new PolycamApiError(res.status, `Polycam ${init.method ?? "GET"} ${pad} gaf ${res.status} ${tekst.slice(0, 300)}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

// ---------- uitlezen (los van het netwerk, zodat het te testen is) ----------

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function eersteTekst(o: Obj, sleutels: string[]): string | null {
  for (const k of sleutels) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return null;
}

/** Firestore-achtige tijd ({_seconds}) of epoch in ms/s → ISO. */
function naarIso(v: unknown): string | null {
  if (typeof v === "string" && v.trim()) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof v === "number" && Number.isFinite(v)) {
    return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  }
  if (isObj(v)) {
    const s = v._seconds ?? v.seconds;
    if (typeof s === "number") return new Date(s * 1000).toISOString();
  }
  return null;
}

export function leesStatus(raw: string | null): ScanStatus {
  if (!raw) return "bezig";
  const s = raw.toLowerCase();
  if (/fail|error|cancel/.test(s)) return "mislukt";
  if (/complete|ready|processed|done|success|finished|available/.test(s)) return "klaar";
  return "bezig";
}

function leesOpenbaar(o: Obj): boolean | null {
  const v = eersteTekst(o, ["visibility", "privacy", "sharing", "access"]);
  if (v) {
    const s = v.toLowerCase();
    if (/public|unlisted|link|anyone/.test(s)) return true;
    if (/private|restricted|invite|team/.test(s)) return false;
  }
  if (typeof o.isPublic === "boolean") return o.isPublic;
  if (typeof o.public === "boolean") return o.public;
  return null;
}

export function normaliseerScan(raw: unknown): PolycamScan | null {
  if (!isObj(raw)) return null;
  const o = isObj(raw.capture) ? raw.capture : raw;
  const id = eersteTekst(o, ["id", "captureId", "capture_id", "_id", "uuid"]);
  if (!id) return null;
  const gemaaktOp = naarIso(o.createdAt ?? o.created_at ?? o.createTime ?? o.created ?? o.captureDate ?? null);
  return {
    id,
    naam: eersteTekst(o, ["name", "title", "displayName"]) ?? "Naamloze scan",
    gemaaktOp,
    status: leesStatus(eersteTekst(o, ["status", "processingStatus", "processing_status", "state"])),
    openbaar: leesOpenbaar(o),
    voorbeeld: eersteTekst(o, ["thumbnailUrl", "thumbnail_url", "thumbnail", "previewUrl", "preview_url", "coverImageUrl"]),
  };
}

function lijstUit(raw: unknown, sleutels: string[]): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (!isObj(raw)) return [];
  for (const k of sleutels) {
    const v = raw[k];
    if (Array.isArray(v)) return v;
    if (isObj(v)) {
      const binnen = lijstUit(v, sleutels);
      if (binnen.length) return binnen;
    }
  }
  return [];
}

/** Nieuwste eerst; scans zonder tijd achteraan. */
export function normaliseerScans(raw: unknown): PolycamScan[] {
  return lijstUit(raw, ["captures", "data", "items", "results"])
    .map(normaliseerScan)
    .filter((s): s is PolycamScan => s !== null)
    .sort((a, b) => (b.gemaaktOp ?? "").localeCompare(a.gemaaktOp ?? ""));
}

function formaatVan(o: Obj, url: string): string | null {
  const f = eersteTekst(o, ["format", "fileFormat", "file_format", "type", "fileType", "extension", "name", "key"]);
  const kandidaat = (f ?? "").toLowerCase();
  const uitNaam = kandidaat.match(/\.?([a-z0-9]{2,5})$/)?.[1];
  if (uitNaam && /^(las|laz|glb|gltf|obj|usdz|ply|fbx|stl|dae|pts|xyz|e57|pdf|svg|dxf|csv|zip)$/.test(uitNaam)) {
    return uitNaam;
  }
  const uitUrl = url.split("?")[0].match(/\.([a-z0-9]{2,5})$/i)?.[1];
  return uitUrl ? uitUrl.toLowerCase() : kandidaat || null;
}

export function normaliseerArtefacten(raw: unknown): PolycamArtefact[] {
  const uit: PolycamArtefact[] = [];
  // Soms een lijst objecten, soms een object { las: "https://…", glb: … }.
  const lijst = lijstUit(raw, ["artifacts", "artefacts", "exports", "files", "data", "downloads"]);
  for (const a of lijst) {
    if (!isObj(a)) continue;
    const url = eersteTekst(a, ["url", "downloadUrl", "download_url", "signedUrl", "signed_url", "href"]);
    if (!url || !/^https:\/\//.test(url)) continue;
    const formaat = formaatVan(a, url);
    if (formaat) uit.push({ formaat, url });
  }
  if (!uit.length && isObj(raw)) {
    const bron = isObj(raw.artifacts) ? raw.artifacts : raw;
    for (const [k, v] of Object.entries(bron)) {
      if (typeof v === "string" && /^https:\/\//.test(v)) uit.push({ formaat: k.toLowerCase(), url: v });
    }
  }
  return uit;
}

/** De puntenwolk: liefst LAZ (kleiner), anders LAS. */
export function vindPuntenwolk(artefacten: PolycamArtefact[]): PolycamArtefact | null {
  return (
    artefacten.find((a) => a.formaat === "laz") ??
    artefacten.find((a) => a.formaat === "las") ??
    null
  );
}

export function deellinkVoor(captureId: string): string {
  return `${POLYCAM_DEELLINK_BASE}/${encodeURIComponent(captureId)}`;
}

// ---------- netwerk ----------

export async function laatsteScans(aantal = 12): Promise<PolycamScan[]> {
  const raw = await polycamFetch(`/captures?limit=${aantal}`);
  return normaliseerScans(raw).slice(0, aantal);
}

export async function haalScan(captureId: string): Promise<PolycamScan | null> {
  const raw = await polycamFetch(`/captures/${encodeURIComponent(captureId)}`);
  return normaliseerScan(raw);
}

/** De downloadlinks (een uur geldig) van wat er nu al klaarstaat. */
export async function beschikbareBestanden(captureId: string): Promise<PolycamArtefact[]> {
  const raw = await polycamFetch(`/captures/${encodeURIComponent(captureId)}/export`);
  return normaliseerArtefacten(raw);
}

/**
 * Laat Polycam een LAS maken. LAS is geen standaardbestand van een scan en
 * moet eerst geëxporteerd worden; daarna verschijnt hij tussen de
 * beschikbare bestanden.
 */
export async function startLasExport(captureId: string): Promise<void> {
  await polycamFetch(`/captures/${encodeURIComponent(captureId)}/export`, {
    method: "POST",
    body: JSON.stringify({ format: "las" }),
  });
}
