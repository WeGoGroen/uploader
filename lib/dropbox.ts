import { getOptionalRedis } from "@/lib/redis";
import { fetchProjectPhotos } from "@/lib/streetview";
import { mapnaamPastBijAdres, parseProjectFolderName } from "@/lib/projectmap-match";

const DROPBOX_TOKEN_URL = "https://api.dropboxapi.com/oauth2/token";
const REFRESH_TOKEN_KEY = "dropbox:refresh_token";
const DROPBOX_API_BASE = "https://api.dropboxapi.com/2";
const DROPBOX_CONTENT_BASE = "https://content.dropboxapi.com/2";

export interface DropboxTokens {
  accessToken: string;
  refreshToken: string | null;
}

export interface DropboxAccount {
  accountId: string;
  email: string;
  name: string;
}

// HTTP-headers mogen alleen ISO-8859-1 bevatten — een bestandsnaam met een
// niet-ASCII teken (ë, ü, "…) in Dropbox-API-Arg laat fetch/undici crashen
// met "The string did not match the expected pattern." Dropbox schrijft zelf
// voor om zulke tekens in de header-waarde te escapen als \uXXXX i.p.v. ze
// letterlijk mee te sturen.
function safeHeaderJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[-￿]/g,
    (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")
  );
}

class DropboxApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
    this.name = "DropboxApiError";
  }
}

export async function exchangeCodeForTokens(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string
): Promise<DropboxTokens> {
  const res = await fetch(DROPBOX_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new DropboxApiError(
      res.status,
      `Dropbox token exchange failed: ${res.status} ${body}`
    );
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
  };

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
  };
}

export async function refreshAccessToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string
): Promise<string> {
  const res = await fetch(DROPBOX_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new DropboxApiError(
      res.status,
      `Dropbox token refresh failed: ${res.status} ${body}`
    );
  }

  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

/**
 * Slaat het refresh-token op in Redis zodra iemand op "Inloggen met Dropbox"
 * klikt, zodat de koppeling meteen werkt voor het hele team — geen
 * handmatige env var meer nodig. DROPBOX_REFRESH_TOKEN blijft als terugval
 * werken voor installaties die het op de oude manier hebben ingesteld.
 */
export async function storeRefreshToken(refreshToken: string): Promise<void> {
  const redis = getOptionalRedis();
  if (!redis) return;
  await redis.set(REFRESH_TOKEN_KEY, refreshToken);
}

async function storedRefreshToken(): Promise<string | null> {
  const redis = getOptionalRedis();
  if (!redis) return null;
  return redis.get(REFRESH_TOKEN_KEY);
}

/**
 * Leest het gedeelde Dropbox-token — eerst uit Redis (via de inlogknop
 * gezet), anders uit DROPBOX_REFRESH_TOKEN in de omgeving. Zelfde patroon
 * als ClickUp: één keer opgezet, werkt daarna voor het hele team zonder dat
 * iedereen apart hoeft in te loggen.
 */
export async function requireDropboxConfig(): Promise<{
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}> {
  const clientId = process.env.DROPBOX_CLIENT_ID;
  const clientSecret = process.env.DROPBOX_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("DROPBOX_CLIENT_ID / DROPBOX_CLIENT_SECRET zijn niet ingesteld");
  }
  const refreshToken = (await storedRefreshToken()) ?? process.env.DROPBOX_REFRESH_TOKEN;
  if (!refreshToken) {
    throw new Error("Dropbox is nog niet gekoppeld. Klik op 'Inloggen met Dropbox' op de Koppelingen-pagina.");
  }
  return { clientId, clientSecret, refreshToken };
}

/** Wisselt het gedeelde refresh-token in voor een kortlevend access-token. */
export async function getSharedAccessToken(): Promise<string> {
  const { clientId, clientSecret, refreshToken } = await requireDropboxConfig();
  return refreshAccessToken(clientId, clientSecret, refreshToken);
}

export function sanitizePathSegment(value: string): string {
  // Dropbox staat geen /, backslash of andere padtekens toe in mapnamen.
  return value.replace(/[/\\:*?"<>|]/g, "-").trim().replace(/\s+/g, " ");
}

export type ProjectKind = "energielabel" | "nen" | "media";

// Eén platte hoofdmap per soort opname ("Automatie Energielabels" /
// "Automatie NEN2580" — geen geneste Automatie/Energielabels-mappen) met
// daarin direct de projectmap per adres. Sorteert door de naam met een "A"
// vanzelf hoog in de mappenlijst, en is in twee klikken te vinden i.p.v.
// door meerdere niveaus (Plaats, dan Straat) te moeten klikken.
export function projectFolderPath(
  kind: ProjectKind,
  woonplaats: string,
  straatEnNummer: string
): string {
  const root =
    kind === "nen"
      ? "Automatie NEN2580"
      : kind === "media"
        ? "Automatie Media"
        : "Automatie Energielabels";
  return `/${root}/${sanitizePathSegment(straatEnNummer)}, ${sanitizePathSegment(woonplaats)}`;
}

// Vaste onderverdeling per opname — zelfde structuur als het sjabloon dat
// WeGoGroen al gebruikte ("LEEG kopie"), nu automatisch per adres aangemaakt.
/**
 * De archiefmap binnen een hoofdmap: daar gaat afgerond werk heen, zodat
 * "Automatie Energielabels" laat zien waar nog aan gewerkt wordt in plaats van
 * een lijst van alles wat er ooit was.
 *
 * Voor de rest van de app mag dat geen verschil maken. Een projectmap die in
 * het archief staat, moet nog steeds gevonden worden — anders maakt de uploader
 * bij het volgende werk een tweede, lege map naast de bestaande en staan de
 * foto's in de ene en het label in de andere.
 */
export const ARCHIEF_MAP = "Afgerond";
const ARCHIEF_LOWER = ARCHIEF_MAP.toLowerCase();

/**
 * Splitst het pad ná de hoofdmap in "welke projectmap" en "wat daarbinnen".
 * Een gearchiveerd project staat één niveau dieper; deze functie maakt dat
 * verschil onzichtbaar voor de tellers hieronder.
 */
function projectDelen(delen: string[]): { sleutel: string; binnen: string[] } | null {
  const zonderArchief = delen[0] === ARCHIEF_LOWER ? delen.slice(1) : delen;
  if (!zonderArchief[0]) return null;
  return { sleutel: zonderArchief[0], binnen: zonderArchief.slice(1) };
}

export const PROJECT_SUBFOLDERS = [
  "BAG",
  "DOT3D",
  "Energielabel",
  "Foto's",
  "Isolatie bewijs",
  "LAZ",
  "Onderbouwing",
  "Opdrachtbevestiging",
  "Opname formulier",
  "Plattegronden",
  "VABI",
];

// Structuur van het NEN2580-sjabloon ("Voorbeeld Map NEN2580" in Dropbox).
export const NEN_PROJECT_SUBFOLDERS = ["Additionals", "Optimized", "Photo's", "RAW", "Video"];

/**
 * Media-opnames: los van een energielabel of NEN2580 wordt er ook beeld
 * aangeleverd voor de verkoopstyling van een pand.
 *
 * Alles wat de opnemer aanlevert gaat onder "in" — dat is de afgesproken
 * scheiding tussen wat erin gaat en wat de bewerker er later uit oplevert.
 * Eén map per soort daarbinnen, zodat de ontvanger meteen weet wat waar staat.
 */
export const MEDIA_PROJECT_SUBFOLDERS = ["in", "in/Photo's", "in/Video", "in/360"];

/**
 * Maakt meerdere mappen in één API-call aan via Dropbox's batch-endpoint.
 * create_folder_v2 in een Promise.all voor 11 mappen tegelijk loopt binnen
 * de kortingsregels van Dropbox vast op "too_many_write_operations" (429) —
 * de batch-API is precies hiervoor bedoeld en telt als één schrijfactie.
 */
export async function createFolders(accessToken: string, paths: string[]): Promise<void> {
  const res = await fetch(`${DROPBOX_API_BASE}/files/create_folder_batch`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ paths, autorename: false, force_async: false }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new DropboxApiError(res.status, `Dropbox create_folder_batch failed: ${res.status} ${body}`);
  }

  let data = (await res.json()) as { ".tag": string; async_job_id?: string };

  // Bij veel mappen ineens (niet ons geval met 11, maar toekomstvast) kan
  // Dropbox de aanvraag asynchroon afhandelen — dan even pollen tot 'm klaar is.
  if (data[".tag"] === "async_job_id" && data.async_job_id) {
    const jobId = data.async_job_id;
    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise((r) => setTimeout(r, 500));
      const checkRes = await fetch(`${DROPBOX_API_BASE}/files/create_folder_batch/check`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ async_job_id: jobId }),
      });
      if (!checkRes.ok) {
        const body = await checkRes.text().catch(() => "");
        throw new DropboxApiError(checkRes.status, `Dropbox batch check failed: ${checkRes.status} ${body}`);
      }
      data = (await checkRes.json()) as { ".tag": string };
      if (data[".tag"] !== "in_progress") break;
    }
  }
  // "complete" met per-map path/conflict-fouten is prima — die mappen
  // bestonden al van een eerdere opname op hetzelfde adres.
}

