/**
 * De meetwaarden van één scan, als platte getallen.
 *
 * Dit is de laag waar het oordeel op rust en, later, waar een gefit model op
 * getraind wordt. Vandaar dat het losstaat van de checks: die zetten er een
 * grens omheen, maar de getallen zelf zijn grensloos en veranderen niet als we
 * de drempels bijstellen. Precies één plek waar elk getal berekend wordt — dat
 * de opgeslagen vector werkelijk is wat de checklist zag, en niet een tweede
 * benadering die er langzaam vanaf drift.
 *
 * Alles is `number | null`, nooit `undefined`: null betekent "niet te meten"
 * (te weinig punten, geen BAG bekend) en dat is straks een betekenisvolle
 * invoer voor het model, geen ontbrekend veld.
 */

import type { FloorLevel } from "@/lib/floorplan";
import type { PointCloud } from "@/lib/laz-reader";
import type { PointCloudContext, ScanAnalysis } from "@/lib/pointcloud-checks";

/**
 * Versie van de meet- en beoordelingslaag.
 *
 * Bij elke wijziging aan een meetwaarde of een drempel gaat dit omhoog. Zonder
 * dat is een opgeslagen oordeel later niet meer te plaatsen: je weet dan niet
 * of een scan destijds door een andere maatstaf is gekomen dan die van vandaag,
 * en kun je dus ook niet nagaan of een wijziging verbetering was.
 */
export const CHECK_VERSION = "2026-08-16.1";

export interface ScanFeatures {
  /** Aantal muurlijnen van 2 m of langer in de omtrek. */
  wallLineCount: number;
  /** Lengtegewogen afwijking van die lijnen, in graden. */
  wallDeviationDeg: number | null;
  /** Grootste afwijking van één lijn, in graden. */
  wallWorstDeg: number | null;
  /** Lengte van de lijn met die grootste afwijking, in meters. */
  wallWorstLengthM: number | null;
  /** Zwakste uitlijnscore over de hoogtelagen (hoger = duidelijker muren). */
  wallRatioMin: number | null;
  /** Onderlinge verdraaiing tussen hoogtelagen, in graden. */
  axisSpreadDeg: number | null;

  /** Aandeel losse punten (0-1). */
  noiseShare: number;

  floorCount: number;
  /** Punten in de dunste doorsnede op ooghoogte. */
  minSlicePoints: number | null;

  widthM: number;
  depthM: number;
  heightM: number;
  /** Grondvlak van de omhullende doos, in m². */
  footprintM2: number;
  /** Grondvlak maal het aantal hoogtelagen, in m². */
  scannedAreaM2: number;

  pointsTotal: number;
  pointsPerM2: number;

  bagAreaM2: number | null;
  /** Gescand oppervlak gedeeld door de BAG-oppervlakte. */
  areaRatio: number | null;
  expectedFloors: number | null;
  /** Gevonden hoogtelagen min verwachte verdiepingen. */
  floorDelta: number | null;
}

/** Zijden korter dan dit tellen niet mee als muurlijn. */
const MIN_EDGE_M = 2;

/**
 * Een erker of een nis van een halve meter staat altijd wel wat scheef en zegt
 * niets over de scan; een gevel van tien meter zegt alles. Vandaar dat de
 * afwijking naar lengte gewogen wordt en korte zijden helemaal wegvallen.
 */
export function computeScanFeatures(
  pc: PointCloud,
  floors: FloorLevel[],
  analyse: ScanAnalysis,
  c: PointCloudContext
): ScanFeatures {
  const widthM = pc.bounds.maxX - pc.bounds.minX;
  const depthM = pc.bounds.maxY - pc.bounds.minY;
  const heightM = pc.bounds.maxZ - pc.bounds.minZ;
  const footprintM2 = widthM * depthM;
  const scannedAreaM2 = footprintM2 * Math.max(floors.length, 1);

  const bruikbaar = analyse.walls.filter((w) => w !== null);
  const zijden = analyse.outlines
    .flatMap((o) => o?.edges ?? [])
    .filter((e) => e.lengthM >= MIN_EDGE_M);
  const totaleLengte = zijden.reduce((n, e) => n + e.lengthM, 0);
  const ergste = zijden.reduce<(typeof zijden)[number] | null>(
    (m, e) => (e.deviationDeg > (m?.deviationDeg ?? -1) ? e : m),
    null
  );

  const bagAreaM2 = c.bagAreaM2 ?? null;
  const expectedFloors = c.expectedFloors ?? null;

  return {
    wallLineCount: zijden.length,
    wallDeviationDeg:
      totaleLengte > 0
        ? zijden.reduce((n, e) => n + e.lengthM * e.deviationDeg, 0) / totaleLengte
        : null,
    wallWorstDeg: ergste?.deviationDeg ?? null,
    wallWorstLengthM: ergste?.lengthM ?? null,
    wallRatioMin: bruikbaar.length > 0 ? Math.min(...bruikbaar.map((w) => w.ratio)) : null,
    axisSpreadDeg: bruikbaar.length > 0 ? analyse.axisSpreadDeg : null,

    noiseShare: analyse.noiseShare,

    floorCount: floors.length,
    minSlicePoints: floors.length > 0 ? Math.min(...floors.map((f) => f.slicePoints)) : null,

    widthM,
    depthM,
    heightM,
    footprintM2,
    scannedAreaM2,

    pointsTotal: pc.totalInFile,
    // Delen door minstens 1 m²: bij een mislukte scan is het grondvlak bijna
    // nul en zou de dichtheid anders naar oneindig lopen.
    pointsPerM2: pc.totalInFile / Math.max(footprintM2, 1),

    bagAreaM2,
    areaRatio: bagAreaM2 !== null && bagAreaM2 > 0 ? scannedAreaM2 / bagAreaM2 : null,
    expectedFloors,
    floorDelta: expectedFloors !== null ? floors.length - expectedFloors : null,
  };
}
