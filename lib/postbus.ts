import { getOptionalRedis } from "@/lib/redis";
import {
  GoogleInvalidGrantError,
  getCurrentAccount,
  refreshAccessToken,
} from "@/lib/google-calendar";

/**
 * De postbus: het Google-account waar de mail van RVO binnenkomt.
 *
 * Wij zijn certificaathouder, dus het afschrift van elk energielabel dat wij
 * registreren wordt gemaild naar info@. Met deze koppeling kan het control
 * center die mails langslopen en de PDF in de projectmap zetten, zonder dat
 * iemand de mail openmaakt.
 *
 * Eén koppeling voor het hele bedrijf, en dat is het verschil met de
 * agenda-koppeling ernaast: die is per teamlid, want iedereen ziet zijn eigen
 * afspraken. Een postbus heeft niemand persoonlijk — hij hoort bij het bedrijf,
 * en dus bij één gedeelde sleutel.
 *
 * Alleen lezen, en alleen binnen deze app: het token staat in de Redis van de
 * uploader, net als de agenda-tokens en om dezelfde reden (zie
 * lib/google-calendar.ts). Het control center krijgt nooit een token te zien,
 * alleen antwoorden.
 */

const REFRESH_SLEUTEL = "google:postbus:refresh_token";
const ADRES_SLEUTEL = "google:postbus:adres";

/**
 * Lezen en verder niets.
 *
 * gmail.readonly is de smalste scope waarmee je een bijlage kunt ophalen —
 * gmail.metadata geeft alleen kopregels. Versturen, verwijderen en labels
 * wijzigen zit er bewust niet bij: deze koppeling hoort niets te veranderen aan
 * een postbus waar ook gewone klantenmail in valt.
 */
export const POSTBUS_SCOPE =
  "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/userinfo.email";

/** De afzender van het afschrift. Alles daarbuiten kijken we niet in. */
export const RVO_AFZENDER = "noreply_eponline@rvo.nl";

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

export interface PostbusStand {
  gekoppeld: boolean;
  adres: string | null;
}

export async function bewaarPostbus(refreshToken: string, adres: string): Promise<void> {
  const redis = getOptionalRedis();
  if (!redis) throw new Error("Geen Redis gekoppeld — het token kan niet bewaard worden");
  await redis.set(REFRESH_SLEUTEL, refreshToken);
  await redis.set(ADRES_SLEUTEL, adres);
}

export async function postbusStand(): Promise<PostbusStand> {
  const redis = getOptionalRedis();
  if (!redis) return { gekoppeld: false, adres: null };
  const [token, adres] = await Promise.all([redis.get(REFRESH_SLEUTEL), redis.get(ADRES_SLEUTEL)]);
  return { gekoppeld: Boolean(token), adres: adres ?? null };
}

async function vergeetPostbus(): Promise<void> {
  const redis = getOptionalRedis();
  if (!redis) return;
  await redis.del(REFRESH_SLEUTEL).catch(() => {});
}

/**
 * Een vers toegangstoken. Weigert Google de koppeling definitief, dan wordt hij
 * opgeruimd: dan is opnieuw inloggen het enige wat helpt, en een koppeling die
 * "bestaat maar niet werkt" is erger dan een die zichtbaar weg is.
 */
async function toegangsToken(): Promise<string> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET zijn niet ingesteld");
  }
  const redis = getOptionalRedis();
  const refreshToken = redis ? await redis.get(REFRESH_SLEUTEL) : null;
  if (!refreshToken) {
    throw new Error("De postbus is nog niet gekoppeld — log in met het account waar de RVO-mail binnenkomt");
  }
  try {
    return await refreshAccessToken(clientId, clientSecret, refreshToken);
  } catch (err) {
    if (err instanceof GoogleInvalidGrantError) await vergeetPostbus();
    throw err;
  }
}

export interface PostbusBijlage {
  id: string;
  filename: string;
}

export interface PostbusMail {
  id: string;
  ontvangen_op: string;
  afzender: string | null;
  onderwerp: string | null;
  bijlagen: PostbusBijlage[];
}

