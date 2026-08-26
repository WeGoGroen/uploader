/**
 * Meet eigenschappen van de scan die je op het oog moeilijk vaststelt: staan de
 * muren recht, staan de verdiepingen onderling recht, en hoeveel ruis zweeft er
 * buiten het pand.
 *
 * Dit vult de beoordeling door het model aan. Het model ziet of een plattegrond
 * klopt; deze functies leveren de getallen eronder, en — belangrijker — de
 * plekken die je op de kaart kunt aanwijzen.
 */

import type { PointCloud } from "@/lib/laz-reader";

/** Zoveel punten gebruiken we voor de richtinganalyse; meer verandert het antwoord niet. */
const SAMPLE = 60_000;
/** Rasterbreedte waarin we muren zoeken bij het projecteren, in meters. */
const PROJECTION_BIN_M = 0.05;

export interface WallAlignment {
  /**
   * Hoe sterk de muren op één richting uitkomen. Gemeten als de verhouding
   * tussen de best passende draaiing en het gemiddelde over alle draaiingen.
   *
   * Op de referentiescan geven echte muren 1,45 tot 2,0. Een even grote wolk
   * willekeurige punten zonder structuur komt op 1,13 — daar zit dus ruimte
   * tussen. Onder ongeveer 1,2 is er geen muurstructuur te vinden.
   */
  ratio: number;
  /** De richting waarin de muren liggen, 0-89 graden. */
  axisDeg: number;
  /** Aantal punten waarop dit gemeten is. */
  points: number;
}

/**
 * Zoekt de richting waarin de muren liggen.
 *
 * Werking: draai de puntenwolk stap voor stap rond en kijk bij welke draaiing
 * de punten het sterkst in smalle stroken vallen. Een rechte muur is een lijn;
 * projecteer je die loodrecht, dan valt hij in één smalle strook en piekt het
 * histogram. Staat de muur schuin of golft hij, dan smeert die piek uit.
 *
 * Door het te delen door het gemiddelde over alle draaiingen wordt de uitkomst
 * onafhankelijk van hoeveel punten er zijn en hoe groot het pand is.
 */
export function wallAlignment(
  pc: PointCloud,
  range: { low: number; high: number }
): WallAlignment | null {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < pc.count; i++) {
    const z = pc.xyz[i * 3 + 2];
    if (z < range.low || z > range.high) continue;
    xs.push(pc.xyz[i * 3]);
    ys.push(pc.xyz[i * 3 + 1]);
  }
  if (xs.length < 2000) return null;

  // Gelijkmatig uitdunnen; de richting van muren verandert daar niet van.
  const step = Math.max(1, Math.floor(xs.length / SAMPLE));
  const px: number[] = [];
  const py: number[] = [];
  for (let i = 0; i < xs.length; i += step) {
    px.push(xs[i]);
    py.push(ys[i]);
  }

  let beste = 0;
  let besteHoek = 0;
  let som = 0;
  for (let deg = 0; deg < 90; deg++) {
    const t = (deg * Math.PI) / 180;
    const c = Math.cos(t);
    const s = Math.sin(t);
    const score = peakiness(px, py, c, s) + peakiness(px, py, -s, c);
    som += score;
    if (score > beste) {
      beste = score;
      besteHoek = deg;
    }
  }
  const gemiddeld = som / 90;
  return {
    ratio: gemiddeld > 0 ? beste / gemiddeld : 0,
    axisDeg: besteHoek,
    points: px.length,
  };
}

