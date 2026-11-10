/**
 * Hulpjes voor de Polycam-stap die zowel in de browser als op de server
 * draaien — los van lib/polycam.ts, dat het token nodig heeft.
 */

/**
 * "D8.1 Polycam link - Begane grond" → "Begane grond".
 * "D8.3 - Polycam link - 2e verdieping (indien aanwezig)" → "2e verdieping".
 * "D8.6Polycam link - Extra 2" → "Extra 2" (de spatie ontbreekt in ClickUp).
 */
export function verdiepingUitVeldnaam(naam: string): string {
  const zonderCode = naam.trim().replace(/^[A-Za-z]+\s*\d+(?:[.\-]\d+)*\s*[-–:]?\s*/, "");
  const zonderPolycam = zonderCode.replace(/^polycam[\s-]*link\s*[-–:]?\s*/i, "");
  const schoon = zonderPolycam.replace(/\(\s*indien aanwezig\s*\)/i, "").replace(/\s{2,}/g, " ").trim();
  return schoon || zonderCode.trim() || naam.trim();
}

/** Een bestandsnaam die Dropbox overal accepteert. */
export function veiligeBestandsnaam(tekst: string): string {
  return tekst
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

/** "Begane grond - Scan 10 nov 10-38.las" */
export function lasBestandsnaam(verdieping: string, scanNaam: string, formaat: "las" | "laz"): string {
  const basis = veiligeBestandsnaam(`${verdieping} - ${scanNaam}`) || "Polycam-scan";
  return `${basis}.${formaat}`;
}

/** De fases die de pop-up laat zien. */
export type KoppelFase = "wacht-upload" | "exporteren" | "opslaan" | "klaar" | "fout";

export interface KoppelAntwoord {
  fase: KoppelFase;
  scan: { id: string; naam: string; gemaaktOp: string | null; openbaar: boolean | null };
  /** Ingevuld zodra de scan in Polycam staat. */
  deellink: string | null;
  /** Pad in Dropbox waar de puntenwolk staat of komt te staan. */
  bestand: string | null;
  /** Terug te sturen bij de volgende vraag: lopende Dropbox-opdracht. */
  saveJobId: string | null;
  /** Terug te sturen: de LAS-export is al aangevraagd. */
  exportGestart: boolean;
  fout: string | null;
}
