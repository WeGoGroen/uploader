import { getOptionalRedis, requireRedis } from "@/lib/redis";

// Cliënt voor de Apitome/Mediatask-API — gebruikt om NEN2580-opnames
// (foto's + plattegronden) automatisch als order aan te leveren. Zelfde
// patroon als ClickUp/Dropbox: één gedeeld token in de omgeving, geen
// login per teamlid. Base-URL is per klant anders (jullie eigen Mediatask-
// omgeving), vandaar apart configureerbaar i.p.v. hardcoded.
export interface MediataskAgency {
  id: string;
  name: string;
  code: string;
}

export interface MediataskPriority {
  id: string;
  name: string;
  description: string;
}

export interface MediataskProductConfigOption {
  name: string;
  type: "select" | "string" | "date" | "number";
  values?: string[];
}

export interface MediataskProduct {
  id: number;
  product_group_id: number;
  full_name: string;
  short_name: string;
  description: string | null;
  configuration: MediataskProductConfigOption[];
}

export interface MediataskOrder {
  id: number;
  client_order_id: number | string;
  state: string;
  output_link?: string | null;
  address?: string;
}

export class MediataskApiError extends Error {
  constructor(
    public status: number,
    message: string,
    /** Het endpoint dat weigerde — zonder dat is een 403 niet na te lopen. */
    public endpoint = ""
  ) {
    super(message);
    this.name = "MediataskApiError";
  }
}

/**
 * Een weigering waar opnieuw proberen niets aan verandert.
 *
 * Het verschil is het hele punt: bij een storing (5xx) of een rem op het
 * aantal verzoeken (429) is nog een poging precies goed, maar een 403 op een
 * order die geen concept meer is blijft bij poging tien net zo hard nee. Elke
 * poging kost daar een complete doorgang van een scan van honderden MB's door
 * Dropbox, en levert een tweede foutmelding op over dezelfde ene oorzaak.
 */
export function isDefinitieveWeigering(err: unknown): err is MediataskApiError {
  return err instanceof MediataskApiError && err.status >= 400 && err.status < 500 && err.status !== 429;
}

/**
 * Maakt van een Mediatask-fout een zin die een opnemer op locatie iets zegt.
 * Bij een storing stuurt hun server een complete HTML-foutpagina terug; die
 * ongefilterd tonen levert een scherm vol markup op i.p.v. een boodschap.
 */
function describeMediataskError(status: number, body: string, endpoint: string): string {
  const isHtml = /^\s*<(!doctype|html)/i.test(body);
  if (status >= 500 || isHtml) {
    return `Mediatask is op dit moment niet bereikbaar (foutcode ${status}). Dit ligt aan hun kant — probeer het over een paar minuten opnieuw.`;
  }
  // Wél een zinnige melding van hun kant: die tonen, maar ingekort.
  let detail = body.trim();
  try {
    const parsed = JSON.parse(body);
    detail = Array.isArray(parsed?.errors) ? parsed.errors.join(", ") : (parsed?.error ?? detail);
  } catch {}
  // Een leeg antwoordlichaam ("{}") toevoegen maakt de melding alleen maar
  // raadselachtiger; dan is het endpoint het enige wat nog informatie draagt.
  const zinnig = detail && detail !== "{}" && detail !== "[]" ? `: ${detail.slice(0, 200)}` : "";
  if (status === 403) {
    return `Mediatask stond ${endpoint} niet toe (403)${zinnig}. Dit is wat een order doet die geen concept meer is: eenmaal ingediend neemt Mediatask er geen bestanden meer bij.`;
  }
  return `Mediatask weigerde het verzoek (${status}) op ${endpoint}${zinnig}`;
}

const MEDIATASK_CREDENTIALS_KEY = "mediatask:credentials";

/**
 * Handmatig ingevoerde credentials via Koppelingen (opgeslagen in Redis)
 * winnen van de omgevingsvariabelen, zodat een teamlid het token/de
 * basis-URL kan zetten zonder een herdeploy — zelfde patroon als het
 * Dropbox-refresh-token.
 */
export async function getStoredMediataskCredentials(): Promise<{ token: string; baseUrl: string } | null> {
  const redis = getOptionalRedis();
  if (!redis) return null;
  const raw = await redis.get(MEDIATASK_CREDENTIALS_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { token?: string; baseUrl?: string };
    if (!parsed.token || !parsed.baseUrl) return null;
    return { token: parsed.token, baseUrl: parsed.baseUrl.replace(/\/$/, "") };
  } catch {
    return null;
  }
}

export async function saveMediataskCredentials(token: string, baseUrl: string): Promise<void> {
  const redis = requireRedis();
  await redis.set(MEDIATASK_CREDENTIALS_KEY, JSON.stringify({ token, baseUrl: baseUrl.replace(/\/$/, "") }));
}

