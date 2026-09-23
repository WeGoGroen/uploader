import { NextResponse } from "next/server";
import {
  DropboxApiError,
  dropboxThuispad,
  getSharedAccessToken,
  leesProjectmap,
  maakSubmappen,
} from "@/lib/dropbox";
import { MEDIA_STAPPEN } from "@/lib/media-folders";
import { dropboxWebUrl, telPerStap, type StapInhoud } from "@/lib/media-inhoud";
import { isMediaProjectmap } from "@/lib/media-pad";

export const maxDuration = 30;

/**
 * Wat er per stap van een media-opname in Dropbox staat, plus per stap de link
 * die de map in de Dropbox-app opent.
 *
 * Hiermee kan de opnemer aanleveren via de Dropbox-app — die uploadt op de
 * achtergrond door, met het scherm uit en de iPad in de tas, wat een
 * webpagina niet kan — zonder dat de uploader blind wordt voor wat er
 * binnenkomt. De pagina vraagt dit periodiek op zolang hij in beeld is.
 *
 * Alleen voor een projectmap onder "Automatie Media", met dezelfde controle als
 * /api/intern/media-plaatsen. Anders was dit een manier om elke map in de
 * bedrijfs-Dropbox te laten uitlezen.
 *
 * Eén bewust schrijvend randje: ontbreken de stapmappen (een opname van vóór
 * de indeling "In/Raw/…"), dan worden ze aangemaakt. De link hieronder moet op
 * een bestaande map uitkomen, en de uploader zelf schrijft ook naar precies
 * die mappen. Staan ze er, dan gebeurt er niets.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { projectmap?: unknown } | null;
  const projectmap = typeof body?.projectmap === "string" ? body.projectmap.trim() : "";

  if (!isMediaProjectmap(projectmap)) {
    return NextResponse.json(
      { error: `alleen een projectmap onder /Automatie Media — kreeg "${projectmap}"` },
      { status: 400 }
    );
  }

  let token: string;
  try {
    token = await getSharedAccessToken();
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Dropbox niet gekoppeld" },
      { status: 503 }
    );
  }

  try {
    const inhoud = await leesProjectmap(token, projectmap);

    // Elke laag van elke stapmap die er nog niet is ("In", "In/Raw", …).
    const bestaand = new Set(inhoud.mappen.map((m) => m.toLowerCase()));
    const ontbreekt = new Set<string>();
    for (const stap of MEDIA_STAPPEN) {
      const delen = stap.map.split("/");
      for (let i = 1; i <= delen.length; i++) {
        const laag = delen.slice(0, i).join("/");
        if (!bestaand.has(laag.toLowerCase())) ontbreekt.add(laag);
      }
    }
    if (ontbreekt.size > 0) await maakSubmappen(token, inhoud.pad, [...ontbreekt]);

    // Zonder thuispad geen link, maar de telling blijft wél bruikbaar.
    const thuispad = await dropboxThuispad(token).catch(() => null);
    const telling = telPerStap(inhoud.bestanden);
    const stappen = {} as Record<string, StapInhoud & { webUrl: string | null }>;
    for (const stap of MEDIA_STAPPEN) {
      stappen[stap.key] = {
        ...telling[stap.key],
        webUrl: thuispad === null ? null : dropboxWebUrl(thuispad, `${inhoud.pad}/${stap.map}`),
      };
    }

    return NextResponse.json(
      { pad: inhoud.pad, stappen },
      { headers: { "Cache-Control": "no-store, private" } }
    );
  } catch (err) {
    if (err instanceof DropboxApiError && err.status === 404) {
      return NextResponse.json({ error: "Deze projectmap bestaat niet (meer)." }, { status: 404 });
    }
    console.error("[MEDIA-INHOUD] uitlezen mislukt", {
      projectmap,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Dropbox kon niet worden uitgelezen" }, { status: 502 });
  }
}
