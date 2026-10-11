import { NextResponse } from "next/server";
import { isInternRequest } from "@/lib/intern-auth";
import { dropboxPost, getMetadata, getSharedAccessToken } from "@/lib/dropbox";
import { isMediaProjectmap, mediaHernoemPaden } from "@/lib/media-pad";

export const maxDuration = 120;

/**
 * Eindfoto's hernoemen binnen OUT/Photo's: `{ projectmap, submap, hernoem: [{ van, naar }] }`.
 *
 * Het control center zet de eindfoto's van Imagen om naar "<adres> - <ruimte>
 * <nummer>.jpg" zodra bekend is wat erop staat. Als reeks en in twee stappen,
 * en dat is het punt van deze route:
 *
 *  1. eerst elke foto naar een tijdelijke naam;
 *  2. dan van de tijdelijke naar de eindnaam.
 *
 * Eén voor één gaat het mis zodra namen van plek wisselen: verandert een
 * keuken van tag, dan moet "Keuken 2" "Keuken 1" worden terwijl die naam nog
 * bezet is. Overschrijven doet deze route nooit — er gaat dan een eindfoto
 * verloren — dus zonder tussenstap zou zo'n reeks halverwege vastlopen.
 *
 * Grenzen, net als bij media-plaatsen: alleen een projectmap onder Automatie
 * Media, alleen in OUT/Photo's, alleen gewone beeldnamen, nooit naar een naam
 * die al bezet is door een bestand dat zelf niet meeverhuist.
 *
 * Het antwoord zegt per regel of hij gelukt is. Halverwege mislukt is geen
 * geheel-of-niets: wat al verplaatst is, staat er, en dat moet de aanroeper
 * weten om zijn eigen administratie gelijk te houden met Dropbox.
 */
export async function POST(request: Request) {
  if (!isInternRequest(request)) {
    return NextResponse.json({ error: "niet_toegestaan" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as {
    projectmap?: string;
    submap?: string;
    hernoem?: { van?: string; naar?: string }[];
  } | null;
  const projectmap = body?.projectmap?.trim() ?? "";
  const submap = body?.submap?.trim() ?? "";
  if (!isMediaProjectmap(projectmap)) {
    return NextResponse.json(
      { error: `alleen een projectmap onder /Automatie Media — kreeg "${projectmap}"` },
      { status: 400 }
    );
  }

  const lijst = (body?.hernoem ?? []).filter((r) => r?.van && r?.naar && r.van !== r.naar);
  if (lijst.length === 0) return NextResponse.json({ ok: true, uitslag: [] });
  if (lijst.length > 300) {
    return NextResponse.json({ error: "meer dan 300 bestanden in één keer" }, { status: 400 });
  }

  const paden = lijst.map((r) => mediaHernoemPaden(projectmap, submap, String(r.van), String(r.naar)));
  const fout = paden.findIndex((p) => !p);
  if (fout >= 0) {
    return NextResponse.json(
      {
        error:
          `"${lijst[fout].van}" → "${lijst[fout].naar}" mag niet: alleen gewone beeldnamen, ` +
          `en alleen binnen OUT/Photo's`,
      },
      { status: 400 }
    );
  }
  const reeks = paden as { van: string; naar: string }[];

  // Twee keer dezelfde eindnaam zou de tweede foto laten verdwijnen.
  const doelen = new Set(reeks.map((p) => p.naar.toLowerCase()));
  if (doelen.size !== reeks.length) {
    return NextResponse.json({ error: "twee bestanden zouden dezelfde naam krijgen" }, { status: 400 });
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

  /*
    Bezet door een bestand dat niet meeverhuist: weigeren vóór er iets
    verplaatst is. Dropbox kijkt niet naar hoofdletters, dus wij ook niet.
  */
  const verhuist = new Set(reeks.map((p) => p.van.toLowerCase()));
  try {
    for (const p of reeks) {
      if (verhuist.has(p.naar.toLowerCase())) continue;
      if (await getMetadata(token, p.naar)) {
        return NextResponse.json(
          { error: `${p.naar.slice(p.naar.lastIndexOf("/") + 1)} bestaat al — er wordt niets overschreven` },
          { status: 409 }
        );
      }
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message.slice(0, 200) : "Dropbox niet te bevragen" },
      { status: 502 }
    );
  }

  const verplaats = async (van: string, naar: string) => {
    const res = await dropboxPost(token, "/files/move_v2", { from_path: van, to_path: naar, autorename: false });
    if (!res.ok) throw new Error(`move ${res.status}: ${(await res.text().catch(() => "")).slice(0, 150)}`);
  };

  const stempel = Date.now().toString(36);
  const uitslag: { van: string; naar: string; gelukt: boolean; fout?: string }[] = [];
  const tijdelijk: (string | null)[] = [];

  // Stap 1: alles naar een tijdelijke naam in dezelfde map.
  for (let i = 0; i < reeks.length; i++) {
    const p = reeks[i];
    const map = p.van.slice(0, p.van.lastIndexOf("/"));
    const tmp = `${map}/.hernoem-${stempel}-${i}${p.van.slice(p.van.lastIndexOf("."))}`;
    try {
      await verplaats(p.van, tmp);
      tijdelijk.push(tmp);
    } catch (err) {
      tijdelijk.push(null);
      uitslag[i] = { van: lijst[i].van!, naar: lijst[i].naar!, gelukt: false, fout: err instanceof Error ? err.message : "mislukt" };
    }
  }

  // Stap 2: van de tijdelijke naam naar de eindnaam. Lukt dat niet, dan terug
  // naar de oude naam, zodat er nooit een foto onder een tijdelijke naam blijft.
  for (let i = 0; i < reeks.length; i++) {
    const tmp = tijdelijk[i];
    if (!tmp) continue;
    try {
      await verplaats(tmp, reeks[i].naar);
      uitslag[i] = { van: lijst[i].van!, naar: lijst[i].naar!, gelukt: true };
    } catch (err) {
      await verplaats(tmp, reeks[i].van).catch(() => {});
      uitslag[i] = { van: lijst[i].van!, naar: lijst[i].naar!, gelukt: false, fout: err instanceof Error ? err.message : "mislukt" };
    }
  }

  const mislukt = uitslag.filter((u) => !u.gelukt).length;
  return NextResponse.json({ ok: mislukt === 0, uitslag }, { status: mislukt === 0 ? 200 : 207 });
}
