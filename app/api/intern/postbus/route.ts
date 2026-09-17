import { NextResponse } from "next/server";
import { isInternRequest } from "@/lib/intern-auth";
import { postbusStand, zoekAfschriftMails } from "@/lib/postbus";

export const maxDuration = 60;

/**
 * De postbus voor het control center: hoe staat de koppeling ervoor, en welke
 * mails van RVO zijn er die het nog niet kent?
 *
 * GET geeft alleen de stand — dat is wat de Systemen-pagina toont. POST doet
 * het zoekwerk en krijgt de mails mee die het control center al heeft, zodat
 * die niet opnieuw uitgelezen worden.
 *
 * De inhoud van andere mail komt hier nooit langs: er wordt uitsluitend gezocht
 * op de afzender van het afschrift.
 */
export async function GET(request: Request) {
  if (!isInternRequest(request)) {
    return NextResponse.json({ error: "niet_toegestaan" }, { status: 401 });
  }
  return NextResponse.json(await postbusStand());
}

export async function POST(request: Request) {
  if (!isInternRequest(request)) {
    return NextResponse.json({ error: "niet_toegestaan" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as {
    bekend?: string[];
    max?: number;
  } | null;

  const stand = await postbusStand();
  if (!stand.gekoppeld) {
    // Geen fout: een postbus die niet gekoppeld is, is een keuze en geen
    // storing. Het control center hoort daar niet elke ronde over te klagen.
    return NextResponse.json({ gekoppeld: false, adres: null, mails: [] });
  }

  try {
    const mails = await zoekAfschriftMails({
      bekend: Array.isArray(body?.bekend) ? body.bekend.slice(0, 500).map(String) : [],
      max: Number(body?.max) || 10,
    });
    return NextResponse.json({ gekoppeld: true, adres: stand.adres, mails });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message.slice(0, 300) : "de postbus is niet te lezen" },
      { status: 502 }
    );
  }
}
