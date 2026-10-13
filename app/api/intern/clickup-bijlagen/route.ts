import { NextResponse } from "next/server";
import { isInternRequest } from "@/lib/intern-auth";
import { getTaakVolledig, requireClickUpConfig } from "@/lib/clickup";
import { checkSaveUrlJob, createFolder, folderExists, getSharedAccessToken, leesProjectmap, saveUrl } from "@/lib/dropbox";
import { bijlagenUitVelden } from "@/lib/opname-velden";
import { doelVan, vrijeNaam, type BijlageDoel } from "@/lib/clickup-bijlagen";
import { HOOFDMAP, isProjectmap } from "@/lib/fotos-opruimen";

export const maxDuration = 300;

/** Zo heten de submappen als we ze zelf moeten aanmaken (lib/dropbox.ts PROJECT_SUBFOLDERS). */
const NIEUWE_NAAM: Record<BijlageDoel, string> = { "foto's": "Foto's", laz: "LAZ" };

/** Hoe lang we op Dropbox wachten voordat we antwoorden; daarna loopt het op de achtergrond door. */
const WACHT_MS = 60_000;

/**
 * Foto's en scans die alleen aan de ClickUp-taak hangen, in de projectmap zetten.
 *
 * Bij 47 van de 55 projecten die op 13 oktober op "foto's ontbreken" stonden,
 * lagen de foto's wel in ClickUp maar nooit als bestand in Dropbox. Welke
 * bijlage waarheen gaat staat in lib/clickup-bijlagen.ts.
 *
 * Dropbox haalt elk bestand zelf op bij ClickUp (save_url): er gaat geen byte
 * door deze functie, ook niet bij een puntenwolk van honderden megabytes.
 *
 * Grenzen: alleen een projectmap onder "Automatie Energielabels" (direct of in
 * "Afgerond"), aangewezen met zijn Dropbox-id; en nooit overschrijven. Staat er
 * ergens in de projectmap al een bestand met dezelfde naam, dan wordt die
 * bijlage overgeslagen — zo kan de route zo vaak draaien als nodig.
 */
export async function POST(request: Request) {
  if (!isInternRequest(request)) {
    return NextResponse.json({ error: "niet_toegestaan" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as { taskId?: string; folder_id?: string } | null;
  const taskId = body?.taskId?.trim() ?? "";
  const folderId = body?.folder_id?.trim() ?? "";
  if (!taskId) return NextResponse.json({ error: "taskId ontbreekt" }, { status: 400 });
  if (!/^id:[A-Za-z0-9_-]+$/.test(folderId)) {
    return NextResponse.json({ error: "folder_id (id:...) is verplicht" }, { status: 400 });
  }

  let token: string;
  let clickupToken: string;
  try {
    token = await getSharedAccessToken();
    ({ token: clickupToken } = await requireClickUpConfig());
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message.slice(0, 200) : "koppeling ontbreekt" },
      { status: 503 }
    );
  }

  let inhoud;
  try {
    inhoud = await leesProjectmap(token, folderId);
  } catch (err) {
    const status = err instanceof Error && err.message.includes("404") ? 404 : 502;
    return NextResponse.json({ error: err instanceof Error ? err.message.slice(0, 200) : "map niet te lezen" }, { status });
  }
  if (!isProjectmap(inhoud.pad)) {
    return NextResponse.json({ error: `alleen een projectmap onder /${HOOFDMAP} — kreeg "${inhoud.pad}"` }, { status: 400 });
  }

  let taak;
  try {
    taak = await getTaakVolledig(clickupToken, taskId);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message.slice(0, 200) : "taak niet te lezen" }, { status: 502 });
  }

  const bijlagen = bijlagenUitVelden(taak.customFields)
    .map((b) => ({ ...b, doel: doelVan(b) }))
    .filter((b): b is typeof b & { doel: BijlageDoel } => b.doel !== null);

  // Elke naam die al ergens in de projectmap staat, op kleine letters.
  const overal = new Set(inhoud.bestanden.map((b) => b.naam.toLowerCase()));
  const perMap: Record<BijlageDoel, Set<string>> = {
    "foto's": new Set(inhoud.bestanden.filter((b) => b.pad.toLowerCase().startsWith("foto's/")).map((b) => b.naam.toLowerCase())),
    laz: new Set(inhoud.bestanden.filter((b) => b.pad.toLowerCase().startsWith("laz/")).map((b) => b.naam.toLowerCase())),
  };

  const geplaatst: Record<BijlageDoel, string[]> = { "foto's": [], laz: [] };
  const overgeslagen: string[] = [];
  const mislukt: { naam: string; reden: string }[] = [];
  const jobs: { naam: string; doel: BijlageDoel; jobId: string }[] = [];
  const mapGemaakt = new Set<BijlageDoel>();

  for (const b of bijlagen) {
    if (overal.has(b.naam.toLowerCase())) {
      overgeslagen.push(b.naam);
      continue;
    }
    const bestaand = inhoud.mappen.find((m) => m.toLowerCase() === b.doel);
    const doelmap = bestaand ?? NIEUWE_NAAM[b.doel];
    if (!bestaand && !mapGemaakt.has(b.doel)) {
      try {
        await createFolder(token, `${inhoud.pad}/${doelmap}`);
      } catch {
        const bestaat = await folderExists(token, `${inhoud.pad}/${doelmap}`).catch(() => false);
        if (!bestaat) {
          mislukt.push({ naam: b.naam, reden: `kon de submap ${doelmap} niet aanmaken` });
          continue;
        }
      }
      mapGemaakt.add(b.doel);
    }

    const naam = vrijeNaam(b.naam, perMap[b.doel]);
    perMap[b.doel].add(naam.toLowerCase());
    overal.add(b.naam.toLowerCase());
    try {
      // Het origineel, niet de miniatuur: dit is het archief van de opname.
      const { done, jobId } = await saveUrl(token, `${inhoud.pad}/${doelmap}/${naam}`, b.url);
      if (done || !jobId) geplaatst[b.doel].push(naam);
      else jobs.push({ naam, doel: b.doel, jobId });
    } catch (err) {
      mislukt.push({ naam: b.naam, reden: err instanceof Error ? err.message.slice(0, 160) : "onbekende fout" });
    }
  }

  // Even wachten tot Dropbox klaar is, zodat de controle erna het ziet.
  const tot = Date.now() + WACHT_MS;
  let open = jobs;
  while (open.length > 0 && Date.now() < tot) {
    await new Promise((r) => setTimeout(r, 2_000));
    const nog: typeof jobs = [];
    for (const j of open) {
      const stand = await checkSaveUrlJob(token, j.jobId).catch(() => ({ status: "in_progress", error: null }));
      if (stand.status === "complete") geplaatst[j.doel].push(j.naam);
      else if (stand.status === "failed") mislukt.push({ naam: j.naam, reden: stand.error ?? "Dropbox kon het niet ophalen" });
      else nog.push(j);
    }
    open = nog;
  }

  return NextResponse.json({
    ok: mislukt.length === 0,
    pad: inhoud.pad,
    fotos: geplaatst["foto's"],
    scans: geplaatst.laz,
    bezig: open.map((j) => j.naam),
    overgeslagen,
    mislukt,
  });
}
