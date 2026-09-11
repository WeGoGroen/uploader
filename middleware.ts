import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, authConfig, leesSessie } from "@/lib/auth";

/**
 * Zet de hele app achter één inlog — inclusief álle API-routes. Zonder dit
 * kon iedereen die het adres kende via /api/dropbox/* bij de volledige
 * Dropbox van het bedrijf (bestanden zien, overschrijven én verwijderen).
 *
 * Alleen deze paden blijven open, en dat kan niet anders:
 *  - de inlogpagina zelf en de route die het wachtwoord controleert;
 *  - de OAuth-callbacks: daar stuurt Google/Dropbox de gebruiker heen, die
 *    komen van buiten en dragen geen cookie van ons. Ze zijn zelf beveiligd
 *    met de state-parameter en een eenmalige code.
 */
const OPEN_PATHS = [
  "/login",
  "/api/auth/login",
  // De namenlijst voor het inlogscherm: die heb je nodig vóórdat je ingelogd
  // bent. Hij geeft alleen namen terug, geen codes of tokens.
  "/api/auth/accounts",
  "/api/auth/google/callback",
  "/api/auth/dropbox/callback",
  // De ochtendcontrole draait via Vercel Cron en heeft dus geen sessie; die
  // route controleert zelf op het cron-geheim of een geldige sessie.
  "/api/health",
  // Herinneringen draaien ook via Vercel Cron; die route controleert zelf op
  // het cron-geheim of een geldige sessie.
  "/api/opnames/herinnering",
  // De herstelwerker draait ook via Vercel Cron; die route controleert zelf
  // op het cron-geheim of een geldige sessie.
  "/api/opnames/herstel",
  // ClickUp roept dit aan als een taak op klaar gaat — geen sessie dus. De
  // route controleert zelf de handtekening die ClickUp over de body zet, en
  // weigert alles zonder geldige handtekening.
  "/api/clickup/webhook",
];

/**
 * De /api/intern-routes zijn er voor het Business Control Center, dat als
 * machine praat en dus geen sessiecookie heeft. Ze controleren zelf het
 * dienst-token (zie lib/intern-auth.ts) en weigeren alles zonder geldig token.
 */
const INTERN_PREFIX = "/api/intern/";

function isOpen(pathname: string): boolean {
  if (OPEN_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return true;
  if (pathname.startsWith(INTERN_PREFIX)) return true;
  // Statische bestanden en de app-iconen: die mogen niet achter de inlog
  // zitten, anders toont de inlogpagina zelf geen stijl of icoon.
  return (
    pathname.startsWith("/_next/") ||
    pathname === "/favicon.ico" ||
    pathname === "/icon" ||
    pathname === "/apple-icon"
  );
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (isOpen(pathname)) return NextResponse.next();

  const { secret } = authConfig();

  /*
    Iedereen logt in onder zijn eigen naam; er is geen gedeeld wachtwoord meer
    dat je kunt vergeten in te stellen. De oude terugval ("geen APP_PASSWORD?
    dan alles open") is daarmee ook weg: die was bedoeld om te voorkomen dat
    een vergeten variabele de app onbruikbaar maakte, maar hij zette in de
    praktijk de deur open zonder dat iemand het merkte.
  */
  if (await leesSessie(secret, request.cookies.get(SESSION_COOKIE)?.value)) {
    return NextResponse.next();
  }

  // API-aanroepen krijgen een nette 401 i.p.v. een omleiding naar HTML.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "niet_ingelogd" }, { status: 401 });
  }

  // Geen ?next= meer: na het inloggen begin je op het dashboard. Zie de
  // toelichting in app/login/page.tsx — terugkomen in het scherm waar je
  // sessie verliep is zelden wat je wilt.
  const login = request.nextUrl.clone();
  login.pathname = "/login";
  login.search = "";
  return NextResponse.redirect(login);
}

export const config = {
  // Alles behalve de Next-interne assets; de fijnmazige uitzonderingen staan
  // hierboven in isOpen().
  matcher: ["/((?!_next/static|_next/image).*)"],
};
