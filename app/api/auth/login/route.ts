import { NextResponse } from "next/server";
import { SESSION_COOKIE, SESSION_MAX_AGE_SECONDS, authConfig, maakSessie } from "@/lib/auth";
import { controleerCode } from "@/lib/personeel";
import { getOptionalRedis } from "@/lib/redis";

/**
 * Inloggen met je eigen naam en code.
 *
 * Hiervóór was er één gedeelde code voor iedereen; wie je was koos je daarna
 * zelf op de gebruikerspagina. Handig in het veld, maar het betekende dat de
 * app niet wist wie er werkte — en dat elke opnemer met één klik onder de naam
 * van een collega kon uploaden. Nu hoort de naam bij de inlog.
 *
 * De pogingslimiet blijft per IP en niet per account: op kantoor delen alle
 * iPads één IP, en een limiet per account zou juist een gerichte plaagactie
 * mogelijk maken (twintig foute pogingen op een collega en die staat buiten).
 */
const MAX_ATTEMPTS = 20;
const WINDOW_SECONDS = 15 * 60;

function clientIp(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for");
  return fwd?.split(",")[0].trim() || request.headers.get("x-real-ip") || "onbekend";
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { naam?: string; code?: string };
  const naam = body.naam?.trim() ?? "";
  const code = body.code ?? "";
  const { secret } = authConfig();

  if (!naam || !/^[0-9]{4}$/.test(code)) {
    return NextResponse.json({ error: "Kies je naam en vul vier cijfers in." }, { status: 400 });
  }

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

  const { ok, persoon } = await controleerCode(naam, code);
  if (!ok || !persoon) {
    if (redis) {
      await redis
        .multi()
        .incr(key)
        .expire(key, WINDOW_SECONDS)
        .exec()
        .catch(() => {});
    }
    return NextResponse.json({ error: "Code klopt niet." }, { status: 401 });
  }

  if (redis) await redis.del(key).catch(() => {});

  const res = NextResponse.json({
    ok: true,
    naam: persoon.naam,
    rol: persoon.rol,
    codeGewijzigd: persoon.codeGewijzigd,
  });
  res.cookies.set(
    SESSION_COOKIE,
    await maakSessie(secret, {
      naam: persoon.naam,
      rol: persoon.rol,
      codeGewijzigd: persoon.codeGewijzigd,
    }),
    {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: SESSION_MAX_AGE_SECONDS,
    }
  );
  return res;
}
