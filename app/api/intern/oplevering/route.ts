import { NextResponse } from "next/server";
import { isInternRequest } from "@/lib/intern-auth";
import {
  checkSaveUrlJob,
  createFolder,
  deleteFile,
  getOrCreateSharedLink,
  getSharedAccessToken,
  listFolderFiles,
  sanitizePathSegment,
  saveUrl,
  uploadFile,
} from "@/lib/dropbox";

export const maxDuration = 300;

/**
 * Haalt een opgeleverde NEN2580 binnen: bestanden van Mediatask naar Dropbox,
 * kantoorbestanden eruit, deelbare link terug.
 *
 * Waarom hier en niet in het control center: de Dropbox-token woont in deze
 * app. Hem doorgeven aan een tweede app zou betekenen dat een sleutel tot alle
 * bedrijfsbestanden over het internet reist voor werk dat hier net zo goed kan.
 *
 * Dropbox haalt de bestanden zélf op via save_url. Dat scheelt niet alleen
 * bandbreedte — de tijdelijke links van Mediatask verlopen binnen vijf minuten,
 * en een bestand dat eerst hierheen en dan daarheen moet is precies zo lang
 * onderweg dat dat misgaat.
 */

/** Word en Excel horen niet in de oplevering: dat zijn de werkbestanden van de
    tekenaar. Een makelaar die de map opent moet plattegronden zien. */
const KANTOORBESTANDEN = /\.(docx?|xlsx?|xlsm|csv)$/i;

const WACHT_MS = 2000;
const MAX_RONDES = 60; // 2 minuten per bestand; daarna is er iets echt mis

async function wacht(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Bestandsnaam uit een S3-link met handtekening halen. */
function bestandsnaam(url: string, terugval: string): string {
  try {
    const match = decodeURIComponent(url).match(/filename="?([^";]+)"?/);
    if (match) return sanitizePathSegment(match[1]);
    const pad = new URL(url).pathname.split("/").pop();
    return pad ? sanitizePathSegment(pad) : terugval;
  } catch {
    return terugval;
  }
}

