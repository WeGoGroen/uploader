/**
 * fetch voor aanroepen vanaf de server naar Dropbox, ClickUp, Mediatask,
 * Microsoft, Google en Resend. Twee dingen erbij, verder precies fetch:
 *
 * 1. Een tijdslimiet. Geen enkele van deze aanroepen had er een, dus één
 *    hangende verbinding hield een functie vast tot Vercel hem na 60 of 300
 *    seconden afschoot. De ochtendcontrole kwam dan te laat of helemaal niet.
 *    Niet voor het echte bestandsverkeer (content.dropboxapi.com, S3): een
 *    scan van een paar honderd MB mag lang duren.
 *
 * 2. Opnieuw proberen bij een 429. Dat antwoord betekent dat de aanvraag níét
 *    is uitgevoerd, dus opnieuw sturen is altijd veilig, ook voor een aanroep
 *    die iets aanmaakt. Eerst de wachttijd die de dienst in Retry-After noemt
 *    (begrensd), anders kort oplopend. Alleen als de body opnieuw te versturen
 *    is; een stream is na de eerste poging op.
 *
 * Een 5xx wordt níét herhaald: dan weten we niet of het gelukt is, en een
 * dubbele ClickUp-taak of een dubbele verplaatsing is erger dan een foutmelding.
 */

export const STANDAARD_LIMIET_MS = 60_000;
const MAX_HERHALINGEN = 2;
const MAX_WACHT_MS = 10_000;

/** Hosts met bestandsverkeer: geen standaardlimiet. */
const ZONDER_LIMIET = [/^content\.dropboxapi\.com$/i, /\.amazonaws\.com$/i, /^dl\.dropboxusercontent\.com$/i];

function hostVan(input: RequestInfo | URL): string {
  try {
    const url = typeof input === "string" ? new URL(input) : input instanceof URL ? input : new URL(input.url);
    return url.hostname;
  } catch {
    return "";
  }
}

function herhaalbaar(body: BodyInit | null | undefined): boolean {
  return (
    body === undefined ||
    body === null ||
    typeof body === "string" ||
    body instanceof URLSearchParams ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body)
  );
}

/** Wachttijd na een 429, in ms. */
export function wachtNa429(retryAfter: string | null, poging: number): number {
  const seconden = Number(retryAfter);
  if (retryAfter && Number.isFinite(seconden) && seconden >= 0) {
    return Math.min(seconden * 1000, MAX_WACHT_MS);
  }
  const datum = retryAfter ? Date.parse(retryAfter) : NaN;
  if (Number.isFinite(datum)) return Math.min(Math.max(0, datum - Date.now()), MAX_WACHT_MS);
  return Math.min(1000 * 2 ** poging, MAX_WACHT_MS);
}

function signaalVoor(input: RequestInfo | URL, init: RequestInit | undefined, limietMs: number) {
  if (init?.signal) return init.signal;
  const host = hostVan(input);
  if (ZONDER_LIMIET.some((r) => r.test(host))) return undefined;
  return AbortSignal.timeout(limietMs);
}

export async function serverFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  limietMs: number = STANDAARD_LIMIET_MS
): Promise<Response> {
  const magHerhalen = herhaalbaar(init?.body);
  for (let poging = 0; ; poging++) {
    const res = await fetch(input, { ...init, signal: signaalVoor(input, init, limietMs) });
    if (res.status !== 429 || !magHerhalen || poging >= MAX_HERHALINGEN) return res;
    const wacht = wachtNa429(res.headers.get("retry-after"), poging);
    await res.body?.cancel().catch(() => {});
    await new Promise((r) => setTimeout(r, wacht));
  }
}