export async function requireMediataskConfig(): Promise<{ token: string; baseUrl: string }> {
  const stored = await getStoredMediataskCredentials();
  if (stored) return stored;
  const token = process.env.MEDIATASK_API_TOKEN;
  const baseUrl = process.env.MEDIATASK_API_BASE;
  if (!token || !baseUrl) {
    throw new Error("Mediatask is niet geconfigureerd (MEDIATASK_API_TOKEN / MEDIATASK_API_BASE ontbreken)");
  }
  return { token, baseUrl: baseUrl.replace(/\/$/, "") };
}

export async function mediataskFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const { token, baseUrl } = await requireMediataskConfig();
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "X-Api-Token": token,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const endpoint = `${init?.method ?? "GET"} ${path}`;
    throw new MediataskApiError(res.status, describeMediataskError(res.status, body, endpoint), endpoint);
  }
  if (res.status === 204) return {} as T;
  return res.json() as Promise<T>;
}

export function getAgencies(): Promise<MediataskAgency[]> {
  return mediataskFetch<MediataskAgency[]>("/api/agencies");
}

export function getPriorities(): Promise<MediataskPriority[]> {
  return mediataskFetch<MediataskPriority[]>("/api/priorities");
}

export function getProducts(): Promise<MediataskProduct[]> {
  return mediataskFetch<MediataskProduct[]>("/api/products");
}

export interface CreateOrderInput {
  product_id: number;
  priority_id: string;
  agency_id: string;
  state?: "draft" | "submitted";
  city: string;
  street: string;
  number: string;
  postcode?: string;
  product_configuration: Record<string, string>;
  // Volledige veldset zoals Mediatask die zelf teruggeeft op een order-GET:
  // photos, drawings, additional, pointclouds, delivery, delivery_extra.
  // Puntenwolken gaan hier NIET in mee: die hebben hun eigen driestapsflow via
  // requestPointcloudUploads hieronder. Bij het aanmaken meesturen geeft een
  // 500 bij Mediatask (live getest).
  files?: {
    photos?: string[];
    drawings?: string[];
    additional?: string[];
    delivery?: string[];
    delivery_extra?: string[];
  };
}

