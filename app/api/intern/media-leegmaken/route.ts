import { NextResponse } from "next/server";
import { isInternRequest } from "@/lib/intern-auth";
import { DROPBOX_API_BASE, dropboxPost, folderExists, getSharedAccessToken, verwijderBatch } from "@/lib/dropbox";
import { isAanleverSubmap, isLeegmaakUitvoer, isMediaProjectmap } from "@/lib/media-pad";

export const maxDuration = 60;

/**
 * Eén aanlevermap van een adres leegmaken: In/Raw/Photo's, In/Raw/Video of
 * In/Raw/360.
 *
 * Waarvoor: Media → Uploaden in het control center, per kolom een knop "Map
 * leegmaken" — voor een shoot die in de verkeerde map of bij het verkeerde
 * adres terechtkwam. Smaller kan een wisrecht niet: alleen de bestanden in één
 * aanlevermap van een bestaande projectmap. De map zelf blijft staan, de
 * uitvoermappen (OUT) en de rest van het adres worden nooit geraakt.
 *
 * Met `soort: "uitvoer"` ook de uitvoer van de fotografie (OUT/Photo's en
 * OUT/_controle/Photo's), en dan alleen dat: zie LEEGMAAK_UITVOER. Dat is voor
 * een shoot die met andere instellingen opnieuw door Imagen gaat.
 *
 * Verwijderd is bij Dropbox niet weg: alles staat daarna in "Verwijderde
 * bestanden" en is terug te zetten. De route geeft de paden terug, zodat het
 * control center zijn eigen wachtrijen voor deze bestanden kan opruimen.
 */
export async function POST(request: Request) {
  if (!isInternRequest(request)) {
    return NextResponse.json({ error: "niet_toegestaan" }, { status: 401 });
  }
  const body = (await request.json().catch(() => null)) as { projectmap?: string; submap?: string; soort?: string } | null;
  const projectmap = body?.projectmap?.trim() ?? "";
  const submap = body?.submap?.trim() ?? "";
  const uitvoer = body?.soort === "uitvoer";

  if (!isMediaProjectmap(projectmap)) {
    return NextResponse.json({ error: `alleen een projectmap onder /Automatie Media — kreeg "${projectmap}"` }, { status: 400 });
  }
  if (uitvoer ? !isLeegmaakUitvoer(submap) : !isAanleverSubmap(submap)) {
    return NextResponse.json(
      {
        error: uitvoer
          ? `alleen OUT/Photo's, OUT/_controle/Photo's of OUT/Oplevering mag als uitvoer leeg — kreeg "${submap}"`
          : `alleen een aanlevermap (In/Raw/…) mag leeg — kreeg "${submap}"`,
      },
      { status: 400 }
    );
  }

  try {
    const token = await getSharedAccessToken();
    if (!(await folderExists(token, projectmap))) {
      return NextResponse.json({ error: `de projectmap ${projectmap} bestaat niet` }, { status: 404 });
    }
    const map = `${projectmap}/${submap}`;

    const paden: string[] = [];
    let res = await dropboxPost(token, "/files/list_folder", { path: map, recursive: true, limit: 2000 });
    for (;;) {
      if (!res.ok) {
        const tekst = await res.text().catch(() => "");
        // Bestaat de submap niet, dan is hij al leeg.
        if (res.status === 409 && tekst.includes("not_found")) break;
        throw new Error(`Dropbox list_folder gaf ${res.status}: ${tekst.slice(0, 200)}`);
      }
      const data = (await res.json()) as {
        entries: { ".tag": string; path_display?: string; path_lower?: string }[];
        cursor: string;
        has_more: boolean;
      };
      for (const e of data.entries) {
        if (e[".tag"] === "file") paden.push(e.path_display ?? e.path_lower ?? "");
      }
      if (!data.has_more) break;
      res = await fetch(`${DROPBOX_API_BASE}/files/list_folder/continue`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ cursor: data.cursor }),
      });
    }

    // Alleen wat écht onder deze ene aanlevermap ligt.
    const veilig = paden.filter((p) => p && p.toLowerCase().startsWith(`${map.toLowerCase()}/`));
    const uit = await verwijderBatch(token, veilig);
    return NextResponse.json({ ok: true, map, paden: veilig, ...uit });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message.slice(0, 300) : "leegmaken mislukt" },
      { status: 502 }
    );
  }
}
