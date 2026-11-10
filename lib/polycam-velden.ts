/**
 * Hulpjes voor het Polycam-blok in stap 2 van de energielabel-uploader.
 *
 * Werkt zonder Polycam-API (die zit alleen in Enterprise): de opnemer plakt
 * de deellink uit de app en kiest de geëxporteerde LAS zelf.
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

/**
 * Haalt de Polycam-link uit wat er geplakt is. De deelknop van de app geeft
 * soms een zinnetje met de link erin ("Check out my capture https://…"),
 * dus we zoeken de eerste URL en controleren die. Geeft null als het geen
 * link naar poly.cam is.
 */
export function haalPolycamLink(tekst: string): string | null {
  const kandidaten = tekst.match(/https?:\/\/[^\s<>"']+/gi) ?? [];
  for (const k of kandidaten) {
    const schoon = k.replace(/[.,;:!?)\]]+$/, "");
    let url: URL;
    try {
      url = new URL(schoon);
    } catch {
      continue;
    }
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:") continue;
    if (host !== "poly.cam" && !host.endsWith(".poly.cam")) continue;
    if (url.pathname === "/" || url.pathname === "") continue;
    return url.toString();
  }
  return null;
}

/** Een bestandsnaam die Dropbox overal accepteert. */
export function veiligeBestandsnaam(tekst: string): string {
  return tekst
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 150);
}

/**
 * "Begane grond - scan.las": de verdieping vooraan, zodat in de LAZ-map te
 * zien is welke puntenwolk bij welke verdieping hoort. Staat hij er al
 * vooraan (opnieuw gekozen), dan niet nog eens.
 */
export function lasBestandsnaam(verdieping: string, origineel: string): string {
  const naam = veiligeBestandsnaam(origineel) || "Polycam-scan.las";
  const v = veiligeBestandsnaam(verdieping);
  if (!v || naam.toLowerCase().startsWith(`${v.toLowerCase()} - `)) return naam;
  return `${v} - ${naam}`;
}

export function isPuntenwolk(naam: string): boolean {
  return /\.(las|laz)$/i.test(naam.trim());
}