export async function createFolder(accessToken: string, path: string): Promise<void> {
  const res = await fetch(`${DROPBOX_API_BASE}/files/create_folder_v2`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ path, autorename: false }),
  });
  if (res.ok) return;

  const body = await res.text().catch(() => "");
  // Map bestaat al: prima, dat is precies de bedoeling bij een tweede opname
  // op hetzelfde adres.
  if (res.status === 409 && body.includes("path/conflict")) return;
  throw new DropboxApiError(res.status, `Dropbox create_folder_v2 failed: ${res.status} ${body}`);
}

/** Uploadt een bestand naar Dropbox; overschrijft stilzwijgend als het al bestaat. */
export async function uploadFile(accessToken: string, path: string, content: Buffer): Promise<void> {
  const res = await fetch(`${DROPBOX_CONTENT_BASE}/files/upload`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/octet-stream",
      "Dropbox-API-Arg": safeHeaderJson({ path, mode: "overwrite", autorename: false, mute: true }),
    },
    body: new Uint8Array(content),
  });
  if (res.ok) return;
  const body = await res.text().catch(() => "");
  throw new DropboxApiError(res.status, `Dropbox files/upload failed: ${res.status} ${body}`);
}

/**
 * Vraagt een kortlopende uploadlink aan waarmee de browser het bestand
 * rechtstreeks bij Dropbox kan afleveren (geen omweg via onze server, geen
 * ~4,5MB-limiet per aanroep). Geldig voor precies dit ene pad; het
 * account-token blijft server-side. Dropbox staat via deze weg bestanden tot
 * 150MB toe — daarboven blijft de chunked route hieronder nodig.
 */
export async function createTemporaryUploadLink(accessToken: string, path: string): Promise<string> {
  const res = await fetch(`${DROPBOX_API_BASE}/files/get_temporary_upload_link`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      commit_info: { path, mode: "overwrite", autorename: false, mute: true },
      duration: 3600,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new DropboxApiError(res.status, `Dropbox get_temporary_upload_link failed: ${res.status} ${body}`);
  }
  const data = (await res.json()) as { link: string };
  return data.link;
}

// Vercel accepteert per serverless-aanroep maximaal ~4,5MB in de request-
// body (harde platformlimiet, niet instelbaar) — een normale iPad-foto of
// RAW-scan zit daar al snel overheen. Grotere bestanden gaan daarom in
// stukken via Dropbox's eigen upload-session-API, zodat elk los verzoek
// vanaf de browser klein genoeg blijft.
/**
 * Start een "concurrent" upload-sessie: daarbij mogen de blokken in
 * willekeurige volgorde en tegelijk verstuurd worden, i.p.v. keurig na
 * elkaar. Dat maakt grote bestanden fors sneller, terwijl het account-token
 * gewoon server-side blijft. Voorwaarde van Dropbox: bij het starten gaat er
 * nog geen data mee, en elk blok behalve het laatste moet een veelvoud van
 * 4MB zijn.
 */
export async function startConcurrentUploadSession(accessToken: string): Promise<string> {
  const res = await fetch(`${DROPBOX_CONTENT_BASE}/files/upload_session/start`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/octet-stream",
      "Dropbox-API-Arg": safeHeaderJson({ close: false, session_type: { ".tag": "concurrent" } }),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new DropboxApiError(res.status, `Dropbox upload_session/start (concurrent) failed: ${res.status} ${body}`);
  }
  const data = (await res.json()) as { session_id: string };
  return data.session_id;
}

export async function startUploadSession(accessToken: string, chunk: Buffer): Promise<string> {
  const res = await fetch(`${DROPBOX_CONTENT_BASE}/files/upload_session/start`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/octet-stream",
      "Dropbox-API-Arg": safeHeaderJson({ close: false }),
    },
    body: new Uint8Array(chunk),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new DropboxApiError(res.status, `Dropbox upload_session/start failed: ${res.status} ${body}`);
  }
  const data = (await res.json()) as { session_id: string };
  return data.session_id;
}

