import { sanitizePathSegment } from "@/lib/dropbox";
import { mediaBestandsnaam } from "@/lib/media-pad";

/**
 * Waar het control center omgevingsfoto's per adres neerzet.
 *
 * Een eigen hoofdmap en niet de mediaprojectmap: omgevingsfoto's horen bij een
 * adres, niet bij een opname, en ze moeten er ook kunnen staan voordat er een
 * fotograaf is geweest. Eén map per adres daaronder, en verder niets — geen
 * submappen, geen vrij pad.
 */
export const OMGEVINGSFOTO_HOOFDMAP = "Omgevingsfoto's";

/** De adresmap ("Noordermarkt 4H, Amsterdam") als één veilig padsegment, of null. */
export function omgevingsfotoAdresmap(ruw: string): string | null {
  const naam = sanitizePathSegment(ruw ?? "");
  if (naam.length < 3 || naam.length > 150) return null;
  if (naam.includes("..") || naam.startsWith(".")) return null;
  // Een adres heeft een huisnummer; zonder is het een straat, en die hoort hier niet.
  if (!/\d/.test(naam)) return null;
  return naam;
}

/** Het volledige pad voor één foto, of null als adres of bestandsnaam niet deugt. */
export function omgevingsfotoDoelPad(adresmap: string, bestandsnaam: string): string | null {
  const map = omgevingsfotoAdresmap(adresmap);
  const naam = mediaBestandsnaam(bestandsnaam);
  if (!map || !naam) return null;
  return `/${OMGEVINGSFOTO_HOOFDMAP}/${map}/${naam}`;
}
