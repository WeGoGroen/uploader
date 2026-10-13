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

/** De submap waar de opname-app de gevelfoto's (ClickUp-veld D2) neerzet. */
export const OPNAMEMAP = "opname formulier";

/**
 * De foto's die direct in de submap "Opname formulier" staan.
 *
 * De opname-app zet de gevelfoto's (D2) daar, naast het opnameformulier. De
 * controle van het dossier kijkt in "foto's", en zag ze dus niet: 66 projecten
 * stonden op "foto's ontbreken" terwijl de foto's er wel waren. Na de
 * oplevering hebben ze daar geen functie meer — de koppeling met ClickUp is bij
 * het aanmaken van de taak al gelegd — dus verhuizen ze mee naar "foto's".
 *
 * Alleen afbeeldingen, en alleen direct in die map: het formulier zelf (PDF)
 * en wat in een dieper gelegen map staat, blijft waar het is.
 */
export function kiesOpnameFotos<T extends { pad: string; naam: string }>(bestanden: T[]): T[] {
  return bestanden.filter((b) => {
    const delen = b.pad.split("/");
    return delen.length === 2 && delen[0].toLowerCase() === OPNAMEMAP && FOTO.test(b.naam);
  });
}

/** De submap voor de puntenwolk. */
export const SCANMAP = "laz";

/** Wat hier als scan geldt: de puntenwolk zelf, niets anders. */
const SCAN = /\.(las|laz)$/i;

/**
 * LAS- en LAZ-bestanden die ergens anders in de projectmap staan dan in "LAZ".
 *
 * Een scan in de map van MO of los in de projectmap telt voor de controle niet
 * mee, en dan blijft het dossier op "LAZ-scan ontbreekt" staan terwijl de scan
 * er is. Alleen .las en .laz: een zip of e57 kan van alles zijn.
 */
export function kiesScans<T extends { pad: string; naam: string }>(bestanden: T[]): T[] {
  return bestanden.filter((b) => {
    const eerste = b.pad.includes("/") ? b.pad.split("/")[0].toLowerCase() : null;
    return eerste !== SCANMAP && SCAN.test(b.naam);
  });
}
