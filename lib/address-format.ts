/**
 * Herleidt een adrestekst tot alleen letters/cijfers, zodat verschillende
 * notaties van hetzelfde adres ("Cruquiusweg 79C-4, Amsterdam" vs.
 * "Cruquiusweg 79 C4") als gelijk herkend worden bij het vergelijken van
 * adressen tussen bronnen (agenda, drafts, Mediatask-orders).
 */
export function normalizeForMatch(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Romeinse etage-aanduidingen die in Amsterdamse adressen voorkomen (I t/m X). */
const ROMEINS: Record<string, string> = {
  i: "1",
  ii: "2",
  iii: "3",
  iv: "4",
  v: "5",
  vi: "6",
  vii: "7",
  viii: "8",
  ix: "9",
  x: "10",
};

/**
 * Brengt de toevoeging achter het huisnummer terug tot één schrijfwijze.
 *
 * Dezelfde woning wordt tussen agenda, ClickUp en de BAG in verschillende
 * notaties geschreven, en dat is geen slordigheid maar gewoonte: in Amsterdam
 * heet de derde etage zowel "206 III" als "206-3", en de begane grond zowel
 * "5-HS" als "5-H" of "5 huis". Zonder deze gelijkstelling ziet de app die
 * als drie verschillende panden en blijft werk dat al gedaan is rood staan —
 * precies wat er bij Ceintuurbaan 206 III en Van Bossestraat 5-HS gebeurde.
 *
 * Alleen deze twee families worden gelijkgesteld, en alleen op de plek ná het
 * huisnummer. Een gewone huisletter blijft dus onderscheidend ("5A" is niet
 * "5B"), en "Dam 1" wordt nooit "Dam 10". Van de Romeinse cijfers alleen die
 * uit i/v/x bestaan: daarmee blijven veelgebruikte huisletters als C, D, L en
 * M gewoon letters in plaats van 100, 500, 50 en 1000.
 */
function normaliseerToevoeging(toevoeging: string): string {
  const kaal = toevoeging.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!kaal) return "";
  if (kaal === "hs" || kaal === "h" || kaal === "huis" || kaal === "bg") return "h";
  return ROMEINS[kaal] ?? kaal;
}

/**
 * De sleutel waarop twee adressen vergeleken worden: straatnaam, huisnummer
 * en een tot één schrijfwijze teruggebrachte toevoeging. Herkent de app geen
 * huisnummer, dan valt hij terug op de kale tekst — liever geen match dan een
 * gokje.
 */
export function adresSleutel(street: string): string {
  // Het huisnummer is het eerste getal dat alleen nog een toevoeging achter
  // zich heeft; een cijfer ín de straatnaam ("1e Jan Steenstraat 5") wordt zo
  // niet voor het huisnummer aangezien, want daar volgt nog een woord op.
  const match = street.trim().match(/^(.+?)\s+(\d+)\s*[-\s/]?\s*([A-Za-z0-9]*)$/);
  if (!match) return normalizeForMatch(street);
  const [, naam, nummer, toevoeging] = match;
  return `${normalizeForMatch(naam)}${nummer}${normaliseerToevoeging(toevoeging)}`;
}

/**
 * Vergelijkt twee adresteksten uit verschillende bronnen (agenda-afspraak,
 * ClickUp-taaknaam, Mediatask-order) en zegt of het om hetzelfde pand gaat.
 *
 * Waarom niet gewoon `startsWith` op de genormaliseerde tekst: dat matchte
 * "Dam 1" óók op "Dam 10, 1012NP Amsterdam", want na het strippen van
 * leestekens is "dam1" een prefix van "dam101012npamsterdam". Op het
 * dashboard betekende dat een vals "✓ geüpload": de startknop verdween en
 * het werk bleef stilletjes liggen.
 *
 * De regel is daarom: knip de postcode/plaats eraf en eis dat straatnaam,
 * huisnummer én toevoeging gelijk zijn. Huisletters onderscheiden echte
 * adressen — "Dam 1" en "Dam 1A" zijn twee panden — dus die mogen niet tegen
 * elkaar wegvallen.
 *
 * Wat wél tegen elkaar wegvalt, is dezelfde etage in een andere schrijfwijze
 * ("206 III" = "206-3", "5-HS" = "5-H"); zie adresSleutel. Dat is geen
 * versoepeling maar een correctie: het gaat daar aantoonbaar om hetzelfde
 * pand, en zonder die gelijkstelling bleef afgerond werk rood staan.
 */
export function sameAddress(a: string, b: string): boolean {
  const ka = adresSleutel(splitAddress(a).street);
  const kb = adresSleutel(splitAddress(b).street);
  return !!ka && ka === kb;
}

