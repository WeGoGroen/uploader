import { NextResponse } from "next/server";
import { isInternRequest } from "@/lib/intern-auth";
import { getOrCreateSharedLink, getSharedAccessToken, listFilePathsRecursive } from "@/lib/dropbox";

export const maxDuration = 60;

/**
 * Maakt (of vindt) een deelbare Dropbox-link voor een projectmap.
 *
 * Bewust alleen voor mappen met inhoud: een link naar een lege map sturen is
 * erger dan geen link — de klant klikt, ziet niets, en belt.
 *
 * `getOrCreateSharedLink` maakt er nooit een tweede aan; bestaat er al een, dan
 * komt dezelfde terug. De klant kan de link dus houden en de map groeit onder
 * hem door.
 */
export async function POST(request: Request) {
  if (!isInternRequest(request)) {
    return NextResponse.json({ error: "niet_toegestaan" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as { pad?: string } | null;
  const pad = body?.pad?.trim() ?? "";
  if (!pad.startsWith("/")) {
    return NextResponse.json({ error: "pad ontbreekt of is ongeldig" }, { status: 400 });
  }

  const token = await getSharedAccessToken();

  /**
   * Recursief tellen, niet alleen wat er los in de map ligt.
   *
   * Een energielabelmap heeft álles in submappen — LAZ, Foto's, Opname
   * formulier — en is aan de bovenkant dus altijd "leeg". Met een platte
   * telling kregen veertien van de vijftien complete mappen geen link, terwijl
   * ze juist de opleveringen waren.
   */
  const bestanden = await listFilePathsRecursive(token, pad).catch(() => []);
  if (bestanden.length === 0) {
    return NextResponse.json(
      { error: "de map is leeg — geen link gemaakt", pad, aantal: 0 },
      { status: 422 }
    );
  }

  try {
    const link = await getOrCreateSharedLink(token, pad);
    return NextResponse.json({ ok: true, pad, link, aantal: bestanden.length });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message.slice(0, 200) : "link maken mislukt" },
      { status: 502 }
    );
  }
}
