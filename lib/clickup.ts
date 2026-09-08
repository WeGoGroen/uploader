import { getOptionalRedis, requireRedis } from "@/lib/redis";

const CLICKUP_API_BASE = "https://api.clickup.com/api/v2";

export interface ClickUpTeam {
  id: string;
  name: string;
}

export interface ClickUpSpace {
  id: string;
  name: string;
}

export interface ClickUpFolder {
  id: string;
  name: string;
}

export interface ClickUpList {
  id: string;
  name: string;
}

export interface ClickUpFieldOption {
  id: string;
  name: string;
}

export interface ClickUpCustomField {
  id: string;
  name: string;
  type: string;
  required: boolean;
  options: ClickUpFieldOption[];
}

export interface ClickUpMember {
  id: number;
  name: string;
  email: string;
}

/**
 * Welke uploadstromen iemand mag gebruiken. Ontbreekt dit veld, dan mag alles
 * — bestaande accounts stonden er niet mee ingesteld en die mogen niet
 * plotseling buitengesloten worden door een uitrol.
 */
export interface UploadRechten {
  energielabel: boolean;
  nen: boolean;
  media: boolean;
}

export const ALLE_RECHTEN: UploadRechten = { energielabel: true, nen: true, media: true };

export function rechtenVan(account: Pick<ClickUpAccount, "rechten"> | null | undefined): UploadRechten {
  return { ...ALLE_RECHTEN, ...(account?.rechten ?? {}) };
}

export interface ClickUpAccount {
  name: string;
  token: string;
  avatar?: string;
  /** Zie UploadRechten. Afwezig = alles toegestaan. */
  rechten?: Partial<UploadRechten>;
  /**
   * Waar meldingen over eigen opnames heen gaan. Los van ClickUp bijgehouden:
   * wie alleen NEN2580 of media uploadt hoeft geen ClickUp-lid te zijn, en
   * dan is er via ClickUp geen adres te vinden.
   */
  email?: string;
  /** Beheerders mogen accounts en koppelingen beheren. Afwezig = medewerker. */
  rol?: "medewerker" | "beheerder";
  /**
   * De persoonlijke inlogcode, gehasht. Afwezig betekent: nog de startcode
   * 0000 — zo hoeft er niets gemigreerd te worden en kan iedereen meteen naar
   * binnen op de code die hij toch al kreeg.
   */
  codeHash?: string;
  codeSalt?: string;
}

const EXTRA_ACCOUNTS_KEY = "clickup:accounts:extra";

function envAccounts(): ClickUpAccount[] {
  const raw = process.env.CLICKUP_ACCOUNTS;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as ClickUpAccount[];
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch {
      // val terug op CLICKUP_TOKEN hieronder als de JSON niet klopt
    }
  }
  if (process.env.CLICKUP_TOKEN) {
    return [{ name: "Floris de Laat", token: process.env.CLICKUP_TOKEN }];
  }
  return [];
}

/**
 * Accounts die via de app zelf zijn toegevoegd (in plaats van via de
 * CLICKUP_ACCOUNTS env var) staan in Redis, zodat een nieuw teamlid niet op
 * een herdeploy hoeft te wachten. Zonder gekoppelde Redis-store blijft dit
 * gewoon leeg — CLICKUP_ACCOUNTS/CLICKUP_TOKEN werken dan als vanouds.
 */
