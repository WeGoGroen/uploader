/**
 * Maakt van een geoptimaliseerde puntenwolk een plattegrond per bouwlaag.
 *
 * Werkwijze, gelijk aan wat Mediatask zelf doet (gids p20): zoek de vloeren op,
 * en teken per vloer een horizontale doorsnede op ooghoogte. Alles wat de
 * doorsnede raakt — muren, kozijnen, deurposten — verschijnt als lijn, en zo
 * ontstaat een beeld waarin een mens direct ziet of er een kamer ontbreekt of
 * een muur niet dichtloopt.
 *
 * Vloeren zijn te vinden als pieken in het hoogtehistogram: een vloervlak is
 * een groot horizontaal oppervlak en levert dus opvallend veel punten op
 * dezelfde hoogte. Op de referentiescan (Marnixkade) komen daar drie
 * verdiepingen uit, op 2,6 en 2,9 m van elkaar.
 */

import type { PointCloud } from "@/lib/laz-reader";

/** Resolutie van het hoogtehistogram waarin we vloeren zoeken, in meters. */
const HEIGHT_BIN_M = 0.05;
/** Minimale afstand tussen twee vloeren. Lager is geen verdieping maar een trede. */
const MIN_FLOOR_GAP_M = 2.0;
/** Een piek telt pas als vloer vanaf dit deel van de sterkste piek. */
const PEAK_THRESHOLD = 0.2;
/**
 * Een vloer moet minstens dit deel van het grondvlak beslaan.
 *
 * Zonder deze eis wordt elke plek waar toevallig veel punten op dezelfde hoogte
 * liggen als verdieping geteld — een aanrecht, een dakkapel, of simpelweg een
 * hoek die uitvoeriger gescand is. Een echte vloer strekt zich uit over het
 * hele pand; een dichte plek blijft lokaal. Vandaar dat we niet naar het aantal
 * punten kijken maar naar hoeveel van het grondvlak ze bedekken.
 */
const MIN_FLOOR_COVERAGE = 0.12;
/** Rastergrootte waarop die dekking gemeten wordt, in meters. */
const COVERAGE_CELL_M = 0.5;
/**
 * Hoe ver onder een vloer we het bereik van die bouwlaag laten beginnen. Net
 * onder de vloer meenemen zorgt dat het vloervlak zelf meedoet — dat is juist
 * wat een top-downbeeld leesbaar maakt: je kijkt op de vloeren neer en de muren
 * verschijnen als de randen ertussen.
 */
const FLOOR_MARGIN_M = 0.2;

export interface FloorLevel {
  /** Hoogte van het vloervlak in het assenstelsel van de scan. */
  floorZ: number;
  /** Aantal punten op het vloervlak — maat voor hoe zeker deze vloer is. */
  floorPoints: number;
  /** Aantal punten in de doorsnede erboven. */
  slicePoints: number;
}

export interface FloorPlanRender {
  metersPerPixel: number;
  /** Bereik van de tekening in meters. */
  extentM: { width: number; depth: number };
  /** Het gebruikte raster, zodat celaanduidingen terugvertaald kunnen worden. */
  grid: GridSpec;
}

/**
 * Het genummerde raster over de plattegrond: kolommen A, B, C… van links naar
 * rechts, rijen 1, 2, 3… van boven naar beneden.
 *
 * Dit bestaat om aan te kunnen wijzen. Automatisch bepalen wáár een plattegrond
 * niet deugt lukt niet betrouwbaar — een lege plek op de tekening kan een
 * overgeslagen kamer zijn of gewoon een leeg vertrek, en dat verschil zit in de
 * betekenis, niet in de meetkunde. Het beoordelingsmodel kan dat wél zien, maar
 * heeft een manier nodig om een plek te benoemen. Vandaar dit raster: het model
 * noemt "C4", en wij zetten daar een rode cirkel.
 */
