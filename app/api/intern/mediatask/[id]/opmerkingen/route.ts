import { NextResponse } from "next/server";
import { isInternRequest } from "@/lib/intern-auth";
import { requireGedeeldeMediataskConfig } from "@/lib/mediatask";
import { getClickUpAccounts } from "@/lib/clickup";
import { mediataskMetSleutel, opmerkingenUit, vindAccount, lijstUit } from "@/lib/mediatask-opmerkingen";

export const maxDuration = 60;

/**
 * Het gesprek bij één Mediatask-order, voor de chatkolom in het Control Center.
 *
 * GET  ?email=&naam=  — alle opmerkingen, oudste eerst, plus wie "ik" ben bij
 *                       Mediatask (zodat het Control Center mijn berichten
 *                       rechts kan zetten) en of ik kan plaatsen.
 * POST {tekst, email, naam}     — plaatst met de eigen Mediatask-sleutel van die
 *                                 persoon. Zonder eigen sleutel: 409, nooit
 *                                 terugvallen op de gedeelde — dan stond het
 *                                 onder andermans naam.
 * POST {tekst, alsAgent: "naam"} — plaatst met de gedeelde sleutel, voor een
 *                                  agent die zelf antwoordt.
 *
 * Lezen gaat altijd met de gedeelde sleutel: die ziet elke order, ook die van
 * een collega.
 */

/** Wie hoort bij een sleutel? Verandert nooit; een uur onthouden is ruim. */
const ikCache = new Map<string, { id: number; naam: string | null; tot: number }>();

async function wieBenIk(baseUrl: string, token: string): Promise<{ id: number; naam: string | null } | null> {
  const bekend = ikCache.get(token);
  if (bekend && bekend.tot > Date.now()) return { id: bekend.id, naam: bekend.naam };
  try {
    const res = await mediataskMetSleutel(baseUrl, token, "/api/me");
    if (!res.ok) return null;
    const body = (await res.json()) as { user?: Record<string, unknown> };
    const id = Number(body.user?.id);
    if (!Number.isFinite(id) || id <= 0) return null;
    const naam = String(body.user?.full_name ?? body.user?.name ?? body.user?.username ?? "").trim() || null;
    ikCache.set(token, { id, naam, tot: Date.now() + 3_600_000 });
    return { id, naam };
  } catch {
    return null;
  }
}

function orderIdUit(id: string): number | null {
  const n = Number(id);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function leesGesprek(baseUrl: string, token: string, orderId: number) {
  const res = await mediataskMetSleutel(baseUrl, token, `/api/orders/${orderId}/comments`);
  if (!res.ok) {
    const tekst = await res.text().catch(() => "");
    throw new Error(`Mediatask gaf ${res.status} op de opmerkingen${tekst ? `: ${tekst.slice(0, 160)}` : ""}`);
  }
  const ruw = (await res.json().catch(() => [])) as unknown;
  const lijst = lijstUit(ruw);
  return {
    opmerkingen: opmerkingenUit(ruw, orderId),
    // Welke velden Mediatask werkelijk stuurt: het endpoint is ongedocumenteerd,
    // en zo is de vorm na te kijken zonder in te loggen bij Mediatask.
    velden:
      lijst[0] && typeof lijst[0] === "object"
        ? [
            ...Object.keys(lijst[0] as object).sort(),
            // De vorm van het tijdveld, om na te kijken: niet gedocumenteerd.
            `timestamps=${JSON.stringify((lijst[0] as Record<string, unknown>).timestamps ?? null)?.slice(0, 120)}`,
          ]
        : [],
  };
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isInternRequest(request)) return NextResponse.json({ error: "niet_toegestaan" }, { status: 401 });
  const orderId = orderIdUit((await params).id);
  if (!orderId) return NextResponse.json({ error: "ongeldig ordernummer" }, { status: 400 });

  const url = new URL(request.url);
  const email = url.searchParams.get("email");
  const naam = url.searchParams.get("naam");

  try {
    const { token, baseUrl } = await requireGedeeldeMediataskConfig();
    const gesprek = await leesGesprek(baseUrl, token, orderId);

    let ik: { mediataskId: number; naam: string | null } | null = null;
    let kanPlaatsen = false;
    if (email || naam) {
      const account = vindAccount(await getClickUpAccounts(), { email, naam });
      if (account?.mediataskToken) {
        const wie = await wieBenIk(baseUrl, account.mediataskToken);
        if (wie) {
          ik = { mediataskId: wie.id, naam: wie.naam };
          kanPlaatsen = true;
        }
      }
    }
    return NextResponse.json({ ...gesprek, ik, kanPlaatsen });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message.slice(0, 240) : "opmerkingen ophalen mislukt" },
      { status: 502 }
    );
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isInternRequest(request)) return NextResponse.json({ error: "niet_toegestaan" }, { status: 401 });
  const orderId = orderIdUit((await params).id);
  if (!orderId) return NextResponse.json({ error: "ongeldig ordernummer" }, { status: 400 });

  const body = (await request.json().catch(() => null)) as {
    tekst?: string;
    email?: string;
    naam?: string;
    alsAgent?: string;
  } | null;
  const tekst = (body?.tekst ?? "").trim();
  if (tekst.length < 2) return NextResponse.json({ error: "lege opmerking" }, { status: 400 });
  if (tekst.length > 4000) return NextResponse.json({ error: "opmerking is te lang (max 4000 tekens)" }, { status: 400 });

  let gedeeld: { token: string; baseUrl: string };
  try {
    gedeeld = await requireGedeeldeMediataskConfig();
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Mediatask niet geconfigureerd" }, { status: 503 });
  }

  let sleutel: string;
  let plaatsTekst = tekst;
  if (body?.alsAgent) {
    sleutel = gedeeld.token;
    // De gedeelde sleutel hoort bij het account van een van ons. Zonder
    // ondertekening leek een antwoord van de agent van die persoon te komen.
    plaatsTekst = `${tekst}\n\n— ${body.alsAgent} (WeGoGroen)`;
  } else {
    const account = vindAccount(await getClickUpAccounts(), { email: body?.email, naam: body?.naam });
    if (!account?.mediataskToken) {
      return NextResponse.json(
        {
          error: "geen_eigen_sleutel",
          uitleg: "Zet eerst je eigen Mediatask-sleutel op je account in de uploader; zonder komt de opmerking onder andermans naam.",
        },
        { status: 409 }
      );
    }
    sleutel = account.mediataskToken;
  }

  const res = await mediataskMetSleutel(gedeeld.baseUrl, sleutel, `/api/orders/${orderId}/comments`, {
    method: "POST",
    // Live vastgesteld (zie addOrderComment): precies {comment: "..."}.
    body: JSON.stringify({ comment: plaatsTekst }),
  });
  if (!res.ok) {
    const fout = await res.text().catch(() => "");
    return NextResponse.json(
      { error: `Mediatask weigerde de opmerking (${res.status})${fout ? `: ${fout.slice(0, 160)}` : ""}` },
      { status: 502 }
    );
  }

  // Het gesprek opnieuw, zodat het Control Center het echte id en de echte
  // tijd vastlegt in plaats van een eigen gok.
  const gesprek = await leesGesprek(gedeeld.baseUrl, gedeeld.token, orderId).catch(() => null);
  return NextResponse.json({ ok: true, geplaatst: plaatsTekst, opmerkingen: gesprek?.opmerkingen ?? null });
}
