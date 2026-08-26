/**
 * Beeld van het pand per adres, automatisch bij het aanmaken van de projectmap.
 *
 * Levert vier plaatjes in "Foto's": drie Street View-hoeken (voorkant plus de
 * linker- en rechterhoek) en een luchtfoto van bovenaf. Samen vertellen die
 * wat je vóór de opname wilt weten: woningtype en bouwjaarindruk van de gevel,
 * de zijgevels en aanbouwen vanuit de hoeken, en dakvorm, dakkapellen,
 * zonnepanelen en de diepte van het perceel vanuit de lucht.
 *
 * Kostenbewust opgebouwd: het metadata-endpoint is gratis en telt niet mee in
 * de facturatie, dus dat gaat altijd eerst. Pas als er echt een panorama is,
 * worden de betaalde plaatjes opgehaald. Alles valt binnen de gratis 10.000
 * aanvragen per maand per SKU.
 */

const METADATA_URL = "https://maps.googleapis.com/maps/api/streetview/metadata";
const IMAGE_URL = "https://maps.googleapis.com/maps/api/streetview";
const PDOK_LUCHTFOTO_WMS = "https://service.pdok.nl/hwh/luchtfotorgb/wms/v1_0";
const PDOK_FREE_URL = "https://api.pdok.nl/bzk/locatieserver/search/v3_1/free";

/** Hoeveel graden de hoekopnames van het vooraanzicht afwijken. 35° is genoeg
    om de zijgevel en een eventuele aanbouw mee te pakken, zonder dat het pand
    zelf uit beeld loopt. */
const HOEK_GRADEN = 35;

export interface ProjectPhoto {
  /** Bestandsnaam zoals hij in "Foto's" komt te staan. */
  filename: string;
  content: Buffer;
}

/** Kompasrichting van punt 1 naar punt 2, in graden (0 = noord). */
function bearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const dLon = (lon2 - lon1) * rad;
  const y = Math.sin(dLon) * Math.cos(lat2 * rad);
  const x =
    Math.cos(lat1 * rad) * Math.sin(lat2 * rad) -
    Math.sin(lat1 * rad) * Math.cos(lat2 * rad) * Math.cos(dLon);
  return (Math.atan2(y, x) / rad + 360) % 360;
}

/**
 * Coördinaten van het adres via PDOK (gratis, geen key). Nodig om te bepalen
 * welke kant de camera op moet kijken: zonder dit weet Google wel het pand te
 * vinden voor het vooraanzicht, maar kunnen wij geen linker- en rechterhoek
 * berekenen die daadwerkelijk op hetzelfde pand gericht staan.
 */