export interface GridSpec {
  cellM: number;
  cols: number;
  rows: number;
  minX: number;
  maxY: number;
}

/** Ongeveer dit aantal kolommen; genoeg om aan te wijzen, weinig genoeg om leesbaar te blijven. */
const TARGET_COLS = 10;

export function gridSpec(pc: PointCloud): GridSpec {
  const spanX = Math.max(pc.bounds.maxX - pc.bounds.minX, 0.5);
  const spanY = Math.max(pc.bounds.maxY - pc.bounds.minY, 0.5);
  // Ronde celmaten lezen prettiger dan 1,37 m.
  const ruw = spanX / TARGET_COLS;
  const cellM = [0.5, 1, 1.5, 2, 2.5, 3, 4, 5].find((v) => v >= ruw) ?? 5;
  return {
    cellM,
    cols: Math.max(1, Math.ceil(spanX / cellM)),
    rows: Math.max(1, Math.ceil(spanY / cellM)),
    minX: pc.bounds.minX,
    maxY: pc.bounds.maxY,
  };
}

/** "C4" naar het middelpunt van die cel, in scancoordinaten. */
export function cellToPoint(grid: GridSpec, cell: string): { x: number; y: number } | null {
  const m = /^([A-Z])\s*(\d+)$/i.exec(cell.trim());
  if (!m) return null;
  const col = m[1].toUpperCase().charCodeAt(0) - 65;
  const row = Number(m[2]) - 1;
  if (col < 0 || col >= grid.cols || row < 0 || row >= grid.rows) return null;
  return {
    x: grid.minX + (col + 0.5) * grid.cellM,
    y: grid.maxY - (row + 0.5) * grid.cellM,
  };
}

/** Een plek die het beoordelingsmodel heeft aangewezen. */
export interface Aandachtsplek {
  cel: string;
  reden: string;
}

/**
 * Extra laag over het bovenaanzicht, gekoppeld aan het checklistpunt waar je op
 * klikt. Zo zie je niet alleen dát er iets is, maar ook waar.
 */
export type Overlay =
  | { soort: "ruis"; indices: Int32Array }
  | {
      soort: "muurrichting";
      graden: number;
      zijden: {
        x1: number;
        y1: number;
        x2: number;
        y2: number;
        lengthM: number;
        deviationDeg: number;
      }[];
      drempel: number;
    }
  | { soort: "uitlijning"; ranges: { low: number; high: number }[] }
  | null;

/**
 * Zoekt de bouwlagen. Geeft ze terug van laag naar hoog; een lege lijst
 * betekent dat er geen duidelijke vloervlakken in zitten — dan is er iets mis
 * met de scan of staat hij niet rechtop.
 */
export function detectFloors(pc: PointCloud): FloorLevel[] {
  const { minZ, maxZ } = pc.bounds;
  const span = maxZ - minZ;
  if (!Number.isFinite(span) || span <= 0) return [];

  const bins = Math.ceil(span / HEIGHT_BIN_M) + 1;
  const hist = new Int32Array(bins);
  for (let i = 0; i < pc.count; i++) {
    const z = pc.xyz[i * 3 + 2];
    const b = Math.floor((z - minZ) / HEIGHT_BIN_M);
    if (b >= 0 && b < bins) hist[b]++;
  }

  let peak = 0;
  for (const n of hist) if (n > peak) peak = n;
  if (peak === 0) return [];

  // Kandidaten: alle bins die genoeg punten hebben, sterkste eerst.
  const kandidaten: number[] = [];
  for (let i = 0; i < bins; i++) if (hist[i] >= peak * PEAK_THRESHOLD) kandidaten.push(i);
  kandidaten.sort((a, b) => hist[b] - hist[a]);

  // Houd per verdieping alleen de sterkste piek over: een vloer geeft ook een
  // piek op het plafond eronder en op de traptreden ernaast. En toets of de
  // piek daadwerkelijk over het pand uitgesmeerd ligt.
  const gekozen: number[] = [];
  for (const b of kandidaten) {
    if (!gekozen.every((g) => Math.abs(g - b) * HEIGHT_BIN_M >= MIN_FLOOR_GAP_M)) continue;
    if (coverage(pc, minZ + b * HEIGHT_BIN_M) < MIN_FLOOR_COVERAGE) continue;
    gekozen.push(b);
  }

  return gekozen
    .sort((a, b) => a - b)
    .map((b) => {
      const floorZ = minZ + b * HEIGHT_BIN_M;
      return {
        floorZ,
        floorPoints: hist[b],
        slicePoints: countInSlice(pc, floorZ),
      };
    });
}

