import { requireRedis } from "@/lib/redis";

export type DraftStatus = "concept" | "uploaded";

/**
 * Welke soort opname dit is. Nodig om een herinnering te kunnen sturen die
 * zegt wát er blijft liggen, en om de opnemer naar de juiste pagina te
 * kunnen terugsturen.
 */
export type DraftSoort = "energielabel" | "nen" | "media";

/**
 * De samenvatting van een opname: alles wat een lijst nodig heeft, zonder de
 * formulierstaat. Dat onderscheid is de kern van deze module — zie de uitleg
 * bij OPSLAG hieronder.
 */
export interface DraftSamenvatting {
  id: string;
  status: DraftStatus;
  titel: string;
  straatnaam: string;
  postcode: string;
  woonplaats: string;
  accountName: string | null;
  /** Ontbreekt bij oude records; die zijn altijd energielabel geweest. */
  soort?: DraftSoort;
  clickupTaskUrl: string | null;
  /**
   * Documentcategorieën die níet naar ClickUp overgezet konden worden. De taak
   * bestaat dan wel, maar de bijlages ontbreken — zo'n opname mag niet als
   * afgerond gepresenteerd worden, want er is nog werk aan.
   */
  incompleteDocs?: string[];
  /**
   * Hieronder staat wat vroeger uit de formulierstaat werd afgeleid tijdens
   * het renderen van een lijst. Dat kan niet meer — lijsten dragen die staat
   * bewust niet meer mee — dus wordt het één keer bij opslaan vastgelegd.
   * Meteen goedkoper: het dashboard rekende dit bij élke hertekening opnieuw uit.
   */
  /** Is er een Mediatask-order voor deze opname? */
  heeftMediatask?: boolean;
  /** A2 "Opnemende adviseur"; kan afwijken van de ingelogde gebruiker. */
  adviseur?: string | null;
  /** Codes van verplichte velden die nog leeg zijn ("A7", "B2", …). */
  ontbrekendeVelden?: string[];
  updatedAt: number;
  createdAt: number;
}

export interface DraftRecord extends DraftSamenvatting {
  // Volledige staat van het formulier, zodat een concept later hervat kan
  // worden precies waar de opnemer gebleven was.
  state: Record<string, unknown>;
}

/**
 * OPSLAG
 *
 * Eerder stond alles in één sleutel per opname plus één grote SET met alle
 * id's. Elke lijstweergave las daardoor élke opname die ooit gemaakt was —
 * inclusief de volledige formulierstaat van ~44 velden. Bij 1000 opnames per
 * maand is dat na een jaar tientallen megabytes per paginabezoek, en dat
 * degradeert niet geleidelijk: het voelt maanden prima en wordt dan binnen
 * weken onwerkbaar.
 *
 * Nu drie soorten sleutels:
 *  - `draft:<id>`      de volledige opname (alleen gelezen bij hervatten)
 *  - `draft:kort:<id>` de samenvatting (wat lijsten nodig hebben)
 *  - `drafts:z:<status>` een gesorteerde index op tijd, per status
 *
 * Een lijst leest dus alleen de index van de gevraagde status, beperkt tot
 * het aantal dat hij toont, en haalt daar alleen samenvattingen bij op.
 */
const KEY = (id: string) => `draft:${id}`;
const KORT = (id: string) => `draft:kort:${id}`;
const Z = (status: DraftStatus) => `drafts:z:${status}`;
const OUDE_INDEX = "drafts:index";
const MIGRATIE_VLAG = "drafts:gemigreerd";

/** Standaard aantal dat een lijst teruggeeft; ruim boven wat een scherm toont. */
export const LIJST_LIMIET = 200;

function samenvattingVan(record: DraftRecord): DraftSamenvatting {
  // Bewust veld voor veld: een spread zou `state` meenemen en dan is het
  // onderscheid tussen samenvatting en volledige opname meteen weer weg.
  return {
    id: record.id,
    status: record.status,
    titel: record.titel,
    straatnaam: record.straatnaam,
    postcode: record.postcode,
    woonplaats: record.woonplaats,
    accountName: record.accountName,
    soort: record.soort,
    clickupTaskUrl: record.clickupTaskUrl,
    incompleteDocs: record.incompleteDocs,
    heeftMediatask: record.heeftMediatask,
    adviseur: record.adviseur,
    ontbrekendeVelden: record.ontbrekendeVelden,
    updatedAt: record.updatedAt,
    createdAt: record.createdAt,
  };
}

/**
 * Zet bestaande opnames één keer om naar de nieuwe indeling. Draait bij de
 * eerste lijstweergave na de uitrol; daarna zorgt de vlag dat het niet nog
 * eens gebeurt. Zonder dit zouden alle bestaande opnames uit beeld
 * verdwijnen — die staan alleen in de oude SET.
 */
