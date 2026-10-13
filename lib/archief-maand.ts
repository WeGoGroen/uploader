/**
 * Binnen het archief een map per maand van afsluiten: "2026-10 Oktober".
 *
 * Jaar en maandnummer vooraan, zodat Dropbox ze op volgorde zet; de naam erbij
 * zodat je niet hoeft te rekenen. Alles wat al in het archief stond van vóór
 * deze indeling blijft er direct onder staan — beide vormen zijn geldig, en
 * alles wat een projectmap zoekt of herkent (lib/dropbox.ts, isProjectmap)
 * kijkt in allebei.
 */
const MAANDNAMEN = [
  "Januari", "Februari", "Maart", "April", "Mei", "Juni",
  "Juli", "Augustus", "September", "Oktober", "November", "December",
];
const MAANDMAP_RE = /^\d{4}-\d{2}( .*)?$/;

/** Is deze mapnaam een maandmap in het archief (en dus geen projectmap)? */
export function isMaandMap(naam: string): boolean {
  return MAANDMAP_RE.test(naam.trim());
}

/** De maandmap voor een datum, in Nederlandse tijd: "2026-10 Oktober". */
export function maandMapNaam(datum: Date = new Date()): string {
  const delen = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Amsterdam",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(datum);
  const jaar = delen.find((d) => d.type === "year")?.value ?? String(datum.getUTCFullYear());
  const maand = delen.find((d) => d.type === "month")?.value ?? "01";
  return `${jaar}-${maand} ${MAANDNAMEN[Number(maand) - 1]}`;
}
