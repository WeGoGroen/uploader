import { getOptionalRedis, requireRedis } from "@/lib/redis";

/**
 * SharePoint-koppeling via Microsoft Graph, als app — niet als persoon.
 *
 * MO Consultancy heeft de toegang ingericht met Graph's Sites.Selected: een
 * application-permissie waarmee deze app leestoegang heeft tot precies één
 * site (/sites/WeGoGroen) en verder nergens bij kan. Dat vraagt om de
 * client-credentials-flow: de app meldt zich met haar eigen id en secret, er
 * komt geen gebruiker aan te pas.
 *
 * Dat is hier ook de betere constructie dan iemand laten inloggen:
 *  - niets hangt aan een persoonlijk account, dus vertrekt er iemand bij
 *    WeGoGroen of MO Consultancy, dan blijft de koppeling gewoon werken;
 *  - er is geen refresh-token dat na 90 dagen stilletjes verloopt — elk
 *    token wordt vers opgehaald en is een uur geldig;
 *  - de toegang is beperkt tot één site in plaats van "alles wat die
 *    persoon mag zien".
 */
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const CONFIG_KEY = "sharepoint:config";

// .default betekent: precies de application-permissies die MO Consultancy aan
// deze app-registratie heeft toegekend (Sites.Selected, leesrecht op één site).
// Losse scopes opgeven kan niet bij client credentials.
const SCOPE = "https://graph.microsoft.com/.default";

/** Waar in SharePoint de finale bestanden staan — instelbaar via de UI, zodat
    een verhuisde map geen herdeploy kost. */
export interface SharePointConfig {
  /** Volledige site-URL, bv. https://moconsultancyltd168.sharepoint.com/sites/WeGoGroen */
  siteUrl: string;
  /** Optionele map binnen de documentbibliotheek, bv. "Gereed". Leeg = hele bibliotheek. */
  rootPath: string;
}

class GraphApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
    this.name = "GraphApiError";
  }
}

export async function requireMicrosoftConfig(): Promise<{
  clientId: string;
  clientSecret: string;
  tenantId: string;
}> {
  const clientId = process.env.MICROSOFT_CLIENT_ID;
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET;
  const tenantId = process.env.MICROSOFT_TENANT_ID;
  const missing = [
    !clientId ? "MICROSOFT_CLIENT_ID" : null,
    !clientSecret ? "MICROSOFT_CLIENT_SECRET" : null,
    // Bij client credentials moet de tenant expliciet zijn: er is geen
    // gebruiker om 'm uit af te leiden.
    !tenantId ? "MICROSOFT_TENANT_ID" : null,
  ].filter(Boolean);

  if (missing.length > 0 || !clientId || !clientSecret || !tenantId) {
    throw new Error(`${missing.join(", ")} ${missing.length === 1 ? "is" : "zijn"} niet ingesteld`);
  }
  return { clientId, clientSecret, tenantId };
}

/** Tokens zijn een uur geldig; binnen één serverless-instantie hergebruiken
    scheelt een aanroep naar Microsoft bij elke Graph-call. Een minuut marge,
    zodat een token nooit net tijdens gebruik verloopt. */
let cachedToken: { value: string; expiresAt: number } | null = null;

export async function getSharedAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.value;
  }

  const { clientId, clientSecret, tenantId } = await requireMicrosoftConfig();

  const res = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      scope: SCOPE,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new GraphApiError(res.status, `Microsoft token request failed: ${res.status} ${body}`);
  }

  const data = (await res.json()) as { access_token: string; expires_in?: number };
  cachedToken = {
    value: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
  return cachedToken.value;
}

