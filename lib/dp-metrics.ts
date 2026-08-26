/**
 * Rekent de ruwe scandata (camerabanen uit lib/dp-scan.ts) om naar meetwaarden
 * waar een mens iets aan heeft: hoe lang is er gelopen, hoe groot is het
 * gescande grondvlak, hoeveel bouwlagen zitten erin, en waar viel de tracking
 * weg. Alles in meters en seconden; de scan zelf rekent in millimeters.
 */

import type { DpPose, DpScan } from "@/lib/dp-scan";

/**
 * Straal rond de scanroute die we als "zeker gescand" rekenen, in meters.
 *
 * De LiDAR haalt verder — tot een meter of vijf — maar we kunnen niet zien
 * waar de muren staan, dus een kegel op volle lengte stempelen loopt dwars
 * door wanden heen en levert een vormeloze vlek in plaats van een plattegrond.
 * Met 2,5 m blijft het gestempelde vlak dicht bij de looproute, wat aansluit
 * bij de werkwijze uit de gids (2 tot 3 m afstand tot de muren houden) en een
 * beeld oplevert waarin kamers en gangen herkenbaar zijn.
 *
 * Gevolg: het gestempelde vlak is een ondergrens van wat gescand is, geen
 * exacte dekking. Zo staat het ook in de checklist en in de uitleg aan het
 * beoordelingsmodel.
 */
export const SENSOR_RANGE_M = 2.5;
/** Halve horizontale beeldhoek die we aanhouden, in radialen (90° totaal). */
export const SENSOR_HALF_FOV = (45 * Math.PI) / 180;
/**
 * Sprong tussen twee opeenvolgende keyframes die de aandacht verdient. Dot3D
 * zet keyframes ongeveer elke meter neer (mediaan 0,9 m op de referentiescan),
 * dus pas ver daarboven wijst een sprong ergens op — meestal een stuk dat
 * doorgelopen is zonder te scannen, of tracking die kwijtraakte.
 */
const LARGE_STEP_M = 3.0;
/** Minimale hoogteafstand tussen twee bouwlagen. */
const FLOOR_SEPARATION_M = 1.8;

export interface DpLevel {
  /** Hoogte van de camera-cluster, in meters t.o.v. het startpunt. */
  heightM: number;
  /** Aantal keyframes op deze hoogte. */
  frames: number;
  /** Aandeel van alle keyframes (0-1). */
  share: number;
}

export interface DpLargeStep {
  /** Index van het keyframe waar de sprong begint. */
  index: number;
  distanceM: number;
}

export interface DpMetrics {
  keyframes: number;
  photos: number;
  /** Duur van de scan uit de IMU-log, of null als die ontbreekt. */
  durationSeconds: number | null;
  /** Totale gelopen afstand langs de camerabaan. */
  pathLengthM: number;
  /** Afstand tussen begin- en eindpunt — klein = rondje gesloten. */
  loopClosureM: number;
  /** Omhullende doos van de camerabaan (breedte x diepte x hoogte). */
  bboxM: { width: number; depth: number; height: number };
  /**
   * Oppervlak binnen SENSOR_RANGE_M van de scanroute, in m². Een ondergrens
   * van wat gescand is — zie SENSOR_RANGE_M waarom het geen exacte dekking is.
   */
  sweptAreaM2: number;
  /** Gedetecteerde bouwlagen, van laag naar hoog. Indicatief — zie heightConfidence. */
  levels: DpLevel[];
  /**
   * Hoe betrouwbaar de hoogte-as is (0-1). Onder ~0,7 zegt het hoogteprofiel
   * — en dus het aantal bouwlagen — weinig; zie deriveUpAxis.
   */
  heightConfidence: number;
  /** Sprongen in de camerabaan die groter zijn dan normale keyframe-afstand. */
  largeSteps: DpLargeStep[];
  /** Grootste sprong, voor snelle weergave. */
  maxStepM: number;
  /**
   * Aandeel keyframes waarbij de iPad duidelijk omlaag wees (>15° onder
   * horizontaal). De gids vraagt de vloer mee te nemen en in gangen onder een
   * hoek van ongeveer 45° naar de vloer te richten.
   */
  floorAimShare: number;
  /**
   * Aandeel keyframes waarbij de iPad duidelijk omhoog wees. De gids raadt
   * plafonds scannen juist af, dus een hoog aandeel is een signaal.
   */
  ceilingAimShare: number;
  /**
   * Aantal overgangen tussen keyframes met een draai van meer dan 60°. De gids
   * vraagt om vloeiende beweging zonder plotselinge richtingswisselingen.
   */
  abruptTurns: number;
  /** Camerahoogtes (meters), gebruikt voor de bouwlaagdetectie. */
  heightsM: number[];
  /** Camerabaan in het horizontale vlak, in meters — invoer voor de render. */
  path: { x: number; y: number; z: number; fx: number; fz: number }[];
}

type Vec3 = [number, number, number];

