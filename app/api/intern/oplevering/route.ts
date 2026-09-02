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
  verplaats,
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
/**
 * Decodeert net zo lang tot er geen %-codering meer in zit.
 *
 * Mediatask levert het meetrapport dubbel gecodeerd aan (%2520 voor een
 * spatie); één keer decoderen liet daardoor "%20" in de bestandsnaam achter —
 * en dat is precies het bestand dat naar de makelaar gaat.
 */
function decodeerVolledig(ruw: string): string {
  let uit = ruw;
  for (let i = 0; i < 4; i++) {
    if (!/%[0-9A-Fa-f]{2}/.test(uit)) break;
    try {
      const volgende = decodeURIComponent(uit);
      if (volgende === uit) break;
      uit = volgende;
    } catch {
      break;
    }
  }
  return uit;
}

/**
 * Is dit het NEN2580-meetrapport?
 *
 * Mediatask levert het altijd als PDF met "Meetrapport" in de naam; de andere
 * uitvoeringen (.docx, .xlsx) zijn werkbestanden en gaan er bij het opruimen
 * toch uit.
 */
function isMeetrapport(naam: string): boolean {
  return /\.pdf$/i.test(naam) && /meetrapport/i.test(naam);
}

/**
 * De naam waaronder een opleverbestand in Dropbox komt te staan.
 *
 * Het meetrapport krijgt een vaste naam: "Meetrapport {adres}.pdf". Mediatask
 * levert het aan als "WeGoGroen - Meetrapport - Lumirestraat 54 - Amsterdam.pdf"
 * — met hun eigen voorvoegsel, streepjes in plaats van komma's en zonder
 * accenten, want die vallen bij hen weg. Dat is het bestand dat de makelaar
 * opent en in zijn eigen dossier bewaart, dus het hoort de naam van het pand te
 * dragen zoals wij het kennen, niet de exportnaam van een leverancier.
 *
 * De rest houdt zijn eigen naam: dat zijn tekeningen en foto's waar het nummer
 * en de bouwlaag in staan, en die betekenen daar iets.
 */
function opleverNaam(url: string, adres: string, terugval: string): string {
  const naam = bestandsnaam(url, terugval);
  if (!isMeetrapport(naam)) return naam;
  return sanitizePathSegment(`Meetrapport ${adres}.pdf`);
}

