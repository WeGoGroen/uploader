import { NextResponse } from "next/server";
import { authScope } from "@/lib/google-calendar";
import { resolveActiveAccountName } from "@/lib/active-account";
import { startOAuthState } from "@/lib/oauth-state";

export async function GET(request: Request) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json({ error: "GOOGLE_CLIENT_ID is not configured" }, { status: 500 });
  }

  const accountName = await resolveActiveAccountName();
  if (!accountName) {
    return NextResponse.json(
      { error: "Geen actief account bekend. Kies eerst een gebruiker via Gebruikers." },
      { status: 400 }
    );
  }

  const redirectUri = new URL("/api/auth/google/callback", request.url).toString();

  const authorizeUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("scope", authScope());
  // access_type=offline + prompt=consent forceren een refresh_token, ook als
  // dit account de app al eerder had geautoriseerd zonder offline access.
  authorizeUrl.searchParams.set("access_type", "offline");
  authorizeUrl.searchParams.set("prompt", "consent");
  // Een willekeurige state, ook in een cookie (zie lib/oauth-state.ts). Voor
  // wíé het token is, haalt de callback uit de sessie van deze browser; dat
  // stond eerst in de state zelf, en die kon iedereen invullen.
  const response = NextResponse.redirect(authorizeUrl.toString());
  const state = startOAuthState("google", response);
  authorizeUrl.searchParams.set("state", state);
  response.headers.set("Location", authorizeUrl.toString());
  return response;
}
