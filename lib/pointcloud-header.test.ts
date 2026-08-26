import { describe, expect, it } from "vitest";
import { readPointCloudHeader } from "@/lib/pointcloud-header";

/** Bouwt een LAS-kop met opgegeven afmetingen; genoeg om de parser te toetsen. */
function buildLas(opts: { compressed: boolean; points: number; extent: [number, number, number] }): Blob {
  const buf = new ArrayBuffer(512);
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);
  bytes.set(new TextEncoder().encode("LASF"), 0);
  bytes.set(new TextEncoder().encode("Dot3D"), 58);
  view.setUint8(104, opts.compressed ? 2 | 0x80 : 2);
  view.setUint32(107, opts.points, true);
  const [x, y, z] = opts.extent;
  view.setFloat64(179, x, true); // maxX
  view.setFloat64(187, 0, true); // minX
  view.setFloat64(195, y, true); // maxY
  view.setFloat64(203, 0, true); // minY
  view.setFloat64(211, z, true); // maxZ
  view.setFloat64(219, 0, true); // minZ
  return new Blob([buf]);
}

describe("readPointCloudHeader", () => {
  it("leest aantal punten en afmetingen uit een LAS-kop", async () => {
    const h = await readPointCloudHeader(
      buildLas({ compressed: false, points: 1_007_080, extent: [8.33, 15.43, 8.15] })
    );
    expect(h.format).toBe("las");
    expect(h.points).toBe(1_007_080);
    expect(h.generator).toBe("Dot3D");
    expect(h.extentM?.x).toBeCloseTo(8.33, 2);
    expect(h.footprintM2).toBeCloseTo(8.33 * 15.43, 2);
    expect(h.heightM).toBeCloseTo(8.15, 2);
  });

  it("leest dezelfde kop uit een gecomprimeerde .laz zonder te decomprimeren", async () => {
    const h = await readPointCloudHeader(
      buildLas({ compressed: true, points: 500, extent: [4, 6, 3] })
    );
    expect(h.format).toBe("laz");
    expect(h.points).toBe(500);
    expect(h.footprintM2).toBeCloseTo(24, 5);
  });

  it("herkent de andere exportformaten van Dot3D", async () => {
    expect((await readPointCloudHeader(new Blob(["ply\nformat ascii 1.0\n"]))).format).toBe("ply");
    expect((await readPointCloudHeader(new Blob(["ASTM-E57 3D Imaging Data File"]))).format).toBe("e57");
    const pts = await readPointCloudHeader(new Blob(["123456\n1.0 2.0 3.0 0\n"]));
    expect(pts.format).toBe("pts");
    expect(pts.points).toBe(123456);
  });

  it("meldt onbekend in plaats van te gokken", async () => {
    const h = await readPointCloudHeader(new Blob(["dit is geen puntenwolk"]));
    expect(h.format).toBe("onbekend");
    expect(h.extentM).toBeNull();
  });
});

/**
 * Draait alleen als je een echte export aanwijst:
 *   PC_SAMPLE="/pad/naar/scan.laz" npx vitest run lib/pointcloud-header.test.ts
 */
const sample = process.env.PC_SAMPLE;
describe.skipIf(!sample)("echte export", () => {
  it("leest de kop van een echte puntenwolk", async () => {
    const { readFile } = await import("node:fs/promises");
    const buf = await readFile(sample!);
    const h = await readPointCloudHeader(new Blob([new Uint8Array(buf)]));
    console.log({
      formaat: h.format,
      generator: h.generator,
      punten: h.points,
      afmetingen: h.extentM && {
        x: +h.extentM.x.toFixed(2),
        y: +h.extentM.y.toFixed(2),
        z: +h.extentM.z.toFixed(2),
      },
      grondvlakM2: h.footprintM2 && +h.footprintM2.toFixed(1),
      hoogteM: h.heightM && +h.heightM.toFixed(2),
    });
    expect(h.format).not.toBe("onbekend");
    expect(h.points).toBeGreaterThan(0);
  }, 60_000);
});
