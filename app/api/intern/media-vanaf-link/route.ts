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
 *
 * Met `bestanden` erbij verdeelt de route in plaats daarvan een hele shoot:
 * per bestand (uit media-link-lezen) de submap die het control center koos —
 * In/Raw/Photo's, In/Raw/Video of In/Raw/360. Dat is Media → Uploaden, waar een
 * link net als een upload over drie kolommen uiteen gaat. Dezelfde grenzen: de
 * submap moet een aanlevermap zijn en het bestand moet daar passen
 * (mediaDoelPad), en de bron moet in de gedeelde map zelf liggen.
 */
export async function POST(request: Request) {
  if (!isInternRequest(request)) {
    return NextResponse.json({ error: "niet_toegestaan" }, { status: 401 });
  }
  const body = (await request.json().catch(() => null)) as {
    projectmap?: string;
    link?: string;
    bestanden?: { naam?: string; pad?: string | null; submap?: string }[];
  } | null;
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

    if (Array.isArray(body?.bestanden)) {
      return NextResponse.json(await verdeel(token, projectmap, link, inhoud, body.bestanden));
    }

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

type Keuze = { naam?: string; pad?: string | null; submap?: string };
type Geplaatst = { naam: string; submap: string; pad: string; uitkomst: "gekopieerd" | "bestond" | "bezig" };

/**
 * Een shoot uit één link over de aanlevermappen verdelen.
 *
 * Zes tegelijk: copy_v2 is per bestand een fractie van een seconde, maar
 * driehonderd foto's achter elkaar passen niet in de minuut van deze functie.
 * Een bestand dat niet mag of niet lukt, houdt de rest niet tegen; het komt
 * terug onder `overgeslagen`, met de reden.
 */
async function verdeel(
  token: string,
  projectmap: string,
  link: string,
  inhoud: Awaited<ReturnType<typeof leesDeellink>>,
  keuzes: Keuze[]
) {
  const geplaatst: Geplaatst[] = [];
  const overgeslagen: { naam: string; reden: string }[] = [];

  if (!inhoud.pad) {
    if (inhoud.soort === "folder") throw new Error("deze map staat in een ander Dropbox-account; daar kan alleen een zip van");
    // Een los bestand van buiten: één keuze, Dropbox haalt hem zelf op.
    const keuze = keuzes[0];
    const submap = keuze?.submap?.trim() ?? "";
    const doel = mediaDoelPad(projectmap, submap, inhoud.naam, "aanlevering");
    if (!doel) return { ok: true, geplaatst, overgeslagen: [{ naam: inhoud.naam, reden: `past niet in ${submap}` }] };
    const job = await saveUrl(token, doel, directeDownload(link));
    let klaar = job.done;
    for (let i = 0; !klaar && job.jobId && i < 10; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const s = await checkSaveUrlJob(token, job.jobId);
      if (s.status === "failed") throw new Error(`Dropbox kon ${inhoud.naam} niet ophalen: ${s.error ?? "onbekend"}`);
      klaar = s.status === "complete";
    }
    geplaatst.push({ naam: inhoud.naam, submap, pad: doel, uitkomst: klaar ? "gekopieerd" : "bezig" });
    return { ok: true, geplaatst, overgeslagen };
  }

  const basis = inhoud.pad.toLowerCase().replace(/\/+$/, "");
  const werk = keuzes.slice(0, 1500);
  let volgende = 0;
  const werker = async () => {
    for (;;) {
      const k = werk[volgende++];
      if (!k) return;
      const naam = (k.naam ?? "").trim();
      const bron = (k.pad ?? "").trim();
      const submap = (k.submap ?? "").trim();
      // De bron moet in de gedeelde map liggen, en de naam moet bij dat pad horen
      // (het pad is in kleine letters, de naam houdt zijn schrijfwijze).
      const binnen =
        !bron.includes("..") &&
        (bron.toLowerCase() === basis || bron.toLowerCase().startsWith(`${basis}/`)) &&
        bron.toLowerCase().split("/").pop() === naam.toLowerCase();
      const doel = binnen ? mediaDoelPad(projectmap, submap, naam, "aanlevering") : null;
      if (!doel) {
        overgeslagen.push({ naam: naam || bron, reden: binnen ? `past niet in ${submap}` : "ligt niet in deze link" });
        continue;
      }
      try {
        const uit = await kopieer(token, bron, doel);
        geplaatst.push({ naam, submap, pad: doel, uitkomst: uit });
      } catch (err) {
        overgeslagen.push({ naam, reden: err instanceof Error ? err.message.slice(0, 160) : "kopiëren mislukt" });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, werk.length) }, () => werker()));
  return { ok: true, geplaatst, overgeslagen };
}