/** Hoe sterk de punten samenklonteren als je ze op één as projecteert. */
function peakiness(px: number[], py: number[], ax: number, ay: number): number {
  let min = Infinity;
  let max = -Infinity;
  const waarden = new Float64Array(px.length);
  for (let i = 0; i < px.length; i++) {
    const v = px[i] * ax + py[i] * ay;
    waarden[i] = v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const bins = Math.max(1, Math.ceil((max - min) / PROJECTION_BIN_M));
  const hist = new Float64Array(bins + 1);
  for (let i = 0; i < waarden.length; i++) {
    hist[Math.floor((waarden[i] - min) / PROJECTION_BIN_M)]++;
  }
  // Som van de kwadraten van de aandelen: hoog als alles in weinig stroken valt.
  let som = 0;
  for (let i = 0; i < hist.length; i++) {
    const aandeel = hist[i] / waarden.length;
    som += aandeel * aandeel;
  }
  return som;
}

/**
 * Grootste onderlinge hoekverschil tussen de muurrichtingen van de
 * verdiepingen, in graden. Muren liggen modulo 90 graden, dus 89 en 1 schelen
 * twee graden en niet achtentachtig.
 *
 * Staan de verdiepingen onderling verdraaid, dan is de scan tijdens het
 * traplopen weggedraaid — een van de vaakst voorkomende fouten, en op het oog
 * lastig te zien omdat elke verdieping op zichzelf klopt.
 */
export function axisSpreadDeg(hoeken: number[]): number {
  if (hoeken.length < 2) return 0;
  let grootste = 0;
  for (let i = 0; i < hoeken.length; i++) {
    for (let j = i + 1; j < hoeken.length; j++) {
      const d = Math.abs(hoeken[i] - hoeken[j]) % 90;
      grootste = Math.max(grootste, Math.min(d, 90 - d));
    }
  }
  return grootste;
}

/** Rastergrootte waarop we dichtheid meten om ruis te vinden, in meters. */
const NOISE_CELL_M = 0.25;
/** Een cel met minder punten dan dit telt als losse ruis. */
const NOISE_MAX_POINTS = 3;

export interface NoiseResult {
  /** Indexen van punten die als ruis gelden, voor het inkleuren op de kaart. */
  indices: Int32Array;
  /** Aandeel van alle punten in dit bereik (0-1). */
  share: number;
}

/**
 * Zoekt punten die los van het pand zweven: spiegelbeelden, wat door een raam
 * naar buiten is gezien, of tracking die even kwijtraakte.
 *
 * Aanpak: leg een raster over het grondvlak, tel de punten per cel, en markeer
 * de punten in cellen die zowel zelf bijna leeg zijn als geen dichte buren
 * hebben. Wat aan het pand vastzit heeft altijd volle cellen om zich heen;
 * losse ruis niet.
 */
export function findNoise(pc: PointCloud, range: { low: number; high: number }): NoiseResult {
  const { minX, maxX, minY, maxY } = pc.bounds;
  const cols = Math.max(1, Math.ceil((maxX - minX) / NOISE_CELL_M) + 1);
  const rows = Math.max(1, Math.ceil((maxY - minY) / NOISE_CELL_M) + 1);
  const telling = new Int32Array(cols * rows);

  const inBereik: number[] = [];
  for (let i = 0; i < pc.count; i++) {
    const z = pc.xyz[i * 3 + 2];
    if (z < range.low || z > range.high) continue;
    inBereik.push(i);
    const cx = Math.floor((pc.xyz[i * 3] - minX) / NOISE_CELL_M);
    const cy = Math.floor((pc.xyz[i * 3 + 1] - minY) / NOISE_CELL_M);
    if (cx >= 0 && cx < cols && cy >= 0 && cy < rows) telling[cy * cols + cx]++;
  }
  if (inBereik.length === 0) return { indices: new Int32Array(0), share: 0 };

  const ruis: number[] = [];
  for (const i of inBereik) {
    const cx = Math.floor((pc.xyz[i * 3] - minX) / NOISE_CELL_M);
    const cy = Math.floor((pc.xyz[i * 3 + 1] - minY) / NOISE_CELL_M);
    if (cx < 0 || cx >= cols || cy < 0 || cy >= rows) continue;
    if (telling[cy * cols + cx] > NOISE_MAX_POINTS) continue;
    // Buren meewegen: een dunne rand langs een volle muur is geen ruis.
    let buren = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
        buren += telling[ny * cols + nx];
      }
    }
    if (buren <= NOISE_MAX_POINTS * 3) ruis.push(i);
  }
  return { indices: Int32Array.from(ruis), share: ruis.length / inBereik.length };
}

