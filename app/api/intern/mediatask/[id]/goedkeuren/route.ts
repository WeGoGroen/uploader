import { NextResponse } from "next/server";
import { isInternRequest } from "@/lib/intern-auth";
import { getOrder, requireMediataskConfig } from "@/lib/mediatask";

export const maxDuration = 60;

/**
 * Een order bij Mediatask goedkeuren.
 *
 * Mediatask documenteert zijn API niet en de endpoints die deze app kent zijn
 * stuk voor stuk live vastgesteld. Voor goedkeuren was dat nog niet gedaan,
 * dus probeert deze route een paar voor de hand liggende vormen — dezelfde
 * vorm als het bestaande /submit — en stopt bij de eerste die werkt.
 *
 * Twee regels maken dat veilig:
 *
 *  1. Alleen een order die op "ready" staat. Dat is de enige status waarin
 *     goedkeuren betekenis heeft; op alles daarbuiten doet deze route niets.
 *  2. Achteraf de order opnieuw ophalen en kijken of de status écht veranderd
 *     is. Een 200 van een endpoint dat toevallig bestaat maar niets doet is
 *     geen goedkeuring, en dat mag het scherm niet als succes tonen.
 *
 * Werkt geen enkele vorm, dan zegt het antwoord dat eerlijk: dan moet het bij
 * Mediatask zelf gebeuren en verandert er hier niets.
 */
const POGINGEN: { pad: (id: number) => string; methode: string; body?: unknown }[] = [
  { pad: (id) => `/api/orders/${id}/accept`, methode: "POST" },
  { pad: (id) => `/api/orders/${id}/approve`, methode: "POST" },
  { pad: (id) => `/api/orders/${id}/finish`, methode: "POST" },
  { pad: (id) => `/api/orders/${id}/complete`, methode: "POST" },
];

/** Statussen waarin de order als goedgekeurd geldt. */
const KLAAR = ["finished", "paid", "accepted"];

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isInternRequest(request)) {
    return NextResponse.json({ error: "niet_toegestaan" }, { status: 401 });
  }

  const { id } = await params;
  const orderId = Number(id);
  if (!Number.isFinite(orderId)) {
    return NextResponse.json({ error: "ongeldig ordernummer" }, { status: 400 });
  }

  let order;
  try {
    order = await getOrder(orderId);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message.slice(0, 200) : "order niet op te halen" },
      { status: 502 }
    );
  }

  const state = String(order.state ?? "").toLowerCase();
  if (KLAAR.includes(state)) {
    // Al goedgekeurd — dan is er niets te doen en is dat goed nieuws.
    return NextResponse.json({ ok: true, state, alGoedgekeurd: true });
  }
  if (state !== "ready") {
    return NextResponse.json(
      { ok: false, state, error: `Deze order staat op "${state}"; alleen "ready" is goed te keuren.` },
      { status: 409 }
    );
  }

  const { token, baseUrl } = await requireMediataskConfig();
  const basis = baseUrl.replace(/\/+$/, "");
  const geprobeerd: string[] = [];

  for (const poging of POGINGEN) {
    const pad = poging.pad(orderId);
    try {
      const res = await fetch(`${basis}${pad}`, {
        method: poging.methode,
        headers: {
          "X-Api-Token": token,
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: poging.body ? JSON.stringify(poging.body) : undefined,
        cache: "no-store",
      });
      geprobeerd.push(`${poging.methode} ${pad} → ${res.status}`);
      // 404/405 betekent: dit endpoint bestaat niet. Door naar de volgende.
      if (!res.ok) continue;

      // Niet op het antwoord vertrouwen maar het resultaat nakijken.
      const na = await getOrder(orderId).catch(() => null);
      const nieuweState = String(na?.state ?? "").toLowerCase();
      if (KLAAR.includes(nieuweState)) {
        return NextResponse.json({ ok: true, state: nieuweState, via: pad, geprobeerd });
      }
      geprobeerd.push(`  ...maar de status bleef "${nieuweState || "onbekend"}"`);
    } catch (err) {
      geprobeerd.push(`${poging.methode} ${pad} → ${err instanceof Error ? err.message.slice(0, 60) : "fout"}`);
    }
  }

  return NextResponse.json(
    {
      ok: false,
      state,
      error: "Mediatask kent geen goedkeur-endpoint dat werkt; keur hem daar zelf goed.",
      geprobeerd,
    },
    { status: 501 }
  );
}
