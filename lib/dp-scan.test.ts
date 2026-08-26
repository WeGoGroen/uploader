import { describe, expect, it } from "vitest";
import { bytesReader, readDpScan } from "@/lib/dp-scan";
import { computeMetrics } from "@/lib/dp-metrics";
import {
  overallVerdict,
  runMeasurementChecks,
  type CheckResult,
  type CheckStatus,
} from "@/lib/dp-checks";

/**
 * Bouwt een minimaal geldig .dp-bestand: magic, een paar kopvelden, twee
 * keyframes en één "foto". Genoeg om de recordketen en de poses te toetsen
 * zonder een scan van 300 MB in de repo te zetten.
 */
function buildDp(): Uint8Array {
  const chunks: Uint8Array[] = [];
  chunks.push(new TextEncoder().encode("DP_BINARY_DATA__"));

  const record = (key: number, payload: Uint8Array) => {
    const head = new Uint8Array(8);
    const v = new DataView(head.buffer);
    v.setUint32(0, key, true);
    v.setUint32(4, payload.byteLength, true);
    chunks.push(head, payload);
  };

  const u32 = (n: number) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n, true);
    return b;
  };
  const u64 = (n: number) => {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, BigInt(n), true);
    return b;
  };
  const doubles = (vals: number[]) => {
    const b = new Uint8Array(vals.length * 8);
    const v = new DataView(b.buffer);
    vals.forEach((x, i) => v.setFloat64(i * 8, x, true));
    return b;
  };

  record(0, u32(2)); // aantal keyframes
  record(2, u64(1786439968)); // scanmoment
  // Eenheidsmatrix als globale transform: scan staat al recht.
  record(4, doubles([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]));
  record(9, new TextEncoder().encode("===== Dot3D Version 6.4.6 (36ce02) =====\nSensor Serial: 123\nPlatform: iPad14,3; iPadOS 26.6\n"));
  record(37, new TextEncoder().encode("/Documents/Dot3d/Data/31 1.dp"));

  // Twee keyframes: pose (9 rotatie + 3 translatie) plus wat dummy-payload.
  const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  record(1000, concat(doubles([...identity, 0, 1500, 0]), new Uint8Array(64)));
  record(1001, concat(doubles([...identity, 2000, 1500, 0]), new Uint8Array(64)));

  // Eén foto: uint64 lengte + JPEG-bytes.
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
  record(500, concat(u64(jpeg.byteLength), jpeg));

  return concat(...chunks);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

describe("readDpScan", () => {
  it("leest kopvelden, poses en foto's uit een geldig bestand", async () => {
    const scan = await readDpScan(bytesReader(buildDp()));
    expect(scan.dot3dVersion).toBe("6.4.6");
    expect(scan.sensorSerial).toBe("123");
    expect(scan.platform).toBe("iPad14,3; iPadOS 26.6");
    expect(scan.declaredKeyframes).toBe(2);
    expect(scan.sourcePath).toContain("31 1.dp");
    expect(scan.capturedAt?.getUTCFullYear()).toBe(2026);
    expect(scan.poses).toHaveLength(2);
    expect(scan.photos).toHaveLength(1);
  });

  it("weigert een bestand zonder Dot3D-magic", async () => {
    const bogus = new TextEncoder().encode("PK dit is een zip");
    await expect(readDpScan(bytesReader(bogus))).rejects.toThrow(/magic/i);
  });

  it("weigert een afgekapt bestand in plaats van er stil overheen te lopen", async () => {
    const full = buildDp();
    await expect(readDpScan(bytesReader(full.subarray(0, full.byteLength - 4)))).rejects.toThrow(
      /beschadigd|onvolledig/i
    );
  });

  it("rekent de camerabaan om naar meters", async () => {
    const metrics = computeMetrics(await readDpScan(bytesReader(buildDp())));
    expect(metrics.keyframes).toBe(2);
    expect(metrics.photos).toBe(1);
    // Twee poses, 2000 mm uit elkaar.
    expect(metrics.pathLengthM).toBeCloseTo(2, 3);
    expect(metrics.loopClosureM).toBeCloseTo(2, 3);
    // Beide poses staan even hoog, dus de verplaatsing zit in het platte vlak.
    expect(metrics.bboxM.height).toBeCloseTo(0, 3);
    expect(Math.hypot(metrics.bboxM.width, metrics.bboxM.depth)).toBeCloseTo(2, 3);
    // Beide keyframes hebben dezelfde oriëntatie, dus de hoogte-as staat vast.
    expect(metrics.heightConfidence).toBeCloseTo(1, 6);
    // Sprong van 2 m blijft onder de drempel van 3 m en telt dus niet mee.
    expect(metrics.maxStepM).toBe(0);
  });
});