function normalize(v: Vec3): Vec3 {
  const n = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / n, v[1] / n, v[2] / n];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/**
 * Bepaalt welke kant "omhoog" is in de scan.
 *
 * Dit is lastiger dan het lijkt. Het veld `globalTransform` in het bestand
 * blijkt géén zwaartekracht-uitlijning te zijn, en het IMU-log bevat
 * geïntegreerde waarden waar geen bruikbare zwaartekrachtrichting uit komt.
 * Wat wél werkt: de opnemer houdt de iPad al lopend gemiddeld rechtop, dus de
 * gemiddelde "omlaag"-as van de camera over alle keyframes wijst naar beneden.
 *
 * De lengte van dat gemiddelde is meteen de betrouwbaarheidsmaat: 1,0 betekent
 * dat de iPad de hele scan dezelfde kant op stond, bij 0 stond hij alle kanten
 * op en is de hoogte-as onbruikbaar. Op de referentiescan is dit 0,54 — genoeg
 * om een hoogteprofiel te tonen, te weinig om er harde conclusies over het
 * aantal bouwlagen op te baseren. Vandaar dat de uitkomst als indicatie langs
 * de beoordeling gaat en niet als eigen goed/fout-oordeel.
 */
function deriveUpAxis(poses: DpPose[]): { up: Vec3; confidence: number } {
  if (poses.length === 0) return { up: [0, -1, 0], confidence: 0 };
  let dx = 0;
  let dy = 0;
  let dz = 0;
  for (const p of poses) {
    // Tweede kolom van de rotatiematrix = de +Y-as van de camera = omlaag.
    dx += p.r[1];
    dy += p.r[4];
    dz += p.r[7];
  }
  const length = Math.hypot(dx, dy, dz);
  const confidence = length / poses.length;
  if (length < 1e-6) return { up: [0, -1, 0], confidence: 0 };
  return { up: [-dx / length, -dy / length, -dz / length], confidence };
}

