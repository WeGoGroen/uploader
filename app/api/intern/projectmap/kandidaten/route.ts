import { NextResponse } from "next/server";
import { getSharedAccessToken } from "@/lib/dropbox";
import { isInternRequest } from "@/lib/intern-auth";
import { zoekKandidaten } from "@/lib/projectmap-zoeken";

export const maxDuration = 120;

/**
 * Welke mappen zouden bij dit adres kunnen horen?
 *
 * Alle treffers, uit alle locaties: de automatie-map, het archief daaronder en
 * de oude handmatige indeling per maand. Er wordt hier bewust niet gekozen — de
 * fout die deze route moet voorkomen is dat een oude map wordt hergebruikt en
 * de stukken van één opdracht over twee mappen verspreid raken. Kiezen doet een
 * mens in het control center; die keuze wordt daar vastgelegd.
 *
 * Leest alleen.
 */
export async function POST(request: Request) {
  if (!isInternRequest(request)) {
    return NextResponse.json({ error: "niet_toegestaan" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as { adres?: string } | null;
  const adres = body?.adres?.trim() ?? "";
  if (adres.length < 4) {
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
    const kandidaten = await zoekKandidaten(token, adres);
    return NextResponse.json({ ok: true, kandidaten });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message.slice(0, 250) : "zoeken mislukt" },
      { status: 502 }
    );
  }
}
