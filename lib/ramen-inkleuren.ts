/**
 * Ramen inkleuren: een foto van een gevel waarop de opnemer met kleuren
 * aangeeft welk glas er in elk raam zit, en waar een raam aan grenst. De
 * kleuren zijn die van het vaste kleurenblad dat het team al op papier
 * gebruikte; de foto gaat met de inkleuring en het gevel-label erop als één
 * JPG naar "D2 Foto's Buitengevels" van het energielabel.
 *
 * Alles hier is los van React en de browser, zodat het te testen is.
 */

export interface Gevel {
  naam: string;
  code: string;
  /** Zoals op het kleurenblad, in hoofdletters onder de code. */
  label: string;
}

export const GEVELS: Gevel[] = [
  { naam: "Voorgevel", code: "VG", label: "VOORGEVEL" },
  { naam: "Achtergevel", code: "AG", label: "ACHTERGEVEL" },
  { naam: "Linker zijgevel", code: "LZG", label: "LINKER ZIJ GEVEL" },
  { naam: "Rechter zijgevel", code: "RZG", label: "RECHTER ZIJ GEVEL" },
];

export type PenSoort = "kleur" | "schrijf";

export interface PenKleur {
  naam: string;
  kleur: string;
  /** Tekstkleur op de knop zelf. */
  tekst: string;
  soort: PenSoort;
}

/** Glassoorten, in de volgorde en kleuren van het kleurenblad. */
export const GLAS: PenKleur[] = [
  { naam: "Enkel", kleur: "#e8101a", tekst: "#000000", soort: "kleur" },
  { naam: "Dubbel", kleur: "#0a3fb0", tekst: "#ffffff", soort: "kleur" },
  { naam: "HR", kleur: "#f7f400", tekst: "#000000", soort: "kleur" },
  { naam: "HR+", kleur: "#f9a548", tekst: "#000000", soort: "kleur" },
  { naam: "HR++", kleur: "#1f9a48", tekst: "#000000", soort: "kleur" },
  { naam: "Triple", kleur: "#6e2bb3", tekst: "#ffffff", soort: "kleur" },
  { naam: "Paneel", kleur: "#cf6ee6", tekst: "#000000", soort: "kleur" },
];

/** Waar het raam aan grenst. */
export const GRENST_AAN: PenKleur[] = [
  { naam: "AVR", kleur: "#1f9a48", tekst: "#000000", soort: "kleur" },
  { naam: "Buiten", kleur: "#e8101a", tekst: "#000000", soort: "kleur" },
  { naam: "AOR", kleur: "#f7f400", tekst: "#000000", soort: "kleur" },
  { naam: "ASGR/Garage", kleur: "#0a3fb0", tekst: "#ffffff", soort: "kleur" },
];

/** Losse kleuren om met een dunne pen op de foto te schrijven. */
export const SCHRIJF: PenKleur[] = [
  { naam: "Zwart", kleur: "#111111", tekst: "#ffffff", soort: "schrijf" },
  { naam: "Wit", kleur: "#ffffff", tekst: "#000000", soort: "schrijf" },
  { naam: "Rood", kleur: "#e8101a", tekst: "#ffffff", soort: "schrijf" },
  { naam: "Blauw", kleur: "#0a6cff", tekst: "#ffffff", soort: "schrijf" },
  { naam: "Groen", kleur: "#1f9a48", tekst: "#ffffff", soort: "schrijf" },
  { naam: "Geel", kleur: "#f7e000", tekst: "#000000", soort: "schrijf" },
  { naam: "Oranje", kleur: "#f28c18", tekst: "#000000", soort: "schrijf" },
  { naam: "Paars", kleur: "#7a35c4", tekst: "#ffffff", soort: "schrijf" },
];

/**
 * Lijndikte in pixels van de foto. Relatief aan de breedte, zodat een lijn
 * op een foto van 4000px er net zo uitziet als op een van 1600px: een
 * inkleurlijn dik genoeg om een raam in een paar halen te vullen, een
 * schrijflijn als een gewone pen.
 */
export function lijnDikte(soort: PenSoort, fotoBreedte: number): number {
  const factor = soort === "kleur" ? 0.016 : 0.0045;
  return Math.max(2, Math.round(fotoBreedte * factor));
}

/** De Dropbox-submap van "D2 Foto's Buitengevels" (zie lib/documents.ts). */
export const BUITENGEVEL_SUBMAP = "Opname formulier";

/**
 * Bestandsnaam met datum en tijd erin. Dropbox overschrijft bij dezelfde naam
 * (de wachtrij uploadt met mode "overwrite"), dus een tweede foto van de
 * voorgevel mag nooit dezelfde naam krijgen als de eerste — dan was die weg.
 */
export function ramenBestandsnaam(gevel: Gevel | null, moment: Date): string {
  const twee = (n: number) => String(n).padStart(2, "0");
  const stempel =
    `${moment.getFullYear()}-${twee(moment.getMonth() + 1)}-${twee(moment.getDate())} ` +
    `${twee(moment.getHours())}.${twee(moment.getMinutes())}.${twee(moment.getSeconds())}`;
  return `${gevel?.naam ?? "Buitengevel"} ${stempel}.jpg`;
}

/** Zelfde opschoning als sanitizePathSegment in lib/dropbox.ts (die module
    is server-only). */
function mapnaamDeel(waarde: string): string {
  return waarde.replace(/[/\\:*?"<>|]/g, "-").trim().replace(/\s+/g, " ");
}

/**
 * De energielabelmap van een adres, zoals de server hem zou aanmaken. Alleen
 * als terugval zonder internet: met internet vraagt de app de echte map op,
 * want die kan inmiddels in het archief ("Afgerond") staan.
 */
export function energielabelMapVoor(woonplaats: string, straatEnNummer: string): string {
  return `/Automatie Energielabels/${mapnaamDeel(straatEnNummer)}, ${mapnaamDeel(woonplaats)}`;
}
