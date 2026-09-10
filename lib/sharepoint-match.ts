/**
 * Herkennen welke SharePoint-map of -bestand bij welk adres hoort. De
 * uitbestede partij levert per adres aan, maar de naamgeving verschilt per
 * keer ("Kerkstraat 12", "Kerkstraat 12 Utrecht - definitief",
 * "kerkstraat_12_label.pdf"). Losse tekstvergelijking is hier gevaarlijk:
 * "Kerkstraat 1" zit als tekst ín "Kerkstraat 12", en dan zou het label van
 * de buren in de verkeerde Dropbox-map belanden. Daarom vergelijken we
 * straatnaam en huisnummer apart, met het huisnummer als heel woord.
 */

import { splitAddress } from "@/lib/address-format";

/** Splitst "Cruquiusweg 79C-4" in straat + huisnummer + toevoeging. */
export interface ParsedAddress {
  street: string;
  number: string;
  /** Huisletter/toevoeging zonder scheidingstekens, bv. "c4". Kan leeg zijn. */
  suffix: string;
}

function tokens(value: string): string[] {
  return value
    .toLowerCase()
    // Diakrieten weg: "Hoofdstraat" vs "Höfdstraat" hoeft niet, maar
    // "Súdergoweg" (Fries) komt in beide notaties voorbij.
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

/**
 * Leest straat + huisnummer uit een adresregel zoals de app die zelf
 * samenstelt ("Kerkstraat 12", "1e Jan Steenstraat 5B"). De greedy prefix
 * zorgt dat een cijfer ín de straatnaam niet als huisnummer wordt gelezen.
 */
export function parseAddressLine(addressLine: string): ParsedAddress | null {
  const match = addressLine.trim().match(/^(.+?)\s+(\d+)\s*([A-Za-z0-9\s-]*)$/);
  if (!match) return null;
  const [, street, number, suffix] = match;
  const streetTokens = tokens(street);
  if (streetTokens.length === 0) return null;
  return {
    street: streetTokens.join(" "),
    number,
    suffix: tokens(suffix).join(""),
  };
}

/**
 * Past deze SharePoint-naam bij dit adres? Eist alle straatwoorden én het
 * huisnummer als losstaand woord. Een toevoeging in het adres moet ook in de
 * naam staan (79C mag niet matchen op 79), maar een naam mág extra woorden
 * bevatten ("- definitief", "Utrecht", "energielabel").
 */
export function matchesAddress(name: string, address: ParsedAddress): boolean {
  const nameTokens = tokens(name);
  const nameText = ` ${nameTokens.join(" ")} `;

  for (const word of address.street.split(" ")) {
    if (!nameTokens.includes(word)) return false;
  }

  const numberIndex = nameTokens.indexOf(address.number);
  if (numberIndex === -1) {
    // Toevoeging kan aan het nummer vastgeplakt zitten ("79c"), dan staat het
    // nummer niet als los woord in de lijst.
    if (!address.suffix) return false;
    return nameTokens.includes(`${address.number}${address.suffix}`);
  }

  if (!address.suffix) return true;

  // Toevoeging mag los ("79 c 4") of vastgeplakt ("79c4") volgen.
  const rest = nameTokens.slice(numberIndex + 1).join("");
  return (
    rest.startsWith(address.suffix) ||
    nameTokens.includes(`${address.number}${address.suffix}`) ||
    nameText.includes(` ${address.number}${address.suffix} `)
  );
}

/**
 * Haalt straatregel en woonplaats terug uit een ClickUp-taaknaam. Taken
 * worden aangemaakt als "Kerkstraat 12, 1234 AB Utrecht" (zie
 * /api/clickup/create-task), en precies die twee delen bepalen waar de
 * Dropbox-projectmap staat. Geeft null als de naam geen adres is — een
 * handmatig aangemaakte taak ("Bellen met makelaar") mag geen sync starten.
 */
export function taskNameToAddress(
  taskName: string
): { addressLine: string; woonplaats: string } | null {
  const { street, cityLine } = splitAddress(taskName.trim());
  if (!street || !cityLine) return null;
  if (!parseAddressLine(street)) return null;

  // cityLine is "1234 AB Utrecht" — de postcode eraf, de rest is de plaats.
  const woonplaats = cityLine.replace(/^\s*\d{4}\s?[A-Za-z]{2}\s*/, "").trim();
  if (!woonplaats) return null;

  return { addressLine: street, woonplaats };
}

/**
 * Leest uit een SharePoint-adresbalk-URL zowel de site als de map. Zo hoeft
 * niemand handmatig een site-URL en een submap uit elkaar te pluizen: open de
 * map in SharePoint, kopieer de URL uit de adresbalk, plakken. Voorbeeld:
 *
 *   https://x.sharepoint.com/sites/WeGoGroen/Shared%20Documents/Forms/
 *     AllItems.aspx?id=%2Fsites%2FWeGoGroen%2FShared%20Documents%2FGereed
 *   → { siteUrl: "https://x.sharepoint.com/sites/WeGoGroen", rootPath: "Gereed" }
 *
 * Let op: de map wordt gezocht in de standaard-documentbibliotheek van de
 * site ("Shared Documents"). Die bibliotheeknaam valt daarom weg uit het pad.
 * Een tweede, aparte bibliotheek op dezelfde site wordt niet ondersteund.
 */
export function parseSharePointUrl(input: string): { siteUrl: string; rootPath: string } | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }

  const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const sitesIndex = segments.indexOf("sites");
  const sitePath = sitesIndex === -1 ? "" : `/${segments.slice(sitesIndex, sitesIndex + 2).join("/")}`;
  const siteUrl = `${url.origin}${sitePath}`;

  // De map staat in de "id"-parameter die SharePoint zelf in de adresbalk
  // zet; het zichtbare pad ervoor eindigt altijd op Forms/AllItems.aspx.
  const id = url.searchParams.get("id");
  if (!id) return { siteUrl, rootPath: "" };

  const idSegments = id.split("/").filter(Boolean).map(decodeURIComponent);
  // Alles t/m de sitenaam eraf, daarna nog de bibliotheeknaam.
  const idSitesIndex = idSegments.indexOf("sites");
  const afterSite = idSegments.slice(idSitesIndex === -1 ? 0 : idSitesIndex + 2);
  const rootPath = afterSite.slice(1).join("/");

  return { siteUrl, rootPath };
}

