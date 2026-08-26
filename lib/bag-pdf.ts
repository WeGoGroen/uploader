// Genereert automatisch het officiële BAG-PDF-rapport (zelfde rapport als de
// "Download als PDF"-knop op bagviewer.kadaster.nl) voor een adres, en zet
// het klaar om naar de map "BAG" in Dropbox te uploaden.
//
// Twee aparte Kadaster-onderdelen zijn hiervoor nodig:
// 1. De BAG API Individuele Bevragingen (JSON-data per adres) — eigen,
//    persoonlijk API-key van WeGoGroen (KADASTER_BAG_API_KEY).
// 2. De print-services van bagviewer.kadaster.nl, die van die JSON-data het
//    PDF-rapport genereert (zelfde MapFish Print-endpoint als de website
//    zelf gebruikt). Die key staat vast in de eigen website van Kadaster
//    (dus al publiek zichtbaar in de browser) en is override-baar via
//    KADASTER_PRINT_API_KEY, mocht Kadaster 'm ooit rotёren.
const BAG_API_BASE = "https://api.bag.kadaster.nl/lvbag/individuelebevragingen/v2";
const PRINT_API_BASE = "https://api.kadaster.nl/ggc/print-services";
const DEFAULT_PRINT_API_KEY = "l7b1a52f655f834acd93c08ab5308c33bf";
const THREEDBAG_API_BASE = "https://api.3dbag.nl";

function requireBagApiKey(): string {
  const key = process.env.KADASTER_BAG_API_KEY;
  if (!key) throw new Error("KADASTER_BAG_API_KEY is niet ingesteld");
  return key;
}

function printApiKey(): string {
  return process.env.KADASTER_PRINT_API_KEY || DEFAULT_PRINT_API_KEY;
}

interface BagAdresResponse {
  _embedded: {
    adressen: Array<{
      _embedded: {
        adresseerbaarObject: {
          verblijfsobject?: {
            verblijfsobject: {
              identificatie: string;
              geometrie?: { punt?: { coordinates: [number, number, number?] } };
              gebruiksdoelen?: string[];
              oppervlakte?: number;
              status: string;
            };
          };
        };
        nummeraanduiding: {
          nummeraanduiding: {
            identificatie: string;
            status: string;
            postcode?: string;
            huisnummer: number;
            huisletter?: string;
            huisnummertoevoeging?: string;
          };
        };
        openbareRuimte: {
          openbareRuimte: { identificatie: string; naam: string; status: string };
        };
        panden: Array<{
          pand: {
            identificatie: string;
            geometrie?: { type: string; coordinates: number[][][] };
            oorspronkelijkBouwjaar?: number;
            status: string;
          };
        }>;
        woonplaats: {
          woonplaats: { identificatie: string; naam: string; status: string };
        };
      };
    }>;
  };
}

export interface BagAddressData {
  adres: string;
  postcode: string;
  woonplaatsIdentificatie: string;
  woonplaatsNaam: string;
  woonplaatsStatus: string;
  openbareRuimteIdentificatie: string;
  openbareRuimteNaam: string;
  openbareRuimteStatus: string;
  bronhouderIdentificatie: string;
  bronhouderNaam: string;
  pandIdentificatie: string;
  pandOorspronkelijkBouwjaar: string;
  pandStatus: string;
  pandGeometrieën: number[][][][];
  verblijfsobjectIdentificatie: string;
  verblijfsobjectOppervlakte: string;
  verblijfsobjectGebruiksdoelen: string;
  verblijfsobjectStatus: string;
  verblijfsobjectPunt: [number, number] | null;
  nummeraanduidingIdentificatie: string;
  nummeraanduidingPostcode: string;
  nummeraanduidingHuisnummer: string;
  nummeraanduidingHuisnummertoevoeging: string;
  nummeraanduidingHuisletter: string;
  nummeraanduidingStatus: string;
}