async function geocode(adres: string): Promise<{ lat: number; lon: number } | null> {
  try {
    const url = new URL(PDOK_FREE_URL);
    url.searchParams.set("q", adres);
    url.searchParams.set("fq", "type:adres");
    url.searchParams.set("rows", "1");
    url.searchParams.set("fl", "centroide_ll");
    const res = await fetch(url.toString(), { cache: "no-store", signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      response: { docs: { centroide_ll?: string }[] };
    };
    const match = data.response.docs[0]?.centroide_ll?.match(/POINT\(([-\d.]+) ([-\d.]+)\)/);
    if (!match) return null;
    return { lat: Number(match[2]), lon: Number(match[1]) };
  } catch {
    return null;
  }
}

async function haalPlaatje(url: string, wat: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error("[STREETVIEW] plaatje ophalen mislukt", {
        wat,
        status: res.status,
        body: (await res.text().catch(() => "")).slice(0, 200),
      });
      return null;
    }
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/** Meters per graad op de evenaar in Web Mercator — voor het omrekenen van
    een adrespunt naar het vierkant dat de WMS-server moet uitsnijden. */
const AARDE_STRAAL = 6378137;

/**
 * Uitsnede van de landelijke luchtfoto rond het pand: 80 bij 80 meter. Dat is
 * ruim genoeg voor het hele perceel inclusief achtertuin en aanbouw, en strak
 * genoeg om het dak nog in detail te zien.
 */
function luchtfotoUrl(lat: number, lon: number): string {
  const HALVE_ZIJDE = 40;
  const x = (lon * Math.PI * AARDE_STRAAL) / 180;
  const y = AARDE_STRAAL * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  const bbox = [x - HALVE_ZIJDE, y - HALVE_ZIJDE, x + HALVE_ZIJDE, y + HALVE_ZIJDE].join(",");

  const params = new URLSearchParams({
    service: "WMS",
    request: "GetMap",
    version: "1.3.0",
    layers: "Actueel_orthoHR",
    styles: "",
    crs: "EPSG:3857",
    bbox,
    width: "1024",
    height: "1024",
    format: "image/jpeg",
  });
  return `${PDOK_LUCHTFOTO_WMS}?${params}`;
}

/**
 * Haalt alle beschikbare beelden voor een adres op. Geeft een lege lijst terug
 * als er geen key is, als Google geen panorama in de buurt heeft, of als er
 * iets misgaat — het aanmaken van de projectmap mag hier nooit op stuklopen.
 */
export async function fetchProjectPhotos(
  woonplaats: string,
  straatEnNummer: string
): Promise<ProjectPhoto[]> {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) {
    console.warn("[STREETVIEW] GOOGLE_MAPS_API_KEY ontbreekt — geen beeldmateriaal");
    return [];
  }

  const location = `${straatEnNummer}, ${woonplaats}, Nederland`;
  const fotos: ProjectPhoto[] = [];

  // Het pand zelf eerst: die coördinaten bepalen zowel de kijkrichting van de
  // straatbeelden als het middelpunt van de luchtfoto.
  const pand = await geocode(location);

  try {
    const metaRes = await fetch(`${METADATA_URL}?${new URLSearchParams({ location, key })}`);
    const meta = metaRes.ok
      ? ((await metaRes.json()) as {
          status: string;
          date?: string;
          error_message?: string;
          pano_id?: string;
          location?: { lat: number; lng: number };
        })
      : { status: `HTTP ${metaRes.status}` };

    if (meta.status !== "OK") {
      console.error("[STREETVIEW] geen panorama", {
        location,
        status: meta.status,
        error: "error_message" in meta ? meta.error_message : undefined,
      });
    } else {
      // Alle hoeken vanaf hetzelfde panorama, anders kiest Google per aanvraag
      // een ander standpunt en kijken de "hoeken" naar iets anders dan de
      // voorkant.
      const basis: Record<string, string> = {
        size: "640x640",
        fov: "70",
        pitch: "10",
        return_error_code: "true",
        key,
      };
      if (meta.pano_id) basis.pano = meta.pano_id;
      else basis.location = location;

      // Richting van het panorama naar het pand: dát is het vooraanzicht.
      // Lukt de berekening niet, dan laten we Google zelf mikken (zonder
      // heading richt hij automatisch op het opgegeven adres) en vervallen de
      // hoekopnames — een hoek zonder betrouwbaar vooraanzicht is een foto
      // van de buren.
      const voor =
        pand && meta.location
          ? bearing(meta.location.lat, meta.location.lng, pand.lat, pand.lon)
          : null;

      const hoeken =
        voor === null
          ? [{ naam: "Straatbeeld voorkant.jpg", heading: null as number | null }]
          : [
              { naam: "Straatbeeld voorkant.jpg", heading: voor },
              { naam: "Straatbeeld linkerhoek.jpg", heading: (voor - HOEK_GRADEN + 360) % 360 },
              { naam: "Straatbeeld rechterhoek.jpg", heading: (voor + HOEK_GRADEN) % 360 },
            ];

      for (const hoek of hoeken) {
        const params = new URLSearchParams(basis);
        if (hoek.heading !== null) params.set("heading", hoek.heading.toFixed(1));
        const content = await haalPlaatje(`${IMAGE_URL}?${params}`, hoek.naam);
        if (content) fotos.push({ filename: hoek.naam, content });
      }

      if (fotos.length > 0) {
        console.log("[STREETVIEW] straatbeelden opgehaald", {
          location,
          panoramaDatum: meta.date,
          aantal: fotos.length,
        });
      }
    }
  } catch {
    // Street View is een extraatje; de luchtfoto hieronder kan nog wel lukken.
  }

  // Luchtfoto van bovenaf — laat dakvorm, dakkapellen, zonnepanelen en de
  // aanbouw aan de achterkant zien, precies wat je vanaf de straat mist.
  //
  // Bewust PDOK en niet Google: de landelijke luchtfoto is 8 cm per pixel en
  // wordt bij daglicht gevlogen, terwijl Google boven Nederlandse woonwijken
  // terugvalt op satellietbeeld waarop de daken in de schaduw wegvallen. PDOK
  // is bovendien open data — geen key, geen quota, geen kosten.
  if (pand) {
    const content = await haalPlaatje(luchtfotoUrl(pand.lat, pand.lon), "Luchtfoto.jpg");
    if (content) fotos.push({ filename: "Luchtfoto.jpg", content });
  }

  return fotos;
}

