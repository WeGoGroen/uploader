/**
 * Checklist voor de geoptimaliseerde puntenwolk — het bestand dat ook naar
 * Mediatask gaat, en het enige waar een echte plattegrond uit te tekenen is.
 *
 * De punten komen uit dezelfde Mediatask-gids als lib/dp-checks.ts, maar zijn
 * hier scherper te maken: waar we bij een .dp op cameraposities aangewezen zijn,
 * staan hier de werkelijke muren in. De visuele punten gaan over de doorsneden
 * per bouwlaag, precies zoals de gids voorschrijft (p18: bekijk de scan in
 * top-down, orthografisch — dan ziet hij eruit als een plattegrond).
 */

import type { CheckResult, CheckStatus, ChecklistItem } from "@/lib/dp-checks";
import type { FloorLevel } from "@/lib/floorplan";
import type { PointCloud } from "@/lib/laz-reader";
import { computeScanFeatures } from "@/lib/scan-features";
import type { BuildingOutline, WallAlignment } from "@/lib/scan-analysis";

/** Uitkomsten van de meetkundige analyse, berekend voordat de checks draaien. */
export interface ScanAnalysis {
  /** Muurrichting per verdieping, van beneden naar boven. */
  walls: (WallAlignment | null)[];
  /** Grootste onderlinge hoekverschil tussen de verdiepingen, in graden. */
  axisSpreadDeg: number;
  /** Aandeel punten dat als losse ruis geldt (0-1). */
  noiseShare: number;
  /** Omtrek van het pand per hoogtelaag, met per zijde de afwijking. */
  outlines: (BuildingOutline | null)[];
}

export interface PointCloudContext {
  fileName: string;
  address?: string;
  /** Gebruiksoppervlakte volgens BAG in m², als bekend. */
  bagAreaM2?: number;
  /** Verwacht aantal bouwlagen, als bekend. */
  expectedFloors?: number;
}

const ok = (id: string, toelichting: string): CheckResult => ({ id, status: "ok", toelichting });
const twijfel = (id: string, toelichting: string): CheckResult => ({ id, status: "twijfel", toelichting });
const afkeuren = (id: string, toelichting: string): CheckResult => ({ id, status: "afkeuren", toelichting });
/**
 * Rood in beeld, maar geen blokkade. Voor verschillen met de BAG en 3DBAG:
 * die registraties kloppen te vaak niet om er een opname op af te keuren, en
 * te vaak wél om ze te negeren.
 */
const afwijking = (id: string, toelichting: string): CheckResult => ({ id, status: "afwijking", toelichting });
const onbekend = (id: string, toelichting: string): CheckResult => ({ id, status: "onbekend", toelichting });

const m2 = (v: number) => `${v.toFixed(0)} m²`;

/**
 * De drempels, op één plek en met een naam.
 *
 * Deze getallen zijn geschat, niet gemeten — er was nog geen scan van een
 * afgekeurde opname om ze aan te ijken. Zodra er gelabelde scans liggen worden
 * ze op die labels gefit; tot die tijd staan ze hier bij elkaar zodat te zien
 * is wat er aan aannames in het oordeel zit. Wijzig je er één, hoog dan
 * CHECK_VERSION op, anders zijn oude oordelen niet meer te vergelijken.
 */
export const WALL_DEV_REJECT = 12;
export const WALL_DEV_DOUBT = 5;
export const WALL_RATIO_REJECT = 1.2;
export const WALL_RATIO_DOUBT = 1.35;
export const AXIS_SPREAD_DOUBT = 10;

