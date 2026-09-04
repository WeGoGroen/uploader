import {
  checkSaveUrlJob,
  createFolder,
  createFolders,
  getSharedAccessToken as getDropboxToken,
  findProjectFolder,
  listFilePathsRecursive,
  projectFolderPath,
  setProjectFolderStatus,
  statusFromName,
  sanitizePathSegment,
  saveUrl,
  type ProjectKind,
} from "@/lib/dropbox";
import {
  getDefaultDriveId,
  getDownloadUrl,
  getSharedAccessToken as getGraphToken,
  listFolderTree,
  requireSharePointConfig,
  resolveSiteId,
  listPathChildren,
  type DriveFile,
} from "@/lib/microsoft";
import {
  matchesAddress,
  matchesPostcodeFolder,
  parseAddressLine,
  postcodeSleutel,
} from "@/lib/sharepoint-match";

/**
 * Zodra een energielabel in ClickUp op "klaar" staat, staat de opgeleverde map
 * klaar op de SharePoint van de uitbestede partij. Die haalden we tot nu toe
 * met de hand op. Dit doet precies die handeling: zoek de map op adres, en zet
 * hem — als hele map, met dezelfde naam en indeling — in de Dropbox-projectmap
 * die bij het aanmaken van de taak al is klaargezet.
 */

/** Mapnaam voor losse bestanden die niet in een eigen SharePoint-map zitten. */
function looseFilesFolderName(): string {
  return process.env.SHAREPOINT_TARGET_SUBFOLDER || "SharePoint";
}

/** Eén map uit SharePoint, met de bestanden die erin zitten. */
interface SourceFolder {
  /** Naam zoals de map in SharePoint heet — die wordt in Dropbox overgenomen. */
  name: string;
  /** Volledige SharePoint-pad, puur voor logregels en de ClickUp-opmerking. */
  sourcePath: string;
  files: DriveFile[];
}

export interface SyncResult {
  /** Dropbox-mappen die zijn aangemaakt/gevuld. */
  targetPaths: string[];
  /** Bronmappen in SharePoint. */
  sources: string[];
  /** Bestandspaden binnen hun map, bv. "Onderbouwing/berekening.pdf". */
  copied: string[];
  /** Dropbox is er nog mee bezig toen wij stopten met wachten. Niet hetzelfde
      als gekopieerd: we weten het simpelweg nog niet. */
  pending: string[];
  /** Kleur die de projectmap heeft gekregen. */
  status: "compleet" | "bezig" | "ontbreekt";
  /** Stond er al — bewust niet opnieuw opgehaald, zodat een tweede webhook
      geen "bestand (1).pdf" oplevert. */
  skipped: string[];
  failed: { name: string; error: string }[];
}

export class SyncError extends Error {
  constructor(
    message: string,
    public code: "geen_adres" | "niets_gevonden" | "geen_projectmap"
  ) {
    super(message);
    this.name = "SyncError";
  }
}

/**
 * Zoekt in SharePoint de map(pen) die bij dit adres horen. Graph's search is
 * ruimhartig (kijkt ook in de inhoud van documenten), dus de definitieve
 * selectie doet matchesAddress — anders belandt de map van de buren in de
 * verkeerde Dropbox-map.
 */