/** Rastergrootte waarop muren gezocht worden, in meters. */
const WALL_CELL_M = 0.05;
/** Straal waarbinnen we de plaatselijke richting bepalen, in cellen. */
const WALL_NEIGHBOURHOOD = 8;
/** Hoe lijnvormig een plek moet zijn om als muur te tellen (0-1). */
const WALL_LINEARITY = 0.78;
/** Twee aangrenzende stukken horen bij dezelfde muur tot dit hoekverschil. */
const WALL_MERGE_DEG = 20;
/**
 * Hoe ver we mogen springen om twee muurstukken aan elkaar te knopen, in
 * cellen. Een deuropening, een radiator of een kast onderbreekt de rij cellen;
 * zonder die sprong valt elke muur in losse stukjes uiteen.
 */
const WALL_BRIDGE_CELLS = 3;
/** Korter dan dit is geen muur maar een kastje of een stoelleuning. */
const MIN_WALL_LENGTH_M = 1.0;

export interface WallSegment {
  /** Begin- en eindpunt in scancoördinaten (meters). */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  lengthM: number;
  /** Richting van de muur, 0-179 graden. */
  angleDeg: number;
  /**
   * Hoeveel deze muur afwijkt van het hoofdstramien van het pand, in graden.
   * Muren staan haaks op elkaar, dus we meten ten opzichte van het dichtstbij
   * liggende veelvoud van 90 graden: 0 is precies in het stramien, 45 is zo
   * scheef als een muur kan staan.
   */
  deviationDeg: number;
}

/**
 * Zoekt de losse muren in een scan en meet per muur de richting.
 *
 * Werkwijze: leg de punten op ooghoogte op een raster van 5 cm, bepaal per
 * gevulde cel of de omgeving lijnvormig is en zo ja welke kant die lijn op
 * loopt, en groei daarna aangrenzende cellen met dezelfde richting samen tot
 * één muur. Wat overblijft zijn rechte stukken van minstens een meter — muren
 * dus, en geen meubels: die zijn te kort of te rond om door de lijnvormigheids-
 * toets te komen.
 *
 * De uitkomst is per muur een lijnstuk met een hoek, zodat je op de kaart kunt
 * aanwijzen wélke muur scheef staat in plaats van alleen te melden dát er iets
 * scheef staat.
 *
 * NOG NIET IN GEBRUIK. Op de referentiescan knoopt het samenvoegen bij hoeken
 * twee haakse muren aan elkaar: er komt dan één lijnstuk van 6,4 m op 157° uit
 * dat in werkelijkheid twee muren van 0° en 90° is. Dat zou als "scheve muur"
 * op de kaart verschijnen terwijl er niets aan de hand is, en dat is erger dan
 * geen markering. Het samenvoegen moet eerst hoeken leren herkennen; tot die
 * tijd draait alleen de aggregaatmeting in wallAlignment mee, die wél
 * gekalibreerd is.
 */
