/**
 * Leest een geëxporteerde puntenwolk, ongeacht in welk formaat de opnemer 'm
 * heeft weggeschreven.
 *
 * Dot3D exporteert naar pts, ply en e57 (gids p19); Mediatask accepteert
 * daarnaast las. Welk formaat het is doet er voor de rest van de controle niet
 * toe — alles komt hier binnen als dezelfde PointCloud, met x, y, z in meters
 * en Z omhoog.
 *
 * Waarom niet gewoon het .dp-bestand? Dat bevat de punten wel, maar in een
 * eigen formaat: per keyframe een zstd-gecomprimeerde piramide van residuen ten
 * opzichte van het niveau eronder. Zonder documentatie is dat niet betrouwbaar
 * terug te rekenen naar meters. Een export kost de opnemer één handeling en
 * levert een gedocumenteerd bestand op.
 */

import { readPointCloud as readLas, type PointCloud } from "@/lib/laz-reader";

export type { PointCloud };

/** Boven dit aantal punten dunnen we uit; meer voegt visueel niets toe. */
const MAX_POINTS = 1_500_000;

export function pointCloudExtension(name: string): "las" | "ply" | "pts" | "e57" | null {
  const m = /\.([a-z0-9]+)$/i.exec(name.trim());
  const ext = m?.[1].toLowerCase();
  if (ext === "las" || ext === "laz") return "las";
  if (ext === "ply") return "ply";
  if (ext === "pts" || ext === "xyz") return "pts";
  if (ext === "e57") return "e57";
  return null;
}

/** Herkent een geëxporteerde puntenwolk aan de bestandsnaam. */
export function isPointCloudFile(name: string): boolean {
  return pointCloudExtension(name) !== null;
}

/**
 * Zet een wolk die in millimeters staat om naar meters.
 *
 * Dot3D werkt intern in millimeters en schrijft dat ook zo weg — in de app zie
 * je onderin "Units: millimeters" staan. Andere exports staan weer wél in
 * meters, en in het bestand staat nergens welke van de twee het is.
 *
 * Vandaar deze afweging op basis van de omvang: een woning is in meters hooguit
 * enkele tientallen groot en in millimeters al gauw tienduizenden. Alles boven
 * de 500 eenheden kán dus geen meters zijn. Die grens ligt zo ruim van beide
 * kanten af dat er geen echt pand tussen valt.
 */
function normaliseerEenheid(pc: PointCloud): PointCloud {
  const grootste = Math.max(
    pc.bounds.maxX - pc.bounds.minX,
    pc.bounds.maxY - pc.bounds.minY,
    pc.bounds.maxZ - pc.bounds.minZ
  );
  if (!Number.isFinite(grootste) || grootste <= 500) return pc;

  const f = 0.001;
  for (let i = 0; i < pc.xyz.length; i++) pc.xyz[i] *= f;
  return {
    ...pc,
    bounds: {
      minX: pc.bounds.minX * f,
      maxX: pc.bounds.maxX * f,
      minY: pc.bounds.minY * f,
      maxY: pc.bounds.maxY * f,
      minZ: pc.bounds.minZ * f,
      maxZ: pc.bounds.maxZ * f,
    },
  };
}

export async function readAnyPointCloud(file: Blob, name: string): Promise<PointCloud> {
  switch (pointCloudExtension(name)) {
    case "las":
      return normaliseerEenheid(await readLas(file));
    case "ply":
      return normaliseerEenheid(await readPly(file));
    case "pts":
      return normaliseerEenheid(await readPts(file));
    case "e57":
      throw new Error(
        "E57 wordt nog niet gelezen. Exporteer voorlopig als PLY of PTS, of stuur één .e57 door dan bouw ik de lezer erbij."
      );
    default:
      throw new Error(`Onbekend puntenwolkformaat: ${name}`);
  }
}

function emptyBounds() {
  return {
    minX: Infinity,
    maxX: -Infinity,
    minY: Infinity,
    maxY: -Infinity,
    minZ: Infinity,
    maxZ: -Infinity,
  };
}

function grow(b: ReturnType<typeof emptyBounds>, x: number, y: number, z: number) {
  if (x < b.minX) b.minX = x;
  if (x > b.maxX) b.maxX = x;
  if (y < b.minY) b.minY = y;
  if (y > b.maxY) b.maxY = y;
  if (z < b.minZ) b.minZ = z;
  if (z > b.maxZ) b.maxZ = z;
}

// ---------------------------------------------------------------- PLY -----

interface PlyProperty {
  name: string;
  size: number;
  read: (v: DataView, at: number, little: boolean) => number;
}

