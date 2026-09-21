import { NextResponse } from "next/server";
import {
  PROJECT_SUBFOLDERS,
  createFolder,
  downloadFile,
  getSharedAccessToken,
  leesProjectmap,
  uploadFile,
} from "@/lib/dropbox";
import { isInternRequest } from "@/lib/intern-auth";

export const maxDuration = 120;

/** De naam van het logboek dat de finalisatie in de projectmap achterlaat. */
const LOGBOEK = "_finalisatie-log.md";

/**
 * De twee schrijfhandelingen die bij het finaliseren van een projectmap horen:
 * ontbrekende standaardsubmappen aanmaken, en het logboek bijwerken.
 *
 * Bewust zo klein. Alles wat inhoudelijk aangevuld moet worden (opnameformulier,
 * Bijlage G, de map van MO, het afschrift) heeft al een eigen route die weet
 * wat hij doet en die nooit overschrijft; die worden hergebruikt. Wat daar niet
 * in paste is dit: een lege map die er nog niet was, en een verslag van wat er
 * gebeurd is.
 *
 * Drie grenzen, en ze zijn het punt van deze route:
 *
 *  1. Werken kan alleen op een map die je met zijn Dropbox-id aanwijst. Een pad
 *     uit de aanroeper overnemen zou betekenen dat wie het control center kan
 *     bereiken in elke map van het account kan schrijven.
 *  2. Alleen submappen uit de vaste lijst worden aangemaakt. Geen vrije namen,
 *     geen paden met ".." erin, niets buiten de projectmap.
 *  3. Er wordt niets overschreven, met precies één uitzondering: ons eigen
 *     logboek. Dat wordt gelezen, aangevuld en teruggeschreven — een map met
 *     twaalf losse logbestanden is erger dan één die meegroeit.
 */
export async function POST(request: Request) {
  if (!isInternRequest(request)) {
    return NextResponse.json({ error: "niet_toegestaan" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as {
    folder_id?: string;
    mappen?: string[];
    logregel?: string;
  } | null;

  const folderId = body?.folder_id?.trim() ?? "";
  if (!/^id:[A-Za-z0-9_-]+$/.test(folderId)) {
    return NextResponse.json({ error: "folder_id (id:...) is verplicht" }, { status: 400 });
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

  // Het pad hoort bij het id en komt dus van Dropbox zelf, niet uit de body.
  let inhoud;
  try {
    inhoud = await leesProjectmap(token, folderId);
  } catch (err) {
    const melding = err instanceof Error ? err.message.slice(0, 250) : "map niet te lezen";
    return NextResponse.json({ error: melding }, { status: /not_found|Geen map/.test(melding) ? 404 : 502 });
  }

  const gemaakt: string[] = [];
  const mislukt: { map: string; fout: string }[] = [];

  const gevraagd = Array.isArray(body?.mappen) ? body.mappen : [];
  const bestaat = new Set(inhoud.mappen.map((m) => m.toLowerCase()));
  for (const naam of gevraagd) {
    const standaard = PROJECT_SUBFOLDERS.find((s) => s.toLowerCase() === String(naam).trim().toLowerCase());
    if (!standaard) {
      mislukt.push({ map: String(naam), fout: "staat niet in de standaardindeling" });
      continue;
    }
    if (bestaat.has(standaard.toLowerCase())) continue;
    try {
      // Serieel: Dropbox geeft bij parallel schrijven 429
      // (too_many_write_operations), en dan is er niets aangemaakt.
      await createFolder(token, `${inhoud.pad}/${standaard}`);
      gemaakt.push(standaard);
    } catch (err) {
      mislukt.push({
        map: standaard,
        fout: err instanceof Error ? err.message.slice(0, 150) : "aanmaken mislukt",
      });
    }
  }

  let logboek: string | null = null;
  const regel = body?.logregel?.trim();
  if (regel) {
    try {
      const pad = `${inhoud.pad}/${LOGBOEK}`;
      const bestond = inhoud.bestanden.some((b) => b.pad.toLowerCase() === LOGBOEK.toLowerCase());
      const blob = bestond ? await downloadFile(token, pad).catch(() => null) : null;
      const eerder = blob ? await blob.text() : null;
      // Nieuwste bovenaan: wie dit bestand opent, wil weten wat er het laatst
      // gebeurd is en niet door een half jaar geschiedenis scrollen.
      const nieuw = eerder ? `${regel}\n\n---\n\n${eerder}` : regel;
      await uploadFile(token, pad, Buffer.from(nieuw, "utf8"));
      logboek = pad;
    } catch (err) {
      mislukt.push({
        map: LOGBOEK,
        fout: err instanceof Error ? err.message.slice(0, 150) : "logboek schrijven mislukt",
      });
    }
  }

  return NextResponse.json({ ok: true, pad: inhoud.pad, gemaakt, logboek, mislukt });
}
