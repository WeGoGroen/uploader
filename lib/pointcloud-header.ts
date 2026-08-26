/**
 * Leest de kop van een geoptimaliseerde puntenwolk-export (.las of .laz) en
 * herkent de andere formaten die Dot3D kan wegschrijven.
 *
 * Waarom alleen de kop: in het LAS-formaat staan het aantal punten en de exacte
 * omhullende doos in de eerste 375 bytes, ónvercompresseerd — ook in een .laz,
 * want laszip comprimeert alleen de puntrecords erna. Eén enkele lees-actie van
 * 400 bytes levert dus de werkelijke afmetingen van het pand op, zonder de
 * tientallen MB's aan puntdata aan te raken.
 *
 * Dat is precies wat de RAW-scan mist. De camerabaan in een _raw.dp is nog niet
 * geoptimaliseerd en dus vervormd; de Optimized-export is dat wél, en is
 * bovendien het bestand dat Mediatask zelf gebruikt. De omhullende doos daaruit
 * is daarmee de betrouwbaarste maat die we zonder zwaar rekenwerk hebben.
 */

export type PointCloudFormat = "las" | "laz" | "e57" | "ply" | "pts" | "onbekend";

export interface PointCloudHeader {
  format: PointCloudFormat;
  /** Aantal punten, als de kop dat prijsgeeft. */
  points: number | null;
  /** Afmetingen van de omhullende doos in meters, als bekend. */
  extentM: { x: number; y: number; z: number } | null;
  /** Naam van het programma dat het bestand schreef, als bekend. */
  generator: string | null;
  /** Grondvlak van de omhullende doos in m² — hoogte-as eruit gelaten. */
  footprintM2: number | null;
  /** Hoogte van de omhullende doos in meters. */
  heightM: number | null;
}

/** Zoveel bytes hebben we nodig; de LAS-kop is nooit langer. */
const PROBE_BYTES = 512;

/**
 * Herkent het formaat en haalt eruit wat zonder decompressie te halen valt.
 * Gooit niet: een onbekend formaat komt terug als "onbekend" met lege velden,
 * zodat de aanroeper zelf kan bepalen wat dat betekent.
 */
export async function readPointCloudHeader(blob: Blob): Promise<PointCloudHeader> {
  const bytes = new Uint8Array(await blob.slice(0, PROBE_BYTES).arrayBuffer());
  const leeg: PointCloudHeader = {
    format: "onbekend",
    points: null,
    extentM: null,
    generator: null,
    footprintM2: null,
    heightM: null,
  };
  if (bytes.byteLength < 8) return leeg;

  const ascii = (start: number, length: number) =>
    new TextDecoder("latin1").decode(bytes.subarray(start, start + length));

  if (ascii(0, 4) === "LASF") return readLas(bytes);
  if (ascii(0, 3) === "ply") return { ...leeg, format: "ply" };
  // E57 begint met een ASTM-handtekening.
  if (ascii(0, 8) === "ASTM-E57") return { ...leeg, format: "e57" };
  // PTS is platte tekst: eerste regel is het aantal punten.
  const eersteRegel = ascii(0, 32).split(/\r?\n/)[0]?.trim();
  if (eersteRegel && /^\d+$/.test(eersteRegel)) {
    return { ...leeg, format: "pts", points: Number(eersteRegel) };
  }
  return leeg;
}

function readLas(bytes: Uint8Array): PointCloudHeader {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const generator = new TextDecoder("latin1")
    .decode(bytes.subarray(58, 90))
    .replace(/\0+$/, "")
    .trim();

  const pointFormat = bytes[104];
  // Bit 7 van het puntformaat is de laszip-vlag: staat die aan, dan zijn de
  // puntrecords gecomprimeerd (.laz). De kop zelf blijft gewoon leesbaar.
  const gecomprimeerd = (pointFormat & 0x80) !== 0;

  const points = view.getUint32(107, true);
  const maxX = view.getFloat64(179, true);
  const minX = view.getFloat64(187, true);
  const maxY = view.getFloat64(195, true);
  const minY = view.getFloat64(203, true);
  const maxZ = view.getFloat64(211, true);
  const minZ = view.getFloat64(219, true);

  const x = maxX - minX;
  const y = maxY - minY;
  const z = maxZ - minZ;
  const bruikbaar = [x, y, z].every((v) => Number.isFinite(v) && v >= 0);

  return {
    format: gecomprimeerd ? "laz" : "las",
    points: points > 0 ? points : null,
    extentM: bruikbaar ? { x, y, z } : null,
    generator: generator || null,
    // In een geoptimaliseerde export is Z de verticale as (de gids, p24: de
    // Z-as hoort omhoog te wijzen). Het grondvlak is dan X maal Y.
    footprintM2: bruikbaar ? x * y : null,
    heightM: bruikbaar ? z : null,
  };
}
