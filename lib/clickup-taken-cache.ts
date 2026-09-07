import { getOptionalRedis } from "@/lib/redis";

export const CACHE_KEY = "clickup:taaknamen";
/**
 * Kort cachen. Deze lijst wordt bij élke dashboardlading opgehaald, en met
 * meerdere opnemers tegelijk zou dat bij vijf pagina's een veelvoud aan
 * ClickUp-aanroepen geven. Een paar minuten oud is ruim genoeg: het gaat om
 * "is dit adres al gedaan", niet om iets dat per seconde verandert.
 *
 * Bewust wél meteen ongeldig gemaakt zodra wíj zelf een taak aanmaken (zie
 * verversTaakCache): dat is precies het moment dat een opnemer klaar is en
 * verwacht meteen groen te zien, en drie minuten wachten voelt dan als een
 * kapotte matching terwijl het gewoon een oude cache is.
 */
export const CACHE_SECONDEN = 180;

/** Na het aanmaken van een taak: forceer een verse lijst bij de eerstvolgende dashboardlading. */
export async function verversTaakCache(): Promise<void> {
  const redis = getOptionalRedis();
  if (!redis) return;
  await redis.del(CACHE_KEY).catch(() => {});
}
