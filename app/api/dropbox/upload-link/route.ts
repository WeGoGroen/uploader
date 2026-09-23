import { NextResponse } from "next/server";
import { createTemporaryUploadLink, getSharedAccessToken } from "@/lib/dropbox";

/**
 * Geeft tijdelijke Dropbox-uploadlinks terug, zodat de browser bestanden
 * rechtstreeks naar Dropbox stuurt i.p.v. via deze server. Dat scheelt een
 * hele hop (browser → Vercel → Dropbox wordt browser → Dropbox), omzeilt de
 * ~4,5MB-limiet per serverless-aanroep en is daardoor fors sneller. Het
 * account-token blijft hierbij server-side: een link is kortlopend en geldt
 * maar voor dat ene pad.
 *
 * Meerdere paden in één aanroep, want een fotoserie vroeg er twintig los op:
 * twintig keer een ronde browser → Vercel voordat er één byte omhoog ging, en
 * (vóór de tokencache) twintig keer een OAuth-ronde erachteraan. De links zelf
 * halen we hier wél tegelijk op — dat is een snelle verbinding tussen twee
 * datacentra, geen mobiele uplink.
 *
 * Een pad dat niet lukt levert `null` op i.p.v. een fout voor de hele groep:
 * de browser valt voor dat ene bestand terug op de route via onze server, en
 * de rest van de serie gaat gewoon door.
 */
const MAX_PADEN = 25;

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    path?: string;
    paths?: unknown;
  } | null;

  const paden = Array.isArray(body?.paths)
    ? body.paths.filter((p): p is string => typeof p === "string" && p.length > 0)
    : body?.path
      ? [body.path]
      : [];

  if (paden.length === 0) return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  if (paden.length > MAX_PADEN) {
    return NextResponse.json({ error: `hoogstens ${MAX_PADEN} paden per aanvraag` }, { status: 400 });
  }

  let accessToken: string;
  try {
    accessToken = await getSharedAccessToken();
  } catch (err) {
    console.error("Failed to create Dropbox upload link", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Uploadlink aanmaken mislukt" },
      { status: 502 }
    );
  }

  const links: Record<string, string | null> = {};
  await Promise.all(
    paden.map(async (pad) => {
      links[pad] = await createTemporaryUploadLink(accessToken, pad).catch((err) => {
        console.error("Failed to create Dropbox upload link", { pad, err });
        return null;
      });
    })
  );

  // `link` blijft erbij voor de enkelvoudige aanvraag, zodat oudere tabbladen
  // die nog draaien tijdens een uitrol niet ineens zonder link zitten.
  return NextResponse.json({ links, link: paden.length === 1 ? links[paden[0]] : undefined });
}