/**
 * Draait alleen als je een echte scan aanwijst. Handig bij een nieuwe
 * Dot3D-versie: als het formaat verandert, valt dat hier meteen om.
 *
 *   DP_SAMPLE="/pad/naar/31 1.dp" npx vitest run lib/dp-scan.test.ts
 */
const sample = process.env.DP_SAMPLE;
describe.skipIf(!sample)("echte scan", () => {
  it("leest een echt .dp-bestand en levert plausibele meetwaarden", async () => {
    const { readFile } = await import("node:fs/promises");
    const scan = await readDpScan(bytesReader(await readFile(sample!)));
    const metrics = computeMetrics(scan);
    console.log({
      dot3d: scan.dot3dVersion,
      platform: scan.platform,
      gescandOp: scan.capturedAt?.toISOString(),
      keyframes: metrics.keyframes,
      fotos: metrics.photos,
      duurMin: metrics.durationSeconds && +(metrics.durationSeconds / 60).toFixed(1),
      looplengteM: +metrics.pathLengthM.toFixed(1),
      rondjeGeslotenM: +metrics.loopClosureM.toFixed(2),
      grondvlakM2: +metrics.sweptAreaM2.toFixed(1),
      bbox: {
        b: +metrics.bboxM.width.toFixed(1),
        d: +metrics.bboxM.depth.toFixed(1),
        h: +metrics.bboxM.height.toFixed(1),
      },
      bouwlagen: metrics.levels.map((l) => ({
        hoogte: +l.heightM.toFixed(2),
        aandeel: +(l.share * 100).toFixed(0),
      })),
      hoogteBetrouwbaarheid: +metrics.heightConfidence.toFixed(2),
      groteSprongen: metrics.largeSteps.length,
      grootsteStapM: +metrics.maxStepM.toFixed(2),
    });
    console.log("referentiematen", scan.referenceDistances);
    console.log(
      runMeasurementChecks(metrics, {
        fileName: sample!.split("/").pop()!,
        referenceDistances: scan.referenceDistances,
      })
    );
    expect(scan.poses.length).toBeGreaterThan(10);
    expect(metrics.pathLengthM).toBeGreaterThan(1);
    expect(scan.declaredKeyframes).toBe(scan.poses.length);
  }, 120_000);
});

describe("overallVerdict", () => {
  const r = (status: CheckStatus): CheckResult => ({ id: status, status, toelichting: "" });

  it("laat één afkeurpunt de doorslag geven", () => {
    expect(overallVerdict([r("ok"), r("afwijking"), r("afkeuren")])).toBe("afkeuren");
  });

  it("houdt een afwijking los van een afkeuring", () => {
    // Verschillen met de BAG kleuren rood, maar mogen het versturen niet
    // tegenhouden — die registratie klopt te vaak niet.
    expect(overallVerdict([r("ok"), r("afwijking")])).toBe("afwijking");
    expect(overallVerdict([r("ok"), r("twijfel"), r("afwijking")])).toBe("afwijking");
  });

  it("geeft groen alleen als er niets openstaat", () => {
    expect(overallVerdict([r("ok"), r("ok")])).toBe("ok");
    expect(overallVerdict([r("ok"), r("twijfel")])).toBe("twijfel");
    expect(overallVerdict([r("onbekend")])).toBe("onbekend");
  });
});