async function gmail<T>(pad: string, token: string): Promise<T> {
  const res = await fetch(`${GMAIL}${pad}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const tekst = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`Gmail gaf ${res.status} op ${pad.split("?")[0]}: ${tekst}`);
  }
  return (await res.json()) as T;
}

export interface Onderdeel {
  filename?: string;
  mimeType?: string;
  body?: { attachmentId?: string };
  parts?: Onderdeel[];
}

/**
 * De PDF-bijlagen uit de opbouw van een mail.
 *
 * Recursief, want de bijlage zit soms een laag dieper: een mail met tekst,
 * opmaak én een bijlage is multipart-in-multipart, en dan hangt de PDF niet aan
 * de buitenste laag. Alleen op het eerste niveau kijken levert bij zo'n mail
 * "geen bijlage gevonden" op — een stilte die je pas opvalt als iemand het
 * afschrift mist.
 */
export function pdfBijlagen(deel: Onderdeel | undefined): PostbusBijlage[] {
  if (!deel) return [];
  const eigen =
    deel.filename && /\.pdf$/i.test(deel.filename) && deel.body?.attachmentId
      ? [{ id: deel.body.attachmentId, filename: deel.filename }]
      : [];
  return [...eigen, ...(deel.parts ?? []).flatMap(pdfBijlagen)];
}

/**
 * De mails van RVO met een afschrift erin, nieuwste eerst.
 *
 * `bekend` is de lijst met mails die het control center al heeft; die worden
 * overgeslagen vóórdat de inhoud opgehaald wordt. Zonder dat zou elke ronde
 * dezelfde vijftig mails opnieuw uitlezen — en dat is de manier waarop je
 * zonder reden tegen de limieten van Gmail aanloopt.
 */
export async function zoekAfschriftMails(opties: {
  bekend?: string[];
  max?: number;
}): Promise<PostbusMail[]> {
  const token = await toegangsToken();
  const bekend = new Set(opties.bekend ?? []);
  const max = Math.min(Math.max(opties.max ?? 10, 1), 25);

  // Een jaar terug: genoeg voor een inhaalslag, en het houdt de lijst eindig.
  const vraag = encodeURIComponent(`from:${RVO_AFZENDER} has:attachment newer_than:1y`);
  const lijst = await gmail<{ messages?: { id: string }[] }>(
    `/messages?q=${vraag}&maxResults=50`,
    token
  );

  const nieuw = (lijst.messages ?? []).map((m) => m.id).filter((id) => !bekend.has(id));

  const mails: PostbusMail[] = [];
  for (const id of nieuw.slice(0, max)) {
    const bericht = await gmail<{
      id: string;
      internalDate?: string;
      payload?: Onderdeel & { headers?: { name: string; value: string }[] };
    }>(`/messages/${id}?format=full`, token);

    const kop = (naam: string) =>
      bericht.payload?.headers?.find((h) => h.name.toLowerCase() === naam)?.value ?? null;

    const bijlagen = pdfBijlagen(bericht.payload);
    if (bijlagen.length === 0) continue;

    mails.push({
      id: bericht.id,
      ontvangen_op: new Date(Number(bericht.internalDate) || Date.now()).toISOString(),
      afzender: kop("from"),
      onderwerp: kop("subject"),
      bijlagen,
    });
  }
  return mails;
}

/**
 * Eén bijlage, als bytes.
 *
 * Gmail geeft geen downloadlink zoals Resend dat doet: de inhoud komt in het
 * antwoord mee, base64url gecodeerd. Een afschrift is een paar honderd
 * kilobyte, dus dat kan gewoon door.
 */
export async function haalGmailBijlage(
  messageId: string,
  bijlageId: string
): Promise<{ base64: string; grootte: number }> {
  const token = await toegangsToken();
  const antwoord = await gmail<{ size?: number; data?: string }>(
    `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(bijlageId)}`,
    token
  );
  if (!antwoord.data) throw new Error("Gmail gaf een bijlage zonder inhoud terug");
  // base64url → gewone base64, zodat de ontvanger hem zonder omweg kan lezen.
  const base64 = antwoord.data.replace(/-/g, "+").replace(/_/g, "/");
  return { base64, grootte: Number(antwoord.size) || 0 };
}

/** Het adres waar deze koppeling op uitkomt; voor de bevestiging na het inloggen. */
export async function leesAdresVan(accessToken: string): Promise<string> {
  const account = await getCurrentAccount(accessToken);
  return account.email;
}
