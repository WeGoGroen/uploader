import { NextResponse } from "next/server";
import { isInternRequest } from "@/lib/intern-auth";
import { getSharedAccessToken, listFolderFiles, verplaatsBatch } from "@/lib/dropbox";
import { isMediaProjectmap, mediaHernoemPaden } from "@/lib/media-pad";

export const maxDuration = 120;

/**
 * Eindfoto's hernoemen binnen één map uit HERNOEM_SUBMAPPEN (OUT/Photo's, OUT/360
 * en de controleversies ernaast): `{ projectmap, submap, hernoem: [{ van, naar }] }`.
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
 * Beide stappen gaan als batch naar Dropbox (files/move_batch_v2), zodat ook
 * vijftig foto's binnen seconden klaar zijn.
 *
 * Grenzen, net als bij media-plaatsen: alleen een projectmap onder Automatie
 * Media, alleen in OUT/Photo's of OUT/360, alleen gewone beeldnamen, nooit naar een naam
 * die al bezet is door een bestand dat zelf niet meeverhuist.
 *
 * Alleen als namen echt van plek wisselen. Krijgt geen enkele foto een naam
 * die een andere foto nu nog heeft (de gewone eerste keer: "EXP_…" wordt
 * "Adres - Keuken"), dan gaat het in één stap. Op 19 oktober deed Dropbox
 * bij Nieuwe Keizersgracht 474 ruim een minuut over stap 1; de route gaf op,
 * stap 2 kwam nooit, en vijf 360's bleven als ".hernoem-…" staan — waarna het
 * control center ze niet meer kon openen. In één stap eindigt een trage
 * batch gewoon op de eindnaam.
 *
 * En herhaalbaar: staat "van" er niet meer maar "naar" wel, dan is hij al
 * hernoemd (een eerdere, trage ronde) en telt hij als gelukt. Zo trekt de
 * volgende ronde de administratie van het control center vanzelf recht.
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
          `en alleen binnen OUT/Photo's of OUT/360`,
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
    verplaatst is. Eén listing van de map in plaats van een vraag per bestand —
    alle doelen staan in dezelfde map. Dropbox kijkt niet naar hoofdletters,
    dus wij ook niet.
  */
  const map = reeks[0].naar.slice(0, reeks[0].naar.lastIndexOf("/"));
  const verhuist = new Set(reeks.map((p) => p.van.toLowerCase()));
  let bezet: Set<string>;
  try {
    bezet = new Set((await listFolderFiles(token, map)).map((b) => `${map}/${b.name}`.toLowerCase()));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message.slice(0, 200) : "Dropbox niet te bevragen" },
      { status: 502 }
    );
  }
  // Al hernoemd door een eerdere ronde: van is weg, naar staat er.
  const alKlaar = (p: { van: string; naar: string }) => !bezet.has(p.van.toLowerCase()) && bezet.has(p.naar.toLowerCase());
  {
    for (const p of reeks) {
      if (alKlaar(p)) continue;
      if (verhuist.has(p.naar.toLowerCase()) || !bezet.has(p.naar.toLowerCase())) continue;
      return NextResponse.json(
        { error: `${p.naar.slice(p.naar.lastIndexOf("/") + 1)} bestaat al — er wordt niets overschreven` },
        { status: 409 }
      );
    }
  }

  /*
    Beide stappen als batch (files/move_batch_v2): één schrijfactie per stap,
    klaar in seconden. Achter elkaar met move_v2 kostte het ruim een seconde per
    foto per stap — bij 44 foto's langer dan het control center wacht.
  */
  const foutVan = (u: unknown, standaard: string) =>
    typeof u === "object" && u && "fout" in u ? String((u as { fout: string }).fout) : standaard;
  const stempel = Date.now().toString(36);
  const uitslag: { van: string; naar: string; gelukt: boolean; fout?: string }[] = [];
  const tijdelijk = reeks.map((p, i) => `${map}/.hernoem-${stempel}-${i}${p.van.slice(p.van.lastIndexOf("."))}`);

  const teDoen: number[] = [];
  reeks.forEach((p, i) => {
    if (alKlaar(p)) uitslag[i] = { van: lijst[i].van!, naar: lijst[i].naar!, gelukt: true };
    else teDoen.push(i);
  });
  // Wisselen er namen? Alleen dan is de tussenstap nodig.
  const bronnen = new Set(teDoen.map((i) => reeks[i].van.toLowerCase()));
  const wissel = teDoen.some((i) => bronnen.has(reeks[i].naar.toLowerCase()));

  if (!wissel) {
    try {
      const stap = await verplaatsBatch(token, teDoen.map((i) => reeks[i]), 90_000);
      teDoen.forEach((i, j) => {
        const u = stap[j];
        uitslag[i] =
          u === "verplaatst"
            ? { van: lijst[i].van!, naar: lijst[i].naar!, gelukt: true }
            : {
                van: lijst[i].van!,
                naar: lijst[i].naar!,
                gelukt: false,
                fout: u === "bezig" ? "Dropbox nog bezig — de volgende ronde ziet of het gelukt is" : foutVan(u, "mislukt"),
              };
      });
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message.slice(0, 200) : "Dropbox kon niet verplaatsen" },
        { status: 502 }
      );
    }
    const mis = uitslag.filter((u) => !u.gelukt).length;
    return NextResponse.json({ ok: mis === 0, uitslag }, { status: mis === 0 ? 200 : 207 });
  }

  try {
    // Stap 1: alles naar een tijdelijke naam in dezelfde map.
    const stap1 = await verplaatsBatch(token, teDoen.map((i) => ({ van: reeks[i].van, naar: tijdelijk[i] })), 50_000);
    const verder: number[] = [];
    stap1.forEach((u, j) => {
      const i = teDoen[j];
      if (u === "verplaatst") verder.push(i);
      else
        uitslag[i] = {
          van: lijst[i].van!,
          naar: lijst[i].naar!,
          gelukt: false,
          fout: u === "bezig" ? "Dropbox nog bezig met de tijdelijke naam" : foutVan(u, "mislukt"),
        };
    });

    // Stap 2: van de tijdelijke naam naar de eindnaam.
    const stap2 = await verplaatsBatch(token, verder.map((i) => ({ van: tijdelijk[i], naar: reeks[i].naar })), 50_000);
    const terug: number[] = [];
    verder.forEach((i, j) => {
      const u = stap2[j];
      if (u === "verplaatst") uitslag[i] = { van: lijst[i].van!, naar: lijst[i].naar!, gelukt: true };
      else {
        if (u !== "bezig") terug.push(i);
        uitslag[i] = {
          van: lijst[i].van!,
          naar: lijst[i].naar!,
          gelukt: false,
          fout: u === "bezig" ? "Dropbox nog bezig met de eindnaam" : foutVan(u, "mislukt"),
        };
      }
    });

    // Lukte de eindnaam niet, dan terug naar de oude naam: nooit een foto onder een tijdelijke naam laten staan.
    if (terug.length > 0) {
      const teruggezet = await verplaatsBatch(token, terug.map((i) => ({ van: tijdelijk[i], naar: reeks[i].van }))).catch(
        () => terug.map(() => ({ fout: "terugzetten mislukt" }) as const)
      );
      // Ook dat niet gelukt: zeg dan waar hij nu staat, anders zoekt iemand een naam die niet meer bestaat.
      terug.forEach((i, j) => {
        if (teruggezet[j] === "verplaatst") return;
        const naam = tijdelijk[i].slice(tijdelijk[i].lastIndexOf("/") + 1);
        uitslag[i] = { ...uitslag[i], fout: `${uitslag[i].fout ?? "mislukt"} — staat nu als ${naam}` };
      });
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message.slice(0, 200) : "Dropbox kon niet verplaatsen" },
      { status: 502 }
    );
  }

  const mislukt = uitslag.filter((u) => !u.gelukt).length;
  return NextResponse.json({ ok: mislukt === 0, uitslag }, { status: mislukt === 0 ? 200 : 207 });
}