const PLY_TYPES: Record<string, { size: number; read: PlyProperty["read"] }> = {
  char: { size: 1, read: (v, a) => v.getInt8(a) },
  int8: { size: 1, read: (v, a) => v.getInt8(a) },
  uchar: { size: 1, read: (v, a) => v.getUint8(a) },
  uint8: { size: 1, read: (v, a) => v.getUint8(a) },
  short: { size: 2, read: (v, a, l) => v.getInt16(a, l) },
  int16: { size: 2, read: (v, a, l) => v.getInt16(a, l) },
  ushort: { size: 2, read: (v, a, l) => v.getUint16(a, l) },
  uint16: { size: 2, read: (v, a, l) => v.getUint16(a, l) },
  int: { size: 4, read: (v, a, l) => v.getInt32(a, l) },
  int32: { size: 4, read: (v, a, l) => v.getInt32(a, l) },
  uint: { size: 4, read: (v, a, l) => v.getUint32(a, l) },
  uint32: { size: 4, read: (v, a, l) => v.getUint32(a, l) },
  float: { size: 4, read: (v, a, l) => v.getFloat32(a, l) },
  float32: { size: 4, read: (v, a, l) => v.getFloat32(a, l) },
  double: { size: 8, read: (v, a, l) => v.getFloat64(a, l) },
  float64: { size: 8, read: (v, a, l) => v.getFloat64(a, l) },
};

/**
 * PLY: een ASCII-kop die de indeling beschrijft, gevolgd door de punten in
 * tekst of binair. We lezen alleen het element "vertex" en daaruit alleen x, y
 * en z; kleur en normalen slaan we over.
 */
async function readPly(file: Blob): Promise<PointCloud> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const kopEinde = vindEindHeader(bytes);
  if (kopEinde < 0) throw new Error("PLY-bestand mist 'end_header'");
  const kop = new TextDecoder("latin1").decode(bytes.subarray(0, kopEinde));

  const formaat = /format\s+(ascii|binary_little_endian|binary_big_endian)/i.exec(kop)?.[1];
  if (!formaat) throw new Error("PLY-bestand mist een formaatregel");
  const little = formaat !== "binary_big_endian";

  // Alleen het vertex-element telt; komt er daarna nog een element (faces),
  // dan negeren we dat.
  const regels = kop.split(/\r?\n/);
  let aantal = 0;
  let inVertex = false;
  const props: PlyProperty[] = [];
  for (const regel of regels) {
    const el = /^element\s+(\S+)\s+(\d+)/i.exec(regel);
    if (el) {
      inVertex = el[1].toLowerCase() === "vertex";
      if (inVertex) aantal = Number(el[2]);
      continue;
    }
    const pr = /^property\s+(\S+)\s+(\S+)/i.exec(regel);
    if (pr && inVertex) {
      if (pr[1].toLowerCase() === "list") {
        throw new Error("PLY met lijst-eigenschappen in vertex wordt niet ondersteund");
      }
      const type = PLY_TYPES[pr[1].toLowerCase()];
      if (!type) throw new Error(`Onbekend PLY-type: ${pr[1]}`);
      props.push({ name: pr[2].toLowerCase(), size: type.size, read: type.read });
    }
  }
  if (aantal === 0) throw new Error("PLY-bestand bevat geen punten");

  const iX = props.findIndex((p) => p.name === "x");
  const iY = props.findIndex((p) => p.name === "y");
  const iZ = props.findIndex((p) => p.name === "z");
  if (iX < 0 || iY < 0 || iZ < 0) throw new Error("PLY-bestand mist x, y of z");

  // Kleur is optioneel maar scheelt veel: met de echte kleuren erbij leest het
  // beeld als de weergave in Dot3D zelf, en herken je vloeren en meubels.
  const iR = props.findIndex((p) => p.name === "red" || p.name === "r");
  const iG = props.findIndex((p) => p.name === "green" || p.name === "g");
  const iB = props.findIndex((p) => p.name === "blue" || p.name === "b");
  const heeftKleur = iR >= 0 && iG >= 0 && iB >= 0;

  const step = Math.max(1, Math.ceil(aantal / MAX_POINTS));
  const keep = Math.floor(aantal / step);
  const xyz = new Float32Array(keep * 3);
  const rgb = heeftKleur ? new Uint8Array(keep * 3) : null;
  const bounds = emptyBounds();

  if (formaat === "ascii") {
    const tekst = new TextDecoder("latin1").decode(bytes.subarray(kopEinde));
    let gelezen = 0;
    let bewaard = 0;
    for (const regel of tekst.split(/\r?\n/)) {
      if (bewaard >= keep) break;
      const trimmed = regel.trim();
      if (!trimmed) continue;
      if (gelezen++ % step !== 0) continue;
      const delen = trimmed.split(/\s+/);
      const x = Number(delen[iX]);
      const y = Number(delen[iY]);
      const z = Number(delen[iZ]);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
      xyz[bewaard * 3] = x;
      xyz[bewaard * 3 + 1] = y;
      xyz[bewaard * 3 + 2] = z;
      if (rgb) {
        rgb[bewaard * 3] = Number(delen[iR]) || 0;
        rgb[bewaard * 3 + 1] = Number(delen[iG]) || 0;
        rgb[bewaard * 3 + 2] = Number(delen[iB]) || 0;
      }
      grow(bounds, x, y, z);
      bewaard++;
    }
    return klaar(xyz, bewaard, aantal, bounds, "ply", rgb);
  }

  const stride = props.reduce((n, p) => n + p.size, 0);
  const offsets: number[] = [];
  let loop = 0;
  for (const p of props) {
    offsets.push(loop);
    loop += p.size;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset + kopEinde);
  let bewaard = 0;
  for (let i = 0; i < keep; i++) {
    const at = i * step * stride;
    if (at + stride > view.byteLength) break;
    const x = props[iX].read(view, at + offsets[iX], little);
    const y = props[iY].read(view, at + offsets[iY], little);
    const z = props[iZ].read(view, at + offsets[iZ], little);
    xyz[bewaard * 3] = x;
    xyz[bewaard * 3 + 1] = y;
    xyz[bewaard * 3 + 2] = z;
    if (rgb) {
      rgb[bewaard * 3] = props[iR].read(view, at + offsets[iR], little);
      rgb[bewaard * 3 + 1] = props[iG].read(view, at + offsets[iG], little);
      rgb[bewaard * 3 + 2] = props[iB].read(view, at + offsets[iB], little);
    }
    grow(bounds, x, y, z);
    bewaard++;
  }
  return klaar(xyz, bewaard, aantal, bounds, "ply", rgb);
}

