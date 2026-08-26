/**
 * Wat er van elke scancontrole bewaard blijft.
 *
 * Tot nu toe verdween een oordeel zodra de opnemer de pop-up sloot. Daarmee
 * verdween ook elke kans om ooit te weten óf het oordeel klopte: een scan die
 * je niet vastlegt is een label dat je nooit meer krijgt. Dit bestand is dus
 * niet zomaar logging — het is de dataset waar het beslismodel later op gefit
 * wordt, en waar de evaluatieset uit komt.
 *
 * Vandaar drie keuzes die nu overdreven lijken en dat later niet zijn:
 *
 *  - de meetwaarden gaan mee, niet alleen het eindoordeel. Op een oordeel valt
 *    niets te fitten; op de vector wel.
 *  - het versienummer gaat mee, zodat een oud oordeel te plaatsen blijft als de
 *    drempels sindsdien zijn verschoven.
 *  - het `label`-veld bestaat al voordat er iets is dat het invult. De vorm van
 *    opgeslagen JSON later veranderen is duurder dan hem nu goed zetten.
 */

import type { CheckStatus } from "@/lib/dp-checks";
import { getOptionalRedis } from "@/lib/redis";
import type { ScanFeatures } from "@/lib/scan-features";

const REC = (id: string) => `scan:rec:${id}`;
const INDEX = "scan:idx";
const BY_ORDER = (orderId: number) => `scan:order:${orderId}`;

/** Hoeveel scans de index bijhoudt. Ruim boven wat we ooit nodig hebben. */
const MAX_INDEX = 5000;

export interface ScanCheckResult {
  id: string;
  status: CheckStatus;
  toelichting: string;
}

/**
 * Het uiteindelijke oordeel over een scan, zoals iemand het naderhand
 * vaststelt. Dit is de waarheid waar het model tegen geijkt wordt — niet wat
 * de checker er destijds van vond.
 */
export interface ScanLabel {
  uitkomst: "goed" | "fout";
  /** Waar het label vandaan komt: handmatig of afgeleid uit Mediatask. */
  bron: "mens" | "mediatask";
  door?: string;
  reden?: string;
  at: string;
}

export interface ScanRecord {
  id: string;
  /** Versie van de meet- en beoordelingslaag die dit oordeel produceerde. */
  version: string;
  at: string;
  fileName: string;
  fileSize: number | null;
  address: string | null;
  /** Ingevuld zodra de scan aan een Mediatask-order hangt. */
  orderId: number | null;
  features: ScanFeatures;
  results: ScanCheckResult[];
  /** Het oordeel van de deterministische laag. */
  verdict: CheckStatus;
  /** Wat het model van de plattegronden vond, als het gedraaid heeft. */
  llmVerdict: CheckStatus | null;
  label: ScanLabel | null;
}

/**
 * Opslaan mag nooit een controle laten mislukken.
 *
 * De opnemer staat op locatie te wachten om te kunnen uploaden; dat die niet
 * verder kan omdat een schrijfactie naar Redis hapert is een veel groter
 * probleem dan een ontbrekend record. Alles hier slikt zijn fouten en meldt ze
 * in de log.
 */
export async function saveScanRecord(rec: ScanRecord): Promise<boolean> {
  const redis = getOptionalRedis();
  if (!redis) return false;
  try {
    await redis.set(REC(rec.id), JSON.stringify(rec));
    await redis.zadd(INDEX, Date.parse(rec.at), rec.id);
    // Oudste eruit, zodat de index niet ongemerkt blijft groeien. De records
    // zelf blijven staan: die zijn klein en het zijn labels.
    await redis.zremrangebyrank(INDEX, 0, -MAX_INDEX - 1);
    return true;
  } catch (err) {
    console.error("Scanrecord opslaan mislukt", err);
    return false;
  }
}

export async function getScanRecord(id: string): Promise<ScanRecord | null> {
  const redis = getOptionalRedis();
  if (!redis) return null;
  try {
    const raw = await redis.get(REC(id));
    return raw ? (JSON.parse(raw) as ScanRecord) : null;
  } catch (err) {
    console.error("Scanrecord lezen mislukt", err);
    return null;
  }
}

/** De nieuwste scans eerst. */
export async function listScanRecords(limit = 100): Promise<ScanRecord[]> {
  const redis = getOptionalRedis();
  if (!redis) return [];
  try {
    const ids = await redis.zrevrange(INDEX, 0, limit - 1);
    if (ids.length === 0) return [];
    const rauw = await redis.mget(...ids.map(REC));
    return rauw.filter((r): r is string => r !== null).map((r) => JSON.parse(r) as ScanRecord);
  } catch (err) {
    console.error("Scanrecords lezen mislukt", err);
    return [];
  }
}

/**
 * Koppelt een bewaarde controle aan de order die er uiteindelijk uit kwam.
 *
 * Dat is de brug naar de labels: zonder ordernummer is een rework van Mediatask
 * niet terug te leiden naar de scan die hem veroorzaakte.
 */
export async function linkScanToOrder(id: string, orderId: number): Promise<ScanRecord | null> {
  const redis = getOptionalRedis();
  if (!redis) return null;
  const rec = await getScanRecord(id);
  if (!rec) return null;
  rec.orderId = orderId;
  try {
    await redis.set(REC(id), JSON.stringify(rec));
    await redis.set(BY_ORDER(orderId), id);
    return rec;
  } catch (err) {
    console.error("Scanrecord koppelen mislukt", err);
    return null;
  }
}

export async function getScanRecordByOrder(orderId: number): Promise<ScanRecord | null> {
  const redis = getOptionalRedis();
  if (!redis) return null;
  try {
    const id = await redis.get(BY_ORDER(orderId));
    return id ? getScanRecord(id) : null;
  } catch (err) {
    console.error("Scanrecord bij order zoeken mislukt", err);
    return null;
  }
}

/**
 * Het oordeel in gewone taal, voor als comment onder de Mediatask-order.
 *
 * De operator daar ziet nu alleen een bestand. Krijgt hij erbij te lezen wat de
 * controle vond en op welke getallen, dan wordt zijn eventuele afkeuring veel
 * specifieker — en juist die specifieke reden is straks het label waar dit
 * systeem van leert.
 */
export function samenvatting(rec: ScanRecord): string {
  const kop = `AI-scancontrole (${rec.version}): ${rec.verdict}`;
  const opvallend = rec.results
    .filter((r) => r.status !== "ok")
    .map((r) => `• ${r.id}: ${r.toelichting}`);
  const cijfers = [
    rec.features.wallDeviationDeg !== null &&
      `muurafwijking ${rec.features.wallDeviationDeg.toFixed(1)}°`,
    `ruis ${(rec.features.noiseShare * 100).toFixed(1)}%`,
    `${rec.features.floorCount} hoogtelagen`,
    `${Math.round(rec.features.pointsPerM2)} punten/m²`,
  ].filter((x): x is string => typeof x === "string");

  return [kop, "", ...(opvallend.length ? opvallend : ["• geen bijzonderheden"]), "", cijfers.join(" · ")].join(
    "\n"
  );
}