export async function POST(request: Request) {
  if (!isInternRequest(request)) {
    return NextResponse.json({ error: "niet_toegestaan" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as {
    adres?: string;
    bestanden?: string[];
    /** Alleen controleren of het al goed staat, niets ophalen. */
    alleenControle?: boolean;
  } | null;

  const adres = body?.adres?.trim() ?? "";
  const bestanden = (body?.bestanden ?? []).filter((u) => typeof u === "string" && u.startsWith("http"));
  if (!adres) return NextResponse.json({ error: "adres ontbreekt" }, { status: 400 });

  const token = await getSharedAccessToken();
  // Vaste naamgeving, zodat de map ook over een jaar nog terug te vinden is en
  // een tweede oplevering in dezelfde map landt in plaats van ernaast.
  const mapNaam = sanitizePathSegment(`NEN2580 (${adres})`);
  const pad = `/Automatie NEN2580/${mapNaam}`;

  const stappen: string[] = [];
  // Namen die we verwachten, om na afloop te kunnen zeggen wélke er ontbreekt.
  const verwachteNamen = bestanden.map((url, i) => bestandsnaam(url, `oplevering-${i + 1}`));

  if (!body?.alleenControle) {
    if (bestanden.length === 0) {
      return NextResponse.json({ error: "geen bestanden meegegeven" }, { status: 400 });
    }

    await createFolder(token, pad).catch(() => {
      // Bestaat al: precies goed, dan vullen we hem aan.
    });

    /**
     * Eerst kijken wat er al ligt.
     *
     * Zonder deze stap maakt Dropbox er bij een tweede ronde "WGG_1478_BG (1).jpg"
     * naast — en dan groeit de map elke keer dat de agent opnieuw draait. Een
     * agent die één keer per tien minuten kijkt, moet dezelfde klus twee keer
     * kunnen doen zonder dat je het ziet.
     */
    const alAanwezig = new Set(
      (await listFolderFiles(token, pad).catch(() => [])).map((f) => f.name.toLowerCase())
    );
    stappen.push(`map ${mapNaam} klaargezet (${alAanwezig.size} bestand(en) stonden er al)`);

    const banen: { naam: string; url: string; jobId: string | null }[] = [];
    let overgeslagen = 0;
    for (const [i, url] of bestanden.entries()) {
      const naam = bestandsnaam(url, `oplevering-${i + 1}`);
      if (alAanwezig.has(naam.toLowerCase())) {
        overgeslagen++;
        continue;
      }
      try {
        const { done, jobId } = await saveUrl(token, `${pad}/${naam}`, url);
        banen.push({ naam, url, jobId: done ? null : jobId });
      } catch {
        // Meteen door naar de terugval hieronder.
        banen.push({ naam, url, jobId: null });
      }
    }

    /**
     * Bestanden waarvoor Dropbox' eigen ophaaldienst faalt, halen we zelf op.
     *
     * Dropbox weigert sommige bestanden structureel met "download_failed" —
     * bij Mediatask zijn dat de .fml-projectbestanden van Floorplanner. Dat is
     * geen reden om de oplevering incompleet te laten: de bytes zijn gewoon op
     * te halen, alleen niet door hen.
     */
    const zelfDoen: { naam: string; url: string }[] = [];

    for (const baan of banen.filter((b) => b.jobId)) {
      let ronde = 0;
      for (;;) {
        const { status } = await checkSaveUrlJob(token, baan.jobId!);
        if (status === "complete") break;
        if (status === "failed") {
          zelfDoen.push({ naam: baan.naam, url: baan.url });
          break;
        }
        if (++ronde > MAX_RONDES) {
          zelfDoen.push({ naam: baan.naam, url: baan.url });
          break;
        }
        await wacht(WACHT_MS);
      }
    }
    zelfDoen.push(...banen.filter((b) => !b.jobId).map((b) => ({ naam: b.naam, url: b.url })));

    for (const item of zelfDoen) {
      try {
        const res = await fetch(item.url);
        if (!res.ok) throw new Error(`bron gaf ${res.status}`);
        const inhoud = Buffer.from(await res.arrayBuffer());
        await uploadFile(token, `${pad}/${item.naam}`, inhoud);
        stappen.push(`${item.naam}: zelf opgehaald (Dropbox kon het niet)`);
      } catch (err) {
        stappen.push(
          `${item.naam}: ook zelf ophalen mislukte (${err instanceof Error ? err.message.slice(0, 80) : "?"})`
        );
      }
    }

    stappen.push(
      `${banen.length - zelfDoen.length} via Dropbox, ${zelfDoen.length} zelf, ${overgeslagen} stond er al`
    );
  }

  // --- Opruimen en controleren ------------------------------------------------
  // listFolderFiles geeft alleen naam en grootte; het pad stellen we zelf samen
  // uit de mapnaam. Dat kan omdat deze map plat is — de oplevering van Mediatask
  // heeft geen submappen.
  const inMap = (await listFolderFiles(token, pad).catch(() => [])).map((f) => ({
    name: f.name,
    path: `${pad}/${f.name}`,
  }));

  /**
   * Dropbox hernoemt bij een naambotsing naar "bestand (1).jpg" in plaats van
   * te overschrijven. Zulke kopieën konden ontstaan voordat deze route ging
   * kijken wat er al lag; ze horen weg zodra het origineel er staat, anders
   * krijgt een makelaar een map met dezelfde plattegrond er twee keer in.
   */
  const namen = new Set(inMap.map((f) => f.name.toLowerCase()));
  const duplicaten = inMap.filter((f) => {
    const m = f.name.match(/^(.*) \(\d+\)(\.[^.]+)$/);
    return m ? namen.has(`${m[1]}${m[2]}`.toLowerCase()) : false;
  });

  const teVerwijderen = [...inMap.filter((f) => KANTOORBESTANDEN.test(f.name)), ...duplicaten];
  const verwijderd: string[] = [];
  for (const f of teVerwijderen) {
    try {
      await deleteFile(token, f.path);
      verwijderd.push(f.name);
    } catch {
      stappen.push(`${f.name} kon niet verwijderd worden`);
    }
  }

  const weg = new Set(teVerwijderen.map((f) => f.name));
  const naVerwijderen = inMap.filter((f) => !weg.has(f.name));
  const link = naVerwijderen.length > 0 ? await getOrCreateSharedLink(token, pad).catch(() => null) : null;

  /**
   * De controle. Bewust hier en niet bij de aanroeper: alleen deze kant kan in
   * Dropbox kijken, en een agent die zijn eigen werk goedkeurt op basis van
   * "de API gaf geen fout" is precies het soort agent dat stilletjes faalt.
   *
   * Tellen is daarbij niet genoeg — de eerste versie keek alleen of er íets
   * stond, en liet daardoor een oplevering door waarbij vier van de vijf
   * bestanden waren aangekomen. Nu wordt per verwacht bestand gekeken of het er
   * ligt, en welke ontbreekt.
   */
  const aanwezig = new Set(inMap.map((f) => f.name.toLowerCase()));
  const ontbrekend = verwachteNamen.filter(
    (naam) => !KANTOORBESTANDEN.test(naam) && !aanwezig.has(naam.toLowerCase())
  );

  const controle = {
    mapBestaat: inMap.length > 0,
    verwacht: verwachteNamen.filter((n) => !KANTOORBESTANDEN.test(n)).length,
    aantalBestanden: naVerwijderen.length,
    ontbrekend,
    kantoorbestandenWeg: naVerwijderen.every((f) => !KANTOORBESTANDEN.test(f.name)),
    heeftLink: Boolean(link),
  };
  const goed =
    controle.aantalBestanden > 0 &&
    controle.ontbrekend.length === 0 &&
    controle.kantoorbestandenWeg &&
    controle.heeftLink;

  return NextResponse.json(
    {
      ok: goed,
      map: pad,
      link,
      bestanden: naVerwijderen.map((f) => f.name),
      verwijderd,
      controle,
      stappen,
      reden: goed
        ? null
        : controle.aantalBestanden === 0
          ? "Er staat geen enkel opleverbestand in de map"
          : controle.ontbrekend.length > 0
            ? `${controle.ontbrekend.length} van ${controle.verwacht} bestanden ontbreekt: ${controle.ontbrekend.join(", ")}`
            : !controle.heeftLink
              ? "Er kon geen deelbare link gemaakt worden"
              : "Er staan nog kantoorbestanden in de map",
    },
    { status: goed ? 200 : 422 }
  );
}
