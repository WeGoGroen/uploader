import { NextResponse } from "next/server";
import { SESSION_COOKIE, SESSION_MAX_AGE_SECONDS, authConfig, createSessionValue } from "@/lib/auth";
import { getOptionalRedis } from "@/lib/redis";

/**
 * Pogingslimiet per IP. Met een korte cijfercode zijn er weinig
 * mogelijkheden, dus zonder deze rem is de code in een paar minuten door te
 * proberen; met deze rem duurt de hele reeks van 10.000 codes ruim een week.
 *
 * Bewust ruim genomen: op kantoor delen alle iPads één IP-adres, dus een paar
 * collega's die zich vertypen mogen samen niet het hele team buitensluiten.
 */
const MAX_ATTEMPTS = 20;
const WINDOW_SECONDS = 15 * 60;

function clientIp(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for");
  return fwd?.split(",")[0].trim() || request.headers.get("x-real-ip") || "onbekend";
}

export async function POST(request: Request) {
  const { password: given } = (await request.json().catch(() => ({}))) as { password?: string };
  const { password, secret } = authConfig();

  if (!password) return NextResponse.json({ error: "geen_wachtwoord_ingesteld" }, { status: 500 });

  const redis = getOptionalRedis();
  const key = `login:fail:${clientIp(request)}`;

  if (redis) {
    const attempts = Number((await redis.get(key).catch(() => null)) ?? 0);
    if (attempts >= MAX_ATTEMPTS) {
      return NextResponse.json(
        { error: "Te veel pogingen. Probeer het over een kwartier opnieuw." },
        { status: 429 }
      );
    }
  }

  if (!given || given !== password) {
    if (redis) {
      // Teller ophogen en meteen een vervaltijd zetten, zodat de blokkade
      // vanzelf weer verloopt.
      await redis
        .multi()
        .incr(key)
        .expire(key, WINDOW_SECONDS)
        .exec()
        .catch(() => {});
    }
    return NextResponse.json({ error: "Wachtwoord klopt niet." }, { status: 401 });
  }

  if (redis) await redis.del(key).catch(() => {});

  const expiresAt = Date.now() + SESSION_MAX_AGE_SECONDS * 1000;
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, await createSessionValue(secret, expiresAt), {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
  return res;
}
