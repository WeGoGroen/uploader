import { NextResponse } from "next/server";
import { isInternRequest } from "@/lib/intern-auth";
import { getOrder, listPointclouds, requireMediataskConfig } from "@/lib/mediatask";

export const maxDuration = 45;

/**
 * Eén Mediatask-order met alles eromheen: de order zelf, de aangeleverde
 * puntenwolken en de activiteitenlijst.
 *
 * De activiteiten haal ik rechtstreeks op met een losse fetch en niet via
 * lib/mediatask: die laag kent alleen de endpoints die de uploader zelf nodig
 * had. Een endpoint dat er niet blijkt te zijn levert hier een lege lijst op in
 * plaats van een foutmelding — de rest van de pagina is dan nog gewoon bruikbaar.
 */
async function probeer<T>(pad: string): Promise<T | null> {
  try {
    const { token, baseUrl } = await requireMediataskConfig();
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}${pad}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const tekst = await res.text();
    if (!tekst.trim() || /^\s*<(!doctype|html)/i.test(tekst)) return null;
    return JSON.parse(tekst) as T;
  } catch {
    return null;
  }
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isInternRequest(request)) {
    return NextResponse.json({ error: "niet_toegestaan" }, { status: 401 });
  }

  const { id } = await params;
  const orderId = Number(id);
  if (!Number.isFinite(orderId)) {
    return NextResponse.json({ error: "ongeldig ordernummer" }, { status: 400 });
  }

  const [order, pointclouds, comments, history, activities] = await Promise.all([
    getOrder(orderId).catch(() => null),
    listPointclouds(orderId).catch(() => []),
    probeer<unknown[]>(`/api/orders/${orderId}/comments`),
    probeer<unknown[]>(`/api/orders/${orderId}/history`),
    probeer<unknown[]>(`/api/orders/${orderId}/activities`),
  ]);

  if (!order) {
    return NextResponse.json({ error: "order niet gevonden bij Mediatask" }, { status: 404 });
  }

  let basis = "";
  try {
    basis = (await requireMediataskConfig()).baseUrl.replace(/\/+$/, "");
  } catch {}

  return NextResponse.json({
    order: { ...order, mediataskUrl: basis ? `${basis}/orders/${orderId}` : null },
    pointclouds,
    // Alle drie proberen: welke van de drie Mediatask aanbiedt is niet
    // gedocumenteerd, en dit is één keer uitzoeken in plaats van gokken.
    comments: comments ?? [],
    history: history ?? [],
    activities: activities ?? [],
  });
}