export async function appendUploadSession(
  accessToken: string,
  sessionId: string,
  offset: number,
  chunk: Buffer,
  /** Sluit de sessie af. Bij een concurrent-sessie moet het blok dat het
      bestand compleet maakt dit zetten, anders weigert finish met
      "concurrent_session_not_closed". */
  close = false
): Promise<void> {
  const res = await fetch(`${DROPBOX_CONTENT_BASE}/files/upload_session/append_v2`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/octet-stream",
      "Dropbox-API-Arg": safeHeaderJson({ cursor: { session_id: sessionId, offset }, close }),
    },
    body: new Uint8Array(chunk),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new DropboxApiError(res.status, `Dropbox upload_session/append_v2 failed: ${res.status} ${body}`);
  }
}

export async function finishUploadSession(
  accessToken: string,
  sessionId: string,
  offset: number,
  path: string,
  chunk: Buffer
): Promise<void> {
  const res = await fetch(`${DROPBOX_CONTENT_BASE}/files/upload_session/finish`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/octet-stream",
      "Dropbox-API-Arg": safeHeaderJson({
        cursor: { session_id: sessionId, offset },
        commit: { path, mode: "overwrite", autorename: false, mute: true },
      }),
    },
    body: new Uint8Array(chunk),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new DropboxApiError(res.status, `Dropbox upload_session/finish failed: ${res.status} ${body}`);
  }
}

/**
 * Laat Dropbox zélf een bestand ophalen bij een URL, in plaats van het door
 * onze serverless-functie te pompen. Gebruikt voor de finale bestanden uit
 * SharePoint: die komen met een kortlevende Graph-download-URL, en zo raken
 * de megabytes nooit Vercel — geen geheugenpiek en geen time-out op een
 * grote plattegrond.
 *
 * Let op: save_url kent geen overwrite-modus (Dropbox hernoemt bij een
 * conflict naar "bestand (1).pdf"). De aanroeper moet dus zelf overslaan wat
 * er al staat — zie syncSharePointFiles.
 */
export async function saveUrl(
  accessToken: string,
  path: string,
  url: string
): Promise<{ done: boolean; jobId: string | null }> {
  const res = await fetch(`${DROPBOX_API_BASE}/files/save_url`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ path, url }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new DropboxApiError(res.status, `Dropbox files/save_url failed: ${res.status} ${body}`);
  }
  const data = (await res.json()) as { ".tag": string; async_job_id?: string };
  if (data[".tag"] === "async_job_id" && data.async_job_id) {
    return { done: false, jobId: data.async_job_id };
  }
  return { done: true, jobId: null };
}

/** Status van een save_url-opdracht: "in_progress" | "complete" | "failed". */
export async function checkSaveUrlJob(
  accessToken: string,
  jobId: string
): Promise<{ status: string; error: string | null }> {
  const res = await fetch(`${DROPBOX_API_BASE}/files/save_url/check_job_status`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ async_job_id: jobId }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new DropboxApiError(res.status, `Dropbox save_url/check_job_status failed: ${res.status} ${body}`);
  }
  const data = (await res.json()) as { ".tag": string; failed?: unknown };
  return {
    status: data[".tag"],
    error: data[".tag"] === "failed" ? JSON.stringify(data.failed ?? {}) : null,
  };
}

/** Verwijdert een bestand — gebruikt om een per ongeluk in de verkeerde map
    geüploade RAW-scan (herkenbaar aan "_raw.dp" in de bestandsnaam) weer weg
    te halen uit Optimized. */
export async function deleteFile(accessToken: string, path: string): Promise<void> {
  const res = await fetch(`${DROPBOX_API_BASE}/files/delete_v2`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ path }),
  });
  if (res.ok) return;
  const body = await res.text().catch(() => "");
  // Al weg: prima, dat is precies de bedoeling.
  if (res.status === 409 && body.includes("path_lookup/not_found")) return;
  throw new DropboxApiError(res.status, `Dropbox files/delete_v2 failed: ${res.status} ${body}`);
}

