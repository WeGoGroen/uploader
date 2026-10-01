import type { NextResponse } from "next/server";
import { gelijkInConstanteTijd } from "@/lib/auth";

/**
 * De `state` bij een OAuth-koppeling (Dropbox, Google Agenda).
 *
 * De callbacks staan open in de middleware: de aanbieder stuurt de browser
 * daarheen, en die komt van buiten. Zonder controle kon iedereen die de
 * client-id kende zijn eigen Dropbox autoriseren en de callback laten
 * aanroepen; het teamtoken werd dan vervangen en alle uploads gingen naar dat
 * account. Bij Google stond de accountnaam zelf in `state`, dus daar kon een
 * vreemde agenda aan de naam van een collega gehangen worden.
 *
 * Nu: bij het starten (achter de inlog) een willekeurige waarde, in `state` én
 * in een httpOnly-cookie die alleen naar de callbacks gaat. De callback
 * accepteert alleen als die twee gelijk zijn. Voor wie gewoon op "koppelen"
 * klikt verandert er niets.
 */
export type OAuthSoort = "dropbox" | "google";

const LEEFTIJD_S = 10 * 60;

function cookieNaam(soort: OAuthSoort): string {
  return `wgg_oauth_${soort}`;
}

function willekeurig(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Nieuwe state; zet de cookie op de doorverwijzing naar de aanbieder. */
export function startOAuthState(soort: OAuthSoort, response: NextResponse, state = willekeurig()): string {
  response.cookies.set(cookieNaam(soort), state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    // Lax: de terugkeer van de aanbieder is een gewone navigatie, en dan gaat
    // de cookie mee.
    sameSite: "lax",
    path: "/api/auth",
    maxAge: LEEFTIJD_S,
  });
  return state;
}

/** Klopt de state in de URL met die in de cookie van deze browser? */
export function oauthStateKlopt(soort: OAuthSoort, request: Request, state: string | null): boolean {
  if (!state) return false;
  const cookie = leesCookie(request.headers.get("cookie"), cookieNaam(soort));
  return !!cookie && gelijkInConstanteTijd(cookie, state);
}

/** Na gebruik weg: een state geldt voor één koppeling. */
export function wisOAuthState(soort: OAuthSoort, response: NextResponse): NextResponse {
  response.cookies.set(cookieNaam(soort), "", { path: "/api/auth", maxAge: 0 });
  return response;
}

export function leesCookie(header: string | null, naam: string): string | null {
  if (!header) return null;
  for (const deel of header.split(";")) {
    const i = deel.indexOf("=");
    if (i === -1) continue;
    if (deel.slice(0, i).trim() === naam) {
      try {
        return decodeURIComponent(deel.slice(i + 1).trim());
      } catch {
        return deel.slice(i + 1).trim();
      }
    }
  }
  return null;
}

/** Tekst veilig in HTML. De resultaatpagina's zetten foutmeldingen en namen in de pagina. */
export function escapeHtml(tekst: unknown): string {
  return String(tekst).replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;"
  );
}
