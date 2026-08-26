import { getOptionalRedis } from "@/lib/redis";

// Google Calendar-koppeling — in tegenstelling tot Dropbox/ClickUp is dit
// bewust PER TEAMLID: iedereen ziet zijn eigen agenda, dus iedereen logt
// zelf in met zijn eigen Google-account (gekoppeld aan de actieve
// ClickUp-account-naam op dit apparaat, net als bij het wisselen van
// ClickUp-gebruiker). Eén gedeeld token zou anders Yannicks apparaat
// Floris' agenda laten zien, en andersom.
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3";
const REFRESH_TOKEN_KEY_PREFIX = "google:refresh_token:";
// calendar.readonly alleen is niet genoeg voor de userinfo-check hieronder
// (getCurrentAccount) — die heeft een aparte profiel/e-mail-scope nodig,
// anders geeft Google daar een 401 op terug ondanks een geldig token.
const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/userinfo.email";

export interface GoogleTokens {
  accessToken: string;
  refreshToken: string | null;
}

export interface GoogleAccount {
  email: string;
  name: string;
}

export interface CalendarEvent {
  id: string;
  summary: string;
  description: string | null;
  location: string | null;
  start: string | null;
  end: string | null;
}

class GoogleApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
    this.name = "GoogleApiError";
  }
}

/**
 * De koppeling is er wel, maar Google accepteert de refresh token niet meer.
 * Apart type zodat de aanroeper de dode token kan opruimen en de UI om
 * opnieuw inloggen kan vragen i.p.v. een storing te melden.
 */
export class GoogleInvalidGrantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleInvalidGrantError";
  }
}

export function authScope(): string {
  return CALENDAR_SCOPE;
}

export async function exchangeCodeForTokens(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string
): Promise<GoogleTokens> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
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
    throw new GoogleApiError(res.status, `Google token exchange failed: ${res.status} ${body}`);
  }

  const data = (await res.json()) as { access_token: string; refresh_token?: string };
  return { accessToken: data.access_token, refreshToken: data.refresh_token ?? null };
}

export async function refreshAccessToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string
): Promise<string> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
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
    // invalid_grant = de refresh token is niet meer geldig: ingetrokken, het
    // wachtwoord is gewijzigd, of — de meest voorkomende oorzaak van "het
    // werkte vanmorgen nog" — de OAuth-consent nog op "Testing" staat, waar
    // Google refresh tokens na 7 dagen laat verlopen. Dat is geen storing die
    // zichzelf oplost, dus daar hoort een opnieuw-inloggen-melding bij i.p.v.
    // de ruwe Google-tekst.
    if (body.includes("invalid_grant")) {
      throw new GoogleInvalidGrantError(
        "De Google-koppeling is verlopen. Log opnieuw in met Google op de Koppelingen-pagina. " +
          "Blijft dit elke week gebeuren, zet dan de OAuth-consent van dit project in Google Cloud " +
          "op 'In productie' — bij 'Testing' verlopen de tokens na 7 dagen."
      );
    }
    throw new GoogleApiError(res.status, `Google token refresh failed: ${res.status} ${body}`);
  }

  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

/** Normaliseert de accountnaam zodat "Floris de Laat" en " floris de laat " dezelfde sleutel raken. */
function accountKey(accountName: string): string {
  return accountName.trim().toLowerCase();
}

export async function storeRefreshToken(accountName: string, refreshToken: string): Promise<void> {
  const redis = getOptionalRedis();
  if (!redis) return;
  await redis.set(`${REFRESH_TOKEN_KEY_PREFIX}${accountKey(accountName)}`, refreshToken);
}

async function storedRefreshToken(accountName: string): Promise<string | null> {
  const redis = getOptionalRedis();
  if (!redis) return null;
  return redis.get(`${REFRESH_TOKEN_KEY_PREFIX}${accountKey(accountName)}`);
}

export async function requireGoogleConfig(accountName: string | null): Promise<{
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET zijn niet ingesteld");
  }
  if (!accountName) {
    throw new Error("Geen actieve gebruiker bekend — kies eerst een account.");
  }
  const refreshToken = await storedRefreshToken(accountName);
  if (!refreshToken) {
    throw new Error(`Google Agenda is nog niet gekoppeld voor ${accountName}. Klik op 'Inloggen met Google' op de Koppelingen-pagina.`);
  }
  return { clientId, clientSecret, refreshToken };
}

export async function getAccessTokenForAccount(accountName: string | null): Promise<string> {
  const { clientId, clientSecret, refreshToken } = await requireGoogleConfig(accountName);
  try {
    return await refreshAccessToken(clientId, clientSecret, refreshToken);
  } catch (err) {
    // Een definitief geweigerde token blijft anders staan, en dan meldt de
    // statusbalk elke keer "HERSTELLEN" terwijl opnieuw inloggen het enige is
    // wat helpt. Weggooien maakt van de koppeling weer een "INLOGGEN".
    if (err instanceof GoogleInvalidGrantError && accountName) {
      await forgetRefreshToken(accountName);
    }
    throw err;
  }
}

async function forgetRefreshToken(accountName: string): Promise<void> {
  const redis = getOptionalRedis();
  if (!redis) return;
  await redis.del(`${REFRESH_TOKEN_KEY_PREFIX}${accountKey(accountName)}`).catch(() => {});
}