/** Zoekt "end_header" plus de regelovergang erna. */
function vindEindHeader(bytes: Uint8Array): number {
  const naald = new TextEncoder().encode("end_header");
  const grens = Math.min(bytes.byteLength, 65536);
  for (let i = 0; i < grens - naald.length; i++) {
    let raak = true;
    for (let j = 0; j < naald.length; j++) {
      if (bytes[i + j] !== naald[j]) {
        raak = false;
        break;
      }
    }
    if (!raak) continue;
    let einde = i + naald.length;
    if (bytes[einde] === 0x0d) einde++;
    if (bytes[einde] === 0x0a) einde++;
    return einde;
  }
  return -1;
}

// ---------------------------------------------------------------- PTS -----

/**
 * PTS is platte tekst: op de eerste regel het aantal punten, daarna per regel
 * "x y z" met eventueel intensiteit en kleur erachter. Simpel, maar log: een
 * woning van een miljoen punten is al gauw 50 MB tekst.
 */
async function readPts(file: Blob): Promise<PointCloud> {
  const tekst = await file.text();
  const regels = tekst.split(/\r?\n/);
  const eerste = regels[0]?.trim() ?? "";
  const opgegeven = /^\d+$/.test(eerste) ? Number(eerste) : 0;
  const start = opgegeven > 0 ? 1 : 0;
  const totaal = opgegeven > 0 ? opgegeven : regels.length - start;

  const step = Math.max(1, Math.ceil(totaal / MAX_POINTS));
  const xyz = new Float32Array(Math.floor(totaal / step) * 3 + 3);
  const bounds = emptyBounds();
  let gelezen = 0;
  let bewaard = 0;
  for (let i = start; i < regels.length; i++) {
    const regel = regels[i].trim();
    if (!regel) continue;
    if (gelezen++ % step !== 0) continue;
    const delen = regel.split(/\s+/);
    const x = Number(delen[0]);
    const y = Number(delen[1]);
    const z = Number(delen[2]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    if ((bewaard + 1) * 3 > xyz.length) break;
    xyz[bewaard * 3] = x;
    xyz[bewaard * 3 + 1] = y;
    xyz[bewaard * 3 + 2] = z;
    grow(bounds, x, y, z);
    bewaard++;
  }
  return klaar(xyz, bewaard, gelezen, bounds, "pts");
}

function klaar(
  xyz: Float32Array,
  bewaard: number,
  totaal: number,
  bounds: ReturnType<typeof emptyBounds>,
  format: PointCloud["format"],
  rgb: Uint8Array | null = null
): PointCloud {
  if (bewaard === 0) throw new Error("Puntenwolk bevat geen bruikbare punten");
  return {
    format,
    count: bewaard,
    totalInFile: totaal,
    xyz: xyz.subarray(0, bewaard * 3),
    rgb: rgb ? rgb.subarray(0, bewaard * 3) : null,
    bounds,
    generator: null,
  };
}
