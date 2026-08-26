/**
 * Leest de punten uit een geoptimaliseerde export (.las of .laz).
 *
 * Dit is wat een .dp níet geeft: de dieptedata in een Dot3D-bestand zit in een
 * gesloten formaat, waardoor we het daar met cameraposities moeten doen en er
 * geen plattegrond uit te halen valt. Een geëxporteerde puntenwolk bevat de
 * punten wél, en daarmee is een echte horizontale doorsnede te tekenen — zelfde
 * principe als Mediatask zelf hanteert (gids p20: doorsneden op 150 cm voor
 * NEN2580).
 *
 * .las is onversleuteld en lezen we direct. .laz is met laszip gecomprimeerd;
 * daarvoor gebruiken we laz-perf (WebAssembly), dat in de browser draait zodat
 * het bestand niet naar de server hoeft.
 */

import type { PointCloudFormat } from "@/lib/pointcloud-header";

/** Boven dit aantal punten dunnen we uit; meer voegt visueel niets toe. */
const MAX_POINTS = 1_500_000;

export interface PointCloud {
  format: PointCloudFormat;
  /** Aantal punten dat daadwerkelijk is ingelezen (na uitdunnen). */
  count: number;
  /** Aantal punten volgens de bestandskop. */
  totalInFile: number;
  /** x, y, z per punt, achter elkaar, in meters. */
  xyz: Float32Array;
  /**
   * r, g, b per punt (0-255), als het bestand kleur bevat. Zonder kleur valt
   * de weergave terug op schaduw op hoogte.
   */
  rgb: Uint8Array | null;
  bounds: { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number };
  generator: string | null;
}

/**
 * Bij welke byte in een puntrecord de kleur staat, per LAS-puntformaat. De
 * formaten zonder kleur staan er niet in; die leveren een grijs beeld op dat
 * op hoogte geschaduwd wordt.
 */
const RGB_OFFSET: Record<number, number> = { 2: 20, 3: 28, 5: 28, 7: 30, 8: 30 };

interface LasHeader {
  compressed: boolean;
  /** Puntformaat zonder de compressievlag. */
  pointFormat: number;
  /** Positie van de kleur in het record, of null als dit formaat geen kleur heeft. */
  rgbOffset: number | null;
  pointCount: number;
  pointOffset: number;
  pointLength: number;
  scale: [number, number, number];
  offset: [number, number, number];
  bounds: PointCloud["bounds"];
  generator: string;
}

function parseLasHeader(bytes: Uint8Array): LasHeader {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (new TextDecoder("latin1").decode(bytes.subarray(0, 4)) !== "LASF") {
    throw new Error("Geen LAS/LAZ-bestand");
  }
  // Bit 7 van het puntformaat is de laszip-vlag.
  const rawFormat = bytes[104];
  const pointFormat = rawFormat & 0x3f;
  return {
    compressed: (rawFormat & 0x80) !== 0,
    pointFormat,
    rgbOffset: RGB_OFFSET[pointFormat] ?? null,
    pointOffset: view.getUint32(96, true),
    pointLength: view.getUint16(105, true),
    pointCount: view.getUint32(107, true),
    scale: [view.getFloat64(131, true), view.getFloat64(139, true), view.getFloat64(147, true)],
    offset: [view.getFloat64(155, true), view.getFloat64(163, true), view.getFloat64(171, true)],
    bounds: {
      maxX: view.getFloat64(179, true),
      minX: view.getFloat64(187, true),
      maxY: view.getFloat64(195, true),
      minY: view.getFloat64(203, true),
      maxZ: view.getFloat64(211, true),
      minZ: view.getFloat64(219, true),
    },
    generator: new TextDecoder("latin1").decode(bytes.subarray(58, 90)).replace(/\0+$/, "").trim(),
  };
}

