import { NextResponse } from "next/server";
import { isInternRequest } from "@/lib/intern-auth";
import {
  checkSaveUrlJob,
  directeDownload,
  folderExists,
  getSharedAccessToken,
  kopieer,
  leesDeellink,
  listFolderFiles,
  saveUrl,
} from "@/lib/dropbox";
import { isMediaProjectmap, mediaDoelPad } from "@/lib/media-pad";

export const maxDuration = 60;

/** Waar aangeleverde clips heen gaan; zie AANLEVER_SUBMAPPEN. */
const SUBMAP = "In/Raw/Video";

/**
 * Clips uit een Dropbox-deellink in <projectmap>/In/Raw/Video zetten.
 *
 * Waarvoor: het aanleverscherm in het control center (Media → Video). Clips
 * die al in Dropbox staan hoeven dan niet eerst gedownload en opnieuw
 * geüpload te worden — en een clip van meer dan 150 MB past niet door een
 * tijdelijke uploadlink, maar wel door een kopie.
 *
 * Twee wegen, en Dropbox doet in beide het werk; er gaat geen byte langs deze
 * server:
 *  - de link wijst naar iets in dít account (een map van de opnemer, een
 *    eerdere opname): files/copy_v2, meteen klaar, ook voor een hele map;
 *  - een losse bestandslink van buiten: files/save_url, Dropbox haalt hem zelf
 *    op. Een map van buiten kan niet — die is via de API alleen als zip te
 *    krijgen — en dat zegt de route dan ook.
 *
 * Alleen video, alleen naar In/Raw/Video, alleen in een projectmap die al
 * bestaat: dezelfde grenzen als media-plaatsen met soort "aanlevering".
 * Bestaat een clip op het doel al, dan blijft die staan.
 */
export async function POST(request: Request) {
  if (!isInternRequest(request)) {
    return NextResponse.json({ error: "niet_toegestaan" }, { status: 401 });
  }
  const body = (await request.json().catch(() => null)) as { projectmap?: string; link?: string } | null;
  const projectmap = body?.projectmap?.trim() ?? "";
  const link = body?.link?.trim() ?? "";

  if (!isMediaProjectmap(projectmap)) {
    return NextResponse.json({ error: `alleen een projectmap onder /Automatie Media — kreeg "${projectmap}"` }, { status: 400 });
  }
  if (!/^https:\/\/(www\.)?dropbox\.com\/(scl\/f[io]|s|sh)\//.test(link)) {
    return NextResponse.json({ error: "dit is geen Dropbox-deellink" }, { status: 400 });
  }

  try {
    const token = await getSharedAccessToken();
    if (!(await folderExists(token, projectmap))) {
      return NextResponse.json({ error: `de projectmap ${projectmap} bestaat niet` }, { status: 404 });
    }
    const inhoud = await leesDeellink(token, link);

    const gekopieerd: string[] = [];
    const bestonden: string[] = [];
    const bezig: string[] = [];
    const overgeslagen: { naam: string; reden: string }[] = [];

    if (inhoud.pad) {
      // In dit account: kopiëren, map of bestand.
      const bronnen =
        inhoud.soort === "folder"
          ? (await listFolderFiles(token, inhoud.pad)).map((f) => ({ naam: f.name, pad: `${inhoud.pad}/${f.name}` }))
          : [{ naam: inhoud.naam, pad: inhoud.pad }];
      for (const b of bronnen) {
        const doel = mediaDoelPad(projectmap, SUBMAP, b.naam, "aanlevering");
        if (!doel) {
          overgeslagen.push({ naam: b.naam, reden: "geen video" });
          continue;
        }
        const uit = await kopieer(token, b.pad, doel);
        (uit === "bestond" ? bestonden : gekopieerd).push(b.naam);
      }
    } else if (inhoud.soort === "folder") {
      return NextResponse.json(
        {
          error:
            "deze map staat in een ander Dropbox-account; daar kan alleen een zip van. Deel de clips los, of zet ze in een map in het WeGoGroen-Dropbox",
        },
        { status: 422 }
      );
    } else {
      // Een los bestand van buiten: Dropbox haalt het zelf op.
      const doel = mediaDoelPad(projectmap, SUBMAP, inhoud.naam, "aanlevering");
      if (!doel) {
        overgeslagen.push({ naam: inhoud.naam, reden: "geen video" });
      } else {
        const job = await saveUrl(token, doel, directeDownload(link));
        let klaar = job.done;
        // Hooguit een halve minuut wachten; daarna zet Dropbox hem op de achtergrond neer.
        for (let i = 0; !klaar && job.jobId && i < 10; i++) {
          await new Promise((r) => setTimeout(r, 3000));
          const s = await checkSaveUrlJob(token, job.jobId);
          if (s.status === "failed") throw new Error(`Dropbox kon ${inhoud.naam} niet ophalen: ${s.error ?? "onbekend"}`);
          klaar = s.status === "complete";
        }
        (klaar ? gekopieerd : bezig).push(inhoud.naam);
      }
    }

    return NextResponse.json({ ok: true, gekopieerd, bestonden, bezig, overgeslagen });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message.slice(0, 300) : "de link kon niet worden gelezen" },
      { status: 502 }
    );
  }
}
