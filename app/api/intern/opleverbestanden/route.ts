import { NextResponse } from "next/server";
import { isInternRequest } from "@/lib/intern-auth";
import { getSharedAccessToken, listFolderWithTemporaryLinks } from "@/lib/dropbox";

export const maxDuration = 60;

/**
 * De inhoud van één opleveringsmap in Dropbox, met een tijdelijke link per
 * bestand.
 *
 * Voor het beoordelen van een oplevering in het control center: daar wil je
 * zien wat er écht in de map staat die naar de makelaar gaat, niet wat
 * Mediatask beweert te hebben geleverd. Dat zijn meestal dezelfde bestanden,
 * maar als ze uit elkaar lopen is dít de kant die telt.
 *
 * De links zijn vier uur geldig en laten niets achter; er wordt niets gedeeld
 * en niets gewijzigd.
 */
export async function GET(request: Request) {
  if (!isInternRequest(request)) {
    return NextResponse.json({ error: "niet_toegestaan" }, { status: 401 });
  }

  const pad = new URL(request.url).searchParams.get("pad") ?? "";
  if (!pad.startsWith("/")) {
    return NextResponse.json({ error: "pad ontbreekt" }, { status: 400 });
  }

  try {
    const token = await getSharedAccessToken();
    const bestanden = await listFolderWithTemporaryLinks(token, pad);
    return NextResponse.json({ pad, bestanden });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message.slice(0, 200) : "map niet te lezen" },
      { status: 502 }
    );
  }
}