function bestandsnaam(url: string, terugval: string): string {
  try {
    const match = decodeerVolledig(url).match(/filename="?([^";]+)"?/);
    if (match) return sanitizePathSegment(decodeerVolledig(match[1]));
    const pad = new URL(url).pathname.split("/").pop();
    return pad ? sanitizePathSegment(decodeerVolledig(pad)) : terugval;
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
    /**
     * Bestaande bestanden met dezelfde naam eerst weghalen.
     *
     * Nodig bij het opnieuw ophalen na een goedkeuring: Mediatask levert een
     * correctie onder dezelfde bestandsnaam, en overslaan-wat-er-al-staat zou
     * betekenen dat de oude versie blijft liggen.
     */
    vervang?: boolean;
    /**
     * Het versienummer van deze oplevering. 1 (of leeg) is de gewone map;
     * vanaf 2 komt de oplevering in een eigen map ernaast te staan.
     *
     * Dat is de hele truc achter "elke versie zijn eigen link": een deelbare
     * link hoort bij een pad, dus een nieuwe link vraagt om een nieuwe map. Het
     * levert bovendien een schone map op — geen verwijderen-en-opnieuw-
     * neerzetten, en dus geen moment waarop de helft weg is.
     */
    versie?: number;
  } | null;

  const adres = body?.adres?.trim() ?? "";
  const bestanden = (body?.bestanden ?? []).filter((u) => typeof u === "string" && u.startsWith("http"));
  if (!adres) return NextResponse.json({ error: "adres ontbreekt" }, { status: 400 });

  const token = await getSharedAccessToken();
  // Vaste naamgeving, zodat de map ook over een jaar nog terug te vinden is en
  // een tweede oplevering in dezelfde map landt in plaats van ernaast.
  //
  // Alles landt in de submap "Afgerond": dat is de plank met deelbare mappen.
  // Wat daarbuiten in Automatie NEN2580 staat is werk in uitvoering.
  const versie = Math.max(1, Math.floor(Number(body?.versie) || 1));
  const mapNaam = sanitizePathSegment(
    versie > 1 ? `NEN2580 (${adres}) - versie ${versie}` : `NEN2580 (${adres})`
  );
  const oudPad = `/Automatie NEN2580/${mapNaam}`;
  const pad = `/Automatie NEN2580/Afgerond/${mapNaam}`;

  // Staat de map nog op de oude plek (van vóór de Afgerond-indeling), verhuis
  // hem dan. De deelbare link verhuist bij Dropbox gewoon mee. Alleen bij de
  // eerste versie: een versiemap heeft nooit op die oude plek gestaan.
  if (versie === 1) {
    const opOudePlek = await listFolderFiles(token, oudPad).catch(() => null);
    if (opOudePlek !== null) {
      await verplaats(token, oudPad, pad).catch(() => {
        // Doel bestaat al of verhuizen faalt: dan werken we verder op het
        // nieuwe pad; de controle hieronder ziet vanzelf wat er ontbreekt.
      });
    }
  }

  const stappen: string[] = [];
  /*
    Hoeveel bestanden er over een bestaande versie heen geschreven zijn.

    De aanroeper heeft dit nodig om iets te kunnen zeggen wat wij hier niet
    weten: of de makelaar de oude versie al gekregen had. Vervangen is namelijk
    niet erg — vervangen ná het versturen wél, want dan loopt er een verkeerde
    tekening rond.
  */
  let vervangenAantal = 0;
  // Namen die we verwachten, om na afloop te kunnen zeggen wélke er ontbreekt.
  const verwachteNamen = bestanden.map((url, i) => opleverNaam(url, adres, `oplevering-${i + 1}`));

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
    let alAanwezig = new Set(
      (await listFolderFiles(token, pad).catch(() => [])).map((f) => f.name.toLowerCase())
    );

    // Vervangmodus: wat opnieuw geleverd wordt eerst weghalen, anders blijft de
    // oude versie liggen onder dezelfde naam.
    if (body?.vervang && alAanwezig.size > 0) {
      let vervangen = 0;
      for (const naam of verwachteNamen) {
        if (alAanwezig.has(naam.toLowerCase())) {
          await deleteFile(token, `${pad}/${naam}`).catch(() => {});
          vervangen++;
        }
      }
      vervangenAantal += vervangen;
      if (vervangen > 0) stappen.push(`${vervangen} bestaand(e) bestand(en) vervangen door de nieuwe versie`);
      alAanwezig = new Set(
        (await listFolderFiles(token, pad).catch(() => [])).map((f) => f.name.toLowerCase())
      );
    }
    /*
      Een meetrapport onder een oudere naam hoort weg.

      Zonder dit staat na een hernoeming (of na een correctie van Mediatask,
      die soms een andere exportnaam meestuurt) hetzelfde rapport twee keer in
      de map — en dan is het aan de makelaar om te raden welke de goede is.
      Alleen bestanden die er als meetrapport uitzien, en nooit degene die we
      zojuist zelf willen neerzetten.
    */
    const nieuweRapportNaam = verwachteNamen.find((n) => isMeetrapport(n));
    if (nieuweRapportNaam) {
      const oude = (await listFolderFiles(token, pad).catch(() => []))
        .map((f) => f.name)
        .filter((n) => isMeetrapport(n) && n.toLowerCase() !== nieuweRapportNaam.toLowerCase());
      for (const naam of oude) {
        await deleteFile(token, `${pad}/${naam}`).catch(() => {});
      }
      if (oude.length > 0) {
        vervangenAantal += oude.length;
        stappen.push(`${oude.length} meetrapport(en) onder een oude naam opgeruimd`);
        alAanwezig = new Set(
          (await listFolderFiles(token, pad).catch(() => [])).map((f) => f.name.toLowerCase())
        );
      }
    }

    stappen.push(`map Afgerond/${mapNaam} klaargezet (${alAanwezig.size} bestand(en) stonden er al)`);

    const banen: { naam: string; url: string; jobId: string | null }[] = [];
    let overgeslagen = 0;
    for (const [i, url] of bestanden.entries()) {
      // Dezelfde naam als in verwachteNamen: twee plekken die zelf een naam
      // bedenken lopen vroeg of laat uit elkaar, en dan staat hetzelfde
      // bestand er twee keer onder twee namen.
      const naam = verwachteNamen[i];
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

    /**
     * Alle banen tegelijk volgen in plaats van één voor één.
     *
     * Sequentieel wachten stapelde: bij drieëntwintig bestanden van elk een
     * paar seconden liep de route tegen zijn tijdslimiet en gaf een 500. De
     * banen lopen bij Dropbox toch al naast elkaar; alleen ons wachten was
     * serieel.
     */
    await Promise.all(
      banen
        .filter((b) => b.jobId)
        .map(async (baan) => {
          let ronde = 0;
          for (;;) {
            const { status } = await checkSaveUrlJob(token, baan.jobId!);
            if (status === "complete") return;
            if (status === "failed" || ++ronde > MAX_RONDES) {
              zelfDoen.push({ naam: baan.naam, url: baan.url });
              return;
            }
            await wacht(WACHT_MS);
          }
        })
    );
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

  // Bestanden met %-codering in de naam hernoemen naar hun leesbare vorm.
  // Erfenis van de dubbele codering van Mediatask; de nieuwe downloads krijgen
  // meteen de goede naam, dit ruimt de oude op.
  for (const bestand of inMap) {
    if (!/%[0-9A-Fa-f]{2}/.test(bestand.name)) continue;
    const schoon = sanitizePathSegment(decodeerVolledig(bestand.name));
    if (schoon === bestand.name) continue;
    try {
      await verplaats(token, bestand.path, `${pad}/${schoon}`);
      bestand.name = schoon;
      bestand.path = `${pad}/${schoon}`;
      stappen.push(`${schoon}: naam hersteld`);
    } catch {
      stappen.push(`${bestand.name}: hernoemen mislukte`);
    }
  }

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
      versie,
      link,
      bestanden: naVerwijderen.map((f) => f.name),
      verwijderd,
      vervangen: vervangenAantal,
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
