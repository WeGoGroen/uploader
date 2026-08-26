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

class MediataskApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
    this.name = "MediataskApiError";
  }
}

/**
 * Maakt van een Mediatask-fout een zin die een opnemer op locatie iets zegt.
 * Bij een storing stuurt hun server een complete HTML-foutpagina terug; die
 * ongefilterd tonen levert een scherm vol markup op i.p.v. een boodschap.
 */
function describeMediataskError(status: number, body: string, path: string): string {
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
  return `Mediatask weigerde het verzoek (${status}): ${detail.slice(0, 200)}`;
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

async function mediataskFetch<T>(path: string, init?: RequestInit): Promise<T> {
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
    throw new MediataskApiError(res.status, describeMediataskError(res.status, body, path));
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
 * Haalt de (meest recente) orders op — gebruikt om per adres in real time te
 * controleren of er al een NEN2580-order bestaat, i.p.v. te vertrouwen op
 * onze eigen concept-administratie (die kan achterlopen, bv. als iemand het
 * concept-record niet had of de opslag daarvan faalde).
 */
export function listOrders(): Promise<MediataskOrder[]> {
  return mediataskFetch<MediataskOrder[]>("/api/orders");
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