export function createOrder(input: CreateOrderInput): Promise<MediataskOrder> {
  return mediataskFetch<MediataskOrder>("/api/orders", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function getOrder(id: number): Promise<MediataskOrder> {
  return mediataskFetch<MediataskOrder>(`/api/orders/${id}`);
}

/**
 * Verklaart een weigering uit de toestand van de order, of null als die daar
 * niet aan ligt.
 *
 * De API zegt bij zo'n weigering alleen "403" met een leeg antwoordlichaam;
 * de verklaring staat in de toestand van de order. Een concept neemt bestanden
 * aan, een ingediende order niet meer — en dát is het verschil tussen "nog
 * eens proberen" en "hier komt nooit meer een scan bij". Alleen aanroepen als
 * er al iets misging: het kost een extra verzoek.
 */
export async function weigeringUitleg(orderId: number): Promise<string | null> {
  const order = await getOrder(orderId).catch(() => null);
  const state = String(order?.state ?? "").trim();
  if (!state || state.toLowerCase() === "draft") return null;
  return `order #${orderId} staat bij Mediatask op "${state}" en is geen concept meer — daar neemt Mediatask geen bestanden meer bij`;
}

/**
 * Haalt de (meest recente) orders op — gebruikt om per adres in real time te
 * controleren of er al een NEN2580-order bestaat, i.p.v. te vertrouwen op
 * onze eigen concept-administratie (die kan achterlopen, bv. als iemand het
 * concept-record niet had of de opslag daarvan faalde).
 */
export function listOrders(pagina?: number): Promise<MediataskOrder[]> {
  // Mediatask geeft maximaal 100 orders per antwoord; met een paginanummer
  // vragen we de oudere op. Of hun API dit ondersteunt is empirisch: geeft
  // pagina 2 dezelfde orders terug als pagina 1, dan negeren ze de parameter.
  return mediataskFetch<MediataskOrder[]>(
    pagina && pagina > 1 ? `/api/orders?page=${pagina}` : "/api/orders"
  );
}

/**
 * Bestaat er al een concept-order voor dit adres? Die hergebruiken in plaats
 * van een tweede aanmaken.
 *
 * Het vangnet achter de orderId-parameter: de pop-up geeft het ordernummer
 * netjes door aan de documentenpagina, maar wie die pagina via een hervat-pad
 * of een herlaadbeurt zonder ordernummer bereikt, maakte voorheen stilletjes
 * een duplicaat aan — de achtergebleven draft bleef dan eeuwig bij Mediatask
 * staan (zo zijn er meerdere gevonden).
 */
export async function vindBestaandeDraft(
  street: string,
  number: string,
  city: string
): Promise<MediataskOrder | null> {
  const doel = `${street} ${number}`.replace(/\s+/g, " ").trim().toLowerCase();
  const plaats = city.trim().toLowerCase();
  if (!doel || !plaats) return null;

  const orders = await listOrders().catch(() => [] as MediataskOrder[]);
  return (
    orders.find((o) => {
      if (o.state !== "draft" || !o.address) return false;
      const [adres, ...rest] = o.address.split(",");
      return (
        adres.replace(/\s+/g, " ").trim().toLowerCase() === doel &&
        rest.join(",").trim().toLowerCase() === plaats
      );
    }) ?? null
  );
}

export function submitOrder(id: number): Promise<void> {
  return mediataskFetch<void>(`/api/orders/${id}/submit`, { method: "POST" });
}

/**
 * Plaatst een opmerking bij een order. Mediatask kent geen opmerkingveld op
 * de order zelf (die velden worden stilzwijgend genegeerd) — het gaat via
 * dit aparte endpoint. Live vastgesteld: de body moet {comment: "..."} zijn;
 * andere vormen worden als letterlijke tekst opgeslagen of stil genegeerd.
 */
export function addOrderComment(id: number, comment: string): Promise<void> {
  return mediataskFetch<void>(`/api/orders/${id}/comments`, {
    method: "POST",
    body: JSON.stringify({ comment }),
  });
}

export function getReportVariables(id: number): Promise<{ order_id: number; variables: Record<string, string> }> {
  return mediataskFetch(`/api/report_variables/${id}`);
}


/**
 * Aanmelden dat er puntenwolken bij een order komen.
 *
 * Mediatask gebruikt hiervoor Rails' directe-uploadflow, in drie stappen:
 *
 *   1. Hier melden welke bestanden er komen (naam, grootte, MD5, type). De API
 *      geeft per bestand een tijdelijke S3-link terug plus de headers die bij
 *      het uploaden meegestuurd moeten worden.
 *   2. De browser zet het bestand rechtstreeks op die S3-link. Dat gaat dus
 *      buiten onze server om — nodig ook, want een scan van honderden MB's past
 *      niet door een serverless-route.
 *   3. Melden dat het geland is met attachPointclouds, anders blijft de
 *      puntenwolk als losse blob zonder order in hun systeem hangen.
 *
 * De checksum is de MD5 van het bestand in base64, hetzelfde formaat als de
 * Content-MD5-header. S3 controleert die bij het uploaden: klopt hij niet, dan
 * weigert S3 het bestand. Dat is meteen de garantie dat er niets onderweg
 * beschadigd is.
 */
export interface PointcloudUploadRequest {
  filename: string;
  byte_size: string;
  checksum: string;
  content_type: string;
}

export interface PointcloudUploadTarget {
  url: string;
  headers: Record<string, string>;
  blob_id: string;
  filename: string;
  pointcloud_id: number;
}

export function requestPointcloudUploads(
  orderId: number,
  pointclouds: PointcloudUploadRequest[]
): Promise<{ pointclouds: PointcloudUploadTarget[] }> {
  return mediataskFetch<{ pointclouds: PointcloudUploadTarget[] }>(`/api/orders/${orderId}`, {
    method: "PATCH",
    body: JSON.stringify({ files: { pointclouds } }),
  });
}

/** Stap 3: de geüploade blobs aan de order koppelen. */
export function attachPointclouds(
  orderId: number,
  pointclouds: { pointcloud_id: number; signed_blob_id: string }[]
): Promise<{ message: string; successes?: string[] }> {
  return mediataskFetch(`/api/orders/${orderId}/pointclouds/attach`, {
    method: "POST",
    body: JSON.stringify({ pointclouds }),
  });
}

export interface MediataskPointcloud {
  id: number;
  url: string;
  images: string[];
}

/** Wat er nu aan puntenwolken bij een order hangt — om te controleren of het gelukt is. */
export function listPointclouds(orderId: number): Promise<MediataskPointcloud[]> {
  return mediataskFetch<MediataskPointcloud[]>(`/api/orders/${orderId}/pointclouds`);
}

/**
 * Foto's en video's als échte bijlage aan een order hangen.
 *
 * Mediatask kent bij een order het bestandsveld `photos`. Dat veld vullen met
 * Dropbox-links werkte niet: de links kwamen niet zichtbaar op de order
 * terecht (live vastgesteld). Wat wél werkt voor puntenwolken is Rails'
 * directe-uploadflow, en die is voor de overige bestandsvelden hetzelfde
 * opgezet: aanmelden bij de order geeft per bestand een tijdelijke S3-link
 * terug, daarna melden dat het geland is.
 *
 * Omdat dat laatste bij `photos` niet zwart-op-wit gedocumenteerd is, kijkt
 * `requestPhotoUploads` naar de vórm van het antwoord in plaats van erop te
 * vertrouwen: geeft Mediatask geen uploadlinks terug, dan gooit hij
 * `GeenDirecteUpload` en valt de aanroeper terug op de linkenlijst. Zo levert
 * een API die morgen anders reageert een leesbare mededeling op in plaats van
 * stilzwijgend verdwenen foto's.
 */
export class GeenDirecteUpload extends Error {
  constructor(message = "Mediatask gaf geen uploadlinks terug voor foto's") {
    super(message);
    this.name = "GeenDirecteUpload";
  }
}

export interface MediaUploadRequest {
  filename: string;
  byte_size: string;
  checksum: string;
  content_type: string;
}

export interface MediaUploadTarget {
  url: string;
  headers: Record<string, string>;
  blob_id: string;
  filename: string;
  /** Mediatask noemt dit veld per bestandssoort anders (photo_id, id, …). */
  photo_id: number;
}

/** Stap 1: de foto's/video's aanmelden en de S3-uploadlinks ophalen. */
export async function requestPhotoUploads(
  orderId: number,
  photos: MediaUploadRequest[]
): Promise<MediaUploadTarget[]> {
  let data: Record<string, unknown>;
  try {
    data = await mediataskFetch<Record<string, unknown>>(`/api/orders/${orderId}`, {
      method: "PATCH",
      body: JSON.stringify({ files: { photos } }),
    });
  } catch (err) {
    // Live vastgesteld (01-09): Mediatask antwoordt op élke schrijfactie op
    // het photos-veld met 422 "Attachments is invalid" — metadata, URL's, een
    // /photos-subresource (404): alles wordt geweigerd, terwijl exact dezelfde
    // vorm voor pointclouds werkt. Foto's aan een order hangen kan alleen in
    // hun eigen UI. Deze vertaling maakt daar de nette linkenterugval van in
    // plaats van een kale fout per bestand.
    //
    // Élke definitieve weigering telt mee, niet alleen 422 en 404. Een 403 —
    // wat een order geeft die geen concept meer is — viel er eerst buiten, en
    // dan kreeg iedere foto, video en 360-opname apart zijn eigen foutmelding
    // over precies dezelfde oorzaak. Eén weigering is één mededeling.
    if (isDefinitieveWeigering(err)) {
      throw new GeenDirecteUpload(`Mediatask accepteert geen foto-bijlagen via de API (${err.status})`);
    }
    throw err;
  }
  const ruw = (data?.photos ?? (data as { files?: { photos?: unknown } })?.files?.photos) as unknown;
  if (!Array.isArray(ruw)) throw new GeenDirecteUpload();
  const doelen = ruw
    .filter((p): p is Record<string, unknown> => Boolean(p) && typeof p === "object")
    .map((p) => ({
      url: String(p.url ?? ""),
      headers: (p.headers ?? {}) as Record<string, string>,
      blob_id: String(p.blob_id ?? p.signed_blob_id ?? ""),
      filename: String(p.filename ?? ""),
      photo_id: Number(p.photo_id ?? p.id ?? 0),
    }))
    .filter((p) => p.url.startsWith("http"));
  if (doelen.length !== photos.length) throw new GeenDirecteUpload();
  return doelen;
}

/** Stap 3: de geüploade blobs aan de order koppelen. */
export function attachPhotos(
  orderId: number,
  photos: { photo_id: number; signed_blob_id: string }[]
): Promise<{ message?: string; successes?: string[] }> {
  return mediataskFetch(`/api/orders/${orderId}/photos/attach`, {
    method: "POST",
    body: JSON.stringify({ photos }),
  });
}

/** Wat er nu als foto aan een order hangt — de enige harde bevestiging. */
export async function listPhotos(orderId: number): Promise<{ id: number; url: string }[]> {
  const order = await getOrder(orderId).catch(() => null);
  const ruw = (order as unknown as { files?: { photos?: unknown } } | null)?.files?.photos;
  if (!Array.isArray(ruw)) return [];
  return ruw.map((p, i) =>
    typeof p === "string"
      ? { id: i, url: p }
      : { id: Number((p as { id?: number }).id ?? i), url: String((p as { url?: string }).url ?? "") }
  );
}

/**
 * Terugvalweg: de foto's als kant-en-klare (Dropbox-)URL in het veld zetten.
 * Minder goed dan een echte bijlage — de verwerker moet er dan zelf heen —
 * maar beter dan een order zonder beeld.
 */
export function setPhotoUrls(orderId: number, urls: string[]): Promise<unknown> {
  return mediataskFetch(`/api/orders/${orderId}`, {
    method: "PATCH",
    body: JSON.stringify({ files: { photos: urls } }),
  });
}
