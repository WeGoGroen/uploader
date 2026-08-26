import { NextResponse } from "next/server";
import { exchangeCodeForTokens, getCurrentAccount, storeRefreshToken } from "@/lib/dropbox";
import { getOptionalRedis } from "@/lib/redis";

/**
 * OAuth-callback: wisselt de code in voor een refresh-token en slaat die
 * direct op in Redis, zodat Dropbox meteen werkt voor het hele team — net
 * als bij het toevoegen van een ClickUp-account hoeft niemand hierna nog
 * iets handmatig te kopiëren of te herdeployen.
 */
function resultPage(body: string): NextResponse {
  return new NextResponse(
    `<!doctype html><html lang="nl"><head><meta charset="utf-8">
      <title>Dropbox koppelen</title>
      <style>
        body { font-family: system-ui, sans-serif; max-width: 640px; margin: 60px auto; padding: 0 20px; color: #1a201c; }
        code, pre { background: #f4f6f4; border: 1px solid #e6e9e6; border-radius: 8px; padding: 12px 14px; display: block; overflow-x: auto; font-size: 13px; }
        .warn { color: #9a5b06; }
        a { color: #147a44; }
      </style></head>
    <body>${body}</body></html>`,
    { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) {
    return resultPage(`<h1>Dropbox-koppeling geannuleerd</h1><p>${error}</p>`);
  }
  if (!code) {
    return resultPage(`<h1>Er ontbreekt een code</h1><p>Start opnieuw via /instellingen.</p>`);
  }

  const clientId = process.env.DROPBOX_CLIENT_ID;
  const clientSecret = process.env.DROPBOX_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return NextResponse.json(
      { error: "Dropbox OAuth credentials are not configured" },
      { status: 500 }
    );
  }

  const redirectUri = new URL("/api/auth/dropbox/callback", request.url).toString();

  try {
    const tokens = await exchangeCodeForTokens(clientId, clientSecret, code, redirectUri);
    const account = await getCurrentAccount(tokens.accessToken);

    if (!tokens.refreshToken) {
      return resultPage(
        `<h1>Geen refresh-token ontvangen</h1>
         <p>Dropbox gaf deze keer geen refresh-token terug. Ga naar
         <a href="https://www.dropbox.com/account/connected_apps">dropbox.com/account/connected_apps</a>,
         verwijder de bestaande koppeling met deze app, en probeer opnieuw via /instellingen.</p>`
      );
    }

    if (!getOptionalRedis()) {
      return resultPage(`
        <h1>Dropbox gekoppeld als ${account.email}</h1>
        <p>Er is nog geen Redis-opslag gekoppeld aan dit project, dus het
        token kan niet automatisch bewaard worden. Zet deze waarde in
        <code>.env.local</code> (lokaal) én als environment variable op
        Vercel:</p>
        <pre>DROPBOX_REFRESH_TOKEN=${tokens.refreshToken}</pre>
        <p class="warn">Deze pagina toont het token maar één keer. Bewaar het
        direct; ververs deze pagina niet.</p>
        <p><a href="/instellingen">← Terug naar Koppelingen</a></p>
      `);
    }

    await storeRefreshToken(tokens.refreshToken);

    return resultPage(`
      <h1>Dropbox gekoppeld als ${account.email}</h1>
      <p>Dropbox werkt nu voor het hele team — niemand hoeft hierna nog apart
      in te loggen.</p>
      <p><a href="/instellingen">← Terug naar Koppelingen</a></p>
    `);
  } catch (err) {
    console.error("Dropbox OAuth callback failed", err);
    return resultPage(`<h1>Koppelen mislukt</h1><p>${String(err)}</p>`);
  }
}
