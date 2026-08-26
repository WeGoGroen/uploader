import { NextResponse } from "next/server";
import { listOrders } from "@/lib/mediatask";
import { controleerEnHerstel, type HerstelUitkomst } from "@/lib/mediatask-pointclouds";

/**
 * Kijkt of Mediatask de puntenwolken van recente orders ook echt verwerkt
 * heeft, en verstuurt opnieuw wat er mis ging.
 *
 * Waarom dit apart moet: het koppelen slaagt en meldt "attached successfully",
 * maar hun verwerker draait daarna pas — en die kan het bestand alsnog
 * afkeuren. Dat staat in hun webinterface als "failed" en komt in de API
 * alleen terug als een puntenwolk zonder voorbeeldbeelden. Zonder deze
 * controle merk je het pas als de verwerker erover belt.
 *
 * ?orderId=123 controleert één order, zonder parameter de recente orders.
 * ?alleenKijken=1 rapporteert wel, maar verstuurt niets opnieuw.
 */
export const maxDuration = 300;

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const enkel = Number(params.get("orderId"));
  const alleenKijken = params.get("alleenKijken") === "1";
  const aantal = Math.min(40, Number(params.get("aantal") ?? 15));

  try {
    const ids = enkel
      ? [enkel]
      : (await listOrders()).slice(0, aantal).map((o) => o.id);

    const uitkomsten: HerstelUitkomst[] = [];
    for (const id of ids) {
      const uit = await controleerEnHerstel(id, { alleenKijken });
      // Alleen orders met iets te melden: een lijst van vijftien keer "niets
      // aan de hand" verbergt juist de twee die het niet zijn.
      if (uit.mislukt.length > 0 || uit.reden) uitkomsten.push(uit);
    }

    const nogSteeds = uitkomsten.flatMap((u) => u.nietGelukt);
    return NextResponse.json({
      gecontroleerd: ids.length,
      problemen: uitkomsten,
      alles_goed: uitkomsten.length === 0,
      nogSteeds,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Controle mislukt" },
      { status: 502 }
    );
  }
}