export async function readPointCloud(blob: Blob): Promise<PointCloud> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const header = parseLasHeader(bytes);
  if (header.pointCount === 0) throw new Error("Puntenwolk bevat geen punten");

  // Uitdunnen door regelmatig punten over te slaan: bij een woning is de
  // puntdichtheid ruim voldoende, en het scheelt geheugen en tekentijd.
  const step = Math.max(1, Math.ceil(header.pointCount / MAX_POINTS));
  const keep = Math.floor(header.pointCount / step);
  const xyz = new Float32Array(keep * 3);
  const rgb = header.rgbOffset !== null ? new Uint8Array(keep * 3) : null;

  if (header.compressed) {
    await readCompressed(bytes, header, xyz, rgb, step, keep);
  } else {
    readUncompressed(bytes, header, xyz, rgb, step, keep);
  }

  return {
    format: header.compressed ? "laz" : "las",
    count: keep,
    totalInFile: header.pointCount,
    xyz,
    rgb,
    bounds: header.bounds,
    generator: header.generator || null,
  };
}

function readUncompressed(
  bytes: Uint8Array,
  h: LasHeader,
  out: Float32Array,
  kleur: Uint8Array | null,
  step: number,
  keep: number
) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < keep; i++) {
    const at = h.pointOffset + i * step * h.pointLength;
    out[i * 3] = view.getInt32(at, true) * h.scale[0] + h.offset[0];
    out[i * 3 + 1] = view.getInt32(at + 4, true) * h.scale[1] + h.offset[1];
    out[i * 3 + 2] = view.getInt32(at + 8, true) * h.scale[2] + h.offset[2];
    if (kleur && h.rgbOffset !== null) {
      // LAS bewaart kleur als 16-bits kanalen; wij hebben aan 8 bits genoeg.
      kleur[i * 3] = view.getUint16(at + h.rgbOffset, true) >> 8;
      kleur[i * 3 + 1] = view.getUint16(at + h.rgbOffset + 2, true) >> 8;
      kleur[i * 3 + 2] = view.getUint16(at + h.rgbOffset + 4, true) >> 8;
    }
  }
}

/**
 * laz-perf levert punt voor punt aan; overslaan kan niet, dus we lezen ze
 * allemaal en houden er één op de `step` bij.
 */
async function readCompressed(
  bytes: Uint8Array,
  h: LasHeader,
  out: Float32Array,
  kleur: Uint8Array | null,
  step: number,
  keep: number
) {
  const { createLazPerf } = await import("laz-perf");
  const lazPerf = await createLazPerf(
    // In de browser staat de wasm in public/, zodat hij van de eigen origin
    // komt. In Node (tests) vindt laz-perf zijn eigen bestand wel.
    typeof window === "undefined"
      ? undefined
      : { locateFile: (path: string) => (path.endsWith(".wasm") ? "/laz-perf.wasm" : path) }
  );

  const filePtr = lazPerf._malloc(bytes.byteLength);
  const pointPtr = lazPerf._malloc(h.pointLength);
  const reader = new lazPerf.LASZip();
  try {
    lazPerf.HEAPU8.set(bytes, filePtr);
    reader.open(filePtr, bytes.byteLength);

    // De WebAssembly-heap kan tijdens het lezen groeien; daarbij raakt de
    // onderliggende ArrayBuffer los en werkt een eerder gemaakte view niet
    // meer. Vandaar dat we hem opnieuw maken zodra de buffer verwisseld is.
    let buffer = lazPerf.HEAPU8.buffer;
    let heap = new DataView(buffer);
    let kept = 0;
    for (let i = 0; i < h.pointCount && kept < keep; i++) {
      reader.getPoint(pointPtr);
      if (i % step !== 0) continue;
      if (lazPerf.HEAPU8.buffer !== buffer) {
        buffer = lazPerf.HEAPU8.buffer;
        heap = new DataView(buffer);
      }
      out[kept * 3] = heap.getInt32(pointPtr, true) * h.scale[0] + h.offset[0];
      out[kept * 3 + 1] = heap.getInt32(pointPtr + 4, true) * h.scale[1] + h.offset[1];
      out[kept * 3 + 2] = heap.getInt32(pointPtr + 8, true) * h.scale[2] + h.offset[2];
      if (kleur && h.rgbOffset !== null) {
        kleur[kept * 3] = heap.getUint16(pointPtr + h.rgbOffset, true) >> 8;
        kleur[kept * 3 + 1] = heap.getUint16(pointPtr + h.rgbOffset + 2, true) >> 8;
        kleur[kept * 3 + 2] = heap.getUint16(pointPtr + h.rgbOffset + 4, true) >> 8;
      }
      kept++;
    }
  } finally {
    reader.delete();
    lazPerf._free(filePtr);
    lazPerf._free(pointPtr);
  }
}