export function findWalls(
  pc: PointCloud,
  range: { low: number; high: number },
  axisDeg: number
): WallSegment[] {
  const { minX, maxX, minY, maxY } = pc.bounds;
  const cols = Math.max(1, Math.ceil((maxX - minX) / WALL_CELL_M) + 1);
  const rows = Math.max(1, Math.ceil((maxY - minY) / WALL_CELL_M) + 1);
  if (cols * rows > 40_000_000) return [];

  const gevuld = new Uint8Array(cols * rows);
  for (let i = 0; i < pc.count; i++) {
    const z = pc.xyz[i * 3 + 2];
    if (z < range.low || z > range.high) continue;
    const cx = Math.floor((pc.xyz[i * 3] - minX) / WALL_CELL_M);
    const cy = Math.floor((pc.xyz[i * 3 + 1] - minY) / WALL_CELL_M);
    if (cx >= 0 && cx < cols && cy >= 0 && cy < rows) gevuld[cy * cols + cx] = 1;
  }

  // Per gevulde cel: is de omgeving lijnvormig, en zo ja, welke richting op?
  const richting = new Float32Array(cols * rows).fill(NaN);
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const idx = cy * cols + cx;
      if (!gevuld[idx]) continue;
      let n = 0;
      let sx = 0;
      let sy = 0;
      for (let dy = -WALL_NEIGHBOURHOOD; dy <= WALL_NEIGHBOURHOOD; dy++) {
        for (let dx = -WALL_NEIGHBOURHOOD; dx <= WALL_NEIGHBOURHOOD; dx++) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
          if (!gevuld[ny * cols + nx]) continue;
          n++;
          sx += dx;
          sy += dy;
        }
      }
      if (n < 6) continue;
      const gx = sx / n;
      const gy = sy / n;
      let sxx = 0;
      let syy = 0;
      let sxy = 0;
      for (let dy = -WALL_NEIGHBOURHOOD; dy <= WALL_NEIGHBOURHOOD; dy++) {
        for (let dx = -WALL_NEIGHBOURHOOD; dx <= WALL_NEIGHBOURHOOD; dx++) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
          if (!gevuld[ny * cols + nx]) continue;
          const ax = dx - gx;
          const ay = dy - gy;
          sxx += ax * ax;
          syy += ay * ay;
          sxy += ax * ay;
        }
      }
      const spoor = sxx + syy;
      const det = sxx * syy - sxy * sxy;
      const wortel = Math.sqrt(Math.max(0, (spoor * spoor) / 4 - det));
      const groot = spoor / 2 + wortel;
      const klein = spoor / 2 - wortel;
      if (groot <= 0) continue;
      if (groot / (groot + Math.max(klein, 0)) < WALL_LINEARITY) continue;
      richting[idx] = eigenHoek(sxx, syy, sxy, groot);
    }
  }

  // Aangrenzende cellen met dezelfde richting samenvoegen tot één muur.
  const bezocht = new Uint8Array(cols * rows);
  const muren: WallSegment[] = [];
  const drempel = (WALL_MERGE_DEG * Math.PI) / 180;
  for (let start = 0; start < richting.length; start++) {
    if (bezocht[start] || Number.isNaN(richting[start])) continue;
    const groep: number[] = [];
    const stapel = [start];
    bezocht[start] = 1;
    while (stapel.length > 0) {
      const idx = stapel.pop()!;
      groep.push(idx);
      const cx = idx % cols;
      const cy = (idx - cx) / cols;
      for (let dy = -WALL_BRIDGE_CELLS; dy <= WALL_BRIDGE_CELLS; dy++) {
        for (let dx = -WALL_BRIDGE_CELLS; dx <= WALL_BRIDGE_CELLS; dx++) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
          const n = ny * cols + nx;
          if (bezocht[n] || Number.isNaN(richting[n])) continue;
          if (hoekVerschil(richting[idx], richting[n]) > drempel) continue;
          bezocht[n] = 1;
          stapel.push(n);
        }
      }
    }
    const muur = maakSegment(groep, cols, minX, minY, axisDeg);
    if (muur && muur.lengthM >= MIN_WALL_LENGTH_M) muren.push(muur);
  }
  return muren.sort((a, b) => b.lengthM - a.lengthM);
}

/**
 * Richting van de langste as van een 2x2-spreidingsmatrix.
 *
 * Het losse geval doet ertoe: bij een muur die precies langs de x- of y-as
 * loopt is de kruisterm nul, en dan levert de gewone formule een deling door
 * bijna-nul op. Juist die muren komen het vaakst voor, dus die vangen we apart
 * af in plaats van er een epsilon in te schuiven.
 */
function eigenHoek(sxx: number, syy: number, sxy: number, grootste: number): number {
  if (Math.abs(sxy) < 1e-9) return sxx >= syy ? 0 : Math.PI / 2;
  return Math.atan2(sxy, grootste - syy);
}

/** Hoekverschil tussen twee richtingen, die modulo 180 graden gelijk zijn. */
function hoekVerschil(a: number, b: number): number {
  const d = Math.abs(a - b) % Math.PI;
  return Math.min(d, Math.PI - d);
}

