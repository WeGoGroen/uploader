import { NextResponse } from "next/server";
import { getOrder, getReportVariables, submitOrder } from "@/lib/mediatask";

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
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const orderId = Number(id);
  if (!Number.isFinite(orderId)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
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
