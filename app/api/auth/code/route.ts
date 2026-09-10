import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE, SESSION_MAX_AGE_SECONDS, authConfig, leesSessie, maakSessie } from "@/lib/auth";
import { controleerCode, haalPersoon, zetCode } from "@/lib/personeel";

/**
 * Je eigen code wijzigen.
 *
 * Altijd met de huidige code erbij: op een gedeelde iPad die nog openstaat zou
 * anders iemand anders jouw code kunnen omzetten en jou buitensluiten.
 */
export async function POST(request: Request) {
  const { secret } = authConfig();
  const store = await cookies();
  const sessie = await leesSessie(secret, store.get(SESSION_COOKIE)?.value);
  if (!sessie) return NextResponse.json({ error: "niet_ingelogd" }, { status: 401 });

  const body = (await request.json().catch(() => null)) as { huidig?: string; nieuw?: string } | null;
  const huidig = body?.huidig ?? "";
  const nieuw = body?.nieuw ?? "";

  if (!/^[0-9]{4}$/.test(nieuw)) {
    return NextResponse.json({ error: "De nieuwe code bestaat uit vier cijfers." }, { status: 400 });
  }
  if (nieuw === "0000") {
    return NextResponse.json(
      { error: "0000 is de startcode die iedereen kent — kies iets anders." },
      { status: 400 }
    );
  }

  const { ok } = await controleerCode(sessie.naam, huidig);
  if (!ok) return NextResponse.json({ error: "Je huidige code klopt niet." }, { status: 403 });

  await zetCode(sessie.naam, nieuw);

  // De sessie weet nu nog dat je op de startcode zat; opnieuw uitgeven zodat
  // de melding "je gebruikt nog 0000" meteen weg is.
  const persoon = await haalPersoon(sessie.naam);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(
    SESSION_COOKIE,
    await maakSessie(secret, {
      naam: sessie.naam,
      rol: persoon?.rol ?? sessie.rol,
      codeGewijzigd: true,
    }),
    { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: SESSION_MAX_AGE_SECONDS }
  );
  return res;
}
