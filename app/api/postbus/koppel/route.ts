import { NextResponse } from "next/server";
import { POSTBUS_SCOPE } from "@/lib/postbus";

/**
 * Start het inloggen op de postbus — het Google-account waar de mail van RVO
 * met het afschrift binnenkomt.
 *
 * Het inloggen zelf gebeurt bij Google, op hun eigen scherm: deze route doet
 * niets anders dan de gebruiker daarheen sturen. Er wordt hier dus nooit een
 * wachtwoord ingevoerd of bewaard; wat terugkomt is een token dat alleen mag
 * lezen, en dat kan in Google zelf weer ingetrokken worden.
 *
 * Deze route zit achter de inlog van deze app (zie middleware.ts) — anders zou
 * iedereen die het adres kent zijn eigen postbus aan ons kunnen hangen.
 */
export async function GET(request: Request) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json({ error: "GOOGLE_CLIENT_ID is niet ingesteld" }, { status: 500 });
  }

  const redirectUri = new URL("/api/auth/google/callback", request.url).toString();

  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", POSTBUS_SCOPE);
  // Offline + consent forceren een refresh-token, ook als dit account de app al
  // eerder had geautoriseerd — zonder dat werkt de koppeling één uur.
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  /*
    De state zegt waarvóór deze koppeling is. Bij de agenda staat hier de naam
    van het teamlid; "postbus" is het vaste woord voor deze ene gedeelde
    koppeling, en de callback leidt daarop af waar het token heen moet. Een
    teamlid dat toevallig zo heet bestaat niet.
  */
  url.searchParams.set("state", "postbus");

  return NextResponse.redirect(url.toString());
}