/**
 * Maakt van een Google Agenda-locatie een zoektekst die PDOK aankan. PDOK's
 * suggest-endpoint eist dat élke zoekterm ergens matcht — het achtervoegsel
 * ", Nederland" dat Google Maps standaard toevoegt (en een eventuele
 * locatienaam vóór het adres, "Café X, Straat 1, …") levert daardoor
 * gegarandeerd nul resultaten op voor een verder prima adres. Live
 * geverifieerd: "Dam 1, 1012 JS Amsterdam" → 33 hits, mét ", Nederland" → 0.
 */
export function calendarLocationToBagQuery(location: string): string {
  const withoutCountry = location
    .trim()
    .replace(/,?\s*(nederland|the netherlands|netherlands)\s*$/i, "")
    .trim();
  const parts = withoutCountry
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  // Locatienaam-prefix herkennen aan het ontbreken van cijfers: een
  // straatregel heeft (vrijwel) altijd een huisnummer, een naam meestal niet.
  while (parts.length > 1 && !/\d/.test(parts[0])) parts.shift();
  return parts.join(", ");
}

const POSTCODE_RE = /\b\d{4}\s?[A-Za-z]{2}\b/;

/**
 * Bouwt steeds ruimere zoekopdrachten voor een adres dat de BAG niet kent,
 * zodat we kunnen laten zien wat er wél bestaat op die plek. Loopt van
 * "bijna hetzelfde" naar "zelfde straat": eerst zonder huisletter/toevoeging
 * (een agenda-typefout zit daar meestal), dan zonder postcode, dan de hele
 * straat. Voorbeeld: "Kalverstraat 220 DP, 1012 XJ Amsterdam" bestaat niet,
 * maar 220A t/m 220E wel — die komen zo boven water.
 */
export function relaxedBagQueries(query: string): string[] {
  const { street, cityLine } = splitAddress(query);
  let streetPart = street.trim();

  // Anker = plaatsnaam, of anders de postcode. Zonder zo'n anker zou de
  // zoekopdracht landelijk worden en zouden we adressen uit een heel andere
  // gemeente als "lijkt hierop" presenteren — dan liever niets voorstellen.
  let anchor = cityLine ? cityLine.replace(POSTCODE_RE, "").trim() : "";
  if (!anchor && cityLine) anchor = cityLine.match(POSTCODE_RE)?.[0] ?? "";

  // Geen los plaats-deel (geen komma én geen postcode)? Dan staat de plaats
  // meestal achteraan de straatregel: "Kerkstraat 12 Utrecht", "Hoofdstraat
  // 5 Den Haag". Minimaal 3 letters, zodat een huisletter-toevoeging ("220
  // DP") niet voor een plaatsnaam wordt aangezien.
  if (!anchor) {
    const trailing = streetPart.match(
      /^(.*\d[A-Za-z0-9-]*)\s+([A-Za-z][A-Za-z.'-]{2,}(?:\s+[A-Za-z][A-Za-z.'-]*)*)$/
    );
    if (trailing) {
      streetPart = trailing[1].trim();
      anchor = trailing[2].trim();
    }
  }
  if (!anchor) return [];

  const out: string[] = [];
  // Huisnummer + eventuele toevoeging staan achteraan de straatregel; de
  // greedy prefix zorgt dat een cijfer ín de straatnaam ("1e Jan
  // Steenstraat 5") niet per ongeluk als huisnummer wordt gelezen.
  const match = streetPart.match(/^(.+)\s+(\d+)\s*([A-Za-z0-9-]*)$/);
  if (match) {
    const [, name, number] = match;
    out.push(`${name.trim()} ${number}, ${anchor}`);
    out.push(`${name.trim()}, ${anchor}`);
  } else {
    out.push(`${streetPart}, ${anchor}`);
  }

  return [...new Set(out)].filter((q) => q && q !== query);
}

/**
 * Splitst een locatietekst in een straatregel en een postcode/plaats-regel,
 * zoals de adresweergave elders in de app. Google Agenda-locaties komen in
 * allerlei vormen binnen ("Straat 1, 1012LG Amsterdam", "Straat 1 1012LG
 * Amsterdam", zonder postcode, etc.) — dus eerst op de postcode zelf
 * ankeren (die verschijnt nooit in een straatnaam) en pas als dat niet lukt
 * terugvallen op de laatste komma.
 */
export function splitAddress(location: string): { street: string; cityLine: string | null } {
  const postcodeMatch = location.match(POSTCODE_RE);
  if (postcodeMatch && postcodeMatch.index !== undefined) {
    const street = location.slice(0, postcodeMatch.index).replace(/,\s*$/, "").trim();
    const cityLine = location.slice(postcodeMatch.index).trim();
    if (street) return { street, cityLine: cityLine || null };
  }

  const commaIndex = location.lastIndexOf(",");
  if (commaIndex === -1) return { street: location, cityLine: null };
  return {
    street: location.slice(0, commaIndex).trim(),
    cityLine: location.slice(commaIndex + 1).trim() || null,
  };
}