export async function getCurrentAccount(accessToken: string): Promise<GoogleAccount> {
  const res = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new GoogleApiError(res.status, `Google userinfo failed: ${res.status}`);
  }
  const data = (await res.json()) as { email: string; name: string };
  return { email: data.email, name: data.name };
}

/**
 * De tijdzone waarin "vandaag" wordt bepaald. Vercel draait in UTC, dus
 * `new Date(jaar, maand, dag)` gaf daar middernacht UTC = 01:00 of 02:00
 * Nederlandse tijd. Gevolg: een afspraak van 23:00 viel buiten het venster en
 * verscheen pas de volgende dag, en tussen middernacht en 02:00 keek de app
 * nog naar de dag ervoor. Daarom expliciet de Nederlandse dag.
 */
const TIMEZONE = "Europe/Amsterdam";

const TZ_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: TIMEZONE,
  hour12: false,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function zonedParts(date: Date): { y: number; m: number; d: number; h: number; mi: number; s: number } {
  const out: Record<string, number> = {};
  for (const p of TZ_PARTS.formatToParts(date)) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  // Middernacht komt uit Intl als hour 24, niet 0.
  return { y: out.year, m: out.month, d: out.day, h: out.hour % 24, mi: out.minute, s: out.second };
}

/** Hoeveel minuten de zone op dit moment vóór UTC loopt (+120 in de zomer). */
function offsetMinutes(date: Date): number {
  const p = zonedParts(date);
  return (Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - date.getTime()) / 60000;
}

/**
 * Het UTC-venster van de Nederlandse kalenderdag waarin `now` valt. De offset
 * wordt bij het geschatte tijdstip zelf opgevraagd, zodat zomer- en wintertijd
 * automatisch goed gaan.
 */
export function dayWindow(now: Date): { start: Date; end: Date } {
  const { y, m, d } = zonedParts(now);
  const midnightAsUtc = Date.UTC(y, m - 1, d);
  const start = new Date(midnightAsUtc - offsetMinutes(new Date(midnightAsUtc)) * 60000);
  // Via +26 uur en dan terug naar middernacht: telt netjes door over een
  // maand- of jaargrens én over een DST-omschakeling (waarin een dag 23 of 25
  // uur duurt).
  const nextDay = zonedParts(new Date(start.getTime() + 26 * 3600_000));
  const nextMidnightAsUtc = Date.UTC(nextDay.y, nextDay.m - 1, nextDay.d);
  const end = new Date(nextMidnightAsUtc - offsetMinutes(new Date(nextMidnightAsUtc)) * 60000);
  return { start, end };
}

/**
 * Haalt de afspraken van vandaag op uit de primaire agenda, gesorteerd op
 * starttijd. Locatie en omschrijving blijven ruw (zoals de makelaar/
 * assessor ze intypt in Google Agenda) — de UI laat de gebruiker zelf
 * kiezen welke tekst als adres gebruikt wordt bij het zoeken.
 */
export async function getTodayEvents(accessToken: string): Promise<CalendarEvent[]> {
  const { start, end } = dayWindow(new Date());

  const url = new URL(`${GOOGLE_CALENDAR_API_BASE}/calendars/primary/events`);
  url.searchParams.set("timeMin", start.toISOString());
  url.searchParams.set("timeMax", end.toISOString());
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new GoogleApiError(res.status, `Google Calendar events failed: ${res.status} ${body}`);
  }

  const data = (await res.json()) as {
    items?: {
      id: string;
      summary?: string;
      description?: string;
      location?: string;
      start?: { dateTime?: string; date?: string };
      end?: { dateTime?: string; date?: string };
    }[];
  };

  return (data.items ?? []).map((e) => ({
    id: e.id,
    summary: e.summary ?? "(geen titel)",
    description: e.description ?? null,
    location: e.location ?? null,
    start: e.start?.dateTime ?? e.start?.date ?? null,
    end: e.end?.dateTime ?? e.end?.date ?? null,
  }));
}

/**
 * Afspraken over een vrij tijdvenster i.p.v. alleen vandaag. Nodig voor het
 * agendaoverzicht in het Business Control Center, dat een week of maand van
 * álle medewerkers naast elkaar zet. Bewust dezelfde vorm als
 * `getTodayEvents` zodat er maar één CalendarEvent-type in omloop blijft.
 */
export async function getEventsBetween(
  accessToken: string,
  start: Date,
  end: Date
): Promise<CalendarEvent[]> {
  const url = new URL(`${GOOGLE_CALENDAR_API_BASE}/calendars/primary/events`);
  url.searchParams.set("timeMin", start.toISOString());
  url.searchParams.set("timeMax", end.toISOString());
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  // Ruim boven een normale werkweek; wie hier tegenaan loopt heeft een ander
  // probleem dan een ontbrekende pagina.
  url.searchParams.set("maxResults", "500");

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new GoogleApiError(res.status, `Google Calendar events failed: ${res.status} ${body}`);
  }

  const data = (await res.json()) as {
    items?: {
      id: string;
      summary?: string;
      description?: string;
      location?: string;
      start?: { dateTime?: string; date?: string };
      end?: { dateTime?: string; date?: string };
    }[];
  };

  return (data.items ?? []).map((e) => ({
    id: e.id,
    summary: e.summary ?? "(geen titel)",
    description: e.description ?? null,
    location: e.location ?? null,
    start: e.start?.dateTime ?? e.start?.date ?? null,
    end: e.end?.dateTime ?? e.end?.date ?? null,
  }));
}
