import { NextResponse } from "next/server";
import { isInternRequest } from "@/lib/intern-auth";
import { addOrderComment, getOrder, requireMediataskConfig } from "@/lib/mediatask";

export const maxDuration = 60;

/**
 * Een correctie aanvragen bij Mediatask.
 *
 * Twee dingen, in deze volgorde, en de eerste is de belangrijkste: de
 * opmerking. Daar staat in wát er gecorrigeerd moet worden, en zonder dat is
 * een afkeuring voor de tekenaar aan de andere kant een raadsel. Het
 * opmerkingen-endpoint is bekend en werkt.
 *
 * Daarna de status. Of Mediatask dat via de API toestaat weten we niet — hun
 * API is niet gedocumenteerd — dus dit probeert dezelfde vormen als bij
 * goedkeuren en controleert achteraf of de status écht veranderd is. Lukt dat
 * niet, dan staat de opmerking er wél en zegt het antwoord dat de status met de
 * hand omgezet moet worden. Dat is de eerlijke tussenstand: de vraag is
 * gesteld, alleen het vlaggetje staat nog verkeerd.
 */
const POGINGEN = [
  "/api/orders/{id}/request-changes",
  "/api/orders/{id}/request_changes",
  "/api/orders/{id}/reject",
  "/api/orders/{id}/revision",
];

/** Statussen waarin Mediatask weer aan het werk is. */
const ONDERHANDEN = ["changes requested", "in progress", "action required"];

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isInternRequest(request)) {
    return NextResponse.json({ error: "niet_toegestaan" }, { status: 401 });
  }

  const { id } = await params;
  const orderId = Number(id);
  if (!Number.isFinite(orderId)) {
    return NextResponse.json({ error: "ongeldig ordernummer" }, { status: 400 });
  }

  const body = (await request.json().catch(() => null)) as { reden?: string; door?: string } | null;
  const reden = (body?.reden ?? "").trim();
  if (reden.length < 3) {
    return NextResponse.json({ error: "geef aan wat er gecorrigeerd moet worden" }, { status: 400 });
  }

  // De naam erbij: aan de andere kant zit een tekenaar die soms wil
  // terugvragen wat er bedoeld wordt.
  const opmerking = body?.door ? `${reden}\n\n— ${body.door} (WeGoGroen)` : reden;

  let opmerkingGeplaatst = false;
  try {
    await addOrderComment(orderId, opmerking);
    opmerkingGeplaatst = true;
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        opmerkingGeplaatst,
        error: `De opmerking kon niet geplaatst worden: ${
          err instanceof Error ? err.message.slice(0, 160) : "onbekende fout"
        }`,
      },
      { status: 502 }
    );
  }

  const { token, baseUrl } = await requireMediataskConfig();
  const basis = baseUrl.replace(/\/+$/, "");
  const geprobeerd: string[] = [];

  for (const vorm of POGINGEN) {
    const pad = vorm.replace("{id}", String(orderId));
    try {
      const res = await fetch(`${basis}${pad}`, {
        method: "POST",
        headers: {
          "X-Api-Token": token,
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ comment: opmerking, reason: opmerking }),
        cache: "no-store",
      });
      geprobeerd.push(`POST ${pad} → ${res.status}`);
      if (!res.ok) continue;

      const na = await getOrder(orderId).catch(() => null);
      const state = String(na?.state ?? "").toLowerCase();
      if (ONDERHANDEN.includes(state)) {
        return NextResponse.json({ ok: true, opmerkingGeplaatst, state, via: pad, geprobeerd });
      }
      geprobeerd.push(`  ...maar de status bleef "${state || "onbekend"}"`);
    } catch (err) {
      geprobeerd.push(`POST ${pad} → ${err instanceof Error ? err.message.slice(0, 60) : "fout"}`);
    }
  }

  const na = await getOrder(orderId).catch(() => null);
  return NextResponse.json({
    ok: false,
    opmerkingGeplaatst: true,
    state: String(na?.state ?? ""),
    error:
      "De opmerking staat bij de order, maar Mediatask laat de status niet via de API omzetten. Zet hem daar op 'changes requested'.",
    geprobeerd,
  });
}
