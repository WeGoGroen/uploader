import { NextResponse } from "next/server";
import { isInternRequest } from "@/lib/intern-auth";
import { getSharedAccessToken, listFolderFiles } from "@/lib/dropbox";
import { addOrderComment, getOrder, listPointclouds, requireMediataskConfig } from "@/lib/mediatask";
import {
  alAanwezigeNamen,
  controleerEnHerstel,
  echtAfgekeurd,
  markeerVervangen,
  naamUitUrl,
  leesOrderPad,
  leesbareFout,
  stuurScansVanuitDropbox,
} from "@/lib/mediatask-pointclouds";
import { herstelOpmerking, opmerkingenVanMediatask, stelDiagnose, type Diagnose } from "@/lib/mediatask-diagnose";

/**
 * Een order op "action required": waarom, en kunnen wij het rechtzetten?
 *
 *   GET  — alleen kijken. Legt de puntenwolken, de opmerkingen van Mediatask en
 *          onze Dropbox-map naast elkaar en zegt wat er mis is. Verstuurt niets.
 *   POST — herstellen: afgekeurde scans opnieuw en ontbrekende scans alsnog
 *          sturen, en een opmerking bij de order zetten dat ze er zijn.
 *
 * POST is een handeling bij een leverancier. Het Control Center roept hem
 * alleen aan na een akkoord van een mens (of als iemand de regel bewust op
 * automatisch zette), en geeft de naam van die persoon mee voor de opmerking.
 */
export const maxDuration = 300;

async function diagnose(orderId: number): Promise<Diagnose | null> {
  const order = await getOrder(orderId).catch(() => null);
  if (!order) return null;

  const [pad, puntenwolken, aanwezig, controle] = await Promise.all([
    leesOrderPad(orderId),
    listPointclouds(orderId).catch(() => []),
    alAanwezigeNamen(orderId),
    controleerEnHerstel(orderId, { alleenKijken: true }),
  ]);

  let inDropbox: string[] | null = null;
  if (pad) {
    const token = await getSharedAccessToken();
    inDropbox = (await listFolderFiles(token, `${pad}/Optimized`).catch(() => [])).map((b) => b.name);
  }

  let opmerkingen: ReturnType<typeof opmerkingenVanMediatask> = [];
  try {
    const { token, baseUrl } = await requireMediataskConfig();
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/orders/${orderId}/comments`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      cache: "no-store",
    });
    if (res.ok) {
      const ruw = (await res.json().catch(() => [])) as unknown;
      const lijst = Array.isArray(ruw) ? ruw : Array.isArray((ruw as { comments?: unknown[] })?.comments) ? (ruw as { comments: unknown[] }).comments : [];
      opmerkingen = opmerkingenVanMediatask(lijst);
    }
  } catch {
    // Zonder opmerkingen is de diagnose nog steeds bruikbaar.
  }

  return stelDiagnose({
    orderId,
    state: order.state ?? null,
    pad,
    puntenwolken: puntenwolken.length,
    afgekeurd: controle.mislukt,
    aanwezig,
    inDropbox,
    opmerkingen,
  });
}

function orderUit(id: string): number | null {
  const n = Number(id);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isInternRequest(request)) return NextResponse.json({ error: "niet_toegestaan" }, { status: 401 });
  const orderId = orderUit((await params).id);
  if (!orderId) return NextResponse.json({ error: "ongeldig ordernummer" }, { status: 400 });

  try {
    const uit = await diagnose(orderId);
    if (!uit) return NextResponse.json({ error: "order niet gevonden bij Mediatask" }, { status: 404 });
    return NextResponse.json(uit);
  } catch (err) {
    return NextResponse.json({ error: leesbareFout(err) }, { status: 502 });
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isInternRequest(request)) return NextResponse.json({ error: "niet_toegestaan" }, { status: 401 });
  const orderId = orderUit((await params).id);
  if (!orderId) return NextResponse.json({ error: "ongeldig ordernummer" }, { status: 400 });
  const body = (await request.json().catch(() => null)) as { door?: string } | null;
  const door = body?.door?.trim() || null;

  try {
    // Vers kijken, niet vertrouwen op wat het Control Center eerder zag: het
    // kan intussen al opgelost zijn, en dan sturen we niets dubbel.
    const voor = await diagnose(orderId);
    if (!voor) return NextResponse.json({ error: "order niet gevonden bij Mediatask" }, { status: 404 });
    if (!voor.herstelbaar || !voor.pad) {
      return NextResponse.json({ ok: false, diagnose: voor, error: voor.samenvatting }, { status: 409 });
    }

    const verstuurd: string[] = [];
    const mislukt: string[] = [];

    if (voor.afgekeurd.length > 0) {
      // Welke puntenwolken nu afgekeurd zijn, vóór het versturen: precies die
      // worden daarna als vervangen afgemeld, en de nieuwe niet.
      const oud = await echtAfgekeurd(orderId, await listPointclouds(orderId).catch(() => []));
      const her = await controleerEnHerstel(orderId);
      verstuurd.push(...her.opnieuwVerstuurd);
      mislukt.push(...her.nietGelukt);
      if (her.opnieuwVerstuurd.length > 0) {
        await markeerVervangen(
          orderId,
          // Alleen wat écht vervangen is; een scan die niet aankwam blijft
          // als afgekeurd zichtbaar.
          oud.filter((p) => her.opnieuwVerstuurd.includes(naamUitUrl(p.url) ?? "")).map((p) => p.id),
          `vervangen bij herstel${door ? ` (${door})` : ""}`
        );
      }
    }
    if (voor.ontbreekt.length > 0) {
      // Slaat over wat er intussen al hangt; stuurt alleen het ontbrekende.
      for (const u of await stuurScansVanuitDropbox(orderId, voor.pad)) {
        if (u.alAanwezig) continue;
        if (u.ok) verstuurd.push(u.naam);
        else mislukt.push(`${u.naam}: ${u.fout ?? "onbekende fout"}`);
      }
    }

    let opmerkingGeplaatst = false;
    if (verstuurd.length > 0) {
      try {
        await addOrderComment(orderId, herstelOpmerking(verstuurd, door));
        opmerkingGeplaatst = true;
      } catch {
        // De scans staan er; zonder opmerking ziet de verwerker ze nog steeds.
      }
    }

    return NextResponse.json({
      ok: verstuurd.length > 0 && mislukt.length === 0,
      verstuurd,
      mislukt,
      opmerkingGeplaatst,
      diagnose: voor,
    });
  } catch (err) {
    return NextResponse.json({ error: leesbareFout(err) }, { status: 502 });
  }
}