async function bagFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${BAG_API_BASE}${path}`, {
    headers: { "X-Api-Key": requireBagApiKey(), Accept: "application/hal+json" },
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`BAG API ${path} failed: ${res.status} ${body}`);
  }
  return res.json() as Promise<T>;
}

export interface Bag3dHeights {
  dakType: string | null;
  bouwlagen: number | null;
  hNok: number | null;
  hDakMax: number | null;
  hDak50p: number | null;
  hDak70p: number | null;
  hMaaiveld: number | null;
}

/**
 * Haalt de 3D-hoogtegegevens van een pand op bij 3DBAG (TU Delft/3DGI,
 * afgeleid van AHN-hoogtemetingen + de BAG). Best-effort: als de dienst niet
 * bereikbaar is of het pand niet gereconstrueerd is, blijft dit gewoon leeg
 * — het hoort als aanvulling bij het BAG-rapport, nooit als blokkade.
 */
export async function get3dBagHeights(pandIdentificatie: string): Promise<Bag3dHeights | null> {
  if (!pandIdentificatie) return null;
  try {
    const res = await fetch(`${THREEDBAG_API_BASE}/collections/pand/items/NL.IMBAG.Pand.${pandIdentificatie}`, {
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      feature: { CityObjects: Record<string, { attributes: Record<string, unknown> }> };
    };
    const cityObject = Object.values(data.feature?.CityObjects ?? {})[0];
    const attrs = cityObject?.attributes;
    if (!attrs) return null;
    const num = (v: unknown): number | null => (typeof v === "number" ? Math.round(v * 10) / 10 : null);
    return {
      dakType: typeof attrs.b3_dak_type === "string" ? attrs.b3_dak_type : null,
      bouwlagen: num(attrs.b3_bouwlagen),
      hNok: num(attrs.b3_h_nok),
      hDakMax: num(attrs.b3_h_dak_max),
      hDak50p: num(attrs.b3_h_dak_50p),
      hDak70p: num(attrs.b3_h_dak_70p),
      hMaaiveld: num(attrs.b3_h_maaiveld),
    };
  } catch {
    return null;
  }
}

export async function getBagAddressData(
  postcode: string,
  huisnummer: number,
  huisletter?: string | null,
  huisnummertoevoeging?: string | null
): Promise<BagAddressData> {
  const params = new URLSearchParams({ postcode, huisnummer: String(huisnummer), expand: "true" });
  if (huisletter) params.set("huisletter", huisletter);
  if (huisnummertoevoeging) params.set("huisnummertoevoeging", huisnummertoevoeging);
  if (huisletter || huisnummertoevoeging) params.set("exacteMatch", "true");

  const data = await bagFetch<BagAdresResponse>(`/adressen?${params.toString()}`);
  const addr = data._embedded?.adressen?.[0];
  if (!addr) throw new Error("Geen BAG-adres gevonden voor dit postcode/huisnummer");

  const emb = addr._embedded;
  const vbo = emb.adresseerbaarObject?.verblijfsobject?.verblijfsobject;
  const pandEntry = emb.panden?.[0]?.pand;
  const num = emb.nummeraanduiding.nummeraanduiding;
  const openbareRuimte = emb.openbareRuimte.openbareRuimte;
  const woonplaats = emb.woonplaats.woonplaats;
  const gemeenteCode = pandEntry?.identificatie.slice(0, 4) ?? num.identificatie.slice(0, 4);

  let bronhouderNaam = woonplaats.naam;
  try {
    const bronhouder = await bagFetch<{ bronhouder: { naam: string } }>(`/bronhouders/${gemeenteCode}`);
    bronhouderNaam = bronhouder.bronhouder.naam;
  } catch {
    // Bronhouder is een aanvulling, geen blokkerend gegeven — val terug op de woonplaatsnaam.
  }

  const pandGeometrieën = (emb.panden ?? [])
    .map((p) => p.pand.geometrie?.coordinates)
    .filter((c): c is number[][][] => Array.isArray(c));

  const puntCoords = vbo?.geometrie?.punt?.coordinates;

  return {
    adres: `${openbareRuimte.naam} ${num.huisnummer}${num.huisletter ?? ""}${num.huisnummertoevoeging ? `-${num.huisnummertoevoeging}` : ""}, ${woonplaats.naam}`,
    postcode: num.postcode ?? postcode,
    woonplaatsIdentificatie: woonplaats.identificatie,
    woonplaatsNaam: woonplaats.naam,
    woonplaatsStatus: woonplaats.status,
    openbareRuimteIdentificatie: openbareRuimte.identificatie,
    openbareRuimteNaam: openbareRuimte.naam,
    openbareRuimteStatus: openbareRuimte.status,
    bronhouderIdentificatie: gemeenteCode,
    bronhouderNaam,
    pandIdentificatie: pandEntry?.identificatie ?? "",
    pandOorspronkelijkBouwjaar: pandEntry?.oorspronkelijkBouwjaar ? String(pandEntry.oorspronkelijkBouwjaar) : "",
    pandStatus: pandEntry?.status ?? "",
    pandGeometrieën,
    verblijfsobjectIdentificatie: vbo?.identificatie ?? "",
    verblijfsobjectOppervlakte: vbo?.oppervlakte ? String(vbo.oppervlakte) : "",
    verblijfsobjectGebruiksdoelen: (vbo?.gebruiksdoelen ?? []).join(", "),
    verblijfsobjectStatus: vbo?.status ?? "",
    verblijfsobjectPunt: puntCoords ? [puntCoords[0], puntCoords[1]] : null,
    nummeraanduidingIdentificatie: num.identificatie,
    nummeraanduidingPostcode: num.postcode ?? postcode,
    nummeraanduidingHuisnummer: String(num.huisnummer),
    nummeraanduidingHuisnummertoevoeging: num.huisnummertoevoeging ?? "",
    nummeraanduidingHuisletter: num.huisletter ?? "",
    nummeraanduidingStatus: num.status,
  };
}

function detailsSection(title: string, rows: [string, string][]): string {
  const lines = rows
    .filter(([, v]) => v)
    .map(([label, v]) => `<style isBold='true'>${label}</style>\n${v}`)
    .join("\n");
  return `<style isBold='true' size='14'>${title}</style>\n${lines}`;
}

function buildDetailsText(d: BagAddressData): string {
  return [
    detailsSection("Pand", [
      ["Identificatie", d.pandIdentificatie],
      ["Oorspronkelijk bouwjaar", d.pandOorspronkelijkBouwjaar],
      ["Status", d.pandStatus],
    ]),
    detailsSection("Verblijfsobject", [
      ["Identificatie", d.verblijfsobjectIdentificatie],
      ["Oppervlakte", d.verblijfsobjectOppervlakte ? `${d.verblijfsobjectOppervlakte} m²` : ""],
      ["Gebruiksdoel", d.verblijfsobjectGebruiksdoelen],
      ["Status", d.verblijfsobjectStatus],
    ]),
    detailsSection("Nummeraanduiding", [
      ["Identificatie", d.nummeraanduidingIdentificatie],
      ["Status", d.nummeraanduidingStatus],
    ]),
    detailsSection("Openbare ruimte", [
      ["Naam", d.openbareRuimteNaam],
      ["Status", d.openbareRuimteStatus],
    ]),
    detailsSection("Woonplaats", [
      ["Naam", d.woonplaatsNaam],
      ["Status", d.woonplaatsStatus],
    ]),
  ].join("\n\n");
}

function build3dDetailsText(d: BagAddressData, heights: Bag3dHeights): string {
  return [
    detailsSection("Adres", [
      ["Adres", d.adres],
      ["Pand-identificatie", d.pandIdentificatie],
    ]),
    detailsSection("3D-hoogte (3DBAG)", [
      ["Daktype", heights.dakType ?? ""],
      ["Bouwlagen", heights.bouwlagen !== null ? String(heights.bouwlagen) : ""],
      ["Nokhoogte", heights.hNok !== null ? `${heights.hNok} m` : ""],
      ["Hoogste dakpunt", heights.hDakMax !== null ? `${heights.hDakMax} m` : ""],
      ["Dakhoogte (50e percentiel)", heights.hDak50p !== null ? `${heights.hDak50p} m` : ""],
      ["Dakhoogte (70e percentiel)", heights.hDak70p !== null ? `${heights.hDak70p} m` : ""],
      ["Maaiveldhoogte", heights.hMaaiveld !== null ? `${heights.hMaaiveld} m` : ""],
    ]),
    detailsSection("Bron", [
      [
        "Toelichting",
        "Hoogtegegevens van 3DBAG (TU Delft / 3DGI), afgeleid uit AHN-hoogtemetingen gecombineerd met de BAG-pandcontour.",
      ],
    ]),
  ].join("\n\n");
}

function computeBbox(pandGeometrieën: number[][][][]): [number, number, number, number] | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const rings of pandGeometrieën) {
    for (const ring of rings) {
      for (const [x, y] of ring) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (!Number.isFinite(minX)) return null;
  // 40% marge rondom het pand, zodat de contour niet strak tegen de rand plakt.
  const padX = (maxX - minX) * 0.4 || 10;
  const padY = (maxY - minY) * 0.4 || 10;
  return [minX - padX, minY - padY, maxX + padX, maxY + padY];
}

function buildPrintPayload(d: BagAddressData, detailsText: string, pageTitle: string = d.adres): Record<string, unknown> {
  const bbox = computeBbox(d.pandGeometrieën);
  const layers = d.pandGeometrieën.length
    ? [
        {
          failOnError: true,
          type: "geojson",
          style: {
            styleProperty: "type",
            bag: { fillColor: "#406a9e", fillOpacity: 0.4, strokeColor: "#2b2b2b", strokeWidth: 1.5 },
            vbo: {
              fillColor: "#406a9e",
              fillOpacity: 0.4,
              strokeColor: "#2b2b2b",
              strokeWidth: 1.5,
              graphicName: "circle",
              pointRadius: 3,
            },
          },
          geoJson: {
            type: "FeatureCollection",
            features: [
              ...d.pandGeometrieën.map((coordinates) => ({
                type: "Feature",
                properties: { type: "bag" },
                geometry: { type: "Polygon", coordinates },
              })),
              ...(d.verblijfsobjectPunt
                ? [
                    {
                      type: "Feature",
                      properties: { type: "vbo" },
                      geometry: { type: "Point", coordinates: d.verblijfsobjectPunt },
                    },
                  ]
                : []),
            ],
          },
        },
      ]
    : [];

  return {
    layout: "1. A4 portrait",
    attributes: {
      map: {
        projection: "EPSG:28992",
        dpi: 150,
        height: 190,
        width: 555,
        bbox: bbox ?? [0, 300000, 280000, 625000],
        layers,
      },
      pageTitle,
      resultaatType: "Nummeraanduiding",
      adres: d.adres,
      postcode: d.postcode,
      woonplaatsIdentificatie: d.woonplaatsIdentificatie,
      woonplaatsNaam: d.woonplaatsNaam,
      woonplaatsStatus: d.woonplaatsStatus,
      openbareRuimteIdentificatie: d.openbareRuimteIdentificatie,
      openbareRuimteNaam: d.openbareRuimteNaam,
      openbareRuimteStatus: d.openbareRuimteStatus,
      bronhouderIdentificatie: d.bronhouderIdentificatie,
      bronhouderNaam: d.bronhouderNaam,
      pandIdentificatie: d.pandIdentificatie,
      pandOorspronkelijkBouwjaar: d.pandOorspronkelijkBouwjaar,
      pandStatus: d.pandStatus,
      verblijfsobjectIdentificatie: d.verblijfsobjectIdentificatie,
      verblijfsobjectOppervlakte: d.verblijfsobjectOppervlakte,
      verblijfsobjectGebruiksdoelen: d.verblijfsobjectGebruiksdoelen,
      verblijfsobjectStatus: d.verblijfsobjectStatus,
      verblijfsobjectInOnderzoek: "",
      nummeraanduidingIdentificatie: d.nummeraanduidingIdentificatie,
      nummeraanduidingPostcode: d.nummeraanduidingPostcode,
      nummeraanduidingHuisnummer: d.nummeraanduidingHuisnummer,
      nummeraanduidingHuisnummertoevoeging: d.nummeraanduidingHuisnummertoevoeging,
      nummeraanduidingHuisletter: d.nummeraanduidingHuisletter,
      nummeraanduidingStatus: d.nummeraanduidingStatus,
      datasource: [
        {
          table: {
            data: [],
            columns: ["geregistreerdOp", "object", "meldingsnummer", "status", "onderbouwing", "toelichting", "laatsteWijziging"],
          },
        },
      ],
      details: detailsText,
      bijbehorendeAdressen: [],
      nevenAdressen: "",
      toonSamenvatting: true,
      toonKaart: layers.length > 0,
      toonTerugmeldingen: false,
      toonBijbehorendeAdressen: false,
      toonUitgebreidOverzicht: false,
      toonDetails: true,
    },
    outputFilename: "report",
  };
}

async function pollPrintJob(ref: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const res = await fetch(`${PRINT_API_BASE}/print/status/${ref}.json`, {
      headers: { apikey: printApiKey() },
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`Kadaster print status failed: ${res.status}`);
    const data = (await res.json()) as { done: boolean; status: string; error?: string };
    if (data.done) {
      if (data.status !== "finished") throw new Error(`Kadaster print job mislukt: ${data.error ?? data.status}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Kadaster print job duurde te lang");
}

