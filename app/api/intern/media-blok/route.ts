import { NextResponse } from "next/server";
import { isInternRequest } from "@/lib/intern-auth";
import {
  appendUploadSession,
  finishUploadSession,
  folderExists,
  getSharedAccessToken,
  startConcurrentUploadSession,
} from "@/lib/dropbox";
import { isMediaProjectmap, mediaDoelPad, type Schrijfsoort } from "@/lib/media-pad";

export const maxDuration = 60;

/**
 * Een groot mediabestand in blokken naar Dropbox, voor het control center.
 *
 * Een tijdelijke uploadlink (media-plaatsen) draagt hoogstens 150 MB, en een
 * 4K-clip van de gimbal is zo'n 25 MB per seconde: een clip van acht seconden
 * past er al niet meer door (5 oktober: 201 MB). Daarom hier dezelfde weg als
 * /api/dropbox/upload-chunk van het portaal — een "concurrent" upload-sessie,
 * blokken van 4 MB — maar achter het dienst-token van het control center en
 * met de padgrenzen van media-plaatsen.
 *
 *   ?actie=start  (JSON: projectmap, submap, bestandsnaam, soort) → { sessie }
 *   ?actie=blok&sessie=…&offset=…&sluit=0|1  (body: de bytes van het blok)
 *   ?actie=klaar  (JSON: sessie, grootte, projectmap, submap, bestandsnaam, soort)
 *
 * Het pad wordt bij start én bij klaar nagerekend: pas bij klaar ontstaat het
 * bestand, en daar mag geen ander pad doorheen glippen dan bij start.
 */
export async function POST(request: Request) {
  if (!isInternRequest(request)) {
    return NextResponse.json({ error: "niet_toegestaan" }, { status: 401 });
  }
  const url = new URL(request.url);
  const actie = url.searchParams.get("actie");

  try {
    const token = await getSharedAccessToken();

    if (actie === "blok") {
      const sessie = url.searchParams.get("sessie") ?? "";
      const offset = Number(url.searchParams.get("offset") ?? "NaN");
      if (!sessie || !Number.isFinite(offset) || offset < 0) {
        return NextResponse.json({ error: "sessie en offset zijn verplicht" }, { status: 400 });
      }
      const bytes = Buffer.from(await request.arrayBuffer());
      await appendUploadSession(token, sessie, offset, bytes, url.searchParams.get("sluit") === "1");
      return NextResponse.json({ ok: true });
    }

    const body = (await request.json().catch(() => null)) as {
      projectmap?: string;
      submap?: string;
      bestandsnaam?: string;
      soort?: string;
      sessie?: string;
      grootte?: number;
    } | null;
    const projectmap = body?.projectmap?.trim() ?? "";
    const soort: Schrijfsoort = body?.soort === "aanlevering" ? "aanlevering" : "oplevering";
    const pad = mediaDoelPad(projectmap, body?.submap?.trim() ?? "", body?.bestandsnaam ?? "", soort);
    if (!isMediaProjectmap(projectmap) || !pad) {
      return NextResponse.json({ error: "dit pad mag niet: projectmap, submap of bestandsnaam klopt niet" }, { status: 400 });
    }

    if (actie === "start") {
      if (!(await folderExists(token, projectmap))) {
        return NextResponse.json({ error: `de projectmap ${projectmap} bestaat niet` }, { status: 404 });
      }
      return NextResponse.json({ ok: true, sessie: await startConcurrentUploadSession(token), pad });
    }
    if (actie === "klaar") {
      const grootte = Number(body?.grootte);
      if (!body?.sessie || !Number.isFinite(grootte) || grootte <= 0) {
        return NextResponse.json({ error: "sessie en grootte zijn verplicht" }, { status: 400 });
      }
      await finishUploadSession(token, body.sessie, grootte, pad, Buffer.alloc(0));
      return NextResponse.json({ ok: true, pad });
    }
    return NextResponse.json({ error: "actie moet start, blok of klaar zijn" }, { status: 400 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message.slice(0, 300) : "uploaden mislukt" },
      { status: 502 }
    );
  }
}
