import { determineVoorgevelOrientation, type LonLat } from "@/lib/gevel";

const LOCATIESERVER_BASE = "https://api.pdok.nl/bzk/locatieserver/search/v3_1";
const BAG_OGC_BASE = "https://api.pdok.nl/kadaster/bag/ogc/v2";

export interface AddressSuggestion {
  id: string;
  label: string;
}

export interface NearbyAddress extends AddressSuggestion {
  distanceMeters: number;
}

export interface AddressDetails {
  straatnaam: string;
  huisnummer: number;
  huisletter: string | null;
  huisnummertoevoeging: string | null;
  postcode: string;
  woonplaatsnaam: string;
  adresseerbaarobjectId: string;
  /** Id van het pand waar dit verblijfsobject in zit; nodig voor 3DBAG. */
  pandIdentificatie: string | null;
  bouwjaar: number | null;
  /** Bruto vloeroppervlak (m²) van het verblijfsobject uit de BAG, of null
      als de BAG dat voor dit object niet registreert. */
  oppervlakte: number | null;
  /** Automatisch bepaalde kompasrichting van de voorgevel (A8), of null als
      dat niet met voldoende zekerheid kon worden vastgesteld. */
  voorgevelOrientatie: string | null;
}

export async function suggestAddresses(query: string): Promise<AddressSuggestion[]> {
  const url = new URL(`${LOCATIESERVER_BASE}/suggest`);
  url.searchParams.set("q", query);
  url.searchParams.set("fq", "type:adres");
  url.searchParams.set("rows", "10");

  const res = await fetch(url.toString(), { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`PDOK suggest failed: ${res.status}`);
  }

  const data = (await res.json()) as {
    response: { docs: { id: string; weergavenaam: string }[] };
  };

  return data.response.docs.map((doc) => ({
    id: doc.id,
    label: doc.weergavenaam,
  }));
}

function haversineMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371000;
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dPhi = ((lat2 - lat1) * Math.PI) / 180;
  const dLambda = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dPhi / 2) ** 2 +
    Math.cos(p1) * Math.cos(p2) * Math.sin(dLambda / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export async function getNearbyAddresses(
  lat: number,
  lon: number,
  count = 20
): Promise<NearbyAddress[]> {
  const url = new URL(`${LOCATIESERVER_BASE}/free`);
  url.searchParams.set("lat", String(lat));
  url.searchParams.set("lon", String(lon));
  url.searchParams.set("fq", "type:adres");
  // Over-fetch: Solr's relevance ranking isn't a perfect distance sort,
  // so we pull extra candidates and re-sort by real Haversine distance.
  url.searchParams.set("rows", String(Math.max(count * 3, 60)));
  url.searchParams.set("fl", "weergavenaam,id,centroide_ll");

  const res = await fetch(url.toString(), { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`PDOK free (nearby) failed: ${res.status}`);
  }

  const data = (await res.json()) as {
    response: {
      docs: { id: string; weergavenaam: string; centroide_ll?: string }[];
    };
  };

  const withDistance = data.response.docs
    .map((doc) => {
      const match = doc.centroide_ll?.match(
        /POINT\(([-\d.]+)\s+([-\d.]+)\)/
      );
      if (!match) return null;
      const docLon = parseFloat(match[1]);
      const docLat = parseFloat(match[2]);
      return {
        id: doc.id,
        label: doc.weergavenaam,
        distanceMeters: Math.round(haversineMeters(lat, lon, docLat, docLon)),
      };
    })
    .filter((x): x is NearbyAddress => x !== null);

  withDistance.sort((a, b) => a.distanceMeters - b.distanceMeters);

  return withDistance.slice(0, count);
}

interface LocatieserverLookupDoc {
  straatnaam: string;
  huisnummer: number;
  huisletter?: string;
  huisnummertoevoeging?: string;
  // PDOK laat postcode soms leeg (bv. bij bedrijventerreinen of hele nieuwe
  // adressen) — geen garantie dat dit veld er altijd is.
  postcode?: string;
  woonplaatsnaam: string;
  adresseerbaarobject_id: string;
}

async function lookupAddress(id: string): Promise<LocatieserverLookupDoc> {
  const url = new URL(`${LOCATIESERVER_BASE}/lookup`);
  url.searchParams.set("id", id);

  const res = await fetch(url.toString(), { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`PDOK lookup failed: ${res.status}`);
  }

  const data = (await res.json()) as {
    response: { docs: LocatieserverLookupDoc[] };
  };

  const doc = data.response.docs[0];
  if (!doc) {
    throw new Error(`PDOK lookup returned no results for id ${id}`);
  }

  return doc;
}

async function getPandInfo(
  adresseerbaarobjectId: string
): Promise<{
  bouwjaar: number | null;
  oppervlakte: number | null;
  geometry: LonLat[] | null;
  pandIdentificatie: string | null;
}> {
  const verblijfsobjectUrl = new URL(
    `${BAG_OGC_BASE}/collections/verblijfsobject/items`
  );
  verblijfsobjectUrl.searchParams.set("identificatie", adresseerbaarobjectId);
  verblijfsobjectUrl.searchParams.set("f", "json");

  const voRes = await fetch(verblijfsobjectUrl.toString(), { cache: "no-store" });
  if (!voRes.ok) return { bouwjaar: null, oppervlakte: null, geometry: null, pandIdentificatie: null };

  const voData = (await voRes.json()) as {
    features: { properties: Record<string, unknown> }[];
  };

  // Bruto vloeroppervlak staat op het verblijfsobject zelf (niet op het
  // pand) — de BAG registreert dit per woning/eenheid, niet per gebouw.
  const oppervlakteRaw = voData.features[0]?.properties["oppervlakte"];
  const oppervlakte = typeof oppervlakteRaw === "number" ? oppervlakteRaw : null;

  const pandHref = voData.features[0]?.properties["pand.href"];
  const pandUrl = Array.isArray(pandHref) ? pandHref[0] : undefined;
  if (!pandUrl || typeof pandUrl !== "string")
    return { bouwjaar: null, oppervlakte, geometry: null, pandIdentificatie: null };

  const pandRes = await fetch(`${pandUrl}?f=json`, { cache: "no-store" });
  if (!pandRes.ok) return { bouwjaar: null, oppervlakte, geometry: null, pandIdentificatie: null };

  const pandData = (await pandRes.json()) as {
    properties: { bouwjaar?: number; identificatie?: string };
    geometry?: { type: string; coordinates: unknown };
  };

  const geometry =
    pandData.geometry?.type === "Polygon"
      ? ((pandData.geometry.coordinates as LonLat[][])[0] ?? null)
      : null;

  return {
    bouwjaar: pandData.properties.bouwjaar ?? null,
    oppervlakte,
    geometry,
    pandIdentificatie: pandData.properties.identificatie ?? null,
  };
}

export async function getAddressDetails(id: string): Promise<AddressDetails> {
  const doc = await lookupAddress(id);
  const { bouwjaar, oppervlakte, geometry, pandIdentificatie } = await getPandInfo(
    doc.adresseerbaarobject_id
  );

  // Gevelrichting is een best-effort aanvulling: als PDOK/BGT hapert of geen
  // zinnige uitlijning oplevert, blijft het veld gewoon leeg voor handmatige
  // invoer — dat mag het ophalen van de rest van het adres nooit blokkeren.
  const voorgevelOrientatie = geometry
    ? await determineVoorgevelOrientation(geometry).catch(() => null)
    : null;

  return {
    straatnaam: doc.straatnaam,
    huisnummer: doc.huisnummer,
    huisletter: doc.huisletter ?? null,
    huisnummertoevoeging: doc.huisnummertoevoeging ?? null,
    postcode: doc.postcode ?? "",
    woonplaatsnaam: doc.woonplaatsnaam,
    adresseerbaarobjectId: doc.adresseerbaarobject_id,
    pandIdentificatie,
    bouwjaar,
    oppervlakte,
    voorgevelOrientatie,
  };
}
