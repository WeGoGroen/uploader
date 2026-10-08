/**
 * Mag hier een bestand van een energielabel-dossier in?
 *
 * Een projectmap staat op één van drie plekken:
 *  - direct onder "Automatie Energielabels";
 *  - in het archief daaronder, "Afgerond";
 *  - in de oude, handmatige indeling "Intern (GoGroen)", onder een maand.
 *
 * Die derde kwam er op 8 oktober bij. Het control center legt bij dossiers uit
 * die indeling de map in Intern vast (lib/finalisatie/map-koppeling.ts aldaar),
 * en twaalf afschriften liepen vast op "alleen een projectmap onder
 * /Automatie Energielabels" terwijl de map gewoon bestond en gekozen was.
 *
 * Wat níet mag: een pad met "..", een hoofdmap zelf, een maandmap zelf, of
 * iets dieper dan de projectmap. Zo blijft een id of pad uit een verzoek niet
 * genoeg om overal in het account te schrijven.
 */
export const ENERGIELABEL_HOOFDMAP = "Automatie Energielabels";
export const INTERN_MAP = "/Certificering NL-EPBD/WeGoGroen/Energielabels/Intern (GoGroen)";

export function isEnergielabelProjectmap(pad: string): boolean {
  if (pad.includes("..") || pad.endsWith("/")) return false;

  if (pad.startsWith(`/${ENERGIELABEL_HOOFDMAP}/`)) {
    const delen = pad.split("/").filter(Boolean);
    // ["Automatie Energielabels", "<adres>"] of ["Automatie Energielabels", "Afgerond", "<adres>"]
    if (delen.length === 2) return delen[1] !== "Afgerond";
    if (delen.length === 3) return delen[1] === "Afgerond";
    return false;
  }

  if (pad.startsWith(`${INTERN_MAP}/`)) {
    // "<maand>/<adres>", precies twee niveaus onder Intern.
    const rest = pad.slice(INTERN_MAP.length + 1).split("/");
    return rest.length === 2 && rest.every((d) => d.trim().length > 0);
  }

  return false;
}
