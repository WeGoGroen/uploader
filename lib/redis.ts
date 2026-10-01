import Redis from "ioredis";

// Namen waaronder een Redis-connectiestring terecht kan komen. De Vercel
// Marketplace-integratie noemt de var meestal REDIS_URL of KV_URL, maar als
// er bij het koppelen per ongeluk een "prefix" is ingevuld, plakt Vercel die
// ervoor (bv. "KV_REST_API_URL_REDIS_URL"). Om niet afhankelijk te zijn van
// dat exacte prefix zoeken we naar elke env var die op "_REDIS_URL" of
// "REDIS_URL" eindigt, naast de bekende standaardnamen.
const KNOWN_NAMES = ["REDIS_URL", "KV_URL"];

function findConnectionString(): string | null {
  for (const name of KNOWN_NAMES) {
    if (process.env[name]) return process.env[name] as string;
  }
  const fallback = Object.keys(process.env).find(
    (key) => key.endsWith("_REDIS_URL") || key.endsWith("REDIS_URL")
  );
  return fallback ? (process.env[fallback] as string) : null;
}

let cached: Redis | null | undefined;

export function getOptionalRedis(): Redis | null {
  if (cached !== undefined) return cached;
  const url = findConnectionString();
  cached = url ? new Redis(url, { maxRetriesPerRequest: 2 }) : null;
  return cached;
}

export function requireRedis(): Redis {
  const redis = getOptionalRedis();
  if (!redis) {
    throw new Error(
      "Geen Redis-opslag gekoppeld. Voeg een Redis-store toe via Vercel → Storage en koppel die aan dit project."
    );
  }
  return redis;
}

/**
 * Voert `doe` uit terwijl niemand anders dezelfde sleutel wijzigt.
 *
 * Voor lijsten die als één JSON-waarde in Redis staan (de accounts, de
 * uitgezette koppelingen). Die worden gelezen, aangepast en teruggeschreven;
 * twee wijzigingen tegelijk, bijvoorbeeld je code en je foto, lazen allebei
 * de oude lijst en de laatste schrijver won: de andere wijziging was weg.
 *
 * Een eenvoudig slot met SET NX en een verlooptijd, zodat een afgebroken
 * aanroep het slot niet voor altijd vasthoudt. Lukt het niet binnen een paar
 * seconden, dan een fout in plaats van toch te schrijven.
 */
export async function metSlot<T>(redis: Redis, sleutel: string, doe: () => Promise<T>): Promise<T> {
  const slot = `${sleutel}:slot`;
  const eigenaar = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  for (let poging = 0; ; poging++) {
    const gekregen = await redis.set(slot, eigenaar, "PX", 10_000, "NX");
    if (gekregen === "OK") break;
    if (poging >= 50) throw new Error("Iemand anders wijzigt dit net; probeer het zo nog eens.");
    await new Promise((r) => setTimeout(r, 100));
  }
  try {
    return await doe();
  } finally {
    // Alleen het eigen slot vrijgeven; is het intussen verlopen en door een
    // ander gepakt, dan blijft dat staan.
    await redis
      .eval(
        'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
        1,
        slot,
        eigenaar
      )
      .catch(() => {});
  }
}