async function findSourceFolders(
  graphToken: string,
  driveId: string,
  rootPath: string,
  addressLine: string,
  postcodeRegel: string | null
): Promise<SourceFolder[]> {
  const address = parseAddressLine(addressLine);
  if (!address) {
    throw new SyncError(`Kon geen huisnummer lezen uit "${addressLine}".`, "geen_adres");
  }

  // De mappen van MO Consultancy heten "<huisnummer> <postcode> <initialen>",
  // dus zonder straatnaam. Postcode + huisnummer is daarom de sleutel; matchen
  // op straatnaam levert daar per definitie niets op. De straatnaam-variant
  // blijft als terugval staan voor mappen die wél een straat in de naam
  // hebben — beide komen voor en het scheelt een misgelopen overdracht.
  const sleutel = postcodeRegel ? postcodeSleutel(addressLine, postcodeRegel) : null;

  const hits = await listPathChildren(graphToken, driveId, rootPath);
  const matching = hits.filter(
    (item) =>
      (sleutel && matchesPostcodeFolder(item.name, sleutel)) ||
      matchesAddress(item.name, address)
  );

  if (matching.length === 0) {
    // Niets gevonden is bijna nooit "de map is leeg" maar "hij heet anders dan
    // verwacht". Een paar voorbeelden meesturen scheelt het handmatig openen
    // van SharePoint om te zien wat er dan wél staat.
    const voorbeelden = hits.slice(0, 8).map((h) => h.name);
    throw new SyncError(
      `Niets gevonden in SharePoint voor "${addressLine}". In de map staan ${hits.length} items` +
        (voorbeelden.length ? `, bijvoorbeeld: ${voorbeelden.join(" | ")}` : " (leeg)") +
        ".",
      "niets_gevonden"
    );
  }

  const out: SourceFolder[] = [];

  // Een map op adresnaam: álles erin hoort bij dit adres, ook bestanden
  // waarvan de náám het adres niet noemt ("Definitief label.pdf"). De
  // indeling binnen die map blijft één-op-één behouden.
  for (const folder of matching.filter((m) => m.isFolder)) {
    const files = await listFolderTree(graphToken, driveId, folder.id);
    if (files.length === 0) continue;
    out.push({ name: folder.name, sourcePath: folder.path, files });
  }

  // Losse bestanden met het adres in de naam, voor het geval er een keer niet
  // per adres een map wordt aangemaakt. Die gaan samen in één eigen map.
  const looseFiles = matching
    .filter((m) => !m.isFolder)
    .map((file): DriveFile => ({ ...file, relativePath: file.name }));

  if (looseFiles.length > 0) {
    out.push({
      name: looseFilesFolderName(),
      sourcePath: looseFiles.map((f) => f.path).join(", "),
      files: looseFiles,
    });
  }

  return out;
}

/** Alle submappen die nodig zijn voor deze bestanden, ouder-eerst. */
function folderPathsFor(targetRoot: string, files: DriveFile[]): string[] {
  const dirs = new Set<string>();
  for (const file of files) {
    const segments = file.relativePath.split("/").slice(0, -1);
    let current = targetRoot;
    for (const segment of segments) {
      current = `${current}/${sanitizePathSegment(segment)}`;
      dirs.add(current);
    }
  }
  return [...dirs].sort((a, b) => a.length - b.length);
}

/**
 * Dropbox haalt het bestand zelf op bij deze URL. Krijgt hij iets anders dan
 * een volledig webadres, dan antwoordt hij met "invalid_url" — een melding die
 * niets zegt over wat er werkelijk misging. Hier vooraf controleren levert een
 * foutmelding op waar je wel iets aan hebt.
 */
function bruikbareDownloadUrl(url: string): boolean {
  try {
    return /^https?:$/.test(new URL(url).protocol);
  } catch {
    return false;
  }
}

function dropboxPath(targetRoot: string, relativePath: string): string {
  const segments = relativePath.split("/").map(sanitizePathSegment);
  return `${targetRoot}/${segments.join("/")}`;
}

