import { NextResponse } from "next/server";
import { isInternRequest } from "@/lib/intern-auth";
import { ensureProjectFolder } from "@/lib/dropbox";

export const maxDuration = 60;

/**
 * De mediaprojectmap van een adres: de bestaande, of een nieuwe.
 *
 * Voor het control center, dat omgevingsfoto's bij een adres zet — ook bij een
 * adres waar de fotograaf nog niet geweest is. /api/intern/media-plaatsen maakt
 * met opzet nooit een map aan (een tweede map naast de echte verspreidt de
 * stukken). Deze route doet dat wél, maar via precies dezelfde functie als de
 * opname in deze app: ensureProjectFolder zoekt eerst naar een bestaande map
 * onder elke schrijfwijze (ook in het archief), en maakt pas als die er niet
 * is de canonieke map met het vaste sjabloon. Wie hier later een opname start,
 * komt dus in dezelfde map uit.
 */
export async function POST(request: Request) {
  if (!isInternRequest(request)) {
    return NextResponse.json({ error: "niet_toegestaan" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as {
    woonplaats?: string;
    straatEnNummer?: string;
  } | null;
  const woonplaats = body?.woonplaats?.trim() ?? "";
  const straatEnNummer = body?.straatEnNummer?.trim() ?? "";
  // Een huisnummer is verplicht: zonder wordt het een map per straat, en daar
  // hoort geen opname in.
  if (!woonplaats || !/\d/.test(straatEnNummer)) {
    return NextResponse.json({ error: "woonplaats en straat met huisnummer zijn verplicht" }, { status: 400 });
  }

  try {
    const map = await ensureProjectFolder("media", woonplaats, straatEnNummer);
    if (!map) return NextResponse.json({ error: "Dropbox niet gekoppeld" }, { status: 503 });
    return NextResponse.json({ ok: true, pad: map.path });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message.slice(0, 200) : "map aanmaken mislukt" },
      { status: 502 }
    );
  }
}