export async function getOrCreateSharedLink(accessToken: string, path: string): Promise<string> {
  const create = await fetch(`${DROPBOX_API_BASE}/sharing/create_shared_link_with_settings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ path }),
  });
  if (create.ok) {
    const data = (await create.json()) as { url: string };
    return data.url;
  }

  const body = await create.text().catch(() => "");
  if (!body.includes("shared_link_already_exists")) {
    throw new DropboxApiError(
      create.status,
      `Dropbox create_shared_link_with_settings failed: ${create.status} ${body}`
    );
  }

  // Al een link voor deze map: die bestaande ophalen i.p.v. te falen.
  const list = await fetch(`${DROPBOX_API_BASE}/sharing/list_shared_links`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ path, direct_only: true }),
  });
  if (!list.ok) {
    const listBody = await list.text().catch(() => "");
    throw new DropboxApiError(
      list.status,
      `Dropbox list_shared_links failed: ${list.status} ${listBody}`
    );
  }
  const listData = (await list.json()) as { links: { url: string }[] };
  if (!listData.links[0]) {
    throw new DropboxApiError(500, "Dropbox meldde een bestaande link, maar gaf er geen terug");
  }
  return listData.links[0].url;
}

/**
 * Zorgt dat er een Dropbox-map + deelbare link is voor dit adres. Geeft de
 * link terug, of null als Dropbox niet geconfigureerd is — dat mag de rest
 * van het aanmaken van de taak niet blokkeren.
 */
export async function ensureProjectFolder(
  kind: ProjectKind,
  woonplaats: string,
  straatEnNummer: string
): Promise<{ path: string; url: string; subfolders: string[] } | null> {
  let accessToken: string;
  try {
    accessToken = await getSharedAccessToken();
  } catch {
    return null;
  }
  // Eerst kijken of er al een map voor dit adres staat — óók onder een iets
  // andere schrijfwijze ("58 3" i.p.v. "58-3", een afgekorte straatnaam) of
  // met een statusbolletje ervoor. Zonder deze stap bouwde deze functie blind
  // het canonieke pad en kwam er een tweede map naast te staan: de foto's in
  // de ene, het label in de andere, en niemand die dat merkt.
  const bestaand = await findProjectFolder(accessToken, kind, woonplaats, straatEnNummer).catch(
    () => null
  );
  const path = bestaand?.path ?? projectFolderPath(kind, woonplaats, straatEnNummer);
  const subfolders =
    kind === "nen"
      ? NEN_PROJECT_SUBFOLDERS
      : kind === "media"
        ? MEDIA_PROJECT_SUBFOLDERS
        : PROJECT_SUBFOLDERS;
  await createFolder(accessToken, path);
  // Per niveau aanmaken: een geneste map ("in/Photo's") kan pas als zijn
  // ouder bestaat, en binnen één batch ligt de volgorde niet vast.
  const perDiepte = new Map<number, string[]>();
  for (const name of subfolders) {
    const diepte = name.split("/").length;
    perDiepte.set(diepte, [...(perDiepte.get(diepte) ?? []), name]);
  }
  for (const diepte of [...perDiepte.keys()].sort((a, b) => a - b)) {
    await createFolders(
      accessToken,
      perDiepte.get(diepte)!.map((name) => `${path}/${name}`)
    );
  }
  // NEN2580 gebruikt "Photo's" i.p.v. "Foto's"; zonder dit onderscheid zou er
  // een losse extra map in het NEN-sjabloon verschijnen.
  await addStreetViewPhotos(
    accessToken,
    `${path}/${kind === "nen" ? "Photo's" : kind === "media" ? "in/Photo's" : "Foto's"}`,
    woonplaats,
    straatEnNummer
  );
  const url = await getOrCreateSharedLink(accessToken, path);
  // De aangemaakte submappen teruggeven, zodat de app kan tonen wat er
  // klaarstaat i.p.v. dat de opnemer in Dropbox moet gaan kijken.
  return { path, url, subfolders };
}

/**
 * Zet het automatische beeldmateriaal (straatbeeld voorkant/linkerhoek/
 * rechterhoek plus de luchtfoto) in "Foto's" van een net aangemaakte
 * projectmap. Faalt nooit hard: geen foto's is vervelend, geen projectmap is
 * blokkerend.
 *
 * Alleen bij een lege map — zodra er foto's van de opname in staan zijn deze
 * niet meer nodig, en een tweede opname op hetzelfde adres mag nooit een
 * handmatig vervangen gevelfoto overschrijven.
 */
async function addStreetViewPhotos(
  accessToken: string,
  fotoPath: string,
  woonplaats: string,
  straatEnNummer: string
): Promise<void> {
  try {
    const existing = await listFolderFiles(accessToken, fotoPath);
    if (existing.length > 0) return;

    const photos = await fetchProjectPhotos(woonplaats, straatEnNummer);
    if (photos.length === 0) return;

    for (const photo of photos) {
      await uploadFile(accessToken, `${fotoPath}/${photo.filename}`, photo.content);
    }
    console.log("[STREETVIEW] beeldmateriaal geplaatst", {
      pad: fotoPath,
      bestanden: photos.map((p) => p.filename),
    });
  } catch (err) {
    // Street View is een extraatje — nooit reden om het aanmaken van de
    // projectmap te laten mislukken. Wel loggen, anders faalt het onzichtbaar.
    console.error("[STREETVIEW] beeldmateriaal plaatsen mislukt", {
      pad: fotoPath,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export interface DropboxFileEntry {
  name: string;
  size: number;
}

/**
 * Lijst bestanden (geen submappen) in een projectmap — gebruikt om op de
 * documentenpagina automatisch te tonen wat er al via Dropbox is
 * geüpload, zonder dat de opnemer dat handmatig hoeft te melden.
 */
export async function listFolderFiles(
  accessToken: string,
  path: string
): Promise<DropboxFileEntry[]> {
  const res = await fetch(`${DROPBOX_API_BASE}/files/list_folder`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ path, recursive: false }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // Map bestaat (nog) niet — gewoon een lege lijst, geen harde fout: dat
    // kan gebeuren bij een nieuw adres waar de map net is aangemaakt.
    if (res.status === 409 && body.includes("path/not_found")) return [];
    throw new DropboxApiError(res.status, `Dropbox list_folder failed: ${res.status} ${body}`);
  }

  const data = (await res.json()) as {
    entries: { ".tag": string; name: string; size?: number }[];
  };

  return data.entries
    .filter((e) => e[".tag"] === "file")
    .map((e) => ({ name: e.name, size: e.size ?? 0 }));
}

/** Directe download-link (i.p.v. de Dropbox-voorbeeldpagina) voor externe
    diensten zoals Mediatask die zelf het bestand ophalen via een URL. */
function toDirectDownloadUrl(shareUrl: string): string {
  if (/[?&]dl=0\b/.test(shareUrl)) return shareUrl.replace(/dl=0\b/, "dl=1");
  return shareUrl.includes("?") ? `${shareUrl}&dl=1` : `${shareUrl}?dl=1`;
}

/** Directe download-links voor alle bestanden in een map, gebruikt om
    foto's/tekeningen als kant-en-klare URL's aan te leveren bij Mediatask —
    geen dubbele upload nodig, ze staan al in Dropbox. */
/** Zelfde als getFileDirectLinks, maar mét bestandsnaam — nodig om in een
    Mediatask-opmerking te kunnen zeggen wélk bestand bij welke link hoort. */
/**
 * Een tijdelijke link naar één bestand: vier uur geldig, geen blijvend spoor.
 *
 * Bewust niet getOrCreateSharedLink: die maakt een permanente deellink, en
 * dertig bestanden bekijken zou dan dertig bestanden voorgoed deelbaar maken.
 * Voor het beoordelen van een oplevering wil je precies het omgekeerde — kijken
 * zonder iets te veranderen.
 */
export async function getTemporaryLink(accessToken: string, path: string): Promise<string> {
  const res = await fetch(`${DROPBOX_API_BASE}/files/get_temporary_link`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) {
    throw new Error(`Dropbox tijdelijke link mislukt (${res.status})`);
  }
  const data = (await res.json()) as { link: string };
  return data.link;
}

/**
 * Alle bestanden in een map, met een tijdelijke link per stuk.
 *
 * De links worden in groepjes opgehaald: bij dertig bestanden is één-voor-één
 * wachten zo'n dertig ritjes naar Dropbox achter elkaar, en dan staat het
 * scherm te wachten op een lijstje.
 */
export async function listFolderWithTemporaryLinks(
  accessToken: string,
  folderPath: string
): Promise<{ name: string; size: number; url: string | null }[]> {
  const files = await listFolderFiles(accessToken, folderPath);
  const uit: { name: string; size: number; url: string | null }[] = [];
  const GROEP = 6;
  for (let i = 0; i < files.length; i += GROEP) {
    const groep = files.slice(i, i + GROEP);
    const links = await Promise.all(
      groep.map((f) =>
        getTemporaryLink(accessToken, `${folderPath}/${f.name}`).catch(() => null)
      )
    );
    groep.forEach((f, n) => uit.push({ name: f.name, size: f.size, url: links[n] }));
  }
  return uit;
}

export async function getFileLinksWithNames(
  accessToken: string,
  folderPath: string
): Promise<{ name: string; url: string }[]> {
  const files = await listFolderFiles(accessToken, folderPath);
  const out: { name: string; url: string }[] = [];
  for (const file of files) {
    const url = await getOrCreateSharedLink(accessToken, `${folderPath}/${file.name}`);
    out.push({ name: file.name, url: toDirectDownloadUrl(url) });
  }
  return out;
}

export async function getFileDirectLinks(accessToken: string, folderPath: string): Promise<string[]> {
  const files = await listFolderFiles(accessToken, folderPath);
  const links: string[] = [];
  for (const file of files) {
    const url = await getOrCreateSharedLink(accessToken, `${folderPath}/${file.name}`);
    links.push(toDirectDownloadUrl(url));
  }
  return links;
}

/** Downloadt de ruwe inhoud van een bestand — gebruikt om Dropbox-bestanden
    door te zetten naar ClickUp zonder ze ergens tussentijds op te slaan. */
export async function downloadFile(accessToken: string, path: string): Promise<Blob> {
  const res = await fetch("https://content.dropboxapi.com/2/files/download", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Dropbox-API-Arg": safeHeaderJson({ path }),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new DropboxApiError(res.status, `Dropbox files/download failed: ${res.status} ${body}`);
  }
  return res.blob();
}

/**
 * Opent een leesstroom op een bestand in Dropbox, zonder het eerst helemaal in
 * het geheugen te trekken.
 *
 * Nodig omdat een scan van honderden MB's anders het geheugen van een
 * serverless-functie opblaast. Met een stroom kan hetzelfde bestand direct
 * doorgesluisd worden naar de opslag van Mediatask.
 */
export async function openFileStream(
  accessToken: string,
  path: string
): Promise<{ stream: ReadableStream<Uint8Array>; size: number }> {
  const res = await fetch("https://content.dropboxapi.com/2/files/download", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Dropbox-API-Arg": safeHeaderJson({ path }),
    },
  });
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => "");
    throw new DropboxApiError(res.status, `Dropbox files/download failed: ${res.status} ${body}`);
  }
  // Dropbox geeft de metadata mee in een header; de lengte hebben we nodig
  // omdat S3 die meetekent in de handtekening van de uploadlink.
  const meta = res.headers.get("dropbox-api-result");
  const size = meta ? ((JSON.parse(meta) as { size?: number }).size ?? 0) : 0;
  return { stream: res.body, size: size || Number(res.headers.get("content-length") ?? 0) };
}

export async function getCurrentAccount(
  accessToken: string
): Promise<DropboxAccount> {
  const res = await fetch(`${DROPBOX_API_BASE}/users/get_current_account`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new DropboxApiError(
      res.status,
      `Dropbox get_current_account failed: ${res.status} ${body}`
    );
  }

  const data = (await res.json()) as {
    account_id: string;
    email: string;
    name: { display_name: string };
  };

  return {
    accountId: data.account_id,
    email: data.email,
    name: data.name.display_name,
  };
}

/**
 * Alle bestandspaden onder een map, relatief aan die map ("Onderbouwing/
 * berekening.pdf"). Gebruikt om te zien wat er al staat voordat er een hele
 * SharePoint-map wordt overgehaald — save_url kent geen overschrijven en zou
 * anders "berekening (1).pdf" maken bij een tweede poging.
 */
export interface ProjectFolderSummary {
  /** Mapnaam direct onder de hoofdmap, bv. "Damrak 1, Amsterdam". */
  name: string;
  /** Aantal bestanden ergens in die map, submappen meegerekend. */
  files: number;
}

/**
 * Telt per projectmap hoeveel bestanden er in totaal in staan. Bedoeld om
 * verweesde mappen te vinden: een map met de vaste submapstructuur maar nul
 * bestanden is werk dat nooit begonnen is — meestal doordat het adres ná het
 * aanmaken nog gecorrigeerd werd, waardoor de map onder de oude naam leeg
 * achterbleef.
 *
 * Eén recursieve listing per hoofdmap, want die geeft mappen én bestanden in
 * dezelfde stroom. MAX_PAGINAS is een noodrem: bij een archief dat veel groter
 * wordt dan verwacht liever een onvolledig antwoord dan een cron die vastloopt
 * — de aanroeper krijgt dat te horen via `volledig`.
 */
export async function summarizeProjectFolders(
  accessToken: string,
  root: string
): Promise<{ folders: ProjectFolderSummary[]; volledig: boolean }> {
  // 20 pagina's was genoeg toen de hoofdmap tientallen projecten telde; met
  // het volledige archief erin (450+ projectmappen, elk met vaste indeling)
  // werd de listing halverwege afgekapt — en een afgekapte scan zegt dan
  // "deze map is leeg" over mappen die vol staan. De grens blijft bestaan als
  // noodrem, maar ruim boven wat er werkelijk staat.
  const MAX_PAGINAS = 200;
  const prefix = `${root.toLowerCase()}/`;
  // Sleutel is de map in kleine letters (paden komen zo terug), waarde de
  // weergavenaam plus de bestandsteller.
  const perMap = new Map<string, ProjectFolderSummary>();
  let cursor: string | null = null;
  let volledig = false;

  for (let pagina = 0; pagina < MAX_PAGINAS; pagina++) {
    const res: Response = await fetch(
      `${DROPBOX_API_BASE}/files/list_folder${cursor ? "/continue" : ""}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(cursor ? { cursor } : { path: root, recursive: true }),
      }
    );

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      if (res.status === 409 && body.includes("path/not_found")) {
        return { folders: [], volledig: true };
      }
      throw new DropboxApiError(res.status, `Dropbox list_folder failed: ${res.status} ${body}`);
    }

    const data = (await res.json()) as {
      entries: { ".tag": string; name: string; path_lower?: string }[];
      cursor: string;
      has_more: boolean;
    };

    for (const entry of data.entries) {
      const p = entry.path_lower;
      if (!p || !p.startsWith(prefix)) continue;
      const project = projectDelen(p.slice(prefix.length).split("/"));
      // De archiefmap zelf is geen project; die valt hier weg.
      if (!project) continue;

      if (entry[".tag"] === "folder") {
        // Alleen de projectmap zelf telt; de submappen daarbinnen (BAG, LAZ, …)
        // horen bij hun projectmap.
        if (project.binnen.length === 0 && !perMap.has(project.sleutel)) {
          perMap.set(project.sleutel, { name: entry.name, files: 0 });
        }
      } else if (entry[".tag"] === "file") {
        const bestaand = perMap.get(project.sleutel);
        if (bestaand) bestaand.files++;
        // Losse bestanden rechtstreeks in de hoofdmap horen bij geen enkele
        // projectmap; die slaan we over.
        else if (project.binnen.length > 0) {
          perMap.set(project.sleutel, { name: project.sleutel, files: 1 });
        }
      }
    }

    if (!data.has_more) {
      volledig = true;
      break;
    }
    cursor = data.cursor;
  }

  return { folders: [...perMap.values()], volledig };
}

