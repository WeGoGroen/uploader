import type { AddressDetails } from "@/lib/pdok";

/**
 * Bewaart waar je in een media-opname gebleven was: het adres, de
 * Dropbox-map en de stap. De uploadwachtrij overleeft navigeren al (die leeft
 * buiten React), maar het adres en de map stonden alleen in het geheugen van
 * de pagina — dus na wegklikken moest je het adres opnieuw opzoeken voordat
 * je zag waar je uploads heen gingen.
 *
 * localStorage en geen server: dit hoort bij dit apparaat, net als de
 * uploadwachtrij zelf, en het moet zonder netwerk terug te lezen zijn.
 */
const SLEUTEL = "wgg-media-sessies";
/** Ouder dan dit ruimen we op; dan is de opname allang op een andere manier afgerond. */
const MAX_LEEFTIJD_MS = 7 * 24 * 60 * 60 * 1000;

export interface MediaSessie {
  /** Dropbox-projectmap; tegelijk de sleutel, want die is uniek per adres. */
  folderPath: string;
  folderUrl: string;
  subfolders: string[];
  address: AddressDetails;
  /** Laatste stap waar je stond ("photos" | "video" | "360"). */
  stap: string;
  bijgewerkt: number;
}

function lees(): MediaSessie[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const ruw = localStorage.getItem(SLEUTEL);
    if (!ruw) return [];
    const alle = JSON.parse(ruw) as MediaSessie[];
    const grens = Date.now() - MAX_LEEFTIJD_MS;
    return alle.filter((s) => s && s.folderPath && s.bijgewerkt > grens);
  } catch {
    // Kapotte of volle opslag mag de pagina nooit blokkeren.
    return [];
  }
}

function schrijf(sessies: MediaSessie[]): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(SLEUTEL, JSON.stringify(sessies));
  } catch {
    // Privémodus of vol: dan werkt de app door, alleen zonder hervatten.
  }
}

export function alleMediaSessies(): MediaSessie[] {
  return lees().sort((a, b) => b.bijgewerkt - a.bijgewerkt);
}

export function mediaSessie(folderPath: string): MediaSessie | null {
  return lees().find((s) => s.folderPath === folderPath) ?? null;
}

export function bewaarMediaSessie(sessie: Omit<MediaSessie, "bijgewerkt">): void {
  const rest = lees().filter((s) => s.folderPath !== sessie.folderPath);
  schrijf([...rest, { ...sessie, bijgewerkt: Date.now() }]);
}

export function vergeetMediaSessie(folderPath: string): void {
  schrijf(lees().filter((s) => s.folderPath !== folderPath));
}
