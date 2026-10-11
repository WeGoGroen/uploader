/**
 * Foto, video of 360°: welke kolom een aangeleverd bestand hoort.
 *
 * Overgenomen uit het Business Control Center (lib/media/herkennen.ts), waar
 * Media → Uploaden een hele shoot in één greep over In/Raw/Photo's,
 * In/Raw/Video en In/Raw/360 verdeelt. De media-opname hier doet sinds de
 * ene uploadknop hetzelfde, en moet dan ook precies hetzelfde beslissen: een
 * bestand dat het BCC als foto ziet en deze uploader als 360, belandt in de
 * betaalde nadirbewerking of juist niet, afhankelijk van waar het binnenkwam.
 * Verandert er hier iets, dan daar ook — en andersom.
 *
 * Aan de naam is het meeste al te zien: een clip is een clip, een RAW een foto,
 * een .insp een Insta360-panorama. Een JPEG niet — een panorama is ook gewoon
 * een JPEG. Daarvoor lezen we de kop van het bestand (de eerste paar honderd
 * kilobyte, zonder te decoderen): de afmetingen, en de XMP waarin een
 * 360-camera "equirectangular" zet. Dat kost een fractie van een seconde per
 * bestand, ook bij een RAW-reeks van tweehonderd stuks.
 *
 * Een foto die per ongeluk in 360 belandt, gaat door de betaalde
 * nadirbewerking. Daarom is 360 de strenge kant: een 2:1-verhouding (dezelfde
 * toets als de nadir-agent, `is360`) of een expliciete equirectangulaire
 * projectie in de XMP. Al het andere beeld is een foto.
 */

export type MediaSoort = "foto" | "video" | "360";

export const SOORTEN: MediaSoort[] = ["foto", "video", "360"];

export type Herkenning =
  | { soort: MediaSoort; reden: string }
  /** Gaat nergens heen: systeembestand, sidecar, formaat dat geen agent leest. */
  | { soort: null; reden: string };

/**
 * Is dit een equirectangulaire 360°-opname?
 *
 * De verhouding is de harde toets en de XMP het bewijsstuk erbij. Andersom zou
 * niet werken: lang niet elke camera schrijft GPano weg, en een opname zonder
 * die gegevens overslaan zou betekenen dat je precies de bestanden laat liggen
 * waar later niemand meer van weet waaróm ze zijn blijven liggen.
 *
 * De marge van 1% op de verhouding vangt af- en bijsnijden van één pixelrij op
 * bij het stitchen. Ruimer mag niet: bij 2,1 is het geen equirectangulaire
 * projectie meer en dan staat de nadir niet waar wij hem zoeken.
 *
 * (Stond in lib/media/nadir/patch.ts; daar wordt hij nu doorgegeven, zodat de
 * uploader en de nadir-agent met precies dezelfde toets werken.)
 */
export function is360(breedte: number, hoogte: number): boolean {
  if (!breedte || !hoogte) return false;
  if (breedte < 2048) return false;
  const verhouding = breedte / hoogte;
  return verhouding > 1.98 && verhouding < 2.02;
}

/** Hoeveel van het begin van een beeldbestand we lezen om het te herkennen. */
export const KOP_BYTES = 256 * 1024;