function maakSegment(
  cellen: number[],
  cols: number,
  minX: number,
  minY: number,
  axisDeg: number
): WallSegment | null {
  if (cellen.length < 8) return null;
  let sx = 0;
  let sy = 0;
  const xs: number[] = [];
  const ys: number[] = [];
  for (const idx of cellen) {
    const cx = idx % cols;
    const cy = (idx - cx) / cols;
    const x = minX + (cx + 0.5) * WALL_CELL_M;
    const y = minY + (cy + 0.5) * WALL_CELL_M;
    xs.push(x);
    ys.push(y);
    sx += x;
    sy += y;
  }
  const gx = sx / cellen.length;
  const gy = sy / cellen.length;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let i = 0; i < xs.length; i++) {
    const ax = xs[i] - gx;
    const ay = ys[i] - gy;
    sxx += ax * ax;
    syy += ay * ay;
    sxy += ax * ay;
  }
  const spoor = sxx + syy;
  const det = sxx * syy - sxy * sxy;
  const wortel = Math.sqrt(Math.max(0, (spoor * spoor) / 4 - det));
  const groot = spoor / 2 + wortel;
  const hoek = eigenHoek(sxx, syy, sxy, groot);
  const dx = Math.cos(hoek);
  const dy = Math.sin(hoek);

  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < xs.length; i++) {
    const t = (xs[i] - gx) * dx + (ys[i] - gy) * dy;
    if (t < min) min = t;
    if (t > max) max = t;
  }
  const graden = ((hoek * 180) / Math.PI + 180) % 180;
  // Afwijking van het stramien: muren staan haaks, dus meten we ten opzichte
  // van het dichtstbijzijnde veelvoud van 90 graden vanaf de hoofdrichting.
  const rel = Math.abs(graden - axisDeg) % 90;
  return {
    x1: gx + dx * min,
    y1: gy + dy * min,
    x2: gx + dx * max,
    y2: gy + dy * max,
    lengthM: max - min,
    angleDeg: graden,
    deviationDeg: Math.min(rel, 90 - rel),
  };
}

/** Grootte van de vakken waarin we de plaatselijke muurrichting meten, in meters. */
const REGION_M = 2.0;
/** Minder punten dan dit in een vak: geen betrouwbare richting te bepalen. */
const REGION_MIN_POINTS = 150;
/**
 * Hoe uitgesproken de richting in een vak moet zijn voordat we er iets over
 * zeggen. Zelfde maat als bij het hele pand: de best passende draaiing gedeeld
 * door het gemiddelde. Een vak vol meubels of een trap heeft geen richting —
 * dan komt hier iets rond de 1,1 uit en is elk "verdraaid" een verzinsel.
 */
const REGION_MIN_RATIO = 1.45;

export interface RegionDeviation {
  /** Middelpunt van het vak in scancoördinaten. */
  x: number;
  y: number;
  sizeM: number;
  /** Heersende muurrichting in dit vak, 0-89 graden. */
  axisDeg: number;
  /** Verschil met het stramien van het hele pand, 0-45 graden. */
  deviationDeg: number;
  /** Hoe uitgesproken de richting in dit vak is; hoger is betrouwbaarder. */
  sharpness: number;
  points: number;
}

/**
 * Meet per vak van twee bij twee meter welke kant de muren daar op staan, en
 * vergelijkt dat met het stramien van het hele pand.
 *
 * Dit vervangt het opdelen in losse muren, dat op hoeken de mist in ging: twee
 * haakse muren werden daar aan elkaar geknoopt tot één diagonaal. Per vak de
 * heersende richting meten heeft dat probleem niet, en sluit bovendien aan bij
 * hoe een scheve scan er in het echt uitziet: niet elke muur apart krom, maar
 * een heel deel van het pand dat verdraaid staat ten opzichte van de rest —
 * meestal het stuk dat na een trap of een lange gang gescand is.
 *
 * De richting per vak komt op dezelfde manier tot stand als die van het hele
 * pand: draaien tot de punten het strakst in stroken vallen.
 */
