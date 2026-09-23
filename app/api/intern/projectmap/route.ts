import { NextResponse } from "next/server";
import { getSharedAccessToken, leesProjectmap } from "@/lib/dropbox";
import { isInternRequest } from "@/lib/intern-auth";

export const maxDuration = 120;

/**
 * De volledige inhoud van één projectmap, voor de finalisatiecontrole in het
 * control center.
 *
 * Waarom niet /api/intern/dropbox: die scant alle hoofdmappen (450+ mappen,
 * tientallen seconden) en geeft per project alleen tellingen per submap terug.
 * Een controle op "ligt er een BAG-rapport" heeft bestandsnámen nodig, en voor
 * één map is een eigen listing juist goedkoop.
 *
 * Op id of op pad. Het id heeft de voorkeur en is het antwoord op een fout die
 * al eens gemaakt is: een pad verandert zodra een map naar "Afgerond" verhuist,
 * en dan wijst de koppeling naar een plek die niet meer bestaat — of, erger,
 * naar een oude map met dezelfde naam.
 *
 * Leest alleen. Er wordt hier niets aangemaakt, verplaatst of overschreven.
 */
export async function POST(request: Request) {
  if (!isInternRequest(request)) {
    return NextResponse.json({ error: "niet_toegestaan" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as {
    folder_id?: string;
    pad?: string;
  } | null;

  const folderId = body?.folder_id?.trim() ?? "";
  const pad = body?.pad?.trim() ?? "";
  const doel = folderId || pad;
  if (!doel) {
    return NextResponse.json({ error: "folder_id of pad is verplicht" }, { status: 400 });
  }
  if (folderId && !/^id:[A-Za-z0-9_-]+$/.test(folderId)) {
    return NextResponse.json({ error: "folder_id moet de vorm id:... hebben" }, { status: 400 });
  }
  if (!folderId && !pad.startsWith("/")) {
    return NextResponse.json({ error: "pad moet met / beginnen" }, { status: 400 });
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
    const inhoud = await leesProjectmap(token, doel);
    return NextResponse.json({ ok: true, ...inhoud });
  } catch (err) {
    const melding = err instanceof Error ? err.message.slice(0, 250) : "uitlezen mislukt";
    // 404 blijft 404: een map die er niet is, komt door opnieuw proberen niet
    // terug — en de aanroeper hoort dat verschil te zien (zie lib/agents/fouten.ts
    // in het control center, dat hierop zijn herhaalgedrag bepaalt).
    const weg = /\b404\b|not_found|Geen map gevonden/.test(melding);
    return NextResponse.json({ error: melding }, { status: weg ? 404 : 502 });
  }
}
