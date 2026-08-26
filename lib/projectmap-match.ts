/**
 * Herkennen of twee Dropbox-mapnamen hetzelfde adres bedoelen.
 *
 * Projectmappen heten "Sanderijnstraat 58-3, Amsterdam". Die naam wordt op
 * twee plekken gemaakt: door de app zelf (met de schrijfwijze van de BAG) en
 * door de SharePoint-overdracht (met de schrijfwijze uit het ClickUp-veld
 * "A1 Adres:"). Die twee lopen in de praktijk uiteen — "58-3" versus "58 3",
 * dubbele spaties, hoofdletters, of een afgekorte straatnaam. Op exacte tekst
 * vergelijken levert dan twee mappen op voor hetzelfde huis, en dat is precies
 * wat je niet wil: dan staan de foto's in de ene en het label in de andere.
 *
 * De postcode kan hier niet als sleutel dienen zoals bij SharePoint: die staat
 * niet in de mapnaam. Daarom vergelijken we straat, huisnummer en woonplaats
 * apart, elk genormaliseerd.
 */

export interface ProjectAddress {
  /** Straatnaam zonder leestekens/diakrieten, in kleine letters. */
  straat: string;
  /** Huisnummer + toevoeging zonder scheidingstekens: "583". */
  huisnummer: string;
  /** Woonplaats zonder leestekens/diakrieten, in kleine letters. */
  woonplaats: string;
}

function normaliseer(waarde: string): string {
  return waarde
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Leest een mapnaam ("Sanderijnstraat 58-3, Amsterdam") uit elkaar. Splitst op
 * de laatste komma: straatnamen bevatten geen komma, woonplaatsen wel eens een
 * streepje maar nooit een komma.
 */
export function parseProjectFolderName(naam: string): ProjectAddress | null {
  const komma = naam.lastIndexOf(",");
  if (komma === -1) return null;

  const straatRegel = naam.slice(0, komma).trim();
  const woonplaats = normaliseer(naam.slice(komma + 1));
  if (!woonplaats) return null;

  // Huisnummer is het eerste cijfergroepje vanaf achteren; alles ervóór is de
  // straat. De greedy prefix voorkomt dat "1e Jan Steenstraat 5" op de "1"
  // struikelt.
  const match = straatRegel.match(/^(.+?)\s+(\d+)\s*([A-Za-z0-9\s-]*)$/);
  if (!match) return null;
  const [, straat, nummer, toevoeging] = match;

  const straatNorm = normaliseer(straat);
  if (!straatNorm) return null;

  return {
    straat: straatNorm,
    huisnummer: normaliseer(`${nummer}${toevoeging}`).replace(/\s+/g, ""),
    woonplaats,
  };
}

/**
 * Zelfde adres? Woonplaats en huisnummer moeten exact gelijk zijn — daar mag
 * geen speling in zitten, want dat zijn juist de velden die buren van elkaar
 * onderscheiden. Alleen de straatnaam mag afwijken in schrijfwijze: een
 * afkorting telt mee zolang die minstens vijf tekens lang is en het begin van
 * de andere naam is ("sanderijnstr" bij "sanderijnstraat"). Korter dan dat
 * wordt het gokken, en dan liever een tweede map dan de verkeerde.
 */
export function isZelfdeAdres(a: ProjectAddress, b: ProjectAddress): boolean {
  if (a.woonplaats !== b.woonplaats) return false;
  if (a.huisnummer !== b.huisnummer) return false;
  if (a.straat === b.straat) return true;

  const [kort, lang] = a.straat.length <= b.straat.length ? [a.straat, b.straat] : [b.straat, a.straat];
  return kort.length >= 5 && lang.startsWith(kort);
}

/** Past deze mapnaam bij dit adres? */
export function mapnaamPastBijAdres(mapnaam: string, adres: ProjectAddress): boolean {
  const uitMap = parseProjectFolderName(mapnaam);
  return uitMap !== null && isZelfdeAdres(uitMap, adres);
}