/**
 * Stuurt een print-payload naar de Kadaster print-services (hetzelfde
 * MapFish Print-endpoint als bagviewer.kadaster.nl zelf gebruikt), wacht
 * tot de job klaar is, en geeft de PDF-bytes terug. Gedeeld door het
 * hoofd-BAG-rapport en het losse 3D BAG-rapport — allebei gebruiken exact
 * dezelfde aanmaak/poll/download-mechaniek, alleen de payload verschilt.
 */
async function runPrintJob(payload: Record<string, unknown>): Promise<Buffer> {
  const createRes = await fetch(`${PRINT_API_BASE}/BAG/report.pdf`, {
    method: "POST",
    headers: { apikey: printApiKey(), "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(payload),
  });
  if (!createRes.ok) {
    const body = await createRes.text().catch(() => "");
    throw new Error(`Kadaster print aanmaken mislukt: ${createRes.status} ${body}`);
  }
  const { ref } = (await createRes.json()) as { ref: string };

  await pollPrintJob(ref);

  const downloadRes = await fetch(`${PRINT_API_BASE}/print/report/${ref}`, {
    headers: { apikey: printApiKey() },
  });
  if (!downloadRes.ok) throw new Error(`Kadaster PDF downloaden mislukt: ${downloadRes.status}`);
  return Buffer.from(await downloadRes.arrayBuffer());
}

/**
 * Genereert het officiële BAG-PDF-rapport voor een adres — zelfde rapport
 * als "Download als PDF" op bagviewer.kadaster.nl — en geeft de bytes terug
 * zodat de caller ze naar Dropbox kan uploaden.
 */
export async function generateBagPdf(
  postcode: string,
  huisnummer: number,
  huisletter?: string | null,
  huisnummertoevoeging?: string | null
): Promise<Buffer> {
  const data = await getBagAddressData(postcode, huisnummer, huisletter, huisnummertoevoeging);
  return runPrintJob(buildPrintPayload(data, buildDetailsText(data)));
}

/**
 * Genereert een apart, tweede PDF met alleen de 3DBAG-hoogtegegevens (nok-/
 * dakhoogte, bouwlagen, maaiveldhoogte), met de pandcontour als kaart voor
 * context. Geeft null terug als er voor dit pand geen 3D-reconstructie
 * beschikbaar is bij 3DBAG — dan is er simpelweg niets om te tonen.
 */
export async function generate3dBagPdf(
  postcode: string,
  huisnummer: number,
  huisletter?: string | null,
  huisnummertoevoeging?: string | null
): Promise<Buffer | null> {
  const data = await getBagAddressData(postcode, huisnummer, huisletter, huisnummertoevoeging);
  const heights = await get3dBagHeights(data.pandIdentificatie);
  if (!heights) return null;
  const payload = buildPrintPayload(data, build3dDetailsText(data, heights), `${data.adres} — 3D BAG`);
  return runPrintJob(payload);
}
