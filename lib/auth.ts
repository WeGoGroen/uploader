/**
 * Simpele afscherming van de hele app met één gedeeld wachtwoord. Bewust
 * klein gehouden: de opnemers werken op iPads in het veld, dus één keer
 * inloggen dat lang geldig blijft. De sessie is een ondertekende cookie —
 * er staat geen wachtwoord in, alleen een vervaldatum plus handtekening, dus
 * niemand kan er zelf eentje in elkaar knutselen.
 *
 * Draait ook in de Edge-runtime (middleware), vandaar Web Crypto i.p.v.
 * node:crypto.
 */

export const SESSION_COOKIE = "wgg_session";
/** 30 dagen: lang genoeg om niet elke opname opnieuw te moeten inloggen. */
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

function toBase64Url(bytes: ArrayBuffer): string {
  const bin = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sign(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return toBase64Url(sig);
}

/** Vergelijkt twee teksten zonder dat de responstijd verraadt hoe ver ze gelijk zijn. */
export function gelijkInConstanteTijd(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let verschil = 0;
  for (let i = 0; i < a.length; i++) verschil |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return verschil === 0;
}

/**
 * Wie er ingelogd is.
 *
 * Hiervóór stond er in de cookie alleen een vervaldatum: de app wist dát je
 * binnen mocht, niet wie je was. Wie je was stond in een losse, niet-beveiligde
 * cookie die je op de gebruikerspagina zelf kon omzetten — handig toen iedereen
 * dezelfde code deelde, maar het betekende ook dat elke opnemer met één klik
 * het werk van een collega op diens naam kon zetten.
 *
 * Nu zit de naam ín de ondertekende sessie. Van gebruiker wisselen is daarmee
 * hetzelfde als opnieuw inloggen, en dat is precies de bedoeling.
 */
export interface Sessie {
  naam: string;
  rol: "medewerker" | "beheerder";
  /** Zit deze persoon nog op de startcode 0000? */
  codeGewijzigd: boolean;
  verlooptOp: number;
}

function base64UrlEncode(tekst: string): string {
  return btoa(unescape(encodeURIComponent(tekst)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64UrlDecode(waarde: string): string {
  const pad = waarde.replace(/-/g, "+").replace(/_/g, "/");
  return decodeURIComponent(escape(atob(pad + "=".repeat((4 - (pad.length % 4)) % 4))));
}

export async function maakSessie(secret: string, sessie: Omit<Sessie, "verlooptOp">): Promise<string> {
  const inhoud: Sessie = { ...sessie, verlooptOp: Date.now() + SESSION_MAX_AGE_SECONDS * 1000 };
  const nuttige = base64UrlEncode(JSON.stringify(inhoud));
  return `${nuttige}.${await sign(secret, nuttige)}`;
}

/**
 * Leest de sessie en controleert de handtekening. Geeft null bij álles wat niet
 * klopt — een half geldige sessie bestaat niet.
 */
export async function leesSessie(secret: string, waarde: string | null | undefined): Promise<Sessie | null> {
  if (!waarde) return null;
  const punt = waarde.lastIndexOf(".");
  if (punt < 1) return null;

  const nuttige = waarde.slice(0, punt);
  const handtekening = waarde.slice(punt + 1);
  const verwacht = await sign(secret, nuttige);

  if (handtekening.length !== verwacht.length) return null;
  let verschil = 0;
  for (let i = 0; i < handtekening.length; i++) {
    verschil |= handtekening.charCodeAt(i) ^ verwacht.charCodeAt(i);
  }
  if (verschil !== 0) return null;

  try {
    const sessie = JSON.parse(base64UrlDecode(nuttige)) as Sessie;
    if (!sessie.naam || !Number.isFinite(sessie.verlooptOp) || sessie.verlooptOp <= Date.now()) {
      return null;
    }
    return { ...sessie, rol: sessie.rol === "beheerder" ? "beheerder" : "medewerker" };
  } catch {
    return null;
  }
}

/**
 * Mag deze aanvraag een van de achtergrondtaken draaien (ochtendcontrole,
 * herinneringen, herstelwerker)? Via Vercel Cron met het cron-geheim, of met
 * een geldige sessie om hem met de hand te starten.
 *
 * Hier stond isValidSession, en die kende alleen het oude sessieformaat: een
 * kale vervaldatum met handtekening. Sinds de naam in de sessie zit is de
 * waarde een stuk JSON, `Number()` daarvan is NaN, en dus gaf hij voor elke
 * echte sessie `false`. Met de hand draaien kon daardoor niet meer. Het
 * cron-geheim werd bovendien met `===` vergeleken; nu in constante tijd.
 */
export async function magAchtergrondtaakDraaien(
  request: Request,
  sessieWaarde: string | null | undefined
): Promise<{ viaCron: boolean; viaSessie: boolean }> {
  const cronSecret = process.env.CRON_SECRET;
  const auth = request.headers.get("authorization") ?? "";
  const viaCron = !!cronSecret && gelijkInConstanteTijd(auth, `Bearer ${cronSecret}`);
  const viaSessie = !!(await leesSessie(authConfig().secret, sessieWaarde));
  return { viaCron, viaSessie };
}

/**
 * Wachtwoord en ondertekeningssleutel. Ontbreekt het wachtwoord, dan blijft
 * de app open — dat is expliciet zichtbaar op de inlogpagina, zodat een
 * ontbrekende omgevingsvariabele niet stilzwijgend de deur openzet.
 */
export function authConfig(): { password: string | null; secret: string } {
  return {
    password: process.env.APP_PASSWORD || null,
    secret: process.env.SESSION_SECRET || "wegogroen-fallback-secret",
  };
}

/** De code waarmee een nieuw account begint, tot iemand hem zelf verandert. */
export const STARTCODE = "0000";

/**
 * Een viercijferige code omzetten naar iets dat je mag opslaan.
 *
 * PBKDF2 via Web Crypto: werkt zowel in Node als in de Edge-runtime, dus geen
 * extra pakket nodig. Vier cijfers zijn maar tienduizend mogelijkheden — het
 * echte slot is niet deze hash maar de pogingslimiet bij het inloggen. De hash
 * zorgt ervoor dat wie de opslag inziet niet meteen ieders code kan aflezen.
 */
export async function hashCode(code: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(code), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: new TextEncoder().encode(salt), iterations: 120_000, hash: "SHA-256" },
    key,
    256
  );
  return toBase64Url(bits);
}

export function nieuweSalt(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return toBase64Url(bytes.buffer);
}
