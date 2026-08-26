import { NextResponse } from "next/server";
import { isInternRequest } from "@/lib/intern-auth";
import { getAgencies, getProducts, listOrders, requireMediataskConfig } from "@/lib/mediatask";

export const maxDuration = 60;

/**
 * De volledige Mediatask-orderlijst, ongefilterd doorgegeven.
 *
 * Mediatask is waar de NEN2580-plattegronden gemaakt worden; dit is de enige
 * plek waar de stand van dat werk staat. Bewust géén selectie van velden hier:
 * welke kolommen het control center toont is een beslissing van het control
 * center, en elke keer dat ik hier een veld weglaat moet ik deze route opnieuw
 * uitrollen om het terug te krijgen.
 *
 * Makelaars en producten gaan mee zodat de andere kant id's naar namen kan
 * vertalen zonder een tweede ronde.
 */
export async function GET(request: Request) {
  if (!isInternRequest(request)) {
    return NextResponse.json({ error: "niet_toegestaan" }, { status: 401 });
  }

  const [orders, agencies, products] = await Promise.allSettled([
    listOrders(),
    getAgencies(),
    getProducts(),
  ]);

  if (orders.status === "rejected") {
    return NextResponse.json(
      {
        error:
          orders.reason instanceof Error ? orders.reason.message.slice(0, 200) : "Mediatask onbereikbaar",
      },
      { status: 502 }
    );
  }

  // De link naar de order in Mediatask zelf. Die kan het control center niet
  // maken: de basis-URL is per klant anders en staat alleen hier in de
  // omgeving. `output_link` wijst naar Floorplanner — dat is de opgeleverde
  // plattegrond, niet de order.
  let basis = "";
  try {
    basis = (await requireMediataskConfig()).baseUrl.replace(/\/+$/, "");
  } catch {
    // Geen configuratie betekent geen link; de rest van het antwoord blijft
    // gewoon bruikbaar.
  }

  return NextResponse.json({
    gemetenOp: new Date().toISOString(),
    mediataskBasis: basis,
    orders: orders.value.map((o) => ({
      ...o,
      mediataskUrl: basis ? `${basis}/orders/${o.id}` : null,
    })),
    makelaars: agencies.status === "fulfilled" ? agencies.value : [],
    producten: products.status === "fulfilled" ? products.value : [],
  });
}