export async function listFilePathsRecursive(
  accessToken: string,
  path: string
): Promise<string[]> {
  const out: string[] = [];
  const prefix = path.toLowerCase();
  let cursor: string | null = null;

  for (;;) {
    const res: Response = await fetch(
      `${DROPBOX_API_BASE}/files/list_folder${cursor ? "/continue" : ""}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(cursor ? { cursor } : { path, recursive: true }),
      }
    );

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      // Map bestaat nog niet — dan staat er per definitie nog niets.
      if (res.status === 409 && body.includes("path/not_found")) return out;
      throw new DropboxApiError(res.status, `Dropbox list_folder failed: ${res.status} ${body}`);
    }

    const data = (await res.json()) as {
      entries: { ".tag": string; path_lower?: string }[];
      cursor: string;
      has_more: boolean;
    };

    for (const entry of data.entries) {
      if (entry[".tag"] !== "file" || !entry.path_lower) continue;
      out.push(entry.path_lower.startsWith(`${prefix}/`) ? entry.path_lower.slice(prefix.length + 1) : entry.path_lower);
    }

    if (!data.has_more) return out;
    cursor = data.cursor;
  }
}

// ---------------------------------------------------------------------------
// Statusmarkering op de projectmap
// ---------------------------------------------------------------------------

/**
 * Dropbox kent wél gekleurde mappen in de webinterface, maar biedt daar geen
 * API voor. De eerste oplossing was een gekleurd bolletje vóór de mapnaam.
 * Dat bleek een vergissing: Windows-programma's (opslaan-dialogen, oudere
 * software) struikelen over zo'n emoji in het pad, en elke statuswissel
 * hernoemde de map onder open Verkenner-vensters vandaan — met "map in
 * gebruik"-meldingen en mislukte opslag-acties als gevolg, precies op de
 * geautomatiseerde mappen.
 *
 * De status leeft daarom nu in Redis (één hash, sleutel = kaal pad in kleine
 * letters) en is zichtbaar in het Business Control Center. De mapnaam blijft
 * schoon. De markers hieronder bestaan nog om bestaande bolletjes te
 * herkennen en op te ruimen.
 */
export const FOLDER_STATUS_MARKERS = {
  /** Alles uit SharePoint staat erin. */
  compleet: "🟢",
  /** Overdracht loopt nog. */
  bezig: "🟠",
  /** Er ontbreekt iets, of het ophalen is mislukt. */
  ontbreekt: "🔴",
} as const;

export type FolderStatus = keyof typeof FOLDER_STATUS_MARKERS;

const MARKER_RE = new RegExp(
  `^(?:${Object.values(FOLDER_STATUS_MARKERS).join("|")})\\s*`
);

/** Mapnaam zonder statusbolletje, zodat vergelijken op adres blijft werken. */
export function stripStatusMarker(name: string): string {
  return name.replace(MARKER_RE, "");
}

/** Huidige status van een mapnaam, of null als er nog geen bolletje voor staat. */
export function statusFromName(name: string): FolderStatus | null {
  for (const [status, marker] of Object.entries(FOLDER_STATUS_MARKERS)) {
    if (name.startsWith(marker)) return status as FolderStatus;
  }
  return null;
}

/**
 * Zoekt de projectmap van dit adres op, óók als er al een statusbolletje voor
 * staat. Zonder dit zou een gemarkeerde map bij een volgende ronde niet meer
 * gevonden worden en zou er een tweede map naast komen te staan.
 */
export async function findProjectFolder(
  accessToken: string,
  kind: ProjectKind,
  woonplaats: string,
  straatEnNummer: string
): Promise<{ path: string; name: string } | null> {
  const canonical = projectFolderPath(kind, woonplaats, straatEnNummer);
  const root = canonical.slice(0, canonical.lastIndexOf("/"));
  const naam = canonical.slice(canonical.lastIndexOf("/") + 1);

  // Eerst waar het werk staat, dan het archief. In die volgorde, want een
  // lopende opname hoort zwaarder te wegen dan een afgeronde met dezelfde naam.
  return (
    (await zoekInEenMap(accessToken, root, naam)) ??
    (await zoekInEenMap(accessToken, `${root}/${ARCHIEF_MAP}`, naam))
  );
}

/** Eén map afzoeken op een projectmap die bij dit adres hoort. */
async function zoekInEenMap(
  accessToken: string,
  map: string,
  naam: string
): Promise<{ path: string; name: string } | null> {
  const gezocht = naam.toLowerCase();
  const gezochtAdres = parseProjectFolderName(naam);

  let cursor: string | null = null;
  for (;;) {
    const res: Response = await fetch(
      `${DROPBOX_API_BASE}/files/list_folder${cursor ? "/continue" : ""}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(cursor ? { cursor } : { path: map, recursive: false }),
      }
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      // Geen archiefmap is de normale toestand zolang er niets gearchiveerd is.
      if (res.status === 409 && body.includes("path/not_found")) return null;
      throw new DropboxApiError(res.status, `Dropbox list_folder failed: ${res.status} ${body}`);
    }
    const data = (await res.json()) as {
      entries: { ".tag": string; name: string; path_display?: string }[];
      cursor: string;
      has_more: boolean;
    };
    for (const entry of data.entries) {
      if (entry[".tag"] !== "folder") continue;
      const kaleNaam = stripStatusMarker(entry.name);

      // Eerst de snelle, exacte weg. Daarna een tolerante vergelijking op
      // straat/huisnummer/woonplaats, want dezelfde woning wordt niet overal
      // identiek geschreven ("58-3" vs "58 3", een afgekorte straatnaam). Zonder
      // die tweede kans ontstaat er een tweede map voor hetzelfde huis, met de
      // foto's in de ene en het label in de andere.
      if (kaleNaam.toLowerCase() === gezocht) {
        return { path: entry.path_display ?? `${map}/${entry.name}`, name: entry.name };
      }
      if (gezochtAdres && mapnaamPastBijAdres(kaleNaam, gezochtAdres)) {
        return { path: entry.path_display ?? `${map}/${entry.name}`, name: entry.name };
      }
    }
    if (!data.has_more) return null;
    cursor = data.cursor;
  }
}

