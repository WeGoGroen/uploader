import { NextResponse } from "next/server";
import { isInternRequest } from "@/lib/intern-auth";
import { deleteFile, getMetadata, getSharedAccessToken, verplaats } from "@/lib/dropbox";
import { isMediaProjectmap, mediaVrijgeefPaden } from "@/lib/media-pad";

export const maxDuration = 30;

/**
 * Een gekeurde 360-rondgang uit de wachtmap naar OUT/360 schuiven.
 *
 * Waarom: zie CONTROLE_SUBMAP in lib/media-pad.ts. Het control center zet een
 * bewerkt panorama eerst in OUT/_controle/360 en roept dit pas aan als de
 * eindcontrole (of een mens) het heeft goedgekeurd.
 *
 * Verplaatsen en niet opnieuw uploaden: het bestand dat gekeurd is, is precies
 * het bestand dat bij de klant komt. Een tweede upload zou een tweede kans
 * zijn dat er onderweg iets anders aankomt dan wat er is nagekeken.
 *
 * Herhaalbaar. Een aanroep die halverwege een time-out kreeg, mag nog eens:
 *  - staat het bestand niet meer in de wachtmap maar wel in OUT/360, dan is het
 *    al gebeurd en is het antwoord gewoon ok;
 *  - staat er in OUT/360 al een oudere versie (een rondgang die opnieuw door de
 *    pipeline ging), dan gaat die eerst weg. move_v2 overschrijft niet, en een
 *    "(1)"-kopie naast het origineel is precies de rommel die deze map niet mag
 *    hebben. Pas wegen als de nieuwe versie er werkelijk staat — daarom eerst
 *    de wachtmap nakijken en dán pas iets in OUT/360 aanraken.
 */
export async function POST(request: Request) {
  if (!isInternRequest(request)) {
    return NextResponse.json({ error: "niet_toegestaan" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as {
    projectmap?: string;
    bestandsnaam?: string;
  } | null;
  const projectmap = body?.projectmap?.trim() ?? "";
  if (!isMediaProjectmap(projectmap)) {
    return NextResponse.json(
      { error: `alleen een projectmap onder /Automatie Media — kreeg "${projectmap}"` },
      { status: 400 }
    );
  }
  const paden = mediaVrijgeefPaden(projectmap, body?.bestandsnaam ?? "");
  if (!paden) {
    return NextResponse.json({ error: "de bestandsnaam is geen gewone beeldnaam" }, { status: 400 });
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

  try {
    const bron = await getMetadata(token, paden.van);
    if (!bron) {
      const doel = await getMetadata(token, paden.naar);
      if (doel) return NextResponse.json({ ok: true, pad: paden.naar, al: true });
      return NextResponse.json(
        { error: `${paden.van} bestaat niet — er is niets om vrij te geven` },
        { status: 404 }
      );
    }
    await deleteFile(token, paden.naar);
    await verplaats(token, paden.van, paden.naar);
    return NextResponse.json({ ok: true, pad: paden.naar });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message.slice(0, 200) : "verplaatsen mislukt" },
      { status: 502 }
    );
  }
}
