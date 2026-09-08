import { NextResponse } from "next/server";
import { haalUitgezet, isKoppeling, zetKoppeling } from "@/lib/koppelingen";

export const dynamic = "force-dynamic";

/** Welke koppelingen bewust uitstaan. Zit achter de gewone inlog (middleware). */
export async function GET() {
  return NextResponse.json({ uit: await haalUitgezet() });
}

/*
  Bewust voor iedereen, niet alleen voor beheerders.

  Het stond even achter de beheerdersrol, maar dat past niet bij waar deze
  schakelaar voor is: hij staat er om een koppeling die je niet gebruikt te
  laten zwijgen. Wie in het veld met een statuslijst zit die rood staat om
  ClickUp - iets waar hij niets mee doet - moet dat zelf kunnen wegnemen zonder
  eerst iemand te bellen. Er gaan ook geen gegevens mee verloren: uit betekent
  alleen dat er niet meer gemeten wordt.
*/
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { dienst?: string; uit?: boolean } | null;
  const dienst = body?.dienst ?? "";
  if (!isKoppeling(dienst)) {
    return NextResponse.json({ error: "onbekende koppeling" }, { status: 400 });
  }
  try {
    const uit = await zetKoppeling(dienst, Boolean(body?.uit));
    return NextResponse.json({ ok: true, uit });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message.slice(0, 200) : "opslaan mislukt" },
      { status: 500 }
    );
  }
}
