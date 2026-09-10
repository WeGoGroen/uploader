import { requireClickUpConfig, getAllTasks } from "@/lib/clickup";
import { detailProjectFolders, getSharedAccessToken as getDropboxToken, sanitizePathSegment } from "@/lib/dropbox";
import {
  getDefaultDriveId,
  getSharedAccessToken as getGraphToken,
  listPathChildren,
  requireSharePointConfig,
  resolveSiteId,
} from "@/lib/microsoft";
import { matchesPostcodeFolder, postcodeSleutel, taskToAddress } from "@/lib/sharepoint-match";
import { syncSharePointFiles, type SyncResult } from "@/lib/sharepoint-sync";

/**
 * De inhaalronde: klopt het dat élke opgeleverde map uit SharePoint (Gereed)
 * ook in een projectmap onder /Automatie Energielabels staat — en zo niet,
 * haal hem alsnog op.
 *
 * De vergelijking kan niet op mapnaam: Gereed-mappen heten naar postcode +
 * huisnummer ("58-3 1055 BW WG"), projectmappen naar straat + plaats
 * ("Sanderijnstraat 58-3, Amsterdam"). Wat wél overal gelijk is: de sync zet
 * de SharePoint-map onder zijn éigen naam ín de projectmap. Een Gereed-map
 * waarvan de naam nergens als submap voorkomt, is dus per definitie nog niet
 * overgezet. De brug terug naar een adres is de ClickUp-taak, waar beide
 * schrijfwijzen in staan (veld "A1 Adres:").
 */

export interface InhaalUitkomst {
  gereedTotaal: number;
  alAanwezig: number;
  opgehaald: { map: string; adres: string; result: Pick<SyncResult, "copied" | "skipped" | "failed" | "status"> }[];
  mislukt: { map: string; adres: string | null; fout: string }[];
  /** Gereed-mappen waar geen ClickUp-taak bij te vinden is — daar valt geen
      adres (en dus geen projectmap) bij te bepalen. Handwerk, maar nu wel
      zichtbaar handwerk. */
  zonderTaak: string[];
  /** Nog niet gedaan deze aanroep (begrensd per ronde); nog een keer aanroepen
      pakt de volgende. */
  nogTeDoen: number;
}

export async function draaiInhaalronde(maxPerRonde = 8): Promise<InhaalUitkomst> {
  const config = await requireSharePointConfig();
  const graphToken = await getGraphToken();
  const siteId = await resolveSiteId(graphToken, config.siteUrl);
  const driveId = await getDefaultDriveId(graphToken, siteId);

  const gereed = (await listPathChildren(graphToken, driveId, config.rootPath)).filter(
    (i) => i.isFolder
  );

  // Alle eerste-niveau-submapnamen die al ergens in een projectmap staan.
  // detailProjectFolders geeft ze in kleine letters (path_lower).
  const dropboxToken = await getDropboxToken();
  const { folders } = await detailProjectFolders(dropboxToken, "/Automatie Energielabels");
  const aanwezig = new Set<string>();
  for (const p of folders) {
    for (const sub of Object.keys(p.perSubmap)) {
      if (sub) aanwezig.add(sub);
    }
  }

  const missend = gereed.filter(
    (m) => !aanwezig.has(sanitizePathSegment(m.name).toLowerCase())
  );

  const uitkomst: InhaalUitkomst = {
    gereedTotaal: gereed.length,
    alAanwezig: gereed.length - missend.length,
    opgehaald: [],
    mislukt: [],
    zonderTaak: [],
    nogTeDoen: 0,
  };
  if (missend.length === 0) return uitkomst;

  // De brug: per taak het adres, en daaruit de postcode+huisnummer-sleutel
  // waarmee de Gereed-mapnaam te herkennen is.
  const { token, listId } = await requireClickUpConfig();
  const taken = await getAllTasks(token, listId);
  const perTaak = taken
    .map((t) => {
      const adres = taskToAddress(t);
      const sleutel = adres?.postcodeRegel
        ? postcodeSleutel(adres.addressLine, adres.postcodeRegel)
        : null;
      return adres && sleutel ? { adres, sleutel } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  // Over álle missende mappen lopen en stoppen na maxPerRonde echte
  // overdrachten. De eerste opzet nam telkens de eerste acht van de lijst —
  // faalden die, dan bleef elke volgende ronde op precies dezelfde acht
  // hangen en kwam de rest nooit aan de beurt.
  let gedaan = 0;
  for (const map of missend) {
    if (gedaan >= maxPerRonde) break;
    const match = perTaak.find((t) => matchesPostcodeFolder(map.name, t.sleutel));
    if (!match) {
      uitkomst.zonderTaak.push(map.name);
      continue;
    }
    gedaan++;
    try {
      const result = await syncSharePointFiles({
        kind: "energielabel",
        addressLine: match.adres.addressLine,
        woonplaats: match.adres.woonplaats,
        postcodeRegel: match.adres.postcodeRegel,
        // Archief van vóór de app: de projectmap bestond nooit, dus die mag
        // de inhaalronde — en alleen de inhaalronde — zelf aanmaken.
        maakProjectmapAan: true,
      });
      uitkomst.opgehaald.push({
        map: map.name,
        adres: `${match.adres.addressLine}, ${match.adres.woonplaats}`,
        result: {
          copied: result.copied,
          skipped: result.skipped,
          failed: result.failed,
          status: result.status,
        },
      });
    } catch (err) {
      uitkomst.mislukt.push({
        map: map.name,
        adres: `${match.adres.addressLine}, ${match.adres.woonplaats}`,
        fout: err instanceof Error ? err.message.slice(0, 300) : "onbekende fout",
      });
    }
  }

  uitkomst.nogTeDoen =
    missend.length - uitkomst.opgehaald.length - uitkomst.mislukt.length - uitkomst.zonderTaak.length;

  return uitkomst;
}