const STATUS_HASH = "sharepoint:mapstatus";

/** Redis-veld voor een projectmap: kaal pad, kleine letters. Zo overleeft de
    status het opruimen van een bolletje uit de naam. */
function statusVeld(root: string, naam: string): string {
  return `${root}/${stripStatusMarker(naam)}`.toLowerCase();
}

/**
 * Legt de overdrachtsstatus van een projectmap vast — in Redis, niet meer in
 * de mapnaam. Geeft het (schone) pad terug.
 *
 * Zelfherstellend: draagt de map nog een bolletje uit de oude aanpak, dan
 * wordt hij hier eenmalig naar de kale naam hernoemd. Dat is veilig voor de
 * deel-link in de ClickUp-taak: Dropbox hangt zo'n link aan de map zelf,
 * niet aan het pad.
 */
export async function setProjectFolderStatus(
  accessToken: string,
  kind: ProjectKind,
  woonplaats: string,
  straatEnNummer: string,
  status: FolderStatus
): Promise<string | null> {
  const huidig = await findProjectFolder(accessToken, kind, woonplaats, straatEnNummer);
  if (!huidig) return null;

  const root = huidig.path.slice(0, huidig.path.lastIndexOf("/"));

  const redis = getOptionalRedis();
  if (redis) {
    await redis.hset(STATUS_HASH, statusVeld(root, huidig.name), status).catch(() => {});
  }

  const kaal = stripStatusMarker(huidig.name);
  if (huidig.name === kaal) return huidig.path;
  return schoonMapNaamOp(accessToken, huidig.path, `${root}/${kaal}`);
}

