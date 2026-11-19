import { NextResponse } from "next/server";
import { isInternRequest } from "@/lib/intern-auth";
import { folderExists, getSharedAccessToken, verwijderBatch } from "@/lib/dropbox";
import { fotoVerwijderPad, isMediaProjectmap } from "@/lib/media-pad";

export const maxDuration = 60;

/** Meer dan dit is geen losse foto meer: dan hoort het via "map leegmaken". */
const MAX_BESTANDEN = 60;

/**
 * Losse fotobestanden van één adres verwijderen, op naam.
 *
 * Waarvoor: de fotografie-projectpagina van het control center heeft per
 * eindfoto een knop "Verwijderen". Het control center weet waar die foto overal
 * staat (de eindfoto, Imagens versie, de varianten, de opgeleverde kopie) en
 * stuurt precies die namen; deze route haalt ze weg.
 *
 * Smal, met opzet: alleen een bestaande projectmap onder Automatie Media,
 * alleen de fotomappen onder OUT (FOTO_VERWIJDER_SUBMAPPEN), alleen beeld, en
 * elke naam precies zoals gegeven — geen jokers, geen mappen. Een pad dat niet
 * deugt laat het hele verzoek mislukken, zodat er nooit "de helft" gebeurt.
 *
 * Verwijderd is bij Dropbox niet weg: het staat daarna in "Verwijderde
 * bestanden" en is terug te zetten. Een naam die er niet (meer) staat telt als
 * `nietGevonden`, niet als fout: de varianten bestaan lang niet bij elke foto.
 */
export async function POST(request: Request) {
  if (!isInternRequest(request)) {
    return NextResponse.json({ error: "niet_toegestaan" }, { status: 401 });
  }
  const body = (await request.json().catch(() => null)) as {
    projectmap?: string;
    bestanden?: { submap?: string; bestandsnaam?: string }[];
  } | null;
  const projectmap = body?.projectmap?.trim() ?? "";
  const bestanden = Array.isArray(body?.bestanden) ? body.bestanden : [];

  if (!isMediaProjectmap(projectmap)) {
    return NextResponse.json({ error: `alleen een projectmap onder /Automatie Media — kreeg "${projectmap}"` }, { status: 400 });
  }
  if (bestanden.length === 0 || bestanden.length > MAX_BESTANDEN) {
    return NextResponse.json({ error: `tussen 1 en ${MAX_BESTANDEN} bestanden — kreeg ${bestanden.length}` }, { status: 400 });
  }
  const paden: string[] = [];
  for (const b of bestanden) {
    const submap = String(b?.submap ?? "").trim();
    const naam = String(b?.bestandsnaam ?? "");
    const pad = fotoVerwijderPad(projectmap, submap, naam);
    if (!pad) {
      return NextResponse.json({ error: `"${submap}/${naam}" mag niet verwijderd worden (alleen beeld in de fotomappen onder OUT)` }, { status: 400 });
    }
    if (!paden.some((p) => p.toLowerCase() === pad.toLowerCase())) paden.push(pad);
  }

  try {
    const token = await getSharedAccessToken();
    if (!(await folderExists(token, projectmap))) {
      return NextResponse.json({ error: `de projectmap ${projectmap} bestaat niet` }, { status: 404 });
    }
    const uit = await verwijderBatch(token, paden);
    // delete_batch geeft per regel succes of een fout; de fout is hier vrijwel altijd not_found.
    return NextResponse.json({ ok: true, paden, verwijderd: uit.verwijderd, nietGevonden: uit.mislukt, bezig: uit.bezig });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message.slice(0, 300) : "verwijderen mislukt" }, { status: 502 });
  }
}
