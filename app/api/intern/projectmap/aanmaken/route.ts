import { NextResponse } from "next/server";
import { ensureProjectFolder, getMetadata, getSharedAccessToken } from "@/lib/dropbox";
import { isInternRequest } from "@/lib/intern-auth";
import { maakProjectmap } from "@/lib/projectmap-aanmaken";
import { zoekKandidaten } from "@/lib/projectmap-zoeken";

// Zoeken over vier locaties, dan de map met sjabloon, Bijlage G en straatbeeld.
export const maxDuration = 120;

/**
 * Een energielabel-projectmap voor een opdracht die er nog geen heeft.
 *
 * Verwacht `{ taskId, adres, naam }` van het control center en geeft
 * `{ ok, pad, folder_id, url, bestond, reden }` terug. Een weigering (ongeldig
 * adres, meer dan één bestaande map) is een gewoon antwoord met `ok: false` en
 * de reden erbij; een storing bij Dropbox een 502.
 *
 * Maakt nooit een tweede map naast een bestaande: zie lib/projectmap-aanmaken.
 */
export async function POST(request: Request) {
  if (!isInternRequest(request)) {
    return NextResponse.json({ error: "niet_toegestaan" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as {
    taskId?: string;
    adres?: string;
    naam?: string;
  } | null;
  if (!body?.adres?.trim() && !body?.naam?.trim()) {
    return NextResponse.json({ error: "adres is verplicht" }, { status: 400 });
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
    const uitkomst = await maakProjectmap(
      { naam: body.naam, adres: body.adres },
      {
        zoekKandidaten: (mapnaam) => zoekKandidaten(token, mapnaam),
        maakMap: (woonplaats, straatEnNummer) =>
          ensureProjectFolder("energielabel", woonplaats, straatEnNummer),
        idVan: async (pad) => (await getMetadata(token, pad))?.id ?? null,
      }
    );
    if (uitkomst.ok) {
      console.log(
        `projectmap/aanmaken: ${body.taskId ?? "?"} → ${uitkomst.pad} (${uitkomst.bestond ? "bestond al" : "nieuw"})`
      );
    }
    return NextResponse.json(uitkomst);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message.slice(0, 250) : "map aanmaken mislukt" },
      { status: 502 }
    );
  }
}