/** Haalt een oud statusbolletje uit de mapnaam. Conflict (schone naam bestaat
    al, bv. het bekende duplicaat) is niet fataal: dan blijft het oude pad. */
async function schoonMapNaamOp(
  accessToken: string,
  vanPad: string,
  naarPad: string
): Promise<string> {
  const res = await fetch(`${DROPBOX_API_BASE}/files/move_v2`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from_path: vanPad, to_path: naarPad, autorename: false }),
  });
  if (res.ok) return naarPad;
  const body = await res.text().catch(() => "");
  if (res.status === 409 && body.includes("to/conflict")) return vanPad;
  throw new DropboxApiError(res.status, `Dropbox files/move_v2 failed: ${res.status} ${body}`);
}

/** Alle vastgelegde statussen, veld = kaal pad in kleine letters. */
export async function getFolderStatuses(): Promise<Record<string, string>> {
  const redis = getOptionalRedis();
  if (!redis) return {};
  return (await redis.hgetall(STATUS_HASH).catch(() => ({}))) as Record<string, string>;
}

/**
 * Eenmalige opruimronde: haalt de bolletjes uit alle projectmapnamen van een
 * hoofdmap, en bewaart de status die erin zat eerst in Redis zodat er niets
 * verloren gaat. Geeft terug wat er hernoemd is en wat niet kon.
 */
export async function verwijderStatusMarkers(
  accessToken: string,
  root: string
): Promise<{ hernoemd: string[]; overgeslagen: string[] }> {
  const redis = getOptionalRedis();
  const hernoemd: string[] = [];
  const overgeslagen: string[] = [];

  let cursor: string | null = null;
  for (;;) {
    const res: Response = await fetch(
      `${DROPBOX_API_BASE}/files/list_folder${cursor ? "/continue" : ""}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(cursor ? { cursor } : { path: root, recursive: false }),
      }
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      if (res.status === 409 && body.includes("path/not_found")) break;
      throw new DropboxApiError(res.status, `Dropbox list_folder failed: ${res.status} ${body}`);
    }
    const data = (await res.json()) as {
      entries: { ".tag": string; name: string; path_display?: string }[];
      cursor: string;
      has_more: boolean;
    };

    for (const entry of data.entries) {
      if (entry[".tag"] !== "folder") continue;
      const status = statusFromName(entry.name);
      if (!status) continue;

      if (redis) {
        await redis.hset(STATUS_HASH, statusVeld(root, entry.name), status).catch(() => {});
      }
      const vanPad = entry.path_display ?? `${root}/${entry.name}`;
      const naarPad = `${root}/${stripStatusMarker(entry.name)}`;
      const uitkomst = await schoonMapNaamOp(accessToken, vanPad, naarPad).catch(() => vanPad);
      if (uitkomst === naarPad) hernoemd.push(entry.name);
      else overgeslagen.push(entry.name);
    }

    if (!data.has_more) break;
    cursor = data.cursor;
  }

  return { hernoemd, overgeslagen };
}


export interface ProjectMapDetail {
  /** Mapnaam, bv. "Damrak 1, Amsterdam". */
  name: string;
  /** Volledig pad. Nodig sinds afgerond werk in het archief kan staan: de naam
      alleen zegt dan niet meer waar de map ligt, en een deel-link maken op
      hoofdmap + naam wijst naar een plek die niet bestaat. */
  pad: string;
  /** Aantal bestanden in de hele projectmap. */
  files: number;
  /** Per directe submap het aantal bestanden erin (submappen meegerekend).
      Bestanden los in de projectmap staan onder "". */
  perSubmap: Record<string, number>;
}

/**
 * Zelfde recursieve listing als summarizeProjectFolders, maar dan met de
 * verdeling over de submappen erbij.
 *
 * Dat verschil is het hele punt voor het control center: "31 bestanden" zegt
 * niet of de plattegronden erbij zitten. Met de verdeling per submap kun je
 * zeggen dat vier van de vijf verwachte mappen gevuld zijn — een uitspraak die
 * ergens op slaat.
 *
 * Kost niets extra: de listing haalt de paden toch al op, ze werden alleen
 * weggegooid.
 */
export async function detailProjectFolders(
  accessToken: string,
  root: string
): Promise<{ folders: ProjectMapDetail[]; volledig: boolean }> {
  // 20 pagina's was genoeg toen de hoofdmap tientallen projecten telde; met
  // het volledige archief erin (450+ projectmappen, elk met vaste indeling)
  // werd de listing halverwege afgekapt — en een afgekapte scan zegt dan
  // "deze map is leeg" over mappen die vol staan. De grens blijft bestaan als
  // noodrem, maar ruim boven wat er werkelijk staat.
  const MAX_PAGINAS = 200;
  const prefix = `${root.toLowerCase()}/`;
  const perMap = new Map<string, ProjectMapDetail>();
  let cursor: string | null = null;
  let volledig = false;

  for (let pagina = 0; pagina < MAX_PAGINAS; pagina++) {
    const res: Response = await fetch(
      `${DROPBOX_API_BASE}/files/list_folder${cursor ? "/continue" : ""}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(cursor ? { cursor } : { path: root, recursive: true }),
      }
    );

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      if (res.status === 409 && body.includes("path/not_found")) {
        return { folders: [], volledig: true };
      }
      throw new Error(`Dropbox listing mislukt (${res.status})`);
    }

    const data = (await res.json()) as {
      entries: { ".tag": string; name: string; path_lower?: string; path_display?: string }[];
      has_more: boolean;
      cursor: string;
    };

    for (const entry of data.entries) {
      const lower = entry.path_lower ?? "";
      if (!lower.startsWith(prefix)) continue;
      const delen = projectDelen(lower.slice(prefix.length).split("/"));
      if (!delen) continue;
      const projectSleutel = delen.sleutel;

      if (!perMap.has(projectSleutel)) {
        const weergave = (entry.path_display ?? entry.name).split("/").filter(Boolean);
        // Alles tot en met de projectmap zelf; wat erbinnen zit valt eraf.
        const tot = weergave.length - delen.binnen.length;
        perMap.set(projectSleutel, {
          name: weergave[tot - 1] ?? projectSleutel,
          pad: `/${weergave.slice(0, tot).join("/")}`,
          files: 0,
          perSubmap: {},
        });
      }
      const project = perMap.get(projectSleutel)!;

      if (entry[".tag"] !== "file") continue;
      project.files++;
      // binnen = [...submappen, bestandsnaam]; de eerste submap telt.
      const submap = delen.binnen.length > 1 ? delen.binnen[0] : "";
      project.perSubmap[submap] = (project.perSubmap[submap] ?? 0) + 1;
    }

    if (!data.has_more) {
      volledig = true;
      break;
    }
    cursor = data.cursor;
  }

  return { folders: [...perMap.values()], volledig };
}


