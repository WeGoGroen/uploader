import { describe, expect, it } from "vitest";
import { isPointCloudFile, pointCloudExtension, readAnyPointCloud } from "@/lib/pointcloud-read";

/** Drie punten die samen een herkenbare omhullende doos vormen. */
const PUNTEN: [number, number, number][] = [
  [0, 0, 0],
  [2, 4, 1],
  [-1, 1, 3],
];

function plyAscii(): Blob {
  const kop = [
    "ply",
    "format ascii 1.0",
    `element vertex ${PUNTEN.length}`,
    "property float x",
    "property float y",
    "property float z",
    "end_header",
  ].join("\n");
  return new Blob([`${kop}\n${PUNTEN.map((p) => p.join(" ")).join("\n")}\n`]);
}

function plyBinair(metKleur: boolean): Blob {
  const props = ["property float x", "property float y", "property float z"];
  if (metKleur) props.push("property uchar red", "property uchar green", "property uchar blue");
  const kop = [
    "ply",
    "format binary_little_endian 1.0",
    `element vertex ${PUNTEN.length}`,
    ...props,
    "end_header",
  ].join("\n");
  const kopBytes = new TextEncoder().encode(`${kop}\n`);
  const stride = metKleur ? 15 : 12;
  const body = new Uint8Array(PUNTEN.length * stride);
  const view = new DataView(body.buffer);
  PUNTEN.forEach((p, i) => {
    const at = i * stride;
    view.setFloat32(at, p[0], true);
    view.setFloat32(at + 4, p[1], true);
    view.setFloat32(at + 8, p[2], true);
    if (metKleur) {
      view.setUint8(at + 12, 10);
      view.setUint8(at + 13, 20);
      view.setUint8(at + 14, 30);
    }
  });
  return new Blob([kopBytes, body]);
}

describe("pointCloudExtension", () => {
  it("herkent de formaten die Dot3D en Mediatask gebruiken", () => {
    expect(pointCloudExtension("scan.laz")).toBe("las");
    expect(pointCloudExtension("scan.LAS")).toBe("las");
    expect(pointCloudExtension("scan.ply")).toBe("ply");
    expect(pointCloudExtension("scan.pts")).toBe("pts");
    expect(pointCloudExtension("scan.e57")).toBe("e57");
    expect(pointCloudExtension("scan_raw.dp")).toBeNull();
    expect(isPointCloudFile("Kerkstraat 31.ply")).toBe(true);
    expect(isPointCloudFile("Kerkstraat 31_raw.dp")).toBe(false);
  });
});

describe("readAnyPointCloud", () => {
  it("leest een PLY in tekstvorm", async () => {
    const pc = await readAnyPointCloud(plyAscii(), "scan.ply");
    expect(pc.format).toBe("ply");
    expect(pc.count).toBe(3);
    expect(pc.bounds).toMatchObject({ minX: -1, maxX: 2, minY: 0, maxY: 4, minZ: 0, maxZ: 3 });
    expect([...pc.xyz.slice(3, 6)]).toEqual([2, 4, 1]);
  });

  it("leest een binaire PLY", async () => {
    const pc = await readAnyPointCloud(plyBinair(false), "scan.ply");
    expect(pc.count).toBe(3);
    expect([...pc.xyz.slice(6, 9)]).toEqual([-1, 1, 3]);
  });

  it("slaat kleurvelden over zonder de maatvoering te verstoren", async () => {
    const pc = await readAnyPointCloud(plyBinair(true), "scan.ply");
    expect(pc.count).toBe(3);
    expect(pc.bounds.maxY).toBe(4);
    expect([...pc.xyz.slice(6, 9)]).toEqual([-1, 1, 3]);
  });

  it("leest een PTS met aantalregel, intensiteit en kleur", async () => {
    const tekst = `3\n0 0 0 -1000 10 20 30\n2 4 1 -900 10 20 30\n-1 1 3 -800 10 20 30\n`;
    const pc = await readAnyPointCloud(new Blob([tekst]), "scan.pts");
    expect(pc.format).toBe("pts");
    expect(pc.count).toBe(3);
    expect(pc.bounds.maxZ).toBe(3);
  });

  it("rekent een export in millimeters om naar meters", async () => {
    // Dot3D schrijft in millimeters weg; in het bestand staat nergens welke
    // eenheid het is, dus dat leiden we af uit de omvang.
    const mm: [number, number, number][] = [
      [0, 0, 0],
      [8330, 15430, 8150],
    ];
    const kop = [
      "ply",
      "format ascii 1.0",
      `element vertex ${mm.length}`,
      "property float x",
      "property float y",
      "property float z",
      "end_header",
    ].join("\n");
    const pc = await readAnyPointCloud(
      new Blob([`${kop}\n${mm.map((p) => p.join(" ")).join("\n")}\n`]),
      "scan.ply"
    );
    expect(pc.bounds.maxX).toBeCloseTo(8.33, 3);
    expect(pc.bounds.maxY).toBeCloseTo(15.43, 3);
    expect(pc.bounds.maxZ).toBeCloseTo(8.15, 3);
    expect(pc.xyz[3]).toBeCloseTo(8.33, 3);
  });

  it("laat een export die al in meters staat ongemoeid", async () => {
    const pc = await readAnyPointCloud(plyAscii(), "scan.ply");
    expect(pc.bounds.maxX).toBe(2);
    expect(pc.bounds.maxY).toBe(4);
  });

  it("meldt duidelijk dat E57 nog niet gelezen wordt", async () => {
    await expect(readAnyPointCloud(new Blob(["ASTM-E57"]), "scan.e57")).rejects.toThrow(/E57/);
  });

  it("weigert een bestand zonder punten in plaats van een lege wolk te leveren", async () => {
    const leeg = "ply\nformat ascii 1.0\nelement vertex 0\nproperty float x\nend_header\n";
    await expect(readAnyPointCloud(new Blob([leeg]), "scan.ply")).rejects.toThrow(/geen punten/i);
  });
});