/**
 * Welk deel van het grondvlak bedekt is door punten op deze hoogte. Een echte
 * vloer komt op de referentiescan boven de 0,3 uit; een lokale ophoping blijft
 * ver daaronder.
 */
function coverage(pc: PointCloud, floorZ: number): number {
  const { minX, maxX, minY, maxY } = pc.bounds;
  const cols = Math.max(1, Math.ceil((maxX - minX) / COVERAGE_CELL_M) + 1);
  const rows = Math.max(1, Math.ceil((maxY - minY) / COVERAGE_CELL_M) + 1);
  const gezien = new Uint8Array(cols * rows);
  let gevuld = 0;
  for (let i = 0; i < pc.count; i++) {
    const z = pc.xyz[i * 3 + 2];
    if (Math.abs(z - floorZ) > HEIGHT_BIN_M) continue;
    const cx = Math.floor((pc.xyz[i * 3] - minX) / COVERAGE_CELL_M);
    const cy = Math.floor((pc.xyz[i * 3 + 1] - minY) / COVERAGE_CELL_M);
    if (cx < 0 || cx >= cols || cy < 0 || cy >= rows) continue;
    const idx = cy * cols + cx;
    if (gezien[idx]) continue;
    gezien[idx] = 1;
    gevuld++;
  }
  return gevuld / (cols * rows);
}

function countInSlice(pc: PointCloud, floorZ: number): number {
  // Punten op ooghoogte boven deze vloer: de maat voor of er genoeg materiaal
  // is om muren uit te tekenen.
  const low = floorZ + 1.0;
  const high = floorZ + 1.6;
  let n = 0;
  for (let i = 0; i < pc.count; i++) {
    const z = pc.xyz[i * 3 + 2];
    if (z >= low && z <= high) n++;
  }
  return n;
}

/**
 * Het hoogtebereik dat bij een bouwlaag hoort: van net onder de vloer tot net
 * onder de vloer erboven. Voor de bovenste laag tot de top van de scan.
 */
export function floorRange(
  floors: FloorLevel[],
  index: number,
  maxZ: number
): { low: number; high: number } {
  const low = floors[index].floorZ - FLOOR_MARGIN_M;
  const volgende = floors[index + 1];
  return { low, high: volgende ? volgende.floorZ - FLOOR_MARGIN_M : maxZ };
}

/**
 * Tekent de plattegrond van één bouwlaag: alle punten tussen 1,0 en 1,6 m boven
 * de vloer, plat geprojecteerd. Het beeldvlak is altijd de volledige omhullende
 * doos van de scan, zodat de bouwlagen onderling vergelijkbaar zijn en meteen
 * opvalt als er één veel kleiner is dan de rest.
 */
/**
 * Tekent de scan van bovenaf, zoals Dot3D dat zelf ook doet.
 *
 * Niet een dunne doorsnede maar álle punten binnen het opgegeven hoogtebereik,
 * met een dieptebuffer: per beeldpunt wint het hoogste punt. Daardoor kijk je
 * op de vloeren en het meubilair neer en tekenen de muren zich af als de randen
 * daartussen — precies het beeld waarop een plattegrond te beoordelen is.
 *
 * Bevat het bestand kleur, dan gebruiken we die. Zo niet, dan schaduwen we op
 * hoogte: laag donker, hoog licht. Dat leest bijna net zo goed en laat
 * hoogteverschillen zelfs beter zien.
 */
