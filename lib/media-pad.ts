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
 * Alles onder "out": dat is in deze mappenstructuur de afgesproken scheiding
 * tussen wat de opnemer aanlevert ("in") en wat de bewerking oplevert. De agent
 * mag nooit in "in" schrijven — daar staan de originelen, en die moeten
 * overleven zodat een patch die tegenvalt opnieuw te maken is.
 */
export const MEDIA_SUBMAPPEN = ["out/360", "out/360/review"] as const;

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
  // ["Automatie Media", "<adres>"] of ["Automatie Media", "Afgerond", "<adres>"]
  if (delen.length === 2) return delen[1] !== ARCHIEF_MAP;
  if (delen.length === 3) return delen[1] === ARCHIEF_MAP;
  return false;
}

export function isMediaSubmap(submap: string): submap is MediaSubmap {
  return (MEDIA_SUBMAPPEN as readonly string[]).includes(submap);
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
