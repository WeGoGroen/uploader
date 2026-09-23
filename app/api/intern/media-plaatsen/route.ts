import { NextResponse } from "next/server";
import { isInternRequest } from "@/lib/intern-auth";
import { createTemporaryUploadLink, folderExists, getSharedAccessToken } from "@/lib/dropbox";
import { MEDIA_SUBMAPPEN, isMediaProjectmap, mediaDoelPad } from "@/lib/media-pad";

export const maxDuration = 30;

/**
 * Een uploadlink voor één bewerkt mediabestand in een bestaande mediaprojectmap.
 *
 * Waarvoor: de 360°-nadiragent in het control center haalt het statief uit een
 * rondgang en moet het resultaat terugzetten in Dropbox, naast het origineel.
 * Dat kon tot nu toe niet — /api/intern/bestand-plaatsen laat alleen een PDF
 * toe, alleen onder "Automatie Energielabels", en zet er zelf "/EP-Online/"
 * achter. Dat is geen route om op te rekken: die drie grenzen zíjn wat hem
 * veilig maakt.
 *
 * Het bestand gaat niet door deze server. Dat is hier geen optimalisatie maar
 * noodzaak: een panorama is twintig megabyte en het verzoeklichaam van een
 * serverless functie mag er vierenhalf. De browser — hier: het control center —
 * krijgt een tijdelijke link die voor precies dit ene pad geldt, een uur lang.
 * Het account-token blijft hier.
 *
 * Drie grenzen, net als bij de energielabelroute, en om dezelfde reden:
 *
 *  1. Alleen een projectmap onder "Automatie Media" — direct, of in het archief
 *     "Afgerond". Een pad daarbuiten is geen media-opname.
 *  2. De projectmap moet al bestaan. Deze route maakt er nooit een aan: geen
 *     map betekent dat een adres anders gespeld staat, en een tweede map naast
 *     de echte verspreidt de stukken zonder dat iemand het merkt.
 *  3. Alleen beeld, en alleen in een submap uit een vaste lijst — zie
 *     lib/media-pad.ts. Die submap mag wel ontstaan, zoals "EP-Online" bij de
 *     andere route ook binnen de projectmap ontstaat.
 */
export async function POST(request: Request) {
  if (!isInternRequest(request)) {
    return NextResponse.json({ error: "niet_toegestaan" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as {
    projectmap?: string;
    submap?: string;
    bestandsnaam?: string;
  } | null;

  const projectmap = body?.projectmap?.trim() ?? "";
  const submap = body?.submap?.trim() ?? "";
  const pad = mediaDoelPad(projectmap, submap, body?.bestandsnaam ?? "");

  /*
    De drie afwijzingen apart benoemen, en niet één "ongeldig verzoek".

    Aan de andere kant staat een agent die zijn eigen logregel schrijft. "pad
    klopt niet" laat daar iemand naar een verkeerde instelling zoeken; "submap
    'out/Video' mag niet" wijst meteen aan wat er moet veranderen.
  */
  if (!isMediaProjectmap(projectmap)) {
    return NextResponse.json(
      { error: `alleen een projectmap onder /Automatie Media — kreeg "${projectmap}"` },
      { status: 400 }
    );
  }
  if (!pad) {
    return NextResponse.json(
      {
        error:
          `submap moet een van ${MEDIA_SUBMAPPEN.join(", ")} zijn en de bestandsnaam ` +
          `een gewone beeldnaam — kreeg submap "${submap}"`,
      },
      { status: 400 }
    );
  }

  let token: string;
  try {
    token = await getSharedAccessToken();
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message.slice(0, 200) : "Dropbox niet gekoppeld" },
      { status: 503 }
    );
  }

  let bestaat: boolean;
  try {
    bestaat = await folderExists(token, projectmap);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message.slice(0, 200) : "Dropbox niet te bevragen" },
      { status: 502 }
    );
  }
  if (!bestaat) {
    return NextResponse.json(
      { error: `de projectmap ${projectmap} bestaat niet in Dropbox — er wordt geen nieuwe aangemaakt` },
      { status: 404 }
    );
  }

  try {
    const link = await createTemporaryUploadLink(token, pad);
    return NextResponse.json({ ok: true, link, pad });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message.slice(0, 200) : "uploadlink maken mislukt" },
      { status: 502 }
    );
  }
}
