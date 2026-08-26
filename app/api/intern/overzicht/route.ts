import { NextResponse } from "next/server";
import { isInternRequest } from "@/lib/intern-auth";
import { listDrafts, telOpnames } from "@/lib/drafts";
import { listScanRecords } from "@/lib/scan-record";
import { getAgencies, listOrders } from "@/lib/mediatask";

export const maxDuration = 60;

/**
 * De werkvoorraad van de uploader, voor het Business Control Center.
 *
 * Dit is wat ClickUp niet weet: welke opnames er halverwege zijn blijven
 * hangen, welke opnames wél afgerond zijn maar met ontbrekende bijlages, en
 * welke scans bij Mediatask in behandeling zijn. Dat zijn precies de dingen
 * die stil blijven liggen omdat niemand er een melding van krijgt.
 *
 * Alleen samenvattingen — nooit de volledige formulierstaat. Die is per opname
 * tientallen velden groot; bij 1000 opnames per maand zou deze route na een
 * jaar megabytes per aanroep verstoken.
 */
export async function GET(request: Request) {
  if (!isInternRequest(request)) {
    return NextResponse.json({ error: "niet_toegestaan" }, { status: 401 });
  }

  // Elk onderdeel apart: Mediatask ligt er weleens uit en dat mag de
  // opnamecijfers niet meeslepen.
  const [opnames, concepten, scans, mediatask, makelaars] = await Promise.allSettled([
    telOpnames(),
    listDrafts(200),
    listScanRecords(50),
    listOrders(),
    getAgencies(),
  ]);

  const conceptenLijst = concepten.status === "fulfilled" ? concepten.value : [];

  return NextResponse.json({
    gemetenOp: new Date().toISOString(),
    opnames:
      opnames.status === "fulfilled" ? opnames.value : { concept: 0, uploaded: 0, fout: "onbekend" },
    // Opnames die nog niet klaar zijn, met waaróm ze niet klaar zijn.
    openstaand: conceptenLijst
      .filter((d) => d.status === "concept")
      .map((d) => ({
        id: d.id,
        titel: d.titel,
        adres: [d.straatnaam, d.woonplaats].filter(Boolean).join(", "),
        soort: d.soort ?? "energielabel",
        medewerker: d.adviseur ?? d.accountName,
        ontbrekendeVelden: d.ontbrekendeVelden ?? [],
        heeftMediatask: Boolean(d.heeftMediatask),
        bijgewerktOp: d.updatedAt,
      })),
    // Afgerond, maar met bijlages die niet in ClickUp terechtkwamen. Ziet er
    // in ClickUp uit als klaar werk en is het niet.
    incompleet: conceptenLijst
      .filter((d) => (d.incompleteDocs ?? []).length > 0)
      .map((d) => ({
        id: d.id,
        adres: [d.straatnaam, d.woonplaats].filter(Boolean).join(", "),
        ontbrekend: d.incompleteDocs ?? [],
        clickupTaskUrl: d.clickupTaskUrl,
        bijgewerktOp: d.updatedAt,
      })),
    scans:
      scans.status === "fulfilled"
        ? scans.value.slice(0, 50).map((s) => ({
            id: s.id,
            adres: s.address,
            orderId: s.orderId,
            // `verdict` is het oordeel van de puntenwolk-controle: afgekeurde
            // scans zijn werk dat opnieuw moet en dus het vermelden waard.
            oordeel: s.verdict,
            aangemaaktOp: s.at,
          }))
        : [],
    mediatask:
      mediatask.status === "fulfilled"
        ? {
            orders: mediatask.value.map((o) => ({
              id: o.id,
              state: o.state,
              adres: o.address ?? null,
              klantOrderId: o.client_order_id,
              // Mediatask hangt elke order aan een makelaar. Dat is de enige
              // plek waar die koppeling bestaat — de ClickUp-lijst is de
              // energielabel-opname zelf en kent geen klantveld.
              agencyId: (o as { agency_id?: string | number }).agency_id ?? null,
            })),
            // De volledige makelaarslijst, niet alleen het aantal: dit is de
            // klantenadministratie van het bedrijf en die hoort in het control
            // center te staan, niet alleen als getal.
            makelaars: makelaars.status === "fulfilled" ? makelaars.value : [],
            fout: null as string | null,
          }
        : {
            orders: [],
            makelaars: [],
            fout:
              mediatask.reason instanceof Error
                ? mediatask.reason.message.slice(0, 160)
                : "niet bereikbaar",
          },
  });
}
