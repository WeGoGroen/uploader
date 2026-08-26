import { NextResponse } from "next/server";
import {
  getDefaultDriveId,
  getSharePointConfig,
  getSharedAccessToken,
  isDefaultSharePointConfig,
  resetSharePointConfig,
  resolveSiteId,
  setSharePointConfig,
} from "@/lib/microsoft";
import { parseSharePointUrl } from "@/lib/sharepoint-match";

export async function GET() {
  const config = await getSharePointConfig();
  return NextResponse.json({ config, isDefault: await isDefaultSharePointConfig() });
}

/**
 * Past de SharePoint-locatie aan. Normaal komt niemand hier: de map van MO
 * Consultancy staat vast ingebakken. Dit is er alleen voor als die map ooit
 * verhuist — vandaar dat de Koppelingen-pagina de velden pas vrijgeeft na een
 * klik op "Aanpassen". Een verkeerde waarde legt de hele automatische
 * overdracht stil, dus de site wordt eerst gecontroleerd voordat hij wordt
 * bewaard.
 */
export async function POST(request: Request) {
  const body = (await request.json()) as { siteUrl?: string; rootPath?: string };
  const input = body.siteUrl?.trim();
  if (!input) {
    return NextResponse.json({ error: "missing_site_url" }, { status: 400 });
  }

  // De hele URL uit de SharePoint-adresbalk mag er zo in geplakt worden; site
  // en map worden er zelf uit gehaald. Een los ingevuld "map"-veld wint,
  // zodat handmatig bijsturen mogelijk blijft.
  const parsed = parseSharePointUrl(input);
  if (!parsed) {
    return NextResponse.json({ error: "invalid_url" }, { status: 400 });
  }
  const siteUrl = parsed.siteUrl;
  const rootPath = (body.rootPath?.trim() || parsed.rootPath).replace(/^\/+|\/+$/g, "");

  let accessToken: string | null = null;
  try {
    accessToken = await getSharedAccessToken();
  } catch {
    // Nog niet ingelogd: dan valt er niets te controleren. De link wordt wel
    // bewaard, want uit de hostnaam volgt bij welke Microsoft-tenant er
    // ingelogd moet worden.
  }

  if (accessToken) {
    try {
      const siteId = await resolveSiteId(accessToken, siteUrl);
      await getDefaultDriveId(accessToken, siteId);
    } catch (err) {
      console.error("SharePoint site check failed", err);
      return NextResponse.json({ error: "site_unreachable" }, { status: 400 });
    }
  }

  try {
    await setSharePointConfig({ siteUrl, rootPath });
  } catch (err) {
    return NextResponse.json(
      { error: "no_storage", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }

  return NextResponse.json({
    ok: true,
    verified: accessToken !== null,
    config: { siteUrl, rootPath },
    isDefault: await isDefaultSharePointConfig(),
  });
}

/** Terug naar de ingebakken standaardmap. */
export async function DELETE() {
  try {
    await resetSharePointConfig();
  } catch (err) {
    return NextResponse.json(
      { error: "no_storage", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
  return NextResponse.json({
    ok: true,
    config: await getSharePointConfig(),
    isDefault: true,
  });
}
