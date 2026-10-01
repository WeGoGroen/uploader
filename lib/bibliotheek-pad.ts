import { sanitizePathSegment } from "@/lib/dropbox";
import { mediaBestandsnaam } from "@/lib/media-pad";

/**
 * De Master B-roll Library: de omgevingsfoto's die het control center op de
 * kaart zet. Daar mag het control center twee dingen:
 *
 *  - nieuwe foto's zetten, maar alleen onder "Uploads/" — de rest van de
 *    bibliotheek is met de hand ingedeeld (stadsdeel/buurt/straat), en daar
 *    hoort een machine niet tussen te schrijven;
 *  - een foto verwijderen, overal in de bibliotheek, maar alleen een
 *    beeldbestand en nooit een map.
 *
 * Paden zijn relatief ten opzichte van de bibliotheek, zoals het control
 * center ze kent ("Amsterdam Oost/Oud-Oost/…/Javastraat 02.jpg").
 */
export const BIBLIOTHEEK_HOOFDMAP = "Master B-roll Library";
export const UPLOAD_MAP = "Uploads";

/** Het volledige Dropbox-pad van een beeldbestand in de bibliotheek, of null. */
export function bibliotheekPad(relatief: string): string | null {
  const delen = (relatief ?? "").split("/");
  if (delen.length < 2 || delen.length > 8) return null;
  const schoon: string[] = [];
  for (const [i, deel] of delen.entries()) {
    const laatste = i === delen.length - 1;
    const s = laatste ? mediaBestandsnaam(deel) : sanitizePathSegment(deel);
    if (!s || s === "." || s === ".." || s.includes("..")) return null;
    // Een opgeschoonde naam die anders is dan wat er stond, is een naam die
    // hier niet bestaat: dan liever weigeren dan het verkeerde bestand raken.
    if (s !== deel.trim().replace(/\s+/g, " ")) return null;
    schoon.push(s);
  }
  return `/${BIBLIOTHEEK_HOOFDMAP}/${schoon.join("/")}`;
}

/** Idem, maar alleen onder Uploads/: de enige plek waar nieuw werk komt. */
export function uploadPad(relatief: string): string | null {
  if (!relatief?.startsWith(`${UPLOAD_MAP}/`)) return null;
  return bibliotheekPad(relatief);
}
