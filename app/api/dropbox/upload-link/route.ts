import { NextResponse } from "next/server";
import { createTemporaryUploadLink, getSharedAccessToken } from "@/lib/dropbox";

/**
 * Geeft een tijdelijke Dropbox-uploadlink terug, zodat de browser het bestand
 * rechtstreeks naar Dropbox stuurt i.p.v. via deze server. Dat scheelt een
 * hele hop (browser → Vercel → Dropbox wordt browser → Dropbox), omzeilt de
 * ~4,5MB-limiet per serverless-aanroep en is daardoor fors sneller. Het
 * account-token blijft hierbij server-side: de link is kortlopend en geldt
 * maar voor dit ene pad.
 */
export async function POST(request: Request) {
  const body = (await request.json()) as { path?: string };
  if (!body.path) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

  try {
    const accessToken = await getSharedAccessToken();
    const link = await createTemporaryUploadLink(accessToken, body.path);
    return NextResponse.json({ link });
  } catch (err) {
    console.error("Failed to create Dropbox upload link", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Uploadlink aanmaken mislukt" },
      { status: 502 }
    );
  }
}
