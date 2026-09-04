import { NextResponse } from "next/server";
import { alleKlaarMeldingen, meldKlaar } from "@/lib/klaar-meldingen";

/** Alle genormaliseerde straatsleutels die handmatig als klaar zijn gemeld. */
export async function GET() {
  try {
    const meldingen = await alleKlaarMeldingen();
    return NextResponse.json({ straten: [...meldingen] });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Ophalen mislukt" },
      { status: 502 }
    );
  }
}

/**
 * Handmatig bevestigen dat een afspraak echt klaar is, voor als de
 * automatische matching het mist (zie lib/klaar-meldingen.ts). Body: de
 * exacte straatregel zoals die op het dashboard stond.
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const street = typeof body?.street === "string" ? body.street.trim() : "";
  if (!street) {
    return NextResponse.json({ error: "Straat ontbreekt" }, { status: 400 });
  }
  try {
    await meldKlaar(street);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Melden mislukt" },
      { status: 502 }
    );
  }
}
