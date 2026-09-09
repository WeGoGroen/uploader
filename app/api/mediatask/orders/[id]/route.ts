import { NextResponse } from "next/server";
import { getOrder, getReportVariables, listPointclouds, submitOrder } from "@/lib/mediatask";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const orderId = Number(id);
  if (!Number.isFinite(orderId)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  try {
    const order = await getOrder(orderId);
    let variables: Record<string, string> | null = null;
    if (order.state === "finished" || order.state === "delivered" || order.output_link) {
      variables = await getReportVariables(orderId)
        .then((r) => r.variables)
        .catch(() => null);
    }
    return NextResponse.json({ order, variables });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Status ophalen mislukt" },
      { status: 502 }
    );
  }
}

/**
 * Dient een bestaande order in.
 *
 * Bestaat apart omdat een puntenwolk pas ná het aanmaken van de order
 * geüpload kan worden — Mediatask geeft de S3-link immers per order uit. De
 * volgorde is dus: order aanmaken als concept, scan uploaden en koppelen, en
 * dan pas indienen. Meteen indienen bij het aanmaken zou de order de deur uit
 * sturen zonder de scan erbij.
 *
 * En daarom is indienen ook het laatste wat deze route zomaar doet. Het is
 * eenrichtingsverkeer: een ingediende order neemt bij Mediatask geen bestanden
 * meer aan, dus gaat hij weg zonder puntenwolk, dan is dat niet meer te
 * herstellen — elke volgende poging krijgt daar een 403, en de verwerker
 * begint aan een NEN2580 zonder scan. Met `verwachteScans` in de body zegt de
 * aanroeper hoeveel scans er aan de order horen te hangen; hangen er minder,
 * dan blijft de order concept en zegt het antwoord waarom. Zonder dat getal
 * gedraagt de route zich als voorheen.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const orderId = Number(id);
  if (!Number.isFinite(orderId)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const body = (await request.json().catch(() => ({}))) as { verwachteScans?: number };
  const verwacht = Number(body?.verwachteScans);
  if (Number.isFinite(verwacht) && verwacht > 0) {
    const aanwezig = await listPointclouds(orderId).catch(() => null);
    // Niet kunnen tellen is geen reden om tegen te houden: dan is Mediatask
    // even onbereikbaar, en dat is iets anders dan een ontbrekende scan.
    if (aanwezig && aanwezig.length < verwacht) {
      return NextResponse.json(
        {
          error:
            `Niet ingediend: er hangen ${aanwezig.length} van de ${verwacht} scans aan order #${orderId}. ` +
            `Na het indienen neemt Mediatask er geen scan meer bij, dus de order blijft als concept staan — ` +
            `stuur de ontbrekende scan opnieuw en rond daarna af.`,
          aanwezigeScans: aanwezig.length,
          verwachteScans: verwacht,
        },
        { status: 409 }
      );
    }
  }

  try {
    await submitOrder(orderId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Indienen mislukt" },
      { status: 502 }
    );
  }
}
