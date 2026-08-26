const BGT_OGC_BASE = "https://api.pdok.nl/lv/bgt/ogc/v1";

export type LonLat = [number, number];

/** A8-veldopties in ClickUp: acht kompasrichtingen, geen tussenliggende graden. */
const COMPASS_OPTIONS: { name: string; degrees: number }[] = [
  { name: "N", degrees: 0 },
  { name: "NO", degrees: 45 },
  { name: "O", degrees: 90 },
  { name: "ZO", degrees: 135 },
  { name: "Z", degrees: 180 },
  { name: "ZW", degrees: 225 },
  { name: "W", degrees: 270 },
  { name: "NW", degrees: 315 },
];

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}
function toDeg(rad: number): number {
  return (rad * 180) / Math.PI;
}

/** Initiële kompaspeiling (0-360, 0 = noord) van punt A naar punt B. */
function bearing([lon1, lat1]: LonLat, [lon2, lat2]: LonLat): number {
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const dLambda = toRad(lon2 - lon1);
  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x =
    Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function haversineMeters([lon1, lat1]: LonLat, [lon2, lat2]: LonLat): number {
  const R = 6371000;
  const p1 = toRad(lat1);
  const p2 = toRad(lat2);
  const dPhi = toRad(lat2 - lat1);
  const dLambda = toRad(lon2 - lon1);
  const a =
    Math.sin(dPhi / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dLambda / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Kortste hoekverschil tussen twee peilingen (0-180). */
function angleDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function centroid(ring: LonLat[]): LonLat {
  let lon = 0;
  let lat = 0;
  for (const [x, y] of ring) {
    lon += x;
    lat += y;
  }
  return [lon / ring.length, lat / ring.length];
}

interface FacadeSegment {
  bearing: number; // richting van het gevelvlak zelf (0-360, evenwijdig aan de gevel)
  length: number; // som van de samengevoegde randen, in meters
  midpoint: LonLat;
}

/**
 * BAG-pandgeometrie bestaat vaak uit veel bijna-collineaire punten (kleine
 * meetonnauwkeurigheden). We voegen opeenvolgende randen met een vergelijkbare
 * richting (< 12°) samen tot rechte gevelvlakken, en negeren fragmentjes
 * korter dan 1,5 m (te klein om een echte gevel te zijn).
 */
function simplifyToFacades(ring: LonLat[]): FacadeSegment[] {
  const points = ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
    ? ring.slice(0, -1)
    : ring;
  if (points.length < 3) return [];

  const edgeBearings = points.map((p, i) => bearing(p, points[(i + 1) % points.length]));

  const segments: FacadeSegment[] = [];
  let runStart = 0;
  for (let i = 1; i <= points.length; i++) {
    const isLast = i === points.length;
    const prevBearing = edgeBearings[i - 1];
    const curBearing = edgeBearings[i % points.length];
    if (isLast || angleDiff(curBearing, prevBearing) > 12) {
      const start = points[runStart];
      const end = points[i % points.length];
      const length = haversineMeters(start, end);
      if (length >= 1.5) {
        segments.push({
          bearing: bearing(start, end),
          length,
          midpoint: [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2],
        });
      }
      runStart = i % points.length;
    }
  }
  return segments;
}

/** Kortste afstand van een punt tot een polygoonrand (in meters, vlakke benadering). */
function distancePointToRing(point: LonLat, ring: LonLat[]): number {
  let min = Infinity;
  for (let i = 0; i < ring.length - 1; i++) {
    const d = distancePointToSegment(point, ring[i], ring[i + 1]);
    if (d < min) min = d;
  }
  return min;
}

function distancePointToSegment(p: LonLat, a: LonLat, b: LonLat): number {
  // Platte projectie rond het punt zelf — over de paar tientallen meters die
  // hier spelen is de kromming van de aarde verwaarloosbaar.
  const latRad = toRad(p[1]);
  const mPerDegLon = 111320 * Math.cos(latRad);
  const mPerDegLat = 110540;
  const toXY = ([lon, lat]: LonLat) => [
    (lon - p[0]) * mPerDegLon,
    (lat - p[1]) * mPerDegLat,
  ];
  const [px, py] = [0, 0];
  const [ax, ay] = toXY(a);
  const [bx, by] = toXY(b);
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/** Dominante richting van een wegdeel-polygoon: bearing van de langste rand,
    genormaliseerd naar 0-180 (een weg heeft geen "kant op", alleen een as). */
function roadAxisBearing(ring: LonLat[]): number {
  let best = { length: 0, bearing: 0 };
  for (let i = 0; i < ring.length - 1; i++) {
    const length = haversineMeters(ring[i], ring[i + 1]);
    if (length > best.length) {
      best = { length, bearing: bearing(ring[i], ring[i + 1]) % 180 };
    }
  }
  return best.bearing;
}

async function fetchNearestWegdeel(point: LonLat, radiusDeg: number): Promise<LonLat[] | null> {
  const [lon, lat] = point;
  const url = new URL(`${BGT_OGC_BASE}/collections/wegdeel/items`);
  url.searchParams.set(
    "bbox",
    `${lon - radiusDeg},${lat - radiusDeg},${lon + radiusDeg},${lat + radiusDeg}`
  );
  url.searchParams.set("f", "json");
  url.searchParams.set("limit", "50");

  const res = await fetch(url.toString(), { cache: "no-store", signal: AbortSignal.timeout(6000) });
  if (!res.ok) return null;

  const data = (await res.json()) as {
    features: { geometry: { type: string; coordinates: unknown } }[];
  };
  if (!data.features.length) return null;

  let nearest: { ring: LonLat[]; distance: number } | null = null;
  for (const f of data.features) {
    if (f.geometry.type !== "Polygon") continue;
    const ring = (f.geometry.coordinates as LonLat[][])[0];
    if (!ring || ring.length < 2) continue;
    const distance = distancePointToRing(point, ring);
    if (!nearest || distance < nearest.distance) nearest = { ring, distance };
  }
  return nearest?.ring ?? null;
}

function nearestCompass(degrees: number): string {
  let best = COMPASS_OPTIONS[0];
  let bestDiff = Infinity;
  for (const c of COMPASS_OPTIONS) {
    const diff = angleDiff(degrees, c.degrees);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = c;
    }
  }
  return best.name;
}

/**
 * Bepaalt de kompasrichting van de voorgevel: het gevelvlak van het pand dat
 * het dichtst bij én het meest evenwijdig aan de openbare weg ligt. Geeft
 * `null` terug als er geen pandgeometrie of geen weg in de buurt gevonden
 * wordt — de opnemer vult het dan gewoon zelf in, zoals nu al het geval is.
 */
export async function determineVoorgevelOrientation(
  pandRing: LonLat[]
): Promise<string | null> {
  const facades = simplifyToFacades(pandRing);
  if (facades.length === 0) return null;

  const center = centroid(pandRing.slice(0, -1));

  // Eerst een kleine straal (panden staan meestal vlak aan de weg), bij geen
  // resultaat één keer verder zoeken (ruimere kavels, brede bermen).
  let wegdeel = await fetchNearestWegdeel(center, 0.0006); // ~50-65 m
  if (!wegdeel) wegdeel = await fetchNearestWegdeel(center, 0.0015); // ~150 m
  if (!wegdeel) return null;

  const roadBearing = roadAxisBearing(wegdeel);

  let best: { segment: FacadeSegment; score: number } | null = null;
  for (const segment of facades) {
    const distance = distancePointToRing(segment.midpoint, wegdeel);
    // Uitlijning met de weg: de gevelrand loopt evenwijdig aan de straat als
    // haar eigen richting (mod 180) dicht bij de wegas ligt.
    const alignment = angleDiff(segment.bearing % 180, roadBearing);
    if (alignment > 45) continue; // te scheef om de voorgevel te kunnen zijn
    // Lagere score = beter: dichterbij en beter uitgelijnd wegen allebei mee.
    const score = distance + alignment * 0.3;
    if (!best || score < best.score) best = { segment, score };
  }
  // Geen enkele gevel redelijk evenwijdig aan de weg (bv. rare kavelvorm) —
  // dan liever niets invullen dan een gok die het label kan verstoren.
  if (!best) return null;

  // Buitenwaartse normaal van het gekozen gevelvlak: loodrecht op de gevel,
  // in de richting weg van het middelpunt van het pand (naar de straat toe).
  const normalA = (best.segment.bearing + 90) % 360;
  const normalB = (best.segment.bearing + 270) % 360;
  const outwardBearing = bearing(center, best.segment.midpoint);
  const outward =
    angleDiff(normalA, outwardBearing) < angleDiff(normalB, outwardBearing) ? normalA : normalB;

  return nearestCompass(outward);
}