/** De video die de agent monteert; zie VIDEO in de uploader (lib/media-pad.ts). */
const VIDEO = /\.(mp4|mov)$/i;
/** Ook video, maar geen formaat dat de montage of de uploader aanneemt. */
const ANDERE_VIDEO = /\.(m4v|avi|mts|m2ts|mxf|wmv|mkv|braw|r3d|3gp|mpe?g)$/i;
/** Insta360: .insp is een panorama (een JPEG), .insv de 360-video. */
const INSTA_FOTO = /\.insp$/i;
const INSTA_VIDEO = /\.insv$/i;
/** Voorbeeldbestanden die een camera naast de echte opname zet. */
const PROXY = /\.(lrv|lrf|thm)$/i;
/** Beeld waarvan de kop bepaalt of het een foto of een panorama is. */
const BEELD = /\.(jpe?g|png|tiff?|webp|heic|heif)$/i;
/** Wat Imagen als foto aanneemt, naast RAW. */
const JPEG = /\.jpe?g$/i;
/** Camera-RAW; dezelfde lijst als RAW in lib/media-pad.ts. */
const RAW = /\.(cr2|cr3|crw|nef|nrw|arw|srf|sr2|raf|orf|rw2|dng|pef|srw|erf|mrw|3fr|fff|iiq|mos|mef|dcr|kdc|x3f|gpr)$/i;
/** Bewerkingsgegevens naast de foto: Lightroom, Capture One, DxO, ON1. */
const SIDECAR = /\.(xmp|dop|pp3|on1|arp|cos|cof|lrcat|lrdata|ini|db|thm|txt|json|csv)$/i;

/** Verborgen troep van het besturingssysteem: .DS_Store, ._IMG_1234.JPG, Thumbs.db. */
function isRommel(naam: string): boolean {
  const kaal = naam.trim();
  if (!kaal) return true;
  if (kaal.startsWith(".")) return true;
  return /^(thumbs\.db|desktop\.ini|icon\r?)$/i.test(kaal);
}

/**
 * Kan de nadir-agent dit lezen? Dezelfde lijst als BEELD in
 * lib/media/nadir/dropbox.ts. Een .insv hoort in 360 maar is video: die gaat
 * de map in en niet de rij van de agent.
 */
export function isPanorama(naam: string): boolean {
  return /\.(jpe?g|png|tiff?|webp|insp|heic|heif)$/i.test(naam);
}

/**
 * Wat de naam al zegt. `"kijken"` betekent: beeld, lees de kop.
 */
export function herkenOpNaam(naam: string): Herkenning | "kijken" {
  if (isRommel(naam)) return { soort: null, reden: "systeembestand" };
  if (PROXY.test(naam)) return { soort: null, reden: "voorbeeldbestand van de camera" };
  if (INSTA_VIDEO.test(naam)) return { soort: "360", reden: "360-video (Insta360)" };
  if (INSTA_FOTO.test(naam)) return { soort: "360", reden: "panorama (Insta360)" };
  if (VIDEO.test(naam)) return { soort: "video", reden: "clip" };
  if (ANDERE_VIDEO.test(naam)) return { soort: null, reden: "video, maar geen MP4 of MOV" };
  if (BEELD.test(naam)) return "kijken";
  if (RAW.test(naam)) return { soort: "foto", reden: "RAW" };
  if (SIDECAR.test(naam)) return { soort: null, reden: "bewerkingsgegevens (sidecar)" };
  return { soort: null, reden: "onbekend formaat" };
}

export interface Kop {
  breedte: number | null;
  hoogte: number | null;
  /** Zegt de XMP "equirectangular"? */
  equirect: boolean;
}

/** Tekst uit bytes zonder decoder-afhankelijkheid: alleen ASCII doet ertoe. */
function alsTekst(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 8192) {
    s += String.fromCharCode(...b.subarray(i, Math.min(b.length, i + 8192)));
  }
  return s;
}

