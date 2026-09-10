import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE, authConfig, leesSessie } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** Wie er nu ingelogd is, voor het scherm. */
export async function GET() {
  const { secret } = authConfig();
  const store = await cookies();
  const sessie = await leesSessie(secret, store.get(SESSION_COOKIE)?.value);
  if (!sessie) return NextResponse.json({ ingelogd: false }, { status: 200 });
  return NextResponse.json({
    ingelogd: true,
    naam: sessie.naam,
    rol: sessie.rol,
    codeGewijzigd: sessie.codeGewijzigd,
  });
}