export function regionDeviations(
  pc: PointCloud,
  range: { low: number; high: number },
  globalAxisDeg: number
): RegionDeviation[] {
  const { minX, maxX, minY, maxY } = pc.bounds;
  const cols = Math.max(1, Math.ceil((maxX - minX) / REGION_M));
  const rows = Math.max(1, Math.ceil((maxY - minY) / REGION_M));

  // Punten per vak verzamelen.
  const vakX: number[][] = Array.from({ length: cols * rows }, () => []);
  const vakY: number[][] = Array.from({ length: cols * rows }, () => []);
  for (let i = 0; i < pc.count; i++) {
    const z = pc.xyz[i * 3 + 2];
    if (z < range.low || z > range.high) continue;
    const x = pc.xyz[i * 3];
    const y = pc.xyz[i * 3 + 1];
    const cx = Math.min(cols - 1, Math.max(0, Math.floor((x - minX) / REGION_M)));
    const cy = Math.min(rows - 1, Math.max(0, Math.floor((y - minY) / REGION_M)));
    const idx = cy * cols + cx;
    vakX[idx].push(x);
    vakY[idx].push(y);
  }

  const uitkomst: RegionDeviation[] = [];
  for (let idx = 0; idx < vakX.length; idx++) {
    const xs = vakX[idx];
    if (xs.length < REGION_MIN_POINTS) continue;
    const ys = vakY[idx];

    let beste = 0;
    let besteHoek = 0;
    let som = 0;
    for (let deg = 0; deg < 90; deg++) {
      const t = (deg * Math.PI) / 180;
      const c = Math.cos(t);
      const s = Math.sin(t);
      const score = peakiness(xs, ys, c, s) + peakiness(xs, ys, -s, c);
      som += score;
      if (score > beste) {
        beste = score;
        besteHoek = deg;
      }
    }
    const gemiddeld = som / 90;
    const scherpte = gemiddeld > 0 ? beste / gemiddeld : 0;
    // Geen duidelijke richting? Dan zwijgen we over dit vak.
    if (scherpte < REGION_MIN_RATIO) continue;

    const rel = Math.abs(besteHoek - globalAxisDeg) % 90;
    const cx = idx % cols;
    const cy = (idx - cx) / cols;
    uitkomst.push({
      x: minX + (cx + 0.5) * REGION_M,
      y: minY + (cy + 0.5) * REGION_M,
      sizeM: REGION_M,
      axisDeg: besteHoek,
      deviationDeg: Math.min(rel, 90 - rel),
      sharpness: scherpte,
      points: xs.length,
    });
  }
  return uitkomst;
}

/** Vanaf deze afwijking noemen we een vak verdraaid ten opzichte van de rest. */
export const REGION_TILT_DEG = 8;

/** Welk deel van het gemeten vloeroppervlak verdraaid staat (0-1). */
export function tiltedShare(regions: RegionDeviation[]): number {
  if (regions.length === 0) return 0;
  return regions.filter((r) => r.deviationDeg > REGION_TILT_DEG).length / regions.length;
}

/** Rastergrootte waarop de omtrek van het pand bepaald wordt, in meters. */
const OUTLINE_CELL_M = 0.1;
/** Hoeveel cellen we het masker opblazen en weer inkrimpen om gaten te dichten. */
const OUTLINE_CLOSE = 3;
/** Hoe grof de omtrek vereenvoudigd wordt, in meters. */
const OUTLINE_SIMPLIFY_M = 0.3;
/** Zijden korter dan dit laten we buiten beschouwing: dat zijn erkers en nissen. */
const OUTLINE_MIN_EDGE_M = 0.8;

export interface OutlineEdge {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  lengthM: number;
  /** Richting van deze zijde, 0-179 graden. */
  angleDeg: number;
  /** Verschil met het stramien van het pand, 0-45 graden. */
  deviationDeg: number;
}

export interface BuildingOutline {
  /** De omtrek als aaneengesloten punten in scancoördinaten. */
  polygon: { x: number; y: number }[];
  /** De zijden ervan, met per zijde de afwijking. */
  edges: OutlineEdge[];
}