export function drawFloorPlan(
  ctx: CanvasRenderingContext2D,
  pc: PointCloud,
  range: { low: number; high: number },
  width: number,
  height: number,
  label?: string,
  marks: Aandachtsplek[] = [],
  overlay: Overlay = null,
  gridRotatieDeg = 0
): FloorPlanRender {
  const { minX, maxX, minY, maxY } = pc.bounds;
  const spanX = Math.max(maxX - minX, 0.5);
  const spanY = Math.max(maxY - minY, 0.5);

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  const margin = 44;
  const scale = Math.min((width - margin * 2) / spanX, (height - margin * 2) / spanY);
  const offsetX = (width - spanX * scale) / 2 - minX * scale;
  // Y omklappen: in de puntenwolk loopt Y naar het noorden, op het scherm omlaag.
  const offsetY = (height + spanY * scale) / 2 + minY * scale;

  const grid = gridSpec(pc);
  // Het raster draait mee met de muren. Staat een muur scheef, dan zie je dat
  // meteen doordat hij de lijnen kruist in plaats van ertussen te liggen.
  drawGrid(ctx, grid, scale, offsetX, offsetY, gridRotatieDeg);

  // Dieptebuffer: per beeldpunt onthouden we de hoogste z en de kleur daarvan.
  const diepte = new Float32Array(width * height).fill(-Infinity);
  const kleur = new Uint8ClampedArray(width * height * 3);
  let getekend = 0;

  for (let i = 0; i < pc.count; i++) {
    const z = pc.xyz[i * 3 + 2];
    if (z < range.low || z > range.high) continue;
    const px = Math.round(pc.xyz[i * 3] * scale + offsetX);
    const py = Math.round(offsetY - pc.xyz[i * 3 + 1] * scale);
    if (px < 0 || px >= width || py < 0 || py >= height) continue;
    const idx = py * width + px;
    if (z <= diepte[idx]) continue;
    diepte[idx] = z;
    if (pc.rgb) {
      kleur[idx * 3] = pc.rgb[i * 3];
      kleur[idx * 3 + 1] = pc.rgb[i * 3 + 1];
      kleur[idx * 3 + 2] = pc.rgb[i * 3 + 2];
    } else {
      // Zonder kleur: donker onderin, licht bovenin het bereik.
      const t = (z - range.low) / Math.max(range.high - range.low, 0.01);
      const w = Math.round(60 + Math.max(0, Math.min(1, t)) * 150);
      kleur[idx * 3] = w;
      kleur[idx * 3 + 1] = w;
      kleur[idx * 3 + 2] = w;
    }
    getekend++;
  }

  if (getekend > 0) {
    const beeld = ctx.getImageData(0, 0, width, height);
    for (let idx = 0; idx < width * height; idx++) {
      if (diepte[idx] === -Infinity) continue;
      beeld.data[idx * 4] = kleur[idx * 3];
      beeld.data[idx * 4 + 1] = kleur[idx * 3 + 1];
      beeld.data[idx * 4 + 2] = kleur[idx * 3 + 2];
      beeld.data[idx * 4 + 3] = 255;
    }
    ctx.putImageData(beeld, 0, 0);
  }

  if (overlay) tekenOverlay(ctx, pc, overlay, scale, offsetX, offsetY, width, height);

  // Aandachtsplekken die het beoordelingsmodel heeft aangewezen, als rode
  // cirkel op de genoemde rastercel. Bewust ná de punten getekend.
  marks.forEach((mark, i) => {
    const punt = cellToPoint(grid, mark.cel);
    if (!punt) return;
    const px = punt.x * scale + offsetX;
    const py = offsetY - punt.y * scale;
    const r = (grid.cellM * scale) / 2 + 4;
    ctx.strokeStyle = "rgba(190, 47, 58, 0.92)";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = "rgba(190, 47, 58, 0.92)";
    ctx.beginPath();
    ctx.arc(px, py - r - 11, 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.font = "600 12px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(i + 1), px, py - r - 10);
    ctx.textAlign = "start";
    ctx.textBaseline = "alphabetic";
  });

  drawScaleBar(ctx, width, height, scale);
  if (label) {
    ctx.fillStyle = "#1c2620";
    ctx.font = "600 15px system-ui, sans-serif";
    ctx.fillText(label, 16, 26);
  }

  return { metersPerPixel: 1 / scale, extentM: { width: spanX, depth: spanY }, grid };
}

/** Kleuren per verdieping in de uitlijningsweergave. */
const LAAG_KLEUREN = ["#1c6fd6", "#d67a1c", "#1c9e5a", "#a8329b", "#c4302b"];

function tekenOverlay(
  ctx: CanvasRenderingContext2D,
  pc: PointCloud,
  overlay: NonNullable<Overlay>,
  scale: number,
  offsetX: number,
  offsetY: number,
  width: number,
  height: number
) {
  if (overlay.soort === "ruis") {
    // Losse punten dik en rood, zodat ze opvallen tussen de rest.
    ctx.fillStyle = "rgba(190, 47, 58, 0.85)";
    for (const i of overlay.indices) {
      const px = pc.xyz[i * 3] * scale + offsetX;
      const py = offsetY - pc.xyz[i * 3 + 1] * scale;
      ctx.fillRect(px - 1.5, py - 1.5, 3, 3);
    }
    return;
  }

  if (overlay.soort === "muurrichting") {
    // De omtrek van het pand, zijde voor zijde. Groen als de zijde in het
    // stramien ligt, rood als hij wegdraait, met de graden erbij. Korte zijden
    // krijgen geen label: die zijn altijd wat rommelig en zouden het beeld
    // volplakken.
    ctx.lineCap = "round";
    for (const z of overlay.zijden) {
      const scheef = z.deviationDeg > overlay.drempel;
      const ax = z.x1 * scale + offsetX;
      const ay = offsetY - z.y1 * scale;
      const bx = z.x2 * scale + offsetX;
      const by = offsetY - z.y2 * scale;
      ctx.strokeStyle = scheef ? "rgba(190, 47, 58, 0.95)" : "rgba(20, 122, 68, 0.85)";
      ctx.lineWidth = scheef ? 5 : 3;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();

      if (z.lengthM < 1.5) continue;
      const mx = (ax + bx) / 2;
      const my = (ay + by) / 2;
      const tekst = `${z.deviationDeg.toFixed(0)}°`;
      ctx.font = "600 14px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const breedte = ctx.measureText(tekst).width + 10;
      ctx.fillStyle = scheef ? "rgba(190, 47, 58, 0.95)" : "rgba(20, 122, 68, 0.9)";
      ctx.fillRect(mx - breedte / 2, my - 10, breedte, 20);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(tekst, mx, my);
      ctx.textAlign = "start";
      ctx.textBaseline = "alphabetic";
    }
    return;
  }

  // Uitlijning: per verdieping de omtrek in een eigen kleur, over elkaar heen.
  overlay.ranges.forEach((range, i) => {
    const cel = 0.3;
    const cols = Math.max(1, Math.ceil((pc.bounds.maxX - pc.bounds.minX) / cel) + 1);
    const rows = Math.max(1, Math.ceil((pc.bounds.maxY - pc.bounds.minY) / cel) + 1);
    const gevuld = new Uint8Array(cols * rows);
    for (let p = 0; p < pc.count; p++) {
      const z = pc.xyz[p * 3 + 2];
      if (z < range.low || z > range.high) continue;
      const cx = Math.floor((pc.xyz[p * 3] - pc.bounds.minX) / cel);
      const cy = Math.floor((pc.xyz[p * 3 + 1] - pc.bounds.minY) / cel);
      if (cx >= 0 && cx < cols && cy >= 0 && cy < rows) gevuld[cy * cols + cx] = 1;
    }
    ctx.fillStyle = LAAG_KLEUREN[i % LAAG_KLEUREN.length];
    ctx.globalAlpha = 0.45;
    for (let idx = 0; idx < gevuld.length; idx++) {
      if (!gevuld[idx]) continue;
      const cx = idx % cols;
      const cy = (idx - cx) / cols;
      // Alleen de randcellen: dat geeft een omtrek in plaats van een vlak.
      const rand =
        cx === 0 ||
        cy === 0 ||
        cx === cols - 1 ||
        cy === rows - 1 ||
        !gevuld[idx - 1] ||
        !gevuld[idx + 1] ||
        !gevuld[idx - cols] ||
        !gevuld[idx + cols];
      if (!rand) continue;
      const px = (pc.bounds.minX + cx * cel) * scale + offsetX;
      const py = offsetY - (pc.bounds.minY + cy * cel) * scale;
      ctx.fillRect(px, py - cel * scale, cel * scale + 1, cel * scale + 1);
    }
    ctx.globalAlpha = 1;
  });
}

/**
 * Tekent het genummerde raster. De letters en cijfers staan er niet voor de
 * sier: het beoordelingsmodel gebruikt ze om een plek aan te wijzen, en de
 * opnemer om die plek terug te vinden op de tekening.
 */
function drawGrid(
  ctx: CanvasRenderingContext2D,
  grid: GridSpec,
  scale: number,
  offsetX: number,
  offsetY: number,
  rotatieDeg = 0
) {
  const step = grid.cellM * scale;
  const left = grid.minX * scale + offsetX;
  const top = offsetY - grid.maxY * scale;

  ctx.save();
  if (rotatieDeg !== 0) {
    const cx = left + (grid.cols * step) / 2;
    const cy = top + (grid.rows * step) / 2;
    ctx.translate(cx, cy);
    ctx.rotate((-rotatieDeg * Math.PI) / 180);
    ctx.translate(-cx, -cy);
  }

  ctx.strokeStyle = "#e6e9e4";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let c = 0; c <= grid.cols; c++) {
    const px = Math.round(left + c * step) + 0.5;
    ctx.moveTo(px, top);
    ctx.lineTo(px, top + grid.rows * step);
  }
  for (let r = 0; r <= grid.rows; r++) {
    const py = Math.round(top + r * step) + 0.5;
    ctx.moveTo(left, py);
    ctx.lineTo(left + grid.cols * step, py);
  }
  ctx.stroke();

  ctx.fillStyle = "#9aa39b";
  ctx.font = "11px system-ui, sans-serif";
  ctx.textAlign = "center";
  for (let c = 0; c < grid.cols; c++) {
    ctx.fillText(String.fromCharCode(65 + c), left + (c + 0.5) * step, top - 6);
  }
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (let r = 0; r < grid.rows; r++) {
    ctx.fillText(String(r + 1), left - 8, top + (r + 0.5) * step);
  }
  ctx.textAlign = "start";
  ctx.textBaseline = "alphabetic";
}

function drawScaleBar(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  scale: number
) {
  const meters = 5;
  const px = meters * scale;
  const x = width - px - 24;
  const y = height - 24;
  ctx.strokeStyle = "#1c2620";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + px, y);
  ctx.moveTo(x, y - 5);
  ctx.lineTo(x, y + 5);
  ctx.moveTo(x + px, y - 5);
  ctx.lineTo(x + px, y + 5);
  ctx.stroke();
  ctx.fillStyle = "#1c2620";
  ctx.font = "12px system-ui, sans-serif";
  ctx.fillText(`${meters} m`, x + px / 2 - 12, y - 9);
}