/**
 * Haalt straatregel en woonplaats uit een ClickUp-taak.
 *
 * De taaknaam is hier géén adres: opnames heten "58-3 1055 BW WG". Het echte
 * adres staat in het custom field "A1 Adres:", als twee regels:
 *
 *   Sanderijnstraat 58-3
 *   1055 BW  AMSTERDAM
 *
 * Voor taken die wél een adres als naam hebben (zoals de app ze zelf
 * aanmaakte) blijft de naam als terugval werken.
 */
export function taskToAddress(task: {
  name: string;
  customFields: { name: string; value: unknown }[];
}): { addressLine: string; woonplaats: string; postcodeRegel: string | null } | null {
  const veld = task.customFields.find((f) =>
    f.name.trim().toLowerCase().startsWith("a1 adres")
  );

  if (typeof veld?.value === "string" && veld.value.trim()) {
    const uitVeld = parseAdresVeld(veld.value);
    if (uitVeld) return uitVeld;
  }

  const uitNaam = taskNameToAddress(task.name);
  return uitNaam ? { ...uitNaam, postcodeRegel: null } : null;
}

/** Leest het tweeregelige adresveld: straat+nummer boven, postcode+plaats onder. */
export function parseAdresVeld(
  waarde: string
): { addressLine: string; woonplaats: string; postcodeRegel: string | null } | null {
  const regels = waarde
    .split(/\r?\n/)
    .map((r) => r.trim())
    .filter(Boolean);
  if (regels.length === 0) return null;

  /*
    Twee schrijfwijzen komen voor, en de tweede werd stil verkeerd gelezen.

    Meestal staat het adres op twee regels: straat+nummer boven, "1055 BW
    AMSTERDAM" eronder. Maar een deel van de taken heeft alles op één regel met
    een komma ertussen: "Balboastraat 12-3, 1057VV Amsterdam". Zonder de splitsing
    hieronder gaf die vorm géén woonplaats terug, viel taskToAddress terug op de
    taaknaam — en daar stond bij drie adressen "Amsterdam1". Dan zoekt de
    overdracht een projectmap die niet bestaat en meldt "niets gevonden", terwijl
    de map er gewoon staat.
  */
  let addressLine = regels[0];
  let plaatsRegel = regels[1] ?? "";

  if (!plaatsRegel && addressLine.includes(",")) {
    const komma = addressLine.lastIndexOf(",");
    const links = addressLine.slice(0, komma).trim();
    const rechts = addressLine.slice(komma + 1).trim();
    if (links && rechts && parseAddressLine(links)) {
      addressLine = links;
      plaatsRegel = rechts;
    }
  }

  if (!parseAddressLine(addressLine)) return null;
  const woonplaats = plaatsRegel.replace(/^\s*\d{4}\s?[A-Za-z]{2}\s*/, "").trim();
  if (!woonplaats) return null;

  return {
    addressLine,
    woonplaats: normaliseerPlaats(woonplaats),
    postcodeRegel: plaatsRegel || null,
  };
}