/**
 * Bepaalt de omtrek van het pand en meet per zijde hoeveel die afwijkt van het
 * stramien.
 *
 * Dit vervangt het meten per vierkant vak. Een vak zegt "hier staat iets 20
 * graden scheef" maar niet wát; een omtrek volgt de gevel en de grote
 * binnenmuren, zodat je per muurdeel ziet hoeveel het afwijkt. Dat is ook hoe
 * je er zelf naar kijkt: je legt een liniaal langs de gevel en ziet of de rest
 * meeloopt.
 *
 * Werkwijze: alle punten van deze hoogtelaag op een raster van 10 cm, gaten
 * dichten door het masker op te blazen en weer in te krimpen, de buitenrand
 * volgen, en die rand vereenvoudigen tot rechte zijden. Het dichten is nodig
 * omdat elke deuropening en elk raam anders een gat in de omtrek slaat.
 */
export function buildingOutline(
  pc: PointCloud,
  range: { low: number; high: number },
  axisDeg: number
): BuildingOutline | null {
  const { minX, maxX, minY, maxY } = pc.bounds;
  const cols = Math.max(3, Math.ceil((maxX - minX) / OUTLINE_CELL_M) + 3);
  const rows = Math.max(3, Math.ceil((maxY - minY) / OUTLINE_CELL_M) + 3);
  if (cols * rows > 10_000_000) return null;

  let masker: Uint8Array<ArrayBufferLike> = new Uint8Array(cols * rows);
  for (let i = 0; i < pc.count; i++) {
    const z = pc.xyz[i * 3 + 2];
    if (z < range.low || z > range.high) continue;
    const cx = Math.floor((pc.xyz[i * 3] - minX) / OUTLINE_CELL_M) + 1;
    const cy = Math.floor((pc.xyz[i * 3 + 1] - minY) / OUTLINE_CELL_M) + 1;
    if (cx >= 0 && cx < cols && cy >= 0 && cy < rows) masker[cy * cols + cx] = 1;
  }

  masker = morfologie(masker, cols, rows, OUTLINE_CLOSE, true);
  masker = morfologie(masker, cols, rows, OUTLINE_CLOSE, false);

  const grootste = grootsteVlek(masker, cols, rows);
  if (!grootste) return null;

  const rand = volgRand(grootste, cols, rows);
  if (rand.length < 8) return null;

  const punten = rand.map((idx) => {
    const cx = idx % cols;
    const cy = (idx - cx) / cols;
    return {
      x: minX + (cx - 1 + 0.5) * OUTLINE_CELL_M,
      y: minY + (cy - 1 + 0.5) * OUTLINE_CELL_M,
    };
  });
  const polygon = vereenvoudig(punten, OUTLINE_SIMPLIFY_M);

  const edges: OutlineEdge[] = [];
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    const lengte = Math.hypot(b.x - a.x, b.y - a.y);
    if (lengte < OUTLINE_MIN_EDGE_M) continue;
    const graden = ((Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI + 180) % 180;
    const rel = Math.abs(graden - axisDeg) % 90;
    edges.push({
      x1: a.x,
      y1: a.y,
      x2: b.x,
      y2: b.y,
      lengthM: lengte,
      angleDeg: graden,
      deviationDeg: Math.min(rel, 90 - rel),
    });
  }
  return { polygon, edges };
}

/** Opblazen (dilate) of inkrimpen (erode) met een vierkante kern. */
function morfologie(
  bron: Uint8Array,
  cols: number,
  rows: number,
  straal: number,
  opblazen: boolean
): Uint8Array {
  let huidig: Uint8Array = new Uint8Array(bron);
  for (let stap = 0; stap < straal; stap++) {
    const volgende = new Uint8Array(cols * rows);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const idx = y * cols + x;
        let raak = opblazen ? 0 : 1;
        for (let dy = -1; dy <= 1 && raak === (opblazen ? 0 : 1); dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            const waarde =
              nx < 0 || nx >= cols || ny < 0 || ny >= rows ? 0 : huidig[ny * cols + nx];
            if (opblazen && waarde) {
              raak = 1;
              break;
            }
            if (!opblazen && !waarde) {
              raak = 0;
              break;
            }
          }
        }
        volgende[idx] = raak;
      }
    }
    huidig = volgende;
  }
  return huidig;
}

