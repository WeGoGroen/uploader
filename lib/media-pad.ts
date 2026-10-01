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
 * "OUT/Photo's" is de tegenhanger van OUT/360 voor de fotografie: de Foto Edit
 * Agent in het control center stuurt elke shoot door Imagen AI en zet de
 * bewerkte JPEG's daar neer. Let op de schrijfwijze — Photo's, met Ph — want zo
 * heet de map die de uploader zelf aanmaakt naast In/Raw/Photo's. Zonder deze
 * regel liep die keten helemaal door tot de laatste meter en bleven negen
 * bewerkte foto's bij Imagen staan met "submap moet een van OUT/360,
 * OUT/360/review, out/Omgevingsfoto's zijn".
 *
 * "OUT/Video" is de uitvoermap van de Video Edit Agent in het control center:
 * die monteert de clips uit In/Raw/Video automatisch en zet de video hier neer.
 * Het is de enige submap waar een video in mag, en er mag daar niets anders in
 * — zie `magInSubmap` hieronder.
 *
 * Alles onder de uitvoermap: dat is in deze mappenstructuur de afgesproken
 * scheiding tussen wat de opnemer aanlevert (In/Raw) en wat de bewerking
 * oplevert (OUT). De agent mag nooit in de invoermap schrijven — daar staan de
 * originelen, en die moeten overleven zodat een patch die tegenvalt opnieuw te
 * maken is.
 */
export const MEDIA_SUBMAPPEN = [
  "OUT/360",
  "OUT/360/review",
  "OUT/_controle/360",
  "OUT/Photo's",
  "OUT/Video",
  "out/Omgevingsfoto's",
] as const;

/**
 * De wachtmap van de 360-eindcontrole, en waar een goedgekeurd bestand heen gaat.
 *
 * Tot 1 oktober zette de nadiragent elk resultaat meteen in OUT/360 en keurde
 * hij het daarna pas. Wie de map opende zag dus ook wat nog nagekeken werd, of
 * wat later werd afgekeurd — op Woestduin en Mary van der Sluis stonden zo
 * nadirs met een verzonnen kleed tussen het goede werk. Nu landt het resultaat
 * eerst hier, en schuift het pas door na een goedkeuring (van de agent of van
 * iemand met de hand), via /api/intern/media-vrijgeven.
 *
 * Buiten OUT/360 en niet als submap ervan: een deellink van OUT/360 neemt zijn
 * submappen mee, en dan zou de klant de wachtmap gewoon kunnen openen.
 */
export const CONTROLE_SUBMAP = "OUT/_controle/360";
export const VRIJGEGEVEN_SUBMAP = "OUT/360";

export type MediaSubmap = (typeof MEDIA_SUBMAPPEN)[number];

/**
 * Waar ruw materiaal heen mag — een aparte lijst, met opzet.
 *
 * De regel hierboven zegt: de agent mag nooit in de invoermap schrijven, want
 * daar staan de originelen en die moeten een tegenvallende patch overleven.
 * Die regel blijft staan. Wat erbij komt is een andere actor: een mens die op
 * het portaal een shoot aanlevert. Die zet juist originelen neer, en heeft
 * daarvoor de invoermap nodig.
 *
 * Twee lijsten en niet één ruimere, omdat het verschil tussen die twee actoren
 * het hele punt is. Zou "In/Raw/360" bij MEDIA_SUBMAPPEN komen, dan mag de
 * nadir-agent er vanaf dat moment ook in, en dan is de bescherming van de
 * originelen stilletjes weg — precies het soort verruiming waar niemand een
 * melding van krijgt.
 */
export const AANLEVER_SUBMAPPEN = ["In/Raw/360"] as const;

export type AanleverSubmap = (typeof AANLEVER_SUBMAPPEN)[number];

/** Wie er schrijft, en dus welke lijst geldt. */
export type Schrijfsoort = "oplevering" | "aanlevering";

/** Wat de nadirmodule kan opleveren. Bewust dezelfde lijst als de leeskant
    daar: schrijft hij iets anders weg, dan klopt er iets niet en is weigeren
    beter dan het ergens neerzetten. */
const BEELD = /\.(jpe?g|png|tiff?|webp|insp|heic|heif)$/i;

/** Wat de videomontage oplevert. Alleen in OUT/Video — zie magInSubmap. */
const VIDEO = /\.(mp4|mov)$/i;

/** De ene submap waar video in hoort. */
const VIDEO_SUBMAP = "out/video";

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

/** Hetzelfde, voor de aanleverkant. Zie AANLEVER_SUBMAPPEN voor waarom dit een
    eigen functie is en geen tweede tak in de bovenstaande. */
export function isAanleverSubmap(submap: string): submap is AanleverSubmap {
  return (AANLEVER_SUBMAPPEN as readonly string[]).some(
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
export function mediaBestandsnaam(ruw: string, submap = ""): string | null {
  const naam = sanitizePathSegment(ruw);
  if (naam.length < 5 || naam.length > 180) return null;
  if (!magInSubmap(naam, submap)) return null;
  return naam;
}

/**
 * Beeld waar beeld hoort, video waar video hoort.
 *
 * Twee lijsten in plaats van één ruimere: kwam .mp4 gewoon bij BEELD, dan kon
 * de nadir-agent vanaf dat moment ook een video in OUT/360 zetten, en de
 * montage een foto in OUT/Video. Geen van beide is ooit de bedoeling, en een
 * verruiming die niemand opmerkt is precies wat deze grenzen moeten voorkomen.
 */
export function magInSubmap(naam: string, submap: string): boolean {
  const isVideomap = submap.toLowerCase() === VIDEO_SUBMAP;
  return isVideomap ? VIDEO.test(naam) : BEELD.test(naam);
}

/** Het volledige pad, of null als een van de drie delen niet deugt. */
export function mediaDoelPad(
  projectmap: string,
  submap: string,
  bestandsnaam: string,
  soort: Schrijfsoort = "oplevering"
): string | null {
  // "oplevering" als standaard, zodat elke bestaande aanroep precies blijft
  // doen wat hij deed. Wie ruw materiaal wil neerzetten moet dat expliciet
  // zeggen — dat is geen formaliteit maar de plek waar die keuze zichtbaar is.
  const mag = soort === "aanlevering" ? isAanleverSubmap(submap) : isMediaSubmap(submap);
  if (!isMediaProjectmap(projectmap) || !mag) return null;
  const naam = mediaBestandsnaam(bestandsnaam, submap);
  if (!naam) return null;
  return `${projectmap}/${submap}/${naam}`;
}

/**
 * Van de wachtmap naar de uitvoermap: de twee paden, of null als het niet mag.
 *
 * Eén vast paar en geen vrije van/naar. Een verplaatsing met vrije paden is
 * een schrijf- én wisrecht op elke map onder Automatie Media; deze kan alleen
 * dit ene ding: een gekeurd bestand onder dezelfde naam één map opschuiven,
 * binnen hetzelfde adres.
 */
export function mediaVrijgeefPaden(
  projectmap: string,
  bestandsnaam: string
): { van: string; naar: string } | null {
  const van = mediaDoelPad(projectmap, CONTROLE_SUBMAP, bestandsnaam);
  const naar = mediaDoelPad(projectmap, VRIJGEGEVEN_SUBMAP, bestandsnaam);
  if (!van || !naar) return null;
  return { van, naar };
}
