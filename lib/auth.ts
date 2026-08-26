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

/** Maakt een sessiewaarde die tot `expiresAt` (ms sinds epoch) geldig is. */
export async function createSessionValue(secret: string, expiresAt: number): Promise<string> {
  return `${expiresAt}.${await sign(secret, String(expiresAt))}`;
}

export async function isValidSession(secret: string, value: string | undefined | null): Promise<boolean> {
  if (!value) return false;
  const dot = value.lastIndexOf(".");
  if (dot < 1) return false;
  const expiresAt = value.slice(0, dot);
  const signature = value.slice(dot + 1);

  const expected = await sign(secret, expiresAt);
  // Lengtes verschillen => zeker ongeldig; anders constante-tijd vergelijking
  // zodat een aanvaller niet aan de responstijd kan aflezen hoe ver hij is.
  if (signature.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < signature.length; i++) diff |= signature.charCodeAt(i) ^ expected.charCodeAt(i);
  if (diff !== 0) return false;

  const ts = Number(expiresAt);
  return Number.isFinite(ts) && ts > Date.now();
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
