/**
 * Welke bestanden /api/intern/fotos-opruimen mag verplaatsen, en uit welke map.
 *
 * Apart van de route en apart getest, want dit is de regel die schade kan doen.
 * De route verplaatst als enige in deze app een bestand dat iemand anders heeft
 * neergezet; één te ruime zeef en er verdwijnt een PDF of een oplevering van MO
 * Consultancy in "foto's", waar niemand ernaar kijkt.
 */

export const HOOFDMAP = "Automatie Energielabels";
export const FOTOMAP = "foto's";

/** Wat hier als foto geldt. HEIC staat erbij omdat iPhones dat leveren. */
const FOTO = /\.(jpe?g|png|heic|heif|webp|tiff?)$/i;

/**
 * De afbeeldingen die lós in de projectmap liggen.
 *
 * De paden komen relatief aan de projectmap binnen, dus "los in de map" is
 * simpelweg: geen schuine streep erin. Wat in een submap staat blijft staan,
 * ook als het een foto is.
 */
export function kiesLosseFotos<T extends { pad: string; naam: string }>(bestanden: T[]): T[] {
  return bestanden.filter((b) => !b.pad.includes("/") && FOTO.test(b.naam));
}

/**
 * Of dit pad een projectmap van een energielabel is — direct onder de
 * hoofdmap, of in het archief "Afgerond".
 *
 * Dezelfde grens als /api/intern/bestand-plaatsen gebruikt. De hoofdmap zelf
 * valt erbuiten: zou die doorgaan, dan gold elke submap van 450 projecten
 * ineens als een los bestand.
 */
export function isProjectmap(pad: string): boolean {
  if (!pad.startsWith(`/${HOOFDMAP}/`) || pad.includes("..") || pad.endsWith("/")) return false;
  const delen = pad.split("/").filter(Boolean);
  // ["Automatie Energielabels", "<adres>"] of ["Automatie Energielabels", "Afgerond", "<adres>"]
  if (delen.length === 2) return delen[1] !== "Afgerond";
  if (delen.length === 3) return delen[1] === "Afgerond";
  return false;
}