async function graphFetch<T>(accessToken: string, path: string): Promise<T> {
  const res = await fetch(path.startsWith("http") ? path : `${GRAPH_BASE}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new GraphApiError(res.status, `Graph ${path} failed: ${res.status} ${body}`);
  }
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Configuratie van de SharePoint-locatie
// ---------------------------------------------------------------------------

/**
 * De map waar MO Consultancy de opgeleverde bestanden neerzet. Staat hier
 * vast ingebakken in plaats van dat iemand hem moet invullen: er is er maar
 * één, hij verandert vrijwel nooit, en een typefout hierin betekent dat de
 * hele automatische overdracht stil stopt. Aanpassen kan alleen bewust, via
 * de knop "Aanpassen" op de Koppelingen-pagina.
 */
export const DEFAULT_SHAREPOINT_CONFIG: SharePointConfig = {
  siteUrl: "https://moconsultancyltd168.sharepoint.com/sites/WeGoGroen",
  rootPath: "Gereed",
};

/**
 * Welke SharePoint-map gebruikt wordt. Volgorde: wat iemand bewust via
 * "Aanpassen" heeft opgeslagen, dan de omgevingsvariabelen, en anders de
 * vaste standaard hierboven. Geeft daardoor nooit null terug — de koppeling
 * werkt out of the box.
 */
export async function getSharePointConfig(): Promise<SharePointConfig> {
  const redis = getOptionalRedis();
  if (redis) {
    const raw = await redis.get(CONFIG_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as SharePointConfig;
        if (parsed.siteUrl) return parsed;
      } catch {
        // stukke JSON: val terug op de env-variabelen hieronder
      }
    }
  }
  const siteUrl = process.env.SHAREPOINT_SITE_URL;
  if (!siteUrl) return DEFAULT_SHAREPOINT_CONFIG;
  return { siteUrl, rootPath: process.env.SHAREPOINT_ROOT_PATH ?? "" };
}

/** Staat de standaardmap nog ingesteld, of heeft iemand hem aangepast? */
export async function isDefaultSharePointConfig(): Promise<boolean> {
  const config = await getSharePointConfig();
  return (
    config.siteUrl === DEFAULT_SHAREPOINT_CONFIG.siteUrl &&
    config.rootPath === DEFAULT_SHAREPOINT_CONFIG.rootPath
  );
}

/** Zet de map terug op de ingebakken standaard. */
export async function resetSharePointConfig(): Promise<void> {
  const redis = requireRedis();
  await redis.del(CONFIG_KEY);
}

export async function setSharePointConfig(config: SharePointConfig): Promise<void> {
  const redis = requireRedis();
  await redis.set(CONFIG_KEY, JSON.stringify(config));
}

export async function requireSharePointConfig(): Promise<SharePointConfig> {
  // Er is altijd een map: de standaard hierboven geldt zolang niemand hem
  // bewust heeft aangepast.
  return getSharePointConfig();
}

/**
 * Zet een SharePoint-site-URL om naar een Graph site-id. Graph kent hiervoor
 * de vorm /sites/{hostname}:{server-relative-path} — precies wat je uit de
 * URL in de browser kunt plakken, zonder dat iemand een GUID hoeft op te
 * zoeken.
 */
export async function resolveSiteId(accessToken: string, siteUrl: string): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(siteUrl);
  } catch {
    throw new Error(`Ongeldige SharePoint-URL: ${siteUrl}`);
  }
  // Alles ná /sites/<naam> (bv. /Gedeelde%20documenten/Forms/AllItems.aspx dat
  // SharePoint zelf in de adresbalk zet) hoort niet bij de site-identiteit.
  const segments = parsed.pathname.split("/").filter(Boolean);
  const sitesIndex = segments.indexOf("sites");
  const sitePath =
    sitesIndex === -1 ? "" : `/${segments.slice(sitesIndex, sitesIndex + 2).join("/")}`;

  const data = await graphFetch<{ id: string }>(
    accessToken,
    `/sites/${parsed.hostname}:${sitePath}`
  );
  return data.id;
}

/** Naam van de site zoals SharePoint 'm toont — gebruikt als label op de
    Koppelingen-pagina, zodat je ziet wáár de app toegang toe heeft. */
export async function getSiteName(accessToken: string, siteId: string): Promise<string> {
  const data = await graphFetch<{ displayName?: string; name?: string }>(
    accessToken,
    `/sites/${siteId}`
  );
  return data.displayName || data.name || "SharePoint";
}

export async function getDefaultDriveId(accessToken: string, siteId: string): Promise<string> {
  const data = await graphFetch<{ id: string }>(accessToken, `/sites/${siteId}/drive`);
  return data.id;
}

export interface DriveItem {
  id: string;
  name: string;
  /** Alleen gevuld voor bestanden. */
  size: number;
  isFolder: boolean;
  /** Pad zoals SharePoint het toont, voor logregels en foutmeldingen. */
  path: string;
  /** Kortlevende download-URL, als Graph 'm bij het uitlezen meegaf. */
  downloadUrl?: string;
}

interface RawDriveItem {
  id: string;
  name: string;
  size?: number;
  folder?: { childCount: number };
  file?: { mimeType: string };
  parentReference?: { path?: string };
  /** Graph geeft deze kortlevende, vooraf geauthenticeerde URL standaard mee
      bij het opvragen van de inhoud van een map — maar níét als je met
      $select een veldenlijst opgeeft. Daarom pakken we 'm hier meteen mee. */
  "@microsoft.graph.downloadUrl"?: string;
}

function toDriveItem(raw: RawDriveItem): DriveItem {
  const parent = raw.parentReference?.path ?? "";
  // Graph geeft "/drive/root:/Map/Submap" terug; het deel vóór ":" is ruis.
  const readableParent = parent.includes(":") ? parent.slice(parent.indexOf(":") + 1) : "";
  return {
    id: raw.id,
    name: raw.name,
    size: raw.size ?? 0,
    isFolder: !!raw.folder,
    path: `${readableParent}/${raw.name}`,
    downloadUrl: raw["@microsoft.graph.downloadUrl"],
  };
}

function encodePath(path: string): string {
  return path
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

/**
 * Alles wat direct in (de ingestelde map van) de documentbibliotheek staat.
 *
 * Eerder gebruikte dit Graph's search-endpoint. Dat bleek twee problemen te
 * hebben: het gaf op deze site structureel een 500 ("generalException"), en
 * het zocht óók in de inhoud van documenten — waardoor een willekeurig
 * rapport dat een adres noemt als treffer terugkwam. De map gewoon uitlezen
 * en zelf op adres matchen is stabieler en preciezer.
 */
export async function listPathChildren(
  accessToken: string,
  driveId: string,
  rootPath: string
): Promise<DriveItem[]> {
  const encodedRoot = encodePath(rootPath);
  const base = encodedRoot
    ? `/drives/${driveId}/root:/${encodedRoot}:/children`
    : `/drives/${driveId}/root/children`;

  const out: DriveItem[] = [];
  let next: string | null = `${GRAPH_BASE}${base}?$top=200`;
  while (next) {
    const data: { value: RawDriveItem[]; "@odata.nextLink"?: string } = await graphFetch(
      accessToken,
      next
    );
    out.push(...data.value.map(toDriveItem));
    next = data["@odata.nextLink"] ?? null;
  }
  return out;
}

/** Bestanden direct in een map (geen submappen). */
export async function listChildren(
  accessToken: string,
  driveId: string,
  itemId: string
): Promise<DriveItem[]> {
  const out: DriveItem[] = [];
  let next: string | null = `${GRAPH_BASE}/drives/${driveId}/items/${itemId}/children?$top=200`;
  while (next) {
    const data: { value: RawDriveItem[]; "@odata.nextLink"?: string } = await graphFetch(
      accessToken,
      next
    );
    out.push(...data.value.map(toDriveItem));
    next = data["@odata.nextLink"] ?? null;
  }
  return out;
}

export interface DriveFile extends DriveItem {
  /** Pad ván de aangewezen map gerekend, bv. "Onderbouwing/berekening.pdf".
      Hiermee kan de mapstructuur één-op-één worden nagebouwd in Dropbox. */
  relativePath: string;
}

/**
 * Alle bestanden onder een map, inclusief submappen, mét het pad binnen die
 * map. De hele map moet namelijk als map in Dropbox terechtkomen — niet
 * platgeslagen tot een hoop losse bestanden.
 */
export async function listFolderTree(
  accessToken: string,
  driveId: string,
  itemId: string,
  prefix = "",
  depth = 0
): Promise<DriveFile[]> {
  // Diepte begrenzen: een per ongeluk aangewezen bibliotheek-root met honderden
  // niveaus mag de serverless-functie niet laten aflopen.
  if (depth > 6) return [];
  const children = await listChildren(accessToken, driveId, itemId);
  const files: DriveFile[] = children
    .filter((c) => !c.isFolder)
    .map((c) => ({ ...c, relativePath: prefix ? `${prefix}/${c.name}` : c.name }));

  for (const folder of children.filter((c) => c.isFolder)) {
    files.push(
      ...(await listFolderTree(
        accessToken,
        driveId,
        folder.id,
        prefix ? `${prefix}/${folder.name}` : folder.name,
        depth + 1
      ))
    );
  }
  return files;
}

/**
 * Kortlevende, vooraf geauthenticeerde download-URL van Graph. Die geven we
 * door aan Dropbox' save_url, zodat Dropbox het bestand zelf rechtstreeks bij
 * SharePoint ophaalt — geen megabytes door onze serverless-functie, en dus
 * geen geheugen- of tijdslimiet die stukloopt op een grote plattegrond.
 */
/**
 * Kortlevende, vooraf geauthenticeerde download-URL van Graph. Die geven we
 * door aan Dropbox' save_url, zodat Dropbox het bestand zelf rechtstreeks bij
 * SharePoint ophaalt — geen megabytes door onze serverless-functie, en dus
 * geen geheugen- of tijdslimiet die stukloopt op een groot bestand.
 *
 * Let op de valkuil die dit eerder brak: vraag je het item op mét een
 * $select-lijst, dan laat Graph @microsoft.graph.downloadUrl stilzwijgend weg.
 * Daarom hier géén $select. Lukt het dan nog niet, dan geeft /content een
 * omleiding naar diezelfde URL — die lezen we uit de Location-header.
 */
export async function getDownloadUrl(
  accessToken: string,
  driveId: string,
  itemId: string
): Promise<string> {
  const data = await graphFetch<Record<string, unknown>>(
    accessToken,
    `/drives/${driveId}/items/${itemId}`
  );
  const url = data["@microsoft.graph.downloadUrl"];
  if (typeof url === "string") return url;

  const res = await fetch(`${GRAPH_BASE}/drives/${driveId}/items/${itemId}/content`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    redirect: "manual",
    cache: "no-store",
  });
  const location = res.headers.get("location");
  if (location) {
    // Een omleiding mag volgens de HTTP-regels ook relatief zijn. Zo'n
    // half adres doorgeven aan Dropbox levert daar een "invalid_url" op,
    // en dat is dan een fout die niets zegt over de echte oorzaak.
    return new URL(location, GRAPH_BASE).toString();
  }

  throw new GraphApiError(
    500,
    `Geen download-URL gekregen voor item ${itemId} (status ${res.status})`
  );
}
