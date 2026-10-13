import type { DossierBijlage } from "@/lib/opname-velden";

/**
 * Welke bijlagen van een opname-taak in ClickUp naar welke submap van de
 * projectmap horen.
 *
 * Waarvoor: bij 47 van de 55 projecten die op 13 oktober op "foto's
 * ontbreken" stonden, lagen de foto's wel in ClickUp — 1.219 stuks, ze zaten
 * zelfs in het opnameformulier — maar nooit als bestand in Dropbox. De
 * opnemer had ze rechtstreeks aan de taak gehangen in plaats van via de app.
 *
 * Alleen twee soorten, want alleen die zijn ondubbelzinnig:
 *  - afbeeldingen, uit elk veld, naar "Foto's";
 *  - de puntenwolk: alles uit veld D4 (LAZ-bestanden) en elke .las/.laz, naar "LAZ".
 * Een PDF, een Word-bestand of een notitie blijft in ClickUp: daarvan staat de
 * plek niet vast, en een verdwaald bestand is erger dan een ontbrekend.
 */

export type BijlageDoel = "foto's" | "laz";

const AFBEELDING = /\.(jpe?g|png|heic|heif|webp|tiff?)$/i;
const SCAN = /\.(las|laz)$/i;

export function doelVan(b: Pick<DossierBijlage, "code" | "naam" | "mime">): BijlageDoel | null {
  if (b.code === "D4" || SCAN.test(b.naam)) return "laz";
  if (b.mime.startsWith("image/") || AFBEELDING.test(b.naam)) return "foto's";
  return null;
}

/**
 * Een bestandsnaam die in de doelmap nog vrij is.
 *
 * ClickUp noemt foto's van een telefoon vaak gewoon "image.jpg"; twintig keer
 * dezelfde naam zou in Dropbox negentien keer overschrijven of hernoemen. Dan
 * krijgt de tweede "image (2).jpg", enzovoort. `bezet` bevat kleine letters.
 */
export function vrijeNaam(naam: string, bezet: Set<string>): string {
  const schoon = naam.replace(/[\\/:*?"<>|]/g, "_").trim() || "bijlage";
  if (!bezet.has(schoon.toLowerCase())) return schoon;
  const punt = schoon.lastIndexOf(".");
  const stam = punt > 0 ? schoon.slice(0, punt) : schoon;
  const ext = punt > 0 ? schoon.slice(punt) : "";
  for (let i = 2; ; i++) {
    const kandidaat = `${stam} (${i})${ext}`;
    if (!bezet.has(kandidaat.toLowerCase())) return kandidaat;
  }
}
