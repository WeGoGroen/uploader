import { describe, expect, it } from "vitest";
import type { FloorLevel } from "@/lib/floorplan";
import type { PointCloud } from "@/lib/laz-reader";
import type { ScanAnalysis } from "@/lib/pointcloud-checks";
import { computeScanFeatures } from "@/lib/scan-features";
import { samenvatting, type ScanRecord } from "@/lib/scan-record";

function wolk(overrides: Partial<PointCloud["bounds"]> = {}): PointCloud {
  return {
    bounds: { minX: 0, maxX: 10, minY: 0, maxY: 8, minZ: 0, maxZ: 5, ...overrides },
    totalInFile: 200_000,
  } as PointCloud;
}

const geenAnalyse: ScanAnalysis = { walls: [], outlines: [], axisSpreadDeg: 0, noiseShare: 0 };

const laag = (floorZ: number, slicePoints: number): FloorLevel =>
  ({ floorZ, slicePoints }) as FloorLevel;

describe("computeScanFeatures", () => {
  it("weegt de muurafwijking naar lengte, zodat een lange gevel zwaarder telt dan een nis", () => {
    const analyse: ScanAnalysis = {
      walls: [{ axisDeg: 0, ratio: 1.8 } as ScanAnalysis["walls"][number]],
      outlines: [
        {
          edges: [
            { lengthM: 9, deviationDeg: 1 },
            { lengthM: 3, deviationDeg: 9 },
          ],
        } as ScanAnalysis["outlines"][number],
      ],
      axisSpreadDeg: 4,
      noiseShare: 0.01,
    };
    const f = computeScanFeatures(wolk(), [laag(0, 5000)], analyse, { fileName: "x.ply" });
    // (9*1 + 3*9) / 12 = 3, niet het rekenkundig gemiddelde van 5.
    expect(f.wallDeviationDeg).toBeCloseTo(3, 5);
    expect(f.wallWorstDeg).toBe(9);
    expect(f.wallWorstLengthM).toBe(3);
    expect(f.wallLineCount).toBe(2);
  });

  it("laat zijden onder twee meter buiten beschouwing", () => {
    const analyse: ScanAnalysis = {
      ...geenAnalyse,
      walls: [{ axisDeg: 0, ratio: 1.6 } as ScanAnalysis["walls"][number]],
      outlines: [
        {
          edges: [
            { lengthM: 6, deviationDeg: 2 },
            { lengthM: 0.4, deviationDeg: 40 },
          ],
        } as ScanAnalysis["outlines"][number],
      ],
    };
    const f = computeScanFeatures(wolk(), [laag(0, 5000)], analyse, { fileName: "x.ply" });
    expect(f.wallLineCount).toBe(1);
    expect(f.wallDeviationDeg).toBeCloseTo(2, 5);
  });

  it("geeft null in plaats van een verzonnen getal als er niets te meten valt", () => {
    const f = computeScanFeatures(wolk(), [], geenAnalyse, { fileName: "x.ply" });
    expect(f.wallDeviationDeg).toBeNull();
    expect(f.wallRatioMin).toBeNull();
    expect(f.axisSpreadDeg).toBeNull();
    expect(f.minSlicePoints).toBeNull();
    expect(f.bagAreaM2).toBeNull();
    expect(f.areaRatio).toBeNull();
    expect(f.floorDelta).toBeNull();
  });

  it("rekent oppervlak en dichtheid over alle hoogtelagen", () => {
    const f = computeScanFeatures(wolk(), [laag(0, 4000), laag(2.7, 3000)], geenAnalyse, {
      fileName: "x.ply",
      bagAreaM2: 100,
      expectedFloors: 2,
    });
    expect(f.footprintM2).toBeCloseTo(80, 5);
    expect(f.scannedAreaM2).toBeCloseTo(160, 5);
    expect(f.areaRatio).toBeCloseTo(1.6, 5);
    expect(f.pointsPerM2).toBeCloseTo(2500, 5);
    expect(f.floorDelta).toBe(0);
    expect(f.minSlicePoints).toBe(3000);
  });

  it("laat de dichtheid niet ontsporen bij een mislukte scan zonder grondvlak", () => {
    const f = computeScanFeatures(wolk({ maxX: 0, maxY: 0 }), [], geenAnalyse, { fileName: "x.ply" });
    expect(Number.isFinite(f.pointsPerM2)).toBe(true);
    expect(f.pointsPerM2).toBe(200_000);
  });
});

describe("samenvatting", () => {
  const basis = (): ScanRecord => ({
    id: "a",
    version: "test",
    at: "2026-08-16T10:00:00.000Z",
    fileName: "scan.ply",
    fileSize: 1,
    address: "Teststraat 1",
    orderId: null,
    features: computeScanFeatures(wolk(), [laag(0, 5000)], { ...geenAnalyse, noiseShare: 0.03 }, {
      fileName: "scan.ply",
    }),
    results: [],
    verdict: "ok",
    llmVerdict: null,
    label: null,
  });

  it("noemt alleen wat niet in orde is", () => {
    const rec = basis();
    rec.results = [
      { id: "pc-ruis", status: "ok", toelichting: "3,0% losse punten" },
      { id: "pc-rechte-muren", status: "twijfel", toelichting: "wijkt 7° af" },
    ];
    const tekst = samenvatting(rec);
    expect(tekst).toContain("pc-rechte-muren");
    expect(tekst).not.toContain("pc-ruis:");
  });

  it("zegt het expliciet als er niets bijzonders is", () => {
    const rec = basis();
    rec.results = [{ id: "pc-ruis", status: "ok", toelichting: "1% losse punten" }];
    expect(samenvatting(rec)).toContain("geen bijzonderheden");
  });

  it("zet de versie in de kop, zodat een oud oordeel later te plaatsen is", () => {
    expect(samenvatting(basis())).toContain("test");
  });
});