/**
 * "AMSTERDAM" → "Amsterdam". De mapnamen in Dropbox zijn met de schrijfwijze
 * van de BAG aangemaakt; helemaal in kapitalen zou bij een nieuw adres een
 * tweede map naast de bestaande opleveren.
 */
function normaliseerPlaats(plaats: string): string {
  if (plaats !== plaats.toUpperCase()) return plaats;
  return plaats
    .toLowerCase()
    .split(/(\s+|-)/)
    .map((deel) => (/^[a-zà-ÿ]/.test(deel) ? deel.charAt(0).toUpperCase() + deel.slice(1) : deel))
    .join("");
}

/**
 * Postcode + huisnummer als sleutel. MO Consultancy noemt hun mappen niet naar
 * de straat maar naar huisnummer + postcode: "58-3 1055 BW WG",
 * "1 E3 1072 VG WGG". Er staat dus geen straatnaam in, en matchen op straat
 * levert gegarandeerd niets op. Postcode + huisnummer is bovendien een
 * betrouwbaardere sleutel dan de straatnaam: die twee samen wijzen in
 * Nederland altijd precies één adres aan.
 */
export interface PostcodeSleutel {
  /** Postcode zonder spaties, in kapitalen: "1055BW". */
  postcode: string;
  /** Huisnummer + toevoeging zonder scheidingstekens, in kapitalen: "583". */
  huisnummer: string;
}

const POSTCODE_IN_TEKST = /(\d{4})\s*([A-Za-z]{2})/;

function compact(waarde: string): string {
  return waarde.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Bouwt de sleutel uit de twee regels van het ClickUp-veld "A1 Adres:". */
export function postcodeSleutel(
  addressLine: string,
  postcodeRegel: string
): PostcodeSleutel | null {
  const pc = postcodeRegel.match(POSTCODE_IN_TEKST);
  const adres = parseAddressLine(addressLine);
  if (!pc || !adres) return null;
  return {
    postcode: `${pc[1]}${pc[2].toUpperCase()}`,
    huisnummer: compact(`${adres.number}${adres.suffix}`),
  };
}

/**
 * Past deze SharePoint-mapnaam bij dit adres? De naam is opgebouwd als
 * "<huisnummer> <postcode> <initialen>", dus: de postcode moet erin staan, en
 * alles wat er vóór staat moet exact het huisnummer zijn. Dat "exact" is hier
 * belangrijk — anders zou map "1 1055 BW WG" ook matchen op huisnummer 11.
 */
export function matchesPostcodeFolder(name: string, sleutel: PostcodeSleutel): boolean {
  const genormaliseerd = name.toUpperCase();
  const pc = genormaliseerd.match(POSTCODE_IN_TEKST);
  if (!pc || pc.index === undefined) return false;
  if (`${pc[1]}${pc[2]}` !== sleutel.postcode) return false;

  const voorPostcode = compact(genormaliseerd.slice(0, pc.index));
  return voorPostcode === sleutel.huisnummer;
}