export async function syncSharePointFiles(input: {
  kind: ProjectKind;
  addressLine: string;
  woonplaats: string;
  /** Regel met de postcode ("1055 BW  AMSTERDAM"). Nodig om de map te vinden:
      MO Consultancy noemt mappen naar postcode + huisnummer, niet naar straat. */
  postcodeRegel?: string | null;
}): Promise<SyncResult> {
  const config = await requireSharePointConfig();
  const graphToken = await getGraphToken();
  const siteId = await resolveSiteId(graphToken, config.siteUrl);
  const driveId = await getDefaultDriveId(graphToken, siteId);

  const folders = await findSourceFolders(
    graphToken,
    driveId,
    config.rootPath,
    input.addressLine,
    input.postcodeRegel ?? null
  );

  const dropboxToken = await getDropboxToken();

  // De projectmap van dit adres moet al bestaan. Zelf een map aanmaken is
  // bewust uitgesloten: de projectmap wordt aangemaakt bij het inplannen van
  // de opname, en als hij hier ontbreekt klopt er iets niet — een afwijkend
  // gespeld adres, of een opname die nooit via de app is aangemaakt. Dan is
  // een nieuwe map naast de bestaande het slechtste antwoord: de bestanden
  // raken verspreid over twee mappen zonder dat iemand het merkt.
  const bestaand = await findProjectFolder(
    dropboxToken,
    input.kind,
    input.woonplaats,
    input.addressLine
  ).catch(() => null);

  if (!bestaand) {
    throw new SyncError(
      `Geen bestaande projectmap gevonden voor "${input.addressLine}, ${input.woonplaats}" ` +
        `onder ${projectFolderPath(input.kind, input.woonplaats, input.addressLine)
          .split("/")
          .slice(0, 2)
          .join("/")}. ` +
        "Er is bewust niets aangemaakt. Controleer of de map onder een andere naam staat, of maak hem eerst aan.",
      "geen_projectmap"
    );
  }

  if (folders.length === 0) {
    // Niets gevonden: de map op rood, zodat je in Dropbox meteen ziet dat hier
    // nog iets moet gebeuren in plaats van dat het stilletjes uitblijft.
    await setProjectFolderStatus(
      dropboxToken,
      input.kind,
      input.woonplaats,
      input.addressLine,
      "ontbreekt"
    ).catch(() => null);
    throw new SyncError(
      `Niets gevonden in SharePoint voor "${input.addressLine}".`,
      "niets_gevonden"
    );
  }

  // Bewust GEEN oranje bolletje bij de start. Dat leek netjes ("je ziet dat
  // hij bezig is"), maar het betekende twee hernoemingen per run — en ClickUp
  // vuurt de webhook bij elke statusaanraking opnieuw af, dus een al groene
  // map ging telkens 🟢→🟠→🟢. Op Windows vecht de Dropbox-client die
  // naamswijzigingen uit met Verkenner, en dan krijgt iedereen die de map
  // open heeft "map in gebruik"-meldingen. Een run duurt bovendien minder dan
  // een minuut; het oranje was toch nauwelijks te zien. Het bolletje wordt nu
  // alleen nog aan het eind gezet, en alleen als de status echt verandert.
  const projectPath = bestaand.path;

  const result: SyncResult = {
    status: "bezig",
    targetPaths: [],
    sources: folders.map((f) => f.sourcePath),
    copied: [],
    pending: [],
    skipped: [],
    failed: [],
  };
  // Naast de job houden we bij wélk bestand het was, zodat een mislukte
  // overdracht opnieuw geprobeerd kan worden met een verse download-URL.
  interface Job {
    name: string;
    jobId: string;
    fileId: string;
    target: string;
  }
  const jobs: Job[] = [];
  const mislukt: Job[] = [];

  for (const folder of folders) {
    const targetRoot = `${projectPath}/${sanitizePathSegment(folder.name)}`;
    result.targetPaths.push(targetRoot);

    // Alleen de map uít SharePoint aanmaken, binnen de bestaande projectmap.
    // De projectmap zelf raken we niet aan.
    await createFolder(dropboxToken, targetRoot).catch(() => {});
    const subfolders = folderPathsFor(targetRoot, folder.files);
    if (subfolders.length > 0) {
      await createFolders(dropboxToken, subfolders).catch(() => {});
    }

    // Wat er al staat overslaan: save_url kent geen overschrijven en zou er
    // anders "bestand (1).pdf" naast zetten.
    const existing = new Set(
      (await listFilePathsRecursive(dropboxToken, targetRoot)).map((p) => p.toLowerCase())
    );

    for (const file of folder.files) {
      const target = dropboxPath(targetRoot, file.relativePath);
      const relativeKey = target.slice(targetRoot.length + 1).toLowerCase();
      const label = `${folder.name}/${file.relativePath}`;

      if (existing.has(relativeKey)) {
        result.skipped.push(label);
        continue;
      }
      try {
        // Bewust een verse URL ophalen in plaats van die uit de maplijst: die
        // is dan al seconden tot minuten oud, en Dropbox haalt het bestand pas
        // daarna zelf op. Bij een groot bestand (een Revit-model van honderden
        // MB's) is dat net het verschil tussen lukken en "download_failed".
        const url = await getDownloadUrl(graphToken, driveId, file.id);
        if (!bruikbareDownloadUrl(url)) {
          throw new Error(`SharePoint gaf een onbruikbare download-URL (${url.slice(0, 60)})`);
        }
        const job = await saveUrl(dropboxToken, target, url);
        if (job.done) {
          result.copied.push(label);
        } else if (job.jobId) {
          jobs.push({ name: label, jobId: job.jobId, fileId: file.id, target });
        }
        existing.add(relativeKey);
      } catch (err) {
        result.failed.push({
          name: label,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // Even wachten op de asynchrone overhevelingen, zodat de gebruiker (of de
  // ClickUp-opmerking) een echt resultaat ziet en niet "0 bestanden". Blijft
  // er iets hangen, dan telt het gewoon als gekopieerd: Dropbox maakt het
  // daarna zelf af, de download-URL is een uur geldig.
  for (let attempt = 0; attempt < 12 && jobs.length > 0; attempt++) {
    await new Promise((r) => setTimeout(r, 1000));
    for (const job of [...jobs]) {
      const status = await checkSaveUrlJob(dropboxToken, job.jobId).catch(() => null);
      if (!status || status.status === "in_progress") continue;
      jobs.splice(jobs.indexOf(job), 1);
      if (status.status === "failed") {
        mislukt.push(job);
      } else {
        result.copied.push(job.name);
      }
    }
  }
  // Wat na twaalf seconden nog loopt is níet klaar. Dat als gekopieerd tellen
  // zette de map op groen terwijl Dropbox nog bezig was — en een groen vinkje
  // dat soms liegt is erger dan geen vinkje, want dan controleert niemand het
  // meer. Deze blijven "bezig" tot een volgende ronde uitsluitsel geeft.
  result.pending.push(...jobs.map((j) => j.name));

  // Eén herkansing voor wat Dropbox niet wist op te halen. Dat gebeurt vooral
  // bij grote bestanden: tegen de tijd dat Dropbox erbij is, is de
  // download-URL van SharePoint verlopen. Een verse URL lost dat op; blijft het
  // misgaan, dan is het een echte fout en gaat de map op rood.
  for (const job of mislukt) {
    try {
      const verseUrl = await getDownloadUrl(graphToken, driveId, job.fileId);
      if (!bruikbareDownloadUrl(verseUrl)) {
        result.failed.push({
          name: job.name,
          error: `SharePoint gaf een onbruikbare download-URL (${verseUrl.slice(0, 60)})`,
        });
        continue;
      }
      const opnieuw = await saveUrl(dropboxToken, job.target, verseUrl);
      if (opnieuw.done) {
        result.copied.push(job.name);
        continue;
      }
      if (!opnieuw.jobId) {
        result.failed.push({ name: job.name, error: "tweede poging gaf geen resultaat" });
        continue;
      }
      let klaar = false;
      for (let attempt = 0; attempt < 20 && !klaar; attempt++) {
        await new Promise((r) => setTimeout(r, 1500));
        const status = await checkSaveUrlJob(dropboxToken, opnieuw.jobId).catch(() => null);
        if (!status || status.status === "in_progress") continue;
        klaar = true;
        if (status.status === "failed") {
          result.failed.push({ name: job.name, error: status.error ?? "onbekende fout" });
        } else {
          result.copied.push(job.name);
        }
      }
      // Nog steeds bezig na een halve minuut: Dropbox maakt het waarschijnlijk
      // zelf af, maar zeker weten doen we het niet. Dus "bezig", geen groen.
      if (!klaar) result.pending.push(job.name);
    } catch (err) {
      result.failed.push({
        name: job.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Het bolletje voor de mapnaam verandert nog tijdens deze functie (oranje
  // tijdens het overzetten, groen of rood erna). In de melding op de taak zou
  // het pad dan het oranje bolletje van halverwege tonen — verwarrend, want
  // dat is niet meer waar. Daarom zonder bolletje rapporteren.
  result.targetPaths = result.targetPaths.map((pad) =>
    pad
      .split("/")
      .map((segment) => segment.replace(/^(?:🟢|🟠|🔴)\s*/, ""))
      .join("/")
  );

  // Groen alleen als het écht af is. Een mislukking wint van alles: half
  // overgezet is erger dan zichtbaar niet overgezet. Daarna telt "nog bezig"
  // zwaarder dan "klaar" — zolang er iets loopt is de uitkomst nog onbekend,
  // en dan hoort er geen vinkje te staan.
  result.status =
    result.failed.length > 0
      ? "ontbreekt"
      : result.pending.length > 0
        ? "bezig"
        : result.copied.length + result.skipped.length > 0
          ? "compleet"
          : "ontbreekt";

  // Alleen hernoemen als het bolletje echt verandert. Een map die al groen is
  // en groen blijft wordt niet aangeraakt — dat is het verschil tussen één
  // naamswijziging per statusovergang en een gestage stroom waar de
  // Windows-client van in de knoop raakt.
  if (statusFromName(bestaand.name) !== result.status) {
    await setProjectFolderStatus(
      dropboxToken,
      input.kind,
      input.woonplaats,
      input.addressLine,
      result.status
    ).catch(() => null);
  }

  return result;
}