async function migreerIndienNodig(): Promise<void> {
  const redis = requireRedis();
  if (await redis.get(MIGRATIE_VLAG)) return;

  const ids = await redis.smembers(OUDE_INDEX);
  if (ids.length > 0) {
    // In blokken, zodat één MGET niet alsnog alles tegelijk ophaalt.
    for (let i = 0; i < ids.length; i += 100) {
      const blok = ids.slice(i, i + 100);
      const ruw = await redis.mget(blok.map(KEY));
      const pipe = redis.pipeline();
      for (const r of ruw) {
        if (!r) continue;
        try {
          const record = JSON.parse(r) as DraftRecord;
          pipe.set(KORT(record.id), JSON.stringify(samenvattingVan(record)));
          pipe.zadd(Z(record.status), record.updatedAt, record.id);
        } catch {
          // Onleesbaar record: overslaan i.p.v. de hele migratie laten klappen.
        }
      }
      await pipe.exec();
    }
  }
  await redis.set(MIGRATIE_VLAG, String(Date.now()));
}

/**
 * De opnames van één status, nieuwste eerst. `limiet` begrenst wat er over de
 * lijn gaat — een lijst die alles ophaalt is precies wat we hier kwijt wilden.
 */
export async function listDraftsByStatus(
  status: DraftStatus,
  limiet = LIJST_LIMIET
): Promise<DraftSamenvatting[]> {
  const redis = requireRedis();
  await migreerIndienNodig();

  const ids = await redis.zrevrange(Z(status), 0, limiet - 1);
  if (!ids.length) return [];

  const ruw = await redis.mget(ids.map(KORT));

  // Een id in de index zonder samenvatting (verlopen, handmatig opgeruimd)
  // blijft anders eeuwig meegelezen worden.
  const dood = ids.filter((_, i) => ruw[i] === null);
  if (dood.length) void redis.zrem(Z(status), ...dood).catch(() => {});

  return ruw
    .filter((r): r is string => r !== null)
    .map((r) => JSON.parse(r) as DraftSamenvatting);
}

/** Alle openstaande en afgeronde opnames samen — voor lijsten die beide tonen. */
export async function listDrafts(limiet = LIJST_LIMIET): Promise<DraftSamenvatting[]> {
  const [concepten, geupload] = await Promise.all([
    listDraftsByStatus("concept", limiet),
    listDraftsByStatus("uploaded", limiet),
  ]);
  return [...concepten, ...geupload].sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getDraft(id: string): Promise<DraftRecord | null> {
  const redis = requireRedis();
  const raw = await redis.get(KEY(id));
  return raw ? (JSON.parse(raw) as DraftRecord) : null;
}

export async function saveDraft(record: DraftRecord): Promise<void> {
  const redis = requireRedis();
  const anders: DraftStatus = record.status === "concept" ? "uploaded" : "concept";
  await redis
    .pipeline()
    .set(KEY(record.id), JSON.stringify(record))
    .set(KORT(record.id), JSON.stringify(samenvattingVan(record)))
    .zadd(Z(record.status), record.updatedAt, record.id)
    // Van status gewisseld: uit de andere index halen, anders staat dezelfde
    // opname in allebei en telt hij dubbel.
    .zrem(Z(anders), record.id)
    .exec();
}

export async function deleteDraft(id: string): Promise<void> {
  const redis = requireRedis();
  await redis
    .pipeline()
    .del(KEY(id))
    .del(KORT(id))
    .zrem(Z("concept"), id)
    .zrem(Z("uploaded"), id)
    .exec();
}

/**
 * Ruimt afgeronde opnames op die ouder zijn dan `dagen`. De formulierstaat en
 * de samenvatting gaan weg, de opname verdwijnt uit de index.
 *
 * Alleen afgeronde: een concept dat lang stilligt is werk dat nog moet
 * gebeuren, en dat mag nooit stilletjes verdampen.
 */
export async function archiveerOudeOpnames(dagen = 90): Promise<number> {
  const redis = requireRedis();
  const grens = Date.now() - dagen * 24 * 60 * 60 * 1000;
  const ids = await redis.zrangebyscore(Z("uploaded"), 0, grens);
  if (!ids.length) return 0;

  const pipe = redis.pipeline();
  for (const id of ids) {
    pipe.del(KEY(id));
    pipe.del(KORT(id));
  }
  pipe.zremrangebyscore(Z("uploaded"), 0, grens);
  await pipe.exec();
  return ids.length;
}

/** Hoeveel opnames er per status in de index staan — voor de cijferpagina. */
export async function telOpnames(): Promise<{ concept: number; uploaded: number }> {
  const redis = requireRedis();
  await migreerIndienNodig();
  const [concept, uploaded] = await Promise.all([
    redis.zcard(Z("concept")),
    redis.zcard(Z("uploaded")),
  ]);
  return { concept, uploaded };
}
