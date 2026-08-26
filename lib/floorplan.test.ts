import { describe, expect, it } from "vitest";
import { cellToPoint, detectFloors, gridSpec } from "@/lib/floorplan";
import type { PointCloud } from "@/lib/laz-reader";

/**
 * Bouwt een puntenwolk met vloervlakken op opgegeven hoogtes, plus muren
 * ertussen — dezelfde vorm als een echte scan, zonder een bestand nodig te
 * hebben.
 */
function buildCloud(floors: number[]): PointCloud {
  const pts: number[] = [];
  for (const z of floors) {
    // Vloervlak: veel punten op één hoogte.
    for (let i = 0; i < 4000; i++) {
      pts.push((i % 60) * 0.1, Math.floor(i / 60) * 0.1, z);
    }
    // Muren: punten verspreid over de hoogte erboven.
    for (let i = 0; i < 1200; i++) {
      pts.push((i % 40) * 0.15, 0, z + 0.2 + (i % 20) * 0.12);
    }
  }
  const xyz = new Float32Array(pts);
  const zs = floors.flatMap((z) => [z, z + 2.6]);
  return {
    format: "laz",
    count: pts.length / 3,
    totalInFile: pts.length / 3,
    xyz,
    rgb: null,
    bounds: {
      minX: 0,
      maxX: 6,
      minY: 0,
      maxY: 6.6,
      minZ: Math.min(...zs) - 0.1,
      maxZ: Math.max(...zs),
    },
    generator: "test",
  };
}

describe("detectFloors", () => {
  it("vindt drie verdiepingen op realistische onderlinge afstand", () => {
    const floors = detectFloors(buildCloud([-4.0, -1.4, 1.5]));
    expect(floors).toHaveLength(3);
    expect(floors[0].floorZ).toBeCloseTo(-4.0, 1);
    expect(floors[1].floorZ).toBeCloseTo(-1.4, 1);
    expect(floors[2].floorZ).toBeCloseTo(1.5, 1);
    // Van laag naar hoog, en elk met punten in de doorsnede erboven.
    expect(floors.every((f) => f.slicePoints > 0)).toBe(true);
  });

  it("ziet een enkele bouwlaag als één vloer", () => {
    expect(detectFloors(buildCloud([0]))).toHaveLength(1);
  });

  it("houdt vloeren die te dicht op elkaar liggen niet uit elkaar", () => {
    // 1,2 m verschil is geen verdieping maar bijvoorbeeld een vide of trap.
    expect(detectFloors(buildCloud([0, 1.2]))).toHaveLength(1);
  });

  it("geeft een lege lijst bij een wolk zonder hoogteverschil", () => {
    const pc = buildCloud([0]);
    expect(detectFloors({ ...pc, bounds: { ...pc.bounds, minZ: 0, maxZ: 0 } })).toEqual([]);
  });
});

describe("raster", () => {
  it("kiest een ronde celmaat en dekt de hele scan", () => {
    const pc = buildCloud([0]);
    const grid = gridSpec({ ...pc, bounds: { ...pc.bounds, minX: 0, maxX: 8.33, minY: 0, maxY: 15.43 } });
    expect([0.5, 1, 1.5, 2, 2.5, 3, 4, 5]).toContain(grid.cellM);
    expect(grid.cols * grid.cellM).toBeGreaterThanOrEqual(8.33);
    expect(grid.rows * grid.cellM).toBeGreaterThanOrEqual(15.43);
  });

  it("rekent een celaanduiding terug naar het midden van die cel", () => {
    const grid = { cellM: 1, cols: 8, rows: 16, minX: 0, maxY: 16 };
    // A1 is linksboven: eerste kolom, eerste rij vanaf de bovenkant.
    expect(cellToPoint(grid, "A1")).toEqual({ x: 0.5, y: 15.5 });
    expect(cellToPoint(grid, "C4")).toEqual({ x: 2.5, y: 12.5 });
    expect(cellToPoint(grid, "c4")).toEqual({ x: 2.5, y: 12.5 });
  });

  it("weigert cellen buiten het raster en onzin", () => {
    const grid = { cellM: 1, cols: 3, rows: 3, minX: 0, maxY: 3 };
    expect(cellToPoint(grid, "Z1")).toBeNull();
    expect(cellToPoint(grid, "A9")).toBeNull();
    expect(cellToPoint(grid, "linksboven")).toBeNull();
  });
});

/**
 * Draait alleen met een echte export:
 *   PC_SAMPLE="/pad/naar/scan.laz" npx vitest run lib/floorplan.test.ts
 */
const sample = process.env.PC_SAMPLE;
describe.skipIf(!sample)("echte export", () => {
  it("leest de punten en vindt de bouwlagen", async () => {
    const { readFile } = await import("node:fs/promises");
    const { readPointCloud } = await import("@/lib/laz-reader");
    const buf = await readFile(sample!);
    const pc = await readPointCloud(new Blob([new Uint8Array(buf)]));
    const floors = detectFloors(pc);
    console.log({
      formaat: pc.format,
      generator: pc.generator,
      puntenInBestand: pc.totalInFile,
      ingelezen: pc.count,
      afmetingen: {
        b: +(pc.bounds.maxX - pc.bounds.minX).toFixed(2),
        d: +(pc.bounds.maxY - pc.bounds.minY).toFixed(2),
        h: +(pc.bounds.maxZ - pc.bounds.minZ).toFixed(2),
      },
      bouwlagen: floors.map((f) => ({
        vloer: +f.floorZ.toFixed(2),
        vloerpunten: f.floorPoints,
        doorsnede: f.slicePoints,
      })),
    });
    const { buildingOutline, wallAlignment } = await import("@/lib/scan-analysis");
    for (let i = 0; i < floors.length; i++) {
      const bereik = { low: floors[i].floorZ - 0.2, high: floors[i].floorZ + 2.2 };
      const as = wallAlignment(pc, { low: floors[i].floorZ + 1.0, high: floors[i].floorZ + 1.6 });
      const omtrek = buildingOutline(pc, bereik, as?.axisDeg ?? 0);
      console.log(
        `laag ${i + 1}: hoofdrichting ${as?.axisDeg}° | ${omtrek?.polygon.length ?? 0} hoekpunten | ` +
          `${omtrek?.edges.length ?? 0} zijden`,
        omtrek?.edges
          .slice(0, 10)
          .map((e) => `${e.lengthM.toFixed(1)}m@${e.deviationDeg.toFixed(0)}°`)
          .join(" ")
      );
    }
    expect(pc.count).toBeGreaterThan(1000);
    expect(floors.length).toBeGreaterThan(0);
  }, 120_000);
});
