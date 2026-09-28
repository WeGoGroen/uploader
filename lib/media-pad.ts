import { sanitizePathSegment } from "@/lib/dropbox";
import { ARCHIEF_MAP } from "@/lib/dropbox";

/**
 * Welke plekken onder "Automatie Media" een machine mag beschrijven.
 *
 * Apart van de route zodat deze grenzen te testen zijn zonder Dropbox erbij te
 * halen. Ze zijn het hele punt van /api/intern/media-plaatsen: die route deelt
 * een uploadlink uit aan het control center, en een link is een schrijfrecht op
 * precies dat ene pad. Wordt er hier te ruim gedacht, dan is het dienst-token
 * een schrijfrecht op de hele Dropbox geworden.
 */

export const MEDIA_HOOFDMAP = "Automatie Media";

/**
 * De submappen waar uitvoer heen mag, met de naam erbij.
 *
 * Een vaste lijst en geen vrij veld. Met een vrij `submap` zou "../.." of een
 * willekeurig pad de projectmap uit lopen, en dan controleert de route wel
 * wélk adres maar niet meer wáár binnen dat adres.
 *
 * "out/Omgevingsfoto's" is voor de omgevingsfoto's die het control center bij
 * een adres zet: kopieën uit de Master B-roll Library, al bewerkt, dus bij de
 * oplevering en niet bij de bewerker.
 *
 * Alles onder de uitvoermap: dat is in deze mappenstructuur de afgesproken
 * scheiding tussen wat de opnemer aanlevert (In/Raw) en wat de bewerking
 * oplevert (OUT). De agent mag nooit in de invoermap schrijven — daar staan de
 * originelen, en die moeten overleven zodat een patch die tegenvalt opnieuw te
 * maken is.
 */
export const MEDIA_SUBMAPPEN = ["OUT/360", "OUT/360/review", "out/Omgevingsfoto's"] as const;

export type MediaSubmap = (typeof MEDIA_SUBMAPPEN)[number];

/** Wat de nadirmodule kan opleveren. Bewust dezelfde lijst als de leeskant
    daar: schrijft hij iets anders weg, dan klopt er iets niet en is weigeren
    beter dan het ergens neerzetten. */
const BEELD = /\.(jpe?g|png|tiff?|webp|insp|heic|heif)$/i;

/**
 * Is dit een projectmap onder de mediahoofdmap?
 *
 * Zelfde vorm als isProjectmap in bestand-plaatsen, met dezelfde reden voor de
 * archieftak: een map die net naar "Afgerond" verhuisd is, houdt werk dat er
 * nog aan kwam, en dat mag niet in een tweede map naast de echte belanden.
 */
export function isMediaProjectmap(pad: string): boolean {
  if (!pad.startsWith(`/${MEDIA_HOOFDMAP}/`) || pad.includes("..") || pad.endsWith("/")) return false;
  const delen = pad.split("/").filter(Boolean);
  /*
    Hoofdletterongevoelig vergelijken, want Dropbox is dat ook.

    Dit stond precies omgekeerd. "/Automatie Media/afgerond" werd als adresmap
    geaccepteerd — het archief zelf, waar nooit iets in hoort te ontstaan —
    terwijl "/Automatie Media/afgerond/Dam 5" werd geweigerd, een echt
    gearchiveerd adres. Beide keren omdat de vergelijking op de schrijfwijze
    lette en Dropbox dat niet doet: voor Dropbox is "afgerond" diezelfde map.
  */
  const archief = (deel: string) => deel.toLowerCase() === ARCHIEF_MAP.toLowerCase();
  // ["Automatie Media", "<adres>"] of ["Automatie Media", "Afgerond", "<adres>"]
  if (delen.length === 2) return !archief(delen[1]);
  if (delen.length === 3) return archief(delen[1]);
  return false;
}

/**
 * Hoofdletterongevoelig, om dezelfde reden als bij de archiefmap hierboven:
 * voor Dropbox zijn "out/360" en "OUT/360" dezelfde map.
 *
 * Dat is hier meer dan netjes zijn. De schrijfwijze van deze mappen is net
 * veranderd, en de twee kanten — het control center en deze route — rollen
 * niet op hetzelfde moment uit. Op de letter vergelijken zou betekenen dat er
 * tussen die twee uitrollen in bestanden geweigerd worden die gewoon naar de
 * goede map hadden gemoeten.
 */
export function isMediaSubmap(submap: string): submap is MediaSubmap {
  return (MEDIA_SUBMAPPEN as readonly string[]).some(
    (m) => m.toLowerCase() === submap.toLowerCase()
  );
}

/**
 * De bestandsnaam zoals hij in Dropbox komt te staan, of null als hij niet mag.
 *
 * `sanitizePathSegment` eerst, en dán pas de extensie beoordelen: anders zou
 * "vloer.jpg/../geheim.pdf" door de extensiecontrole glippen op de ".pdf" die
 * er na het opschonen niet eens meer staat.
 */
export function mediaBestandsnaam(ruw: string): string | null {
  const naam = sanitizePathSegment(ruw);
  if (naam.length < 5 || naam.length > 180) return null;
  if (!BEELD.test(naam)) return null;
  return naam;
}

/** Het volledige pad, of null als een van de drie delen niet deugt. */
export function mediaDoelPad(projectmap: string, submap: string, bestandsnaam: string): string | null {
  if (!isMediaProjectmap(projectmap) || !isMediaSubmap(submap)) return null;
  const naam = mediaBestandsnaam(bestandsnaam);
  if (!naam) return null;
  return `${projectmap}/${submap}/${naam}`;
}
