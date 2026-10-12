import { NextResponse } from "next/server";
import { alleKlaarMeldingen, isKlaarDienst, meldKlaar, trekKlaarIn } from "@/lib/klaar-meldingen";

/**
 * Alle genormaliseerde straatsleutels die handmatig als klaar zijn gemeld,
 * per dienst. `straten` blijft voor oudere aanroepers: dat zijn de
 * energielabel-meldingen.
 */
export async function GET() {
  try {
    const meldingen = await alleKlaarMeldingen();
    return NextResponse.json({
      energielabel: [...meldingen.energielabel],
      nen: [...meldingen.nen],
      straten: [...meldingen.energielabel],
    });
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
 * exacte straatregel zoals die op het dashboard stond, de dienst
 * ("energielabel" of "nen", standaard energielabel) en `klaar` (standaard
 * true; false draait de melding terug).
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const street = typeof body?.street === "string" ? body.street.trim() : "";
  if (!street) {
    return NextResponse.json({ error: "Straat ontbreekt" }, { status: 400 });
  }
  const dienst = body?.dienst ?? "energielabel";
  if (!isKlaarDienst(dienst)) {
    return NextResponse.json({ error: "Onbekende dienst" }, { status: 400 });
  }
  try {
    if (body?.klaar === false) await trekKlaarIn(street, dienst);
    else await meldKlaar(street, dienst);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Melden mislukt" },
      { status: 502 }
    );
  }
}
