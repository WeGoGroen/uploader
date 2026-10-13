import { NextResponse } from "next/server";
import { exchangeCodeForTokens, getCurrentAccount, storeRefreshToken } from "@/lib/google-calendar";
import { getOptionalRedis } from "@/lib/redis";
import { getActiveAccountName } from "@/lib/active-account";
import { escapeHtml, oauthStateKlopt, wisOAuthState } from "@/lib/oauth-state";

function resultPage(body: string): NextResponse {
  return new NextResponse(
    `<!doctype html><html lang="nl"><head><meta charset="utf-8">
      <title>Google Agenda koppelen</title>
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

function resultaat(body: string): NextResponse {
  return wisOAuthState("google", resultPage(body));
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) {
    return resultaat(`<h1>Google-koppeling geannuleerd</h1><p>${escapeHtml(error)}</p>`);
  }
  if (!oauthStateKlopt("google", request, url.searchParams.get("state"))) {
    return resultaat(
      `<h1>Koppeling niet herkend</h1><p>Deze koppeling is niet vanuit de app gestart, of het duurde te lang. Start opnieuw via <a href="/instellingen">Koppelingen</a>.</p>`
    );
  }
  // Voor wie: wie er in deze browser ingelogd is. Dezelfde naam als bij het
  // starten, want dat ging ook via de sessie.
  const accountName = await getActiveAccountName();
  if (!code) {
    return resultaat(`<h1>Er ontbreekt een code</h1><p>Start opnieuw via /instellingen.</p>`);
  }
  if (!accountName) {
    return resultaat(
      `<h1>Onbekend voor wie dit is</h1><p>Je bent in deze browser niet (meer) ingelogd. Log in en start opnieuw via /instellingen.</p>`
    );
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return NextResponse.json({ error: "Google OAuth credentials are not configured" }, { status: 500 });
  }

  const redirectUri = new URL("/api/auth/google/callback", request.url).toString();

  try {
    const tokens = await exchangeCodeForTokens(clientId, clientSecret, code, redirectUri);
    const account = await getCurrentAccount(tokens.accessToken);

    if (!tokens.refreshToken) {
      return resultaat(
        `<h1>Geen refresh-token ontvangen</h1>
         <p>Google gaf deze keer geen refresh-token terug. Ga naar
         <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>,
         verwijder de bestaande koppeling met deze app, en probeer opnieuw via /instellingen.</p>`
      );
    }

    if (!getOptionalRedis()) {
      return resultaat(`
        <h1>Google Agenda gekoppeld als ${escapeHtml(account.email)}</h1>
        <p>Er is nog geen Redis-opslag gekoppeld aan dit project, dus het
        token kan niet automatisch bewaard worden voor <b>${escapeHtml(accountName)}</b>.</p>
        <p class="warn">Koppel eerst een Redis-store aan dit project (zie .env.local.example), anders werkt de per-teamlid koppeling niet.</p>
        <p><a href="/instellingen">← Terug naar Koppelingen</a></p>
      `);
    }

    await storeRefreshToken(accountName, tokens.refreshToken);

    return resultaat(`
      <h1>Google Agenda gekoppeld als ${escapeHtml(account.email)}</h1>
      <p>Dit geldt alleen voor <b>${escapeHtml(accountName)}</b> op dit apparaat — de afspraken van
      vandaag verschijnen nu bij het zoeken van een adres. Elk teamlid logt apart in
      met zijn eigen Google-account via Koppelingen.</p>
      <p><a href="/instellingen">← Terug naar Koppelingen</a></p>
    `);
  } catch (err) {
    console.error("Google OAuth callback failed", err);
    return resultaat(`<h1>Koppelen mislukt</h1><p>${escapeHtml(String(err))}</p>`);
  }
}