/**
 * Controleert of de koppeling nú werkt, voor de Koppelingen-pagina en de
 * ochtendcontrole. Gebruikt bewust het metadata-endpoint op een vast bekend
 * adres (Dam 1, Amsterdam): dat is gratis en telt niet mee in de facturatie,
 * dus deze controle mag zo vaak draaien als nodig.
 *
 * Geeft het onderscheid terug dat ertoe doet: geen key (uit), key geweigerd
 * (REQUEST_DENIED — meestal billing of een verkeerde API-restrictie), of
 * gewoon in orde.
 */
/** Snelle controle of de landelijke luchtfoto (PDOK) nu antwoordt. Gratis en
    zonder key, maar wel de bron van één van de vier bestanden — valt hij weg,
    dan wil je dat weten voordat iemand een halflege projectmap opent. */
async function luchtfotoWerkt(): Promise<{ ok: boolean; error: string }> {
  try {
    const res = await fetch(luchtfotoUrl(52.3731, 4.8922), { signal: AbortSignal.timeout(5000) });
    if (res.ok) return { ok: true, error: "" };
    return { ok: false, error: `PDOK gaf ${res.status}` };
  } catch {
    return { ok: false, error: "PDOK luchtfoto is nu niet bereikbaar." };
  }
}

export async function checkStreetView(): Promise<{
  connected: boolean;
  ok: boolean;
  label: string | null;
  error: string | null;
}> {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) {
    return {
      connected: false,
      ok: false,
      label: null,
      error: "GOOGLE_MAPS_API_KEY is niet ingesteld — nieuwe projectmappen krijgen geen beeldmateriaal.",
    };
  }

  try {
    const res = await fetch(
      `${METADATA_URL}?${new URLSearchParams({ location: "Dam 1, Amsterdam, Nederland", key })}`,
      { cache: "no-store", signal: AbortSignal.timeout(5000) }
    );
    const meta = (await res.json()) as { status: string; date?: string; error_message?: string };
    if (meta.status === "OK") {
      // De luchtfoto komt van PDOK, een andere dienst dan Street View. Zonder
      // aparte controle merk je een storing daar pas als iemand een projectmap
      // opent en er drie i.p.v. vier bestanden staan.
      const kaart = await luchtfotoWerkt();
      if (!kaart.ok) {
        return {
          connected: true,
          ok: false,
          label: null,
          error: `Straatbeeld werkt, luchtfoto niet: ${kaart.error}`,
        };
      }
      return { connected: true, ok: true, label: "straatbeeld + luchtfoto actief", error: null };
    }
    if (meta.status === "REQUEST_DENIED") {
      return {
        connected: true,
        ok: false,
        label: null,
        error: `Google weigert de key: ${meta.error_message ?? "REQUEST_DENIED"}`,
      };
    }
    // Iets anders (OVER_QUERY_LIMIT, ZERO_RESULTS op een adres dat Google
    // gewoon kent): dan is er wel degelijk iets mis met de koppeling.
    return {
      connected: true,
      ok: false,
      label: null,
      error: `Onverwacht antwoord van Google: ${meta.status}${meta.error_message ? ` — ${meta.error_message}` : ""}`,
    };
  } catch {
    return { connected: true, ok: false, label: null, error: "Google Street View is nu niet bereikbaar." };
  }
}