export const POINTCLOUD_CHECKLIST: ChecklistItem[] = [
  {
    id: "pc-rechte-muren",
    categorie: "Maatvoering",
    titel: "Muurdetectie",
    bron_gids: "p23 Ex.3 — 'walls seem not to be straight'; scheve scans zijn de vaakst gemaakte fout",
    bron: "meting",
  },
  {
    id: "pc-drift",
    categorie: "Nauwkeurigheid",
    titel: "Geen dubbele of verschoven muren",
    bron_gids: "p18 — geen breuken of verschuivingen in een geoptimaliseerde scan",
    bron: "beeld",
    vraag:
      "Zie je muren die dubbel getekend lijken, of dezelfde ruimte verschoven over zichzelf heen? Dat is drift en maakt de maatvoering onbetrouwbaar.",
  },
  {
    id: "pc-ruis",
    categorie: "Nauwkeurigheid",
    titel: "Ruis",
    bron_gids: "p13 — spiegels en glas geven valse punten",
    bron: "meting",
  },
  {
    id: "pc-rechtop",
    categorie: "Nauwkeurigheid",
    titel: "Scan staat rechtop (Z-as omhoog)",
    bron_gids: "p24 Ex.4 — 'the (blue) Z axis should point up by default'",
    bron: "meting",
  },
  {
    id: "pc-bouwlagen",
    categorie: "Volledigheid",
    titel: "Alle verdiepingen zitten in de scan",
    bron_gids: "p7 — verdieping voor verdieping scannen",
    bron: "meting",
  },
  {
    id: "pc-oppervlak",
    categorie: "Volledigheid",
    titel: "Grondvlak komt overeen met het pand",
    bron_gids: "p10 — 'try to capture the entire room'",
    bron: "meting",
  },
  {
    id: "pc-dichtheid",
    categorie: "Nauwkeurigheid",
    titel: "Voldoende punten om muren uit te tekenen",
    bron_gids: "afgeleid: te dun betekent dat de tekenaar de muren niet kan volgen",
    bron: "meting",
  },
  {
    id: "pc-doorsnede",
    categorie: "Maatvoering",
    titel: "Elke hoogtelaag heeft genoeg materiaal op ooghoogte",
    bron_gids: "p20 — doorsneden op 150 cm voor NEN2580",
    bron: "meting",
  },
  {
    id: "pc-kamers",
    categorie: "Volledigheid",
    titel: "Alle ruimtes staan op de plattegrond",
    bron_gids: "p10 — laat geen ruimtes ongescand",
    bron: "beeld",
    vraag:
      "Zie je op elke hoogtelaag aaneengesloten kamers, of zijn er lege plekken binnen de buitenmuren waar een kamer hoort te zitten? Let ook op bijruimtes: berging, toilet, kastruimte, garage.",
  },
  {
    id: "pc-muren-dicht",
    categorie: "Maatvoering",
    titel: "Muren lopen dicht, met herkenbare deuropeningen",
    bron_gids: "p18 — geen breuken of verschuivingen",
    bron: "beeld",
    vraag:
      "Vormen de muurlijnen gesloten contouren, of zitten er grote gaten in waar geen deur of doorgang hoort? Een enkele onderbreking bij een deuropening is normaal; een muur die half ontbreekt niet.",
  },
  {
    id: "pc-uitlijning",
    categorie: "Nauwkeurigheid",
    titel: "Hoogtelagen liggen boven elkaar uitgelijnd",
    bron_gids: "p18 — controleer de uitlijning tussen verdiepingen",
    bron: "beeld",
    vraag:
      "Liggen de buitenmuren van de verschillende verdiepingen op dezelfde plek, of is er een verdieping duidelijk verschoven of verdraaid ten opzichte van de andere?",
  },
];