async function extraAccounts(): Promise<ClickUpAccount[]> {
  const redis = getOptionalRedis();
  if (!redis) return [];
  /*
    Een hapering hier mag niemand buitensluiten.

    Sinds iedereen met zijn eigen naam inlogt, is deze lijst het inlogscherm:
    gooit hij, dan is er geen enkel account om uit te kiezen en komt niemand de
    app meer in — ook de eigenaar niet. Bij een storing valt de app daarom
    terug op wat er in de omgeving staat (CLICKUP_ACCOUNTS/CLICKUP_TOKEN), en
    meldt de ochtendcontrole dat er accounts missen.
  */
  try {
    const raw = await redis.get(EXTRA_ACCOUNTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ClickUpAccount[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Meerdere teamleden kunnen ieder hun eigen ClickUp-token gebruiken, zodat
 * taken op naam van de juiste persoon worden aangemaakt. Configuratie via
 * CLICKUP_ACCOUNTS (JSON: [{"name":"Floris","token":"pk_..."}, ...]) en/of
 * accounts die via de app zelf zijn toegevoegd (opgeslagen in Redis).
 * Zonder configuratie valt de app terug op het enkele CLICKUP_TOKEN, zodat
 * bestaande installaties gewoon blijven werken.
 */
export async function getClickUpAccounts(): Promise<ClickUpAccount[]> {
  const fromEnv = envAccounts();
  const fromRedis = await extraAccounts();
  const byName = new Map<string, ClickUpAccount>();
  for (const a of [...fromEnv, ...fromRedis]) byName.set(a.name, a);

  // Voor accounts die uit de omgeving komen wint het omgevings-token, ook als
  // Redis hetzelfde account kent. De env-token is wat er bij een rotatie in
  // Vercel wordt vervangen; een oude kopie in Redis mag hem niet blijven
  // overschaduwen — precies dat hield op 31-08 de hele ClickUp-koppeling op
  // een ingetrokken token, dwars door elke redeploy heen. Avatar en mailadres
  // uit Redis blijven wel gelden; alleen het token is heilig.
  for (const env of fromEnv) {
    const samengevoegd = byName.get(env.name);
    if (samengevoegd && env.token && samengevoegd.token !== env.token) {
      byName.set(env.name, { ...samengevoegd, token: env.token });
    }
  }
  return [...byName.values()];
}

/**
 * Voegt een nieuw account toe (of overschrijft een bestaand account met
 * dezelfde naam) in Redis. De caller is verantwoordelijk voor het valideren
 * van het token bij ClickUp vóórdat dit wordt aangeroepen.
 */
export async function addClickUpAccount(account: ClickUpAccount): Promise<void> {
  const redis = requireRedis();
  const current = await extraAccounts();
  const next = [...current.filter((a) => a.name !== account.name), account];
  await redis.set(EXTRA_ACCOUNTS_KEY, JSON.stringify(next));
}

/**
 * Werkt een deel van een account bij (bv. alleen de avatar, of alleen het
 * token) zonder de rest te verliezen. Een account dat alleen via
 * CLICKUP_ACCOUNTS bestaat, krijgt zo een Redis-override met dezelfde naam —
 * getClickUpAccounts() laat die override altijd winnen van de env-versie.
 */
export async function patchClickUpAccount(patch: {
  name: string;
  token?: string;
  avatar?: string | null;
  email?: string | null;
  rechten?: Partial<UploadRechten>;
  rol?: "medewerker" | "beheerder";
  codeHash?: string;
  codeSalt?: string;
}): Promise<void> {
  const current = await getClickUpAccounts();
  const existing = current.find((a) => a.name === patch.name);
  // Zonder token kan iemand geen ClickUp-taak aanmaken en dus geen
  // energielabel doen. Voor NEN2580 en media is dat niet nodig, dus een
  // account mag bestaan met een leeg token — het recht op energielabel wordt
  // dan geweigerd in plaats van de hele uitnodiging.
  const token = patch.token ?? existing?.token ?? "";
  await addClickUpAccount({
    name: patch.name,
    token,
    avatar: patch.avatar === null ? undefined : patch.avatar ?? existing?.avatar,
    email: patch.email === null ? undefined : patch.email ?? existing?.email,
    rechten: patch.rechten ?? existing?.rechten,
    rol: patch.rol ?? existing?.rol,
    codeHash: patch.codeHash ?? existing?.codeHash,
    codeSalt: patch.codeSalt ?? existing?.codeSalt,
  });
}

/**
 * Leest het ClickUp-token en List-id op basis van de gekozen account (of de
 * eerste beschikbare als er geen keuze is doorgegeven). Gooit een duidelijke
 * fout i.p.v. stil te falen, zodat een ontbrekende configuratie niet als een
 * lege lijst of een 401 verderop in de keten opduikt.
 */
export async function requireClickUpConfig(
  accountName?: string | null
): Promise<{ token: string; listId: string; accountName: string }> {
  const listId = process.env.CLICKUP_LIST_ID;
  if (!listId) {
    throw new Error("CLICKUP_LIST_ID is niet ingesteld in .env.local");
  }
  const accounts = await getClickUpAccounts();
  if (accounts.length === 0) {
    throw new Error("CLICKUP_TOKEN of CLICKUP_ACCOUNTS is niet ingesteld in .env.local");
  }
  const chosen = (accountName && accounts.find((a) => a.name === accountName)) || accounts[0];
  if (!chosen.token) {
    // Uitgenodigd voor NEN2580/media, maar nog geen eigen ClickUp-token
    // geplakt. Beter een zin die zegt wat er moet gebeuren dan een 401 verderop.
    throw new Error(
      `${chosen.name} heeft nog geen persoonlijk ClickUp-token. Toe te voegen via Gebruikers in deze app.`
    );
  }
  return { token: chosen.token, listId, accountName: chosen.name };
}

class ClickUpApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
    this.name = "ClickUpApiError";
  }
}

async function clickupFetch<T>(
  accessToken: string,
  path: string,
  init?: RequestInit
): Promise<T> {
  const res = await fetch(`${CLICKUP_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: accessToken,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ClickUpApiError(
      res.status,
      `ClickUp API ${path} failed: ${res.status} ${body}`
    );
  }

  return res.json() as Promise<T>;
}

export async function exchangeCodeForToken(
  clientId: string,
  clientSecret: string,
  code: string
): Promise<string> {
  const res = await fetch(`${CLICKUP_API_BASE}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ClickUpApiError(
      res.status,
      `ClickUp token exchange failed: ${res.status} ${body}`
    );
  }

  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

export async function getAuthorizedUser(
  accessToken: string
): Promise<{ id: number; username: string }> {
  const data = await clickupFetch<{ user: { id: number; username: string } }>(
    accessToken,
    "/user"
  );
  return data.user;
}

export async function getTeams(accessToken: string): Promise<ClickUpTeam[]> {
  const data = await clickupFetch<{ teams: ClickUpTeam[] }>(
    accessToken,
    "/team"
  );
  return data.teams;
}

export async function getSpaces(
  accessToken: string,
  teamId: string
): Promise<ClickUpSpace[]> {
  const data = await clickupFetch<{ spaces: ClickUpSpace[] }>(
    accessToken,
    `/team/${teamId}/space?archived=false`
  );
  return data.spaces;
}

export async function getFolders(
  accessToken: string,
  spaceId: string
): Promise<ClickUpFolder[]> {
  const data = await clickupFetch<{ folders: ClickUpFolder[] }>(
    accessToken,
    `/space/${spaceId}/folder?archived=false`
  );
  return data.folders;
}

export async function getFolderlessLists(
  accessToken: string,
  spaceId: string
): Promise<ClickUpList[]> {
  const data = await clickupFetch<{ lists: ClickUpList[] }>(
    accessToken,
    `/space/${spaceId}/list?archived=false`
  );
  return data.lists;
}

export async function getFolderLists(
  accessToken: string,
  folderId: string
): Promise<ClickUpList[]> {
  const data = await clickupFetch<{ lists: ClickUpList[] }>(
    accessToken,
    `/folder/${folderId}/list?archived=false`
  );
  return data.lists;
}

/**
 * Haalt de (meest recente) taaknamen uit de lijst op — gebruikt om per
 * adres real-time te checken of er al een taak bestaat, i.p.v. te
 * vertrouwen op onze eigen concept-administratie (die kan achterlopen als
 * het opslaan van het concept-record faalde, ook al is de taak wél echt
 * aangemaakt in ClickUp). Niet uitputtend (ClickUp geeft max. 100 taken per
 * pagina) — voor "is dit adres vandaag al gedaan" is dat ruim voldoende.
 */
/**
 * Taaknamen uit de lijst, gebruikt om te zien of een adres al gedaan is.
 *
 * Bewust gepagineerd: ClickUp geeft standaard 100 taken per pagina terug. Bij
 * 1000 opnames per maand is een adres van drie dagen geleden al van pagina 1
 * af, en dan zou de app "nog niet gedaan" zeggen terwijl het wél gedaan is —
 * geen foutmelding, gewoon dubbel werk. Vijf pagina's dekt bij dat volume
 * ruim twee weken.
 */
export async function getRecentTaskNames(
  accessToken: string,
  listId: string,
  maxPaginas = 5
): Promise<string[]> {
  const namen: string[] = [];
  for (let pagina = 0; pagina < maxPaginas; pagina++) {
    const data = await clickupFetch<{ tasks: { name: string }[]; last_page?: boolean }>(
      accessToken,
      `/list/${listId}/task?archived=false&order_by=created&reverse=true&subtasks=false&page=${pagina}`
    );
    namen.push(...data.tasks.map((t) => t.name));
    // ClickUp meldt zelf wanneer het op is; anders stoppen bij een halve pagina.
    if (data.last_page || data.tasks.length === 0) break;
  }
  return namen;
}

interface RawClickUpField {
  id: string;
  name: string;
  type: string;
  required?: boolean;
  type_config?: {
    options?: { id: string; name?: string; label?: string }[];
  };
}

export async function getListCustomFields(
  accessToken: string,
  listId: string
): Promise<ClickUpCustomField[]> {
  const data = await clickupFetch<{ fields: RawClickUpField[] }>(
    accessToken,
    `/list/${listId}/field`
  );
  // "labels"-velden gebruiken `label` i.p.v. `name` voor de optietekst.
  return data.fields.map((f) => ({
    id: f.id,
    name: f.name,
    type: f.type,
    required: f.required ?? false,
    options: (f.type_config?.options ?? []).map((o) => ({
      id: o.id,
      name: o.name ?? o.label ?? "",
    })),
  }));
}

export async function getListMembers(
  accessToken: string,
  listId: string
): Promise<ClickUpMember[]> {
  const data = await clickupFetch<{
    members: { id: number; username: string; email: string }[];
  }>(accessToken, `/list/${listId}/member`);
  return data.members.map((m) => ({ id: m.id, name: m.username, email: m.email }));
}

export async function getListStatuses(
  accessToken: string,
  listId: string
): Promise<string[]> {
  const data = await clickupFetch<{ statuses: { status: string }[] }>(
    accessToken,
    `/list/${listId}`
  );
  return (data.statuses ?? []).map((s) => s.status);
}

export interface CreateTaskInput {
  name: string;
  customFields: { id: string; value: string | number | boolean | string[] }[];
  markdownDescription?: string;
  assignees?: number[];
  /** ClickUp-schaal: 1 Dringend, 2 Hoog, 3 Normaal, 4 Laag, null = geen. */
  priority?: number | null;
  status?: string;
  /** Epoch-milliseconden. */
  dueDate?: number | null;
}

export async function createTask(
  accessToken: string,
  listId: string,
  input: CreateTaskInput
): Promise<{ id: string; url: string }> {
  const data = await clickupFetch<{ id: string; url: string }>(
    accessToken,
    `/list/${listId}/task`,
    {
      method: "POST",
      body: JSON.stringify({
        name: input.name,
        custom_fields: input.customFields,
        ...(input.markdownDescription
          ? { markdown_description: input.markdownDescription }
          : {}),
        ...(input.assignees?.length ? { assignees: input.assignees } : {}),
        ...(input.priority ? { priority: input.priority } : {}),
        ...(input.status ? { status: input.status } : {}),
        ...(input.dueDate ? { due_date: input.dueDate, due_date_time: false } : {}),
      }),
    }
  );
  return data;
}

/**
 * Upload naar een attachment-custom-field verloopt niet via het gewone
 * /task/-pad maar via de losstaande V3 attachments-API: het bestand komt
 * eerst op de "custom_fields"-entiteit terecht, en die attachment-id wordt
 * daarna in het veld gezet via setAttachmentFieldValue.
 */
export async function uploadCustomFieldAttachment(
  accessToken: string,
  teamId: string,
  fieldId: string,
  filename: string,
  file: Blob
): Promise<{ id: string }> {
  // ClickUp weigert bestandsnamen die niet met een letter/cijfer beginnen
  // ("Filename must start with a letter or number") — sommige export-tools
  // zetten er een underscore of punt voor, dus die strippen we hier weg.
  const safeFilename = filename.replace(/^[^A-Za-z0-9]+/, "") || `bestand-${filename}`;

  const form = new FormData();
  form.append("attachment", file, safeFilename);
  form.append("filename", safeFilename);

  const res = await fetch(
    `https://api.clickup.com/api/v3/workspaces/${teamId}/custom_fields/${fieldId}/attachments`,
    {
      method: "POST",
      headers: { Authorization: accessToken },
      body: form,
    }
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ClickUpApiError(res.status, `ClickUp custom field attachment upload failed: ${res.status} ${body}`);
  }
  return res.json() as Promise<{ id: string }>;
}

/** Koppelt eerder geüploade attachment-id's aan een attachment-custom-field op een taak. */
export async function setAttachmentFieldValue(
  accessToken: string,
  taskId: string,
  fieldId: string,
  attachmentIds: string[]
): Promise<void> {
  await clickupFetch(accessToken, `/task/${taskId}/field/${fieldId}`, {
    method: "POST",
    body: JSON.stringify({ value: { add: attachmentIds } }),
  });
}

export interface ClickUpTask {
  id: string;
  name: string;
  status: string;
  url: string;
  /** Ruwe custom fields; het adres staat in "A1 Adres:", niet in de naam. */
  customFields: { name: string; value: unknown }[];
}

/** Eén taak ophalen — gebruikt door de webhook, die alleen een task_id krijgt. */
/**
 * De workspace waar een taak in zit.
 *
 * Nodig voor de V3-attachments-API, die per workspace werkt. Vragen aan de
 * taak zelf en niet aan het token: `getTeams()` geeft alle workspaces waar
 * iemand lid van is, en de eerste daarvan hoeft de onze niet te zijn. Zit een
 * medewerker ook in een andere workspace, dan ging het bestand naar een
 * workspace waar dat veld niet bestaat — en dat antwoordt ClickUp met
 * "404 Not Found or Authorized", precies de fout die de bijlages liet stranden
 * terwijl de taak zelf gewoon werd aangemaakt.
 */
export async function getTaskTeamId(accessToken: string, taskId: string): Promise<string | null> {
  const data = await clickupFetch<{ team_id?: string }>(accessToken, `/task/${taskId}`);
  return data.team_id ? String(data.team_id) : null;
}

export async function getTask(accessToken: string, taskId: string): Promise<ClickUpTask> {
  const data = await clickupFetch<{
    id: string;
    name: string;
    status?: { status: string };
    url: string;
    custom_fields?: { name: string; value?: unknown }[];
  }>(accessToken, `/task/${taskId}`);
  return {
    id: data.id,
    name: data.name,
    status: data.status?.status ?? "",
    url: data.url,
    customFields: (data.custom_fields ?? []).map((f) => ({ name: f.name, value: f.value })),
  };
}

/**
 * Zet een opmerking op de taak. De automatische SharePoint-ophaalactie
 * gebeurt buiten beeld; zonder zo'n regel in de taak zou niemand kunnen zien
 * of het gelukt is, of waarom niet.
 */
export async function createTaskComment(
  accessToken: string,
  taskId: string,
  text: string
): Promise<void> {
  await clickupFetch(accessToken, `/task/${taskId}/comment`, {
    method: "POST",
    body: JSON.stringify({ comment_text: text, notify_all: false }),
  });
}
