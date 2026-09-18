import { requireClickUpConfig, getAllTasks } from "@/lib/clickup";
import { getOptionalRedis } from "@/lib/redis";
import { detailProjectFolders, getSharedAccessToken as getDropboxToken, sanitizePathSegment } from "@/lib/dropbox";
import {
  getDefaultDriveId,
  getSharedAccessToken as getGraphToken,
  listPathChildren,
  requireSharePointConfig,
  resolveSiteId,
} from "@/lib/microsoft";
import {
  matchesAddress,
  matchesPostcodeFolder,
  parseAddressLine,
  postcodeSleutel,
  taskToAddress,
} from "@/lib/sharepoint-match";
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

/*
  De werklijst tussen rondes bewaren.

  Elke ronde begon met een volledige recursieve scan van /Automatie
  Energielabels plus alle ClickUp-taken ophalen. Met tientallen projectmappen
  viel dat niet op; met het archief erin (400+ mappen, duizenden bestanden)
  duurt alleen die voorbereiding al langer dan een serverless-aanroep mag
  duren — en dan haalt de ronde nul mappen op, hoe klein je de portie ook
  maakt. Eén keer bepalen wat er mist en die lijst een uur bewaren maakt elke
  volgende ronde bijna gratis.
*/
const WERKLIJST = "sharepoint:inhaal:werklijst";
const WERKLIJST_TTL = 3600;

interface Werklijst {
  gereedTotaal: number;
  alAanwezig: number;
  /** Nog te doen: naam van de Gereed-map. */
  missend: string[];
  /** Geen ClickUp-taak bij te vinden; blijft staan als eindrapport. */
  zonderTaak: string[];
}

export async function vergeetWerklijst(): Promise<void> {
  const redis = getOptionalRedis();
  if (redis) await redis.del(WERKLIJST).catch(() => {});
}

export async function draaiInhaalronde(
  maxPerRonde = 8,
  /** Alleen kijken en rapporteren, niets overzetten. Dat is de controle
      "zit alles erin?" — die hoort niets te veranderen. */
  alleenKijken = false
): Promise<InhaalUitkomst> {
  const werklijst = await bepaalWerklijst(alleenKijken);

  const uitkomst: InhaalUitkomst = {
    gereedTotaal: werklijst.gereedTotaal,
    alAanwezig: werklijst.alAanwezig,
    opgehaald: [],
    mislukt: [],
    zonderTaak: [...werklijst.zonderTaak],
    nogTeDoen: werklijst.missend.length,
  };
  if (alleenKijken || werklijst.missend.length === 0) return uitkomst;

  const { token, listId } = await requireClickUpConfig();
  const taken = await getAllTasks(token, listId);
  const perTaak = taken
    .map((t) => {
      const adres = taskToAddress(t);
      if (!adres) return null;
      const sleutel = adres.postcodeRegel
        ? postcodeSleutel(adres.addressLine, adres.postcodeRegel)
        : null;
      // Naast de postcodesleutel ook de straat+huisnummer-vorm: een deel van
      // de Gereed-mappen heet naar het volledige adres in plaats van naar
      // postcode + nummer, en zonder deze tweede weg viel dat stil af.
      const straat = parseAddressLine(adres.addressLine);
      return sleutel || straat ? { adres, sleutel, straat } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  // Over de hele lijst lopen en stoppen na maxPerRonde echte overdrachten.
  // De eerste opzet nam telkens de eerste acht — faalden die, dan bleef elke
  // volgende ronde op precies dezelfde acht hangen.
  const rest: string[] = [];
  let gedaan = 0;

  for (const naam of werklijst.missend) {
    if (gedaan >= maxPerRonde) {
      rest.push(naam);
      continue;
    }

    const match =
      perTaak.find((t) => t.sleutel && matchesPostcodeFolder(naam, t.sleutel)) ??
      perTaak.find((t) => t.straat && matchesAddress(naam, t.straat));

    if (!match) {
      // Geen adres af te leiden: van de werklijst af, maar wél in het
      // eindrapport. Anders blijft elke ronde over dezelfde mappen struikelen.
      werklijst.zonderTaak.push(naam);
      uitkomst.zonderTaak.push(naam);
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
        map: naam,
        adres: `${match.adres.addressLine}, ${match.adres.woonplaats}`,
        result: {
          copied: result.copied,
          skipped: result.skipped,
          failed: result.failed,
          status: result.status,
        },
      });
    } catch (err) {
      // Mislukt blijft op de lijst: een volgende ronde probeert het opnieuw,
      // bijvoorbeeld als SharePoint even traag was.
      rest.push(naam);
      uitkomst.mislukt.push({
        map: naam,
        adres: `${match.adres.addressLine}, ${match.adres.woonplaats}`,
        fout: err instanceof Error ? err.message.slice(0, 300) : "onbekende fout",
      });
    }
  }

  werklijst.missend = rest;
  werklijst.alAanwezig = werklijst.gereedTotaal - rest.length - werklijst.zonderTaak.length;
  await bewaarWerklijst(werklijst);

  uitkomst.nogTeDoen = rest.length;
  uitkomst.alAanwezig = werklijst.alAanwezig;
  return uitkomst;
}