/** De deterministische controles op de puntenwolk. */
export function runPointCloudChecks(
  pc: PointCloud,
  floors: FloorLevel[],
  c: PointCloudContext,
  analyse: ScanAnalysis
): CheckResult[] {
  // Alle getallen komen uit computeScanFeatures, ook al zijn ze hier zo
  // opnieuw uit te rekenen: dit is exact de vector die we vastleggen, en dus
  // exact waar het oordeel op stoelt. Zou de checklist zelf gaan rekenen, dan
  // kan een opgeslagen scan later een ander verhaal vertellen dan wat de
  // opnemer op zijn scherm zag.
  const f = computeScanFeatures(pc, floors, analyse, c);
  const width = f.widthM;
  const depth = f.depthM;
  const heightM = f.heightM;
  const footprint = f.footprintM2;
  const results: CheckResult[] = [];

  // Rechte muren: hoe sterk lijnen de muren uit op één richting, en staan de
  // verdiepingen onderling recht. Zie lib/scan-analysis.ts voor de meting.
  const bruikbaar = analyse.walls.filter((w): w is WallAlignment => w !== null);
  if (f.wallRatioMin === null) {
    results.push(onbekend("pc-rechte-muren", "Te weinig punten op ooghoogte om muurrichtingen te meten"));
  } else {
    const zwakste = f.wallRatioMin;
    const spreiding = f.axisSpreadDeg ?? 0;
    const richtingen = bruikbaar.map((w) => `${w.axisDeg}°`).join(", ");
    const gewogen = f.wallDeviationDeg ?? 0;
    const ergsteLengte = f.wallWorstLengthM ?? 0;
    const ergsteHoek = f.wallWorstDeg ?? 0;

    if (f.wallLineCount === 0) {
      results.push(onbekend("pc-rechte-muren", "Geen doorlopende muurlijnen van twee meter gevonden"));
    } else if (gewogen > WALL_DEV_REJECT) {
      results.push(
        afkeuren(
          "pc-rechte-muren",
          `Muurlijnen wijken gemiddeld ${gewogen.toFixed(1)}° af (${f.wallLineCount} lijnen, ergste ${ergsteLengte.toFixed(1)} m op ${ergsteHoek.toFixed(0)}°) — de scan staat scheef`
        )
      );
    } else if (zwakste < WALL_RATIO_REJECT) {
      results.push(
        afkeuren(
          "pc-rechte-muren",
          `Muren lijnen nergens op uit (score ${zwakste.toFixed(2)}; onder ${WALL_RATIO_REJECT.toFixed(1).replace(".", ",")} is er geen muurstructuur te vinden) — de scan is te scheef om op te tekenen`
        )
      );
    } else if (gewogen > WALL_DEV_DOUBT) {
      results.push(
        twijfel(
          "pc-rechte-muren",
          `Muurlijnen wijken gemiddeld ${gewogen.toFixed(1)}° af; ergste is ${ergsteLengte.toFixed(1)} m op ${ergsteHoek.toFixed(0)}° — klik op "toon" om te zien welke`
        )
      );
    } else if (spreiding > AXIS_SPREAD_DOUBT) {
      results.push(
        twijfel(
          "pc-rechte-muren",
          `Hoogtelagen staan ${spreiding.toFixed(0)}° verdraaid ten opzichte van elkaar (richtingen: ${richtingen}) — waarschijnlijk weggedraaid op de trap`
        )
      );
    } else if (zwakste < WALL_RATIO_DOUBT) {
      results.push(
        twijfel("pc-rechte-muren", `Muren lijnen matig uit (score ${zwakste.toFixed(2)}), richtingen: ${richtingen}`)
      );
    } else {
      results.push(
        ok(
          "pc-rechte-muren",
          `${f.wallLineCount} muurlijnen wijken gemiddeld ${gewogen.toFixed(1)}° af; hoogtelagen onderling binnen ${spreiding.toFixed(0)}°`
        )
      );
    }
  }

  // Ruis: punten die los van het pand zweven.
  const ruisPct = analyse.noiseShare * 100;
  if (analyse.noiseShare > 0.05) {
    results.push(twijfel("pc-ruis", `${ruisPct.toFixed(1)}% van de punten zweeft los — kijk op de kaart waar dat zit`));
  } else if (analyse.noiseShare > 0.02) {
    results.push(twijfel("pc-ruis", `${ruisPct.toFixed(1)}% losse punten; meestal ramen of een spiegel`));
  } else {
    results.push(ok("pc-ruis", `${ruisPct.toFixed(1)}% losse punten`));
  }

  // Staat de scan rechtop, dan liggen de vloeren als duidelijke horizontale
  // vlakken in het hoogtehistogram. Vinden we die niet terwijl er wel hoogte
  // in zit, dan is het assenstelsel waarschijnlijk gekanteld (gids p24).
  if (floors.length === 0) {
    results.push(
      afkeuren(
        "pc-rechtop",
        heightM > 2
          ? `Geen vloervlakken gevonden bij ${heightM.toFixed(1)} m hoogteverschil — scan staat waarschijnlijk gekanteld; corrigeer de Z-as in Dot3D (Edit > Coordinates > Primary)`
          : "Geen vloervlakken gevonden"
      )
    );
  } else {
    results.push(ok("pc-rechtop", `${floors.length} vloervlak(ken) horizontaal gevonden`));
  }

  const hoogtes = floors.map((f) => `${f.floorZ.toFixed(2)} m`).join(", ");
  if (floors.length === 0) {
    results.push(onbekend("pc-bouwlagen", "Geen hoogtelagen te bepalen zolang de scan niet rechtop staat"));
  } else if (c.expectedFloors === undefined) {
    results.push(onbekend("pc-bouwlagen", `${floors.length} hoogtelaag/lagen op ${hoogtes}; geen verwacht aantal verdiepingen bekend`));
  } else if (floors.length < c.expectedFloors) {
    results.push(
      afwijking(
        "pc-bouwlagen",
        `${floors.length} hoogtelaag/lagen in de scan (${hoogtes}), maar ${c.expectedFloors} verdiepingen verwacht — controleer of er een verdieping ontbreekt`
      )
    );
  } else {
    results.push(ok("pc-bouwlagen", `${floors.length} hoogtelaag/lagen op ${hoogtes}, verwacht ${c.expectedFloors} verdiepingen`));
  }

  if (c.bagAreaM2 === undefined) {
    results.push(
      onbekend(
        "pc-oppervlak",
        `Omhullende doos ${width.toFixed(1)} x ${depth.toFixed(1)} m (${m2(footprint)}); geen BAG-oppervlakte om tegen te leggen`
      )
    );
  } else {
    // De omhullende doos telt uitbouwen en schuine gevels als rechthoek mee en
    // valt daardoor ruimer uit dan de gebruiksoppervlakte. Ver eronder betekent
    // dat er een deel van het pand ontbreekt.
    const perLaag = footprint * Math.max(floors.length, 1);
    const ratio = perLaag / c.bagAreaM2;
    if (ratio < 0.6) {
      results.push(
        afwijking(
          "pc-oppervlak",
          `${m2(perLaag)} over ${floors.length} hoogtelaag/lagen tegen ${m2(c.bagAreaM2)} volgens BAG — groot verschil, controleer of er een deel ontbreekt`
        )
      );
    } else if (ratio < 0.85) {
      results.push(twijfel("pc-oppervlak", `${m2(perLaag)} tegen ${m2(c.bagAreaM2)} volgens BAG`));
    } else {
      results.push(ok("pc-oppervlak", `${m2(perLaag)} tegen ${m2(c.bagAreaM2)} volgens BAG`));
    }
  }

  // Puntdichtheid per m² grondvlak. De referentiescan (Marnixkade) zit op ruim
  // 7.800 punten per m²; daar is elke muur ruim mee te volgen.
  const perM2 = pc.totalInFile / Math.max(footprint, 1);
  if (perM2 < 500) {
    results.push(afkeuren("pc-dichtheid", `${Math.round(perM2)} punten per m² — te dun om muren uit te tekenen`));
  } else if (perM2 < 2000) {
    results.push(twijfel("pc-dichtheid", `${Math.round(perM2)} punten per m² — aan de dunne kant`));
  } else {
    results.push(ok("pc-dichtheid", `${pc.totalInFile.toLocaleString("nl-NL")} punten, ${Math.round(perM2)} per m²`));
  }

  const dun = floors.filter((f) => f.slicePoints < 2000);
  if (floors.length === 0) {
    results.push(onbekend("pc-doorsnede", "Geen hoogtelagen gevonden"));
  } else if (dun.length > 0) {
    results.push(
      twijfel(
        "pc-doorsnede",
        `${dun.length} hoogtelaag/lagen met weinig punten op ooghoogte (${dun.map((f) => f.slicePoints).join(", ")}) — daar is de plattegrond mager`
      )
    );
  } else {
    results.push(ok("pc-doorsnede", floors.map((f) => `${f.slicePoints.toLocaleString("nl-NL")} punten`).join(", ")));
  }

  return results;
}

/** De punten die het beoordelingsmodel op de plattegronden moet nagaan. */
export function pointCloudVisualChecklist(): ChecklistItem[] {
  return POINTCLOUD_CHECKLIST.filter((i) => i.bron === "beeld");
}

export function pointCloudChecklistItem(id: string): ChecklistItem | undefined {
  return POINTCLOUD_CHECKLIST.find((i) => i.id === id);
}

export type { CheckResult, CheckStatus };