/**
 * Verplaatst of hernoemt één bestand of map. Bestaat het doel al, dan faalt de
 * aanroep in plaats van stilletjes een "(1)"-kopie te maken — dat gedrag heeft
 * ons eerder duplicaten opgeleverd.
 */
export async function verplaats(accessToken: string, van: string, naar: string): Promise<void> {
  const res = await fetch(`${DROPBOX_API_BASE}/files/move_v2`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from_path: van, to_path: naar, autorename: false }),
  });
  if (res.ok) return;
  const body = await res.text().catch(() => "");
  throw new DropboxApiError(res.status, `Dropbox files/move_v2 failed: ${res.status} ${body}`);
}

export interface ArchiveerUitkomst {
  archief: string;
  verplaatst: string[];
  overgeslagen: { pad: string; reden: string }[];
  mislukt: { pad: string; reden: string }[];
}

/**
 * Zet afgeronde projectmappen in de archiefmap onder dezelfde hoofdmap.
 *
 * Waarom dit bestaat: "Automatie Energielabels" hoort te laten zien waar nog
 * aan gewerkt wordt. Met een paar honderd afgeronde adressen ertussen is dat
 * niet meer te lezen, en dan gaat iemand handmatig slepen — precies de rommel
 * die de automatisering moest voorkomen.
 *
 * Verplaatsen is veilig voor de deel-links in ClickUp: Dropbox hangt zo'n link
 * aan de map zelf en niet aan het pad. En de app blijft de map vinden, want
 * findProjectFolder kijkt ook in het archief.
 *
 * Alleen mappen die er echt staan, direct onder de hoofdmap. Een pad uit een
 * verouderde kopie van de mappenlijst wordt overgeslagen en niet gegokt.
 */
export async function archiveerProjectmappen(
  accessToken: string,
  root: string,
  paden: string[],
  opties: { droog?: boolean } = {}
): Promise<ArchiveerUitkomst> {
  const archief = `${root}/${ARCHIEF_MAP}`;
  const overgeslagen: { pad: string; reden: string }[] = [];
  const mislukt: { pad: string; reden: string }[] = [];

  // De echte mappen ophalen: de naam in Dropbox is leidend, niet het pad dat de
  // aanroeper meestuurt. Scheelt gedoe met hoofdletters en oude statusbolletjes.
  const bestaand = new Map<string, string>();
  let cursor: string | null = null;
  for (;;) {
    const res: Response = await fetch(
      `${DROPBOX_API_BASE}/files/list_folder${cursor ? "/continue" : ""}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(cursor ? { cursor } : { path: root, recursive: false }),
      }
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new DropboxApiError(res.status, `Dropbox list_folder failed: ${res.status} ${body}`);
    }
    const data = (await res.json()) as {
      entries: { ".tag": string; name: string; path_display?: string; path_lower?: string }[];
      cursor: string;
      has_more: boolean;
    };
    for (const entry of data.entries) {
      if (entry[".tag"] !== "folder") continue;
      if (entry.name.toLowerCase() === ARCHIEF_MAP.toLowerCase()) continue;
      bestaand.set(
        (entry.path_lower ?? `${root}/${entry.name}`.toLowerCase()),
        entry.path_display ?? `${root}/${entry.name}`
      );
    }
    if (!data.has_more) break;
    cursor = data.cursor;
  }

  const teVerplaatsen: { van: string; naar: string }[] = [];
  for (const pad of paden) {
    const echt = bestaand.get(pad.toLowerCase());
    if (!echt) {
      overgeslagen.push({ pad, reden: "staat niet (meer) direct onder de hoofdmap" });
      continue;
    }
    const naam = echt.slice(echt.lastIndexOf("/") + 1);
    teVerplaatsen.push({ van: echt, naar: `${archief}/${naam}` });
  }

  if (opties.droog || teVerplaatsen.length === 0) {
    return { archief, verplaatst: teVerplaatsen.map((t) => t.van), overgeslagen, mislukt };
  }

  await createFolder(accessToken, archief);

  /* In batches naar Dropbox: honderd losse move-aanroepen lopen tegen
     "too_many_write_operations" aan, en dan is de helft verplaatst. */
  const verplaatst: string[] = [];
  const GROOTTE = 100;
  for (let i = 0; i < teVerplaatsen.length; i += GROOTTE) {
    const groep = teVerplaatsen.slice(i, i + GROOTTE);
    const start = await fetch(`${DROPBOX_API_BASE}/files/move_batch_v2`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        entries: groep.map((t) => ({ from_path: t.van, to_path: t.naar })),
        autorename: false,
      }),
    });
    if (!start.ok) {
      const body = await start.text().catch(() => "");
      throw new DropboxApiError(start.status, `Dropbox move_batch_v2 failed: ${start.status} ${body}`);
    }

    let uitkomst = (await start.json()) as {
      ".tag": string;
      async_job_id?: string;
      entries?: { ".tag": string; failure?: unknown }[];
    };

    // Dropbox doet dit asynchroon zodra het er meer dan een handvol zijn.
    for (let poging = 0; uitkomst[".tag"] === "async_job_id" && poging < 120; poging++) {
      await new Promise((r) => setTimeout(r, 1000));
      const check = await fetch(`${DROPBOX_API_BASE}/files/move_batch/check_v2`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ async_job_id: uitkomst.async_job_id }),
      });
      if (!check.ok) {
        const body = await check.text().catch(() => "");
        throw new DropboxApiError(check.status, `Dropbox move_batch/check_v2 failed: ${check.status} ${body}`);
      }
      uitkomst = (await check.json()) as typeof uitkomst;
    }

    if (uitkomst[".tag"] !== "complete" || !uitkomst.entries) {
      throw new DropboxApiError(0, `Dropbox verplaatste de mappen niet af (${uitkomst[".tag"]})`);
    }

    uitkomst.entries.forEach((regel, k) => {
      if (regel[".tag"] === "success") verplaatst.push(groep[k].van);
      else mislukt.push({ pad: groep[k].van, reden: JSON.stringify(regel.failure ?? regel).slice(0, 200) });
    });
  }

  return { archief, verplaatst, overgeslagen, mislukt };
}
