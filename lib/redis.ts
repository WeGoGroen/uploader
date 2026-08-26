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
