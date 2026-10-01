import { parseAdresVeld } from "@/lib/sharepoint-match";
import { parseProjectFolderName } from "@/lib/projectmap-match";

/**
 * Een energielabel-projectmap aanmaken voor een opdracht die er geen heeft.
 *
 * Voor de Energielabel AI Agent in het control center. Die ziet geleverde
 * labels zonder projectmap en koppelt zelf een bestaande map als er precies één
 * is; pas als er nergens een staat, vraagt hij deze route er een te maken.
 *
 * Het gevaar is hier hetzelfde als overal waar een map ontstaat: een tweede map
 * naast de echte, met de foto's in de ene en het label in de andere. Daarom
 * kijkt deze route zelf nog een keer, en breder dan het aanmaken zelf doet:
 * ensureProjectFolder vindt een bestaande map in de automatie-map en het
 * archief, maar niet in de oude handmatige indeling per maand. Staat het adres
 * daar, dan wordt er niets aangemaakt.
 *
 * De beslissing staat hier zonder Dropbox, zodat hij na te rekenen is; de route
 * geeft de echte aanroepen mee.
 */

export interface Kandidaat {
  id: string;
  pad: string;
  herkomst: string;
}

export interface AanmaakDeps {
  zoekKandidaten: (mapnaam: string) => Promise<Kandidaat[]>;
  /** ensureProjectFolder("energielabel", …): vindt of maakt de map, met sjabloon. */
  maakMap: (woonplaats: string, straatEnNummer: string) => Promise<{ path: string; url: string } | null>;
  /** Het id van een map op pad; null als hij er (nog) niet is. */
  idVan: (pad: string) => Promise<string | null>;
}

export type AanmaakUitkomst =
  | {
      ok: true;
      pad: string;
      folder_id: string | null;
      url: string | null;
      /** De map stond er al; er is niets nieuws aangemaakt. */
      bestond: boolean;
      reden: null;
    }
  | { ok: false; pad: null; folder_id: null; reden: string; kandidaten?: Kandidaat[] };

function nee(reden: string, kandidaten?: Kandidaat[]): AanmaakUitkomst {
  return { ok: false, pad: null, folder_id: null, reden, ...(kandidaten ? { kandidaten } : {}) };
}

/**
 * Straat met huisnummer en woonplaats uit wat het control center meestuurt.
 *
 * `naam` is de mapnaam die het control center al maakte ("Straat 12, Plaats");
 * `adres` het ruwe ClickUp-adres, met postcode. De naam gaat voor: daarop zoekt
 * het control center ook naar kandidaten, dus dan praten beide kanten over
 * hetzelfde adres.
 */
export function leesAdres(
  invoer: { naam?: string; adres?: string }
): { straatEnNummer: string; woonplaats: string; mapnaam: string } | null {
  for (const bron of [invoer.naam, invoer.adres]) {
    // Regeleindes blijven staan: ClickUp zet straat en plaats op twee regels.
    const tekst = bron?.replace(/[ \t]+/g, " ").trim();
    if (!tekst) continue;
    const gelezen = parseAdresVeld(tekst);
    if (!gelezen) continue;
    const mapnaam = `${gelezen.addressLine}, ${gelezen.woonplaats}`;
    // Zonder huisnummer wordt het een map per straat; daar hoort geen opname in.
    if (!parseProjectFolderName(mapnaam)) continue;
    return { straatEnNummer: gelezen.addressLine, woonplaats: gelezen.woonplaats, mapnaam };
  }
  return null;
}

export async function maakProjectmap(
  invoer: { naam?: string; adres?: string },
  deps: AanmaakDeps
): Promise<AanmaakUitkomst> {
  const adres = leesAdres(invoer);
  if (!adres) {
    return nee("ongeldig adres: er valt geen straat met huisnummer en woonplaats uit te lezen");
  }

  /*
    Eerst kijken of er al iets staat, op alle plekken.

    Eén treffer: die is het, en die geven we terug alsof hij net gemaakt is —
    de aanroeper wil een map om te koppelen, niet per se een nieuwe. Meer dan
    één: niet kiezen. Dat is een vraag voor een mens, dezelfde regel als in het
    control center.
  */
  const kandidaten = await deps.zoekKandidaten(adres.mapnaam);
  if (kandidaten.length > 1) {
    return nee(
      `er staan al ${kandidaten.length} mappen voor ${adres.mapnaam} (${kandidaten
        .map((k) => k.herkomst)
        .join(", ")}); kies de juiste in het control center`,
      kandidaten
    );
  }
  if (kandidaten.length === 1) {
    const k = kandidaten[0];
    return { ok: true, pad: k.pad, folder_id: k.id || null, url: null, bestond: true, reden: null };
  }

  const map = await deps.maakMap(adres.woonplaats, adres.straatEnNummer);
  if (!map) return nee("Dropbox is niet gekoppeld");

  // Het id is wat het control center vastlegt; zonder kan het de map alleen
  // de volgende ronde via het zoeken terugvinden. Geen reden om te falen.
  const folderId = await deps.idVan(map.path).catch(() => null);
  return { ok: true, pad: map.path, folder_id: folderId, url: map.url, bestond: false, reden: null };
}