/** XMP schrijft het als element of als attribuut; beide tellen. */
function zegtEquirect(tekst: string): boolean {
  return /ProjectionType\s*(=\s*["']|>)\s*equirectangular/i.test(tekst);
}

/**
 * De afmetingen en de projectie uit de eerste bytes van een beeldbestand.
 *
 * JPEG: de markers aflopen tot het frame (SOF) — alleen de koppen, geen
 * pixels. Komt het frame niet binnen de gelezen bytes (een JPEG met een enorme
 * EXIF-voorvertoning), dan blijven de afmetingen leeg en beslist de XMP.
 * PNG: de IHDR staat altijd op dezelfde plek. HEIC, TIFF en WebP: alleen de
 * XMP; hun afmetingen staan te diep voor een snelle blik.
 */
export function leesKop(bytes: Uint8Array): Kop {
  const kop: Kop = { breedte: null, hoogte: null, equirect: false };
  const n = bytes.length;

  // PNG
  if (n >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    kop.breedte = dv.getUint32(16);
    kop.hoogte = dv.getUint32(20);
    kop.equirect = zegtEquirect(alsTekst(bytes));
    return kop;
  }

  // JPEG
  if (n >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 4 <= n) {
      if (bytes[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = bytes[i + 1];
      if (marker === 0xff) {
        i++;
        continue;
      }
      // Markers zonder lengte: RST0-7, SOI, TEM.
      if ((marker >= 0xd0 && marker <= 0xd8) || marker === 0x01) {
        i += 2;
        continue;
      }
      if (marker === 0xd9 || marker === 0xda) break; // einde, of de pixels beginnen
      const lengte = (bytes[i + 2] << 8) | bytes[i + 3];
      if (lengte < 2) break;
      const begin = i + 4;
      const eind = Math.min(n, i + 2 + lengte);
      // SOF0-15 behalve DHT (C4), JPG (C8) en DAC (CC).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        if (begin + 5 <= n) {
          kop.hoogte = (bytes[begin + 1] << 8) | bytes[begin + 2];
          kop.breedte = (bytes[begin + 3] << 8) | bytes[begin + 4];
        }
        break;
      }
      // APP1 met XMP
      if (marker === 0xe1 && !kop.equirect) {
        const stuk = bytes.subarray(begin, eind);
        const tekst = alsTekst(stuk.subarray(0, Math.min(stuk.length, 64)));
        if (tekst.startsWith("http://ns.adobe.com/xap/1.0/") || tekst.startsWith("http://ns.adobe.com/xmp/extension/")) {
          kop.equirect = zegtEquirect(alsTekst(stuk));
        }
      }
      i += 2 + lengte;
    }
    return kop;
  }

  // HEIC, TIFF, WebP, of iets dat zich als beeld voordoet: alleen de XMP.
  kop.equirect = zegtEquirect(alsTekst(bytes));
  return kop;
}

/**
 * Het oordeel over een beeldbestand, gegeven zijn kop.
 *
 * Een panorama in een formaat dat Imagen niet aanneemt (HEIC, PNG) mag gewoon
 * naar 360 — de nadir-agent leest die wel. Als foto houden we ze tegen, met de
 * reden erbij: een HEIC van een telefoon tussen de RAW's laat het hele
 * Imagen-project mislukken.
 */
export function herkenUitKop(naam: string, kop: Kop | null): Herkenning {
  const { breedte, hoogte, equirect } = kop ?? { breedte: null, hoogte: null, equirect: false };
  const maat = breedte && hoogte ? `${breedte}×${hoogte}` : null;

  if (breedte && hoogte && is360(breedte, hoogte)) {
    return { soort: "360", reden: `panorama 2:1 (${maat})` };
  }
  if (equirect) {
    const verhouding = breedte && hoogte ? breedte / hoogte : null;
    // Een XMP die "equirectangular" zegt bij een 3:2-beeld is een bijgesneden
    // uitsnede, geen rondgang: daar staat de nadir niet waar de agent hem zoekt.
    if (verhouding === null || (verhouding > 1.9 && verhouding < 2.1)) {
      return { soort: "360", reden: maat ? `equirectangulair (${maat})` : "equirectangulair volgens de XMP" };
    }
  }

  if (JPEG.test(naam)) return { soort: "foto", reden: maat ? `foto (${maat})` : "foto" };
  return { soort: null, reden: "foto in een formaat dat Imagen niet aanneemt — exporteer als JPEG" };
}

/** In één keer, voor wie de kop al heeft (of null als hij niet te lezen was). */
export function herken(naam: string, kopBytes: Uint8Array | null): Herkenning {
  const opNaam = herkenOpNaam(naam);
  if (opNaam !== "kijken") return opNaam;
  return herkenUitKop(naam, kopBytes ? leesKop(kopBytes) : null);
}