/** De grootste aaneengesloten vlek; losse bijgebouwen en ruis vallen af. */
function grootsteVlek(masker: Uint8Array, cols: number, rows: number): Uint8Array | null {
  const bezocht = new Uint8Array(masker.length);
  let beste: number[] = [];
  for (let start = 0; start < masker.length; start++) {
    if (!masker[start] || bezocht[start]) continue;
    const groep: number[] = [];
    const stapel = [start];
    bezocht[start] = 1;
    while (stapel.length > 0) {
      const idx = stapel.pop()!;
      groep.push(idx);
      const x = idx % cols;
      const y = (idx - x) / cols;
      const buren = [
        x > 0 ? idx - 1 : -1,
        x < cols - 1 ? idx + 1 : -1,
        y > 0 ? idx - cols : -1,
        y < rows - 1 ? idx + cols : -1,
      ];
      for (const n of buren) {
        if (n < 0 || bezocht[n] || !masker[n]) continue;
        bezocht[n] = 1;
        stapel.push(n);
      }
    }
    if (groep.length > beste.length) beste = groep;
  }
  if (beste.length < 20) return null;
  const uit = new Uint8Array(masker.length);
  for (const idx of beste) uit[idx] = 1;
  return uit;
}

/**
 * Volgt de buitenrand van een vlek met de rechterhandregel: houd je hand aan de
 * muur en loop door tot je weer bij het begin bent.
 */
function volgRand(masker: Uint8Array, cols: number, rows: number): number[] {
  let start = -1;
  for (let idx = 0; idx < masker.length; idx++) {
    if (masker[idx]) {
      start = idx;
      break;
    }
  }
  if (start < 0) return [];

  const richtingen = [
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
    [-1, 0],
    [-1, -1],
    [0, -1],
    [1, -1],
  ];
  const rand: number[] = [];
  let huidig = start;
  let binnenkomst = 4;
  for (let stap = 0; stap < masker.length * 4; stap++) {
    rand.push(huidig);
    const x = huidig % cols;
    const y = (huidig - x) / cols;
    let volgende = -1;
    let nieuweRichting = 0;
    for (let k = 1; k <= 8; k++) {
      const r = (binnenkomst + k) % 8;
      const nx = x + richtingen[r][0];
      const ny = y + richtingen[r][1];
      if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
      const n = ny * cols + nx;
      if (!masker[n]) continue;
      volgende = n;
      nieuweRichting = r;
      break;
    }
    if (volgende < 0) break;
    huidig = volgende;
    binnenkomst = (nieuweRichting + 4) % 8;
    if (huidig === start && rand.length > 4) break;
  }
  return rand;
}

/** Vereenvoudigt een lijn tot rechte stukken (Douglas-Peucker). */
function vereenvoudig(
  punten: { x: number; y: number }[],
  tolerantie: number
): { x: number; y: number }[] {
  if (punten.length < 3) return punten;
  const houden = new Uint8Array(punten.length);
  houden[0] = 1;
  houden[punten.length - 1] = 1;
  const stapel: [number, number][] = [[0, punten.length - 1]];
  while (stapel.length > 0) {
    const [begin, eind] = stapel.pop()!;
    let grootste = 0;
    let index = -1;
    const a = punten[begin];
    const b = punten[eind];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengte = Math.hypot(dx, dy) || 1;
    for (let i = begin + 1; i < eind; i++) {
      const afstand = Math.abs(dy * (punten[i].x - a.x) - dx * (punten[i].y - a.y)) / lengte;
      if (afstand > grootste) {
        grootste = afstand;
        index = i;
      }
    }
    if (index > 0 && grootste > tolerantie) {
      houden[index] = 1;
      stapel.push([begin, index], [index, eind]);
    }
  }
  return punten.filter((_, i) => houden[i]);
}