/**
 * De werklijst: welke Gereed-mappen staan nog niet in een projectmap.
 *
 * Eén keer bepalen en een uur bewaren. Het bepalen kost een volledige scan
 * van /Automatie Energielabels plus de hele Gereed-map; dat elke ronde
 * opnieuw doen betekent dat het grootste deel van de beschikbare tijd opgaat
 * aan opnieuw uitrekenen wat je al wist.
 */
async function bepaalWerklijst(negeerCache: boolean): Promise<Werklijst> {
  const redis = getOptionalRedis();

  if (!negeerCache && redis) {
    const rauw = await redis.get(WERKLIJST).catch(() => null);
    if (rauw) {
      try {
        return JSON.parse(rauw) as Werklijst;
      } catch {
        // stukke JSON: gewoon opnieuw bepalen
      }
    }
  }

  const config = await requireSharePointConfig();
  const graphToken = await getGraphToken();
  const siteId = await resolveSiteId(graphToken, config.siteUrl);
  const driveId = await getDefaultDriveId(graphToken, siteId);

  const gereed = (await listPathChildren(graphToken, driveId, config.rootPath)).filter(
    (i) => i.isFolder
  );

  const dropboxToken = await getDropboxToken();
  const { folders, volledig } = await detailProjectFolders(dropboxToken, "/Automatie Energielabels");
  if (!volledig) {
    // Een afgekapte scan zou "mist nog" zeggen over mappen die er allang
    // staan, en die opnieuw gaan ophalen. Dan liever hard stoppen.
    throw new Error(
      "De Dropbox-listing van /Automatie Energielabels is niet compleet; de vergelijking zou onbetrouwbaar zijn."
    );
  }

  // De sync zet de SharePoint-map onder zijn eigen naam ín de projectmap. Een
  // Gereed-map waarvan de naam nergens als submap voorkomt, is dus nog niet
  // overgezet. detailProjectFolders geeft submapnamen in kleine letters.
  const aanwezig = new Set<string>();
  for (const p of folders) {
    for (const sub of Object.keys(p.perSubmap)) {
      if (sub) aanwezig.add(sub);
    }
  }

  const missend = gereed
    .filter((m) => !aanwezig.has(sanitizePathSegment(m.name).toLowerCase()))
    .map((m) => m.name);

  const lijst: Werklijst = {
    gereedTotaal: gereed.length,
    alAanwezig: gereed.length - missend.length,
    missend,
    zonderTaak: [],
  };
  await bewaarWerklijst(lijst);
  return lijst;
}

async function bewaarWerklijst(lijst: Werklijst): Promise<void> {
  const redis = getOptionalRedis();
  if (!redis) return;
  await redis.set(WERKLIJST, JSON.stringify(lijst), "EX", WERKLIJST_TTL).catch(() => {});
}
