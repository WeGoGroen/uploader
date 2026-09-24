import { MEDIA_STAPPEN, type MediaStap } from "@/lib/media-folders";

/**
 * Wat er per stap van een media-opname werkelijk in Dropbox staat.
 *
 * Waarom apart van de uploadwachtrij: die weet alleen wat er vanaf dít apparaat
 * via de uploader omhoog ging. Bestanden die via de Dropbox-app gaan — die
 * uploadt op de achtergrond door, ook met het scherm uit, en dat kan een
 * webpagina op een iPad niet — ziet de wachtrij nooit. Dan zou de opname "leeg"
 * lijken terwijl de map vol staat. Dropbox zelf is de enige bron die het hele
 * verhaal kent.
 */

export interface StapInhoud {
  aantal: number;
  bytes: number;
  /** Wanneer het laatste bestand binnenkwam (ISO), of null zolang er niets is. */
  laatste: string | null;
}

/**
 * Waar een stap vóór de mappenwissel heen schreef.
 *
 * Tot de indeling "In/Raw/…" werd, stond alles direct onder "in/": "in/Photo's",
 * "in/Video", "in/360". Opnames van vóór die wissel hebben hun bestanden daar
 * nog. Zonder deze tweede plek zou zo'n opname nul foto's tonen terwijl er
 * honderd staan — precies de verwarring die dit moet wegnemen.
 */
export function oudeMap(map: string): string | null {
  const m = /^in\/raw\/(.+)$/i.exec(map);
  return m ? `in/${m[1]}` : null;
}

/**
 * Telt per stap de bestanden, hun omvang en het laatste binnenkomen.
 *
 * Hoofdletterongevoelig, want Dropbox is dat ook: "in" en "In" zijn voor
 * Dropbox dezelfde map, en een opname van vóór de wissel heeft "in" gehouden.
 * Ook wat in een submap van een stap staat telt mee — wie een hele map foto's
 * in "Photo's" zet, heeft die foto's wel degelijk aangeleverd.
 */
export function telPerStap(
  bestanden: { pad: string; grootte: number; gewijzigd?: string | null }[],
  stappen: MediaStap[] = MEDIA_STAPPEN
): Record<MediaStap["key"], StapInhoud> {
  const uitkomst = {} as Record<MediaStap["key"], StapInhoud>;
  for (const stap of stappen) {
    const plekken = [stap.map, oudeMap(stap.map)]
      .filter((p): p is string => !!p)
      .map((p) => `${p.toLowerCase()}/`);
    const telling: StapInhoud = { aantal: 0, bytes: 0, laatste: null };
    for (const b of bestanden) {
      const pad = b.pad.toLowerCase();
      if (!plekken.some((p) => pad.startsWith(p))) continue;
      telling.aantal++;
      telling.bytes += b.grootte;
      if (b.gewijzigd && (!telling.laatste || b.gewijzigd > telling.laatste)) {
        telling.laatste = b.gewijzigd;
      }
    }
    uitkomst[stap.key] = telling;
  }
  return uitkomst;
}

/**
 * De link naar een map op dropbox.com — en op een iPad met de Dropbox-app
 * opent die link de map in de app, waar uploaden op de achtergrond doorloopt.
 *
 * Per padstuk gecodeerd en niet in één keer: de schuine strepen moeten blijven
 * staan, maar een komma of spatie in een adres ("Damrak 1, Amsterdam") niet.
 */
export function dropboxWebUrl(thuispad: string, pad: string): string {
  const stukken = `${thuispad}/${pad}`.split("/").filter(Boolean).map(encodeURIComponent);
  return `https://www.dropbox.com/home/${stukken.join("/")}`;
}

/** "4,55 GB", "812 MB", "96 kB" — op het scherm, niet voor berekeningen. */
export function leesbareOmvang(bytes: number): string {
  const eenheden = ["B", "kB", "MB", "GB", "TB"];
  let waarde = bytes;
  let i = 0;
  while (waarde >= 1024 && i < eenheden.length - 1) {
    waarde /= 1024;
    i++;
  }
  const cijfers = i === 0 || waarde >= 100 ? 0 : waarde >= 10 ? 1 : 2;
  return `${waarde.toFixed(cijfers).replace(".", ",")} ${eenheden[i]}`;
}