export function computeMetrics(scan: DpScan): DpMetrics {
  const { up, confidence } = deriveUpAxis(scan.poses);

  // Twee horizontale assen loodrecht op "omhoog", zodat we plat kunnen tekenen.
  const seed: Vec3 = Math.abs(up[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const right = normalize(cross(seed, up));
  const front = cross(up, right);

  const pts: Vec3[] = scan.poses.map((p) => {
    const v: Vec3 = [p.t[0] / 1000, p.t[1] / 1000, p.t[2] / 1000];
    return [dot(v, right), dot(v, up), dot(v, front)];
  });

  // Kijkrichting per keyframe, opgesplitst in horizontaal (voor de render) en
  // verticaal (om te zien of er naar de vloer of het plafond gericht is).
  const aim = scan.poses.map((pose) => {
    // Derde kolom van de rotatiematrix = de +Z-as van de camera = kijkrichting.
    const f = normalize([pose.r[2], pose.r[5], pose.r[8]]);
    const pitch = Math.asin(Math.max(-1, Math.min(1, dot(f, up))));
    const fx = dot(f, right);
    const fz = dot(f, front);
    const len = Math.hypot(fx, fz) || 1;
    return { fx: fx / len, fz: fz / len, pitch };
  });

  const path = scan.poses.map((_, i) => ({
    x: pts[i][0],
    y: pts[i][1],
    z: pts[i][2],
    fx: aim[i].fx,
    fz: aim[i].fz,
  }));

  const PITCH_THRESHOLD = (15 * Math.PI) / 180;
  const downward = aim.filter((a) => a.pitch < -PITCH_THRESHOLD).length;
  const upward = aim.filter((a) => a.pitch > PITCH_THRESHOLD).length;

  const TURN_THRESHOLD = Math.cos((60 * Math.PI) / 180);
  let abruptTurns = 0;
  for (let i = 1; i < aim.length; i++) {
    const cosTurn = aim[i].fx * aim[i - 1].fx + aim[i].fz * aim[i - 1].fz;
    if (cosTurn < TURN_THRESHOLD) abruptTurns++;
  }

  let pathLength = 0;
  const gaps: DpLargeStep[] = [];
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(
      pts[i][0] - pts[i - 1][0],
      pts[i][1] - pts[i - 1][1],
      pts[i][2] - pts[i - 1][2]
    );
    pathLength += d;
    if (d >= LARGE_STEP_M) gaps.push({ index: i, distanceM: d });
  }

  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const zs = pts.map((p) => p[2]);

  const loopClosure =
    pts.length >= 2
      ? Math.hypot(
          pts[0][0] - pts[pts.length - 1][0],
          pts[0][1] - pts[pts.length - 1][1],
          pts[0][2] - pts[pts.length - 1][2]
        )
      : 0;

  return {
    keyframes: scan.poses.length,
    photos: scan.photos.length,
    durationSeconds: scan.imu?.durationSeconds ?? null,
    pathLengthM: pathLength,
    loopClosureM: loopClosure,
    bboxM: {
      width: span(xs),
      depth: span(zs),
      height: span(ys),
    },
    sweptAreaM2: sweptArea(path),
    levels: detectLevels(ys),
    heightConfidence: confidence,
    largeSteps: gaps,
    maxStepM: gaps.reduce((m, gp) => Math.max(m, gp.distanceM), 0),
    floorAimShare: aim.length ? downward / aim.length : 0,
    ceilingAimShare: aim.length ? upward / aim.length : 0,
    abruptTurns,
    heightsM: ys,
    path,
  };
}

function span(v: number[]): number {
  if (v.length === 0) return 0;
  return Math.max(...v) - Math.min(...v);
}

/**
 * Zoekt bouwlagen als pieken in de verdeling van de camerahoogte. De opnemer
 * houdt de iPad steeds op ongeveer dezelfde hoogte boven de vloer, dus elke
 * bouwlaag levert een eigen piek op ~1,5 m boven die vloer.
 *
 * Dit is een indicatie, geen zekerheid: een scan die vooral op één verdieping
 * plaatsvond met een kort uitstapje naar zolder laat die zolder als een lage
 * piek zien. Daarom geeft elke laag ook zijn aandeel terug, zodat de
 * beoordeling kan wegen hoe stevig het signaal is.
 */
function detectLevels(heights: number[]): DpLevel[] {
  if (heights.length < 10) return [];
  const min = Math.min(...heights);
  const max = Math.max(...heights);
  const binSize = 0.1;
  const bins = Math.max(1, Math.ceil((max - min) / binSize) + 1);
  const hist = new Float64Array(bins);
  for (const h of heights) hist[Math.round((h - min) / binSize)] += 1;

  // Gladstrijken met een gaussiaan (sigma 0,3 m) zodat losse frames geen piek worden.
  const sigma = 3;
  const radius = sigma * 3;
  const kernel: number[] = [];
  for (let i = -radius; i <= radius; i++) {
    kernel.push(Math.exp(-(i * i) / (2 * sigma * sigma)));
  }
  const smooth = new Float64Array(bins);
  for (let i = 0; i < bins; i++) {
    let sum = 0;
    let weight = 0;
    for (let k = -radius; k <= radius; k++) {
      const j = i + k;
      if (j < 0 || j >= bins) continue;
      sum += hist[j] * kernel[k + radius];
      weight += kernel[k + radius];
    }
    smooth[i] = weight > 0 ? sum / weight : 0;
  }

  const peaks: number[] = [];
  const peakMax = Math.max(...smooth);
  for (let i = 1; i < bins - 1; i++) {
    if (smooth[i] >= smooth[i - 1] && smooth[i] > smooth[i + 1] && smooth[i] >= peakMax * 0.08) {
      peaks.push(i);
    }
  }

  // Pieken die te dicht op elkaar liggen zijn dezelfde bouwlaag: houd de hoogste.
  const kept: number[] = [];
  for (const p of peaks.sort((a, b) => smooth[b] - smooth[a])) {
    if (kept.every((q) => Math.abs(q - p) * binSize >= FLOOR_SEPARATION_M)) kept.push(p);
  }

  return kept
    .sort((a, b) => a - b)
    .map((p) => {
      const center = min + p * binSize;
      const frames = heights.filter(
        (h) => Math.abs(h - center) <= FLOOR_SEPARATION_M / 2
      ).length;
      return { heightM: center, frames, share: frames / heights.length };
    });
}

/**
 * Telt het grondvlak binnen bereik van de scanroute door per camerapositie de
 * zichtkegel op een raster van 10 cm te stempelen. Dit is niet de
 * gebruiksoppervlakte volgens NEN2580 en ook niet de exacte sensordekking,
 * maar een ondergrens: het vlak waarvan we zeker weten dat de opnemer er
 * langs is gekomen en de sensor er zicht op had.
 */
function sweptArea(
  path: { x: number; z: number; fx: number; fz: number }[]
): number {
  const cell = 0.1;
  const cells = new Set<number>();
  const cos = Math.cos(SENSOR_HALF_FOV);
  const steps = Math.ceil(SENSOR_RANGE_M / cell);

  for (const p of path) {
    for (let dx = -steps; dx <= steps; dx++) {
      for (let dz = -steps; dz <= steps; dz++) {
        const ox = dx * cell;
        const oz = dz * cell;
        const dist = Math.hypot(ox, oz);
        if (dist > SENSOR_RANGE_M) continue;
        if (dist > 0.2) {
          // Buiten de kegel? Dan heeft de sensor er niet naar gekeken.
          const dot = (ox * p.fx + oz * p.fz) / dist;
          if (dot < cos) continue;
        }
        const cx = Math.round((p.x + ox) / cell);
        const cz = Math.round((p.z + oz) / cell);
        cells.add(cx * 100000 + cz);
      }
    }
  }
  return cells.size * cell * cell;
}
