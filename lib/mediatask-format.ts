/**
 * Client-veilige hulpfuncties rond Mediatask-productopties (geen import van
 * lib/mediatask.ts hier — die trekt Redis binnen, wat niet in de browser
 * hoort).
 */

/**
 * Zoekt in een lijst oppervlakte-opties (zoals Mediatask ze aanlevert, bv.
 * "≤110m2", "111-230m2", ">600m2") welke bucket een gemeten oppervlakte
 * bevat, zodat het bruto vloeroppervlak automatisch ingevuld kan worden op
 * basis van een m²-waarde uit de agenda-notitie.
 */
export function matchGrossFloorAreaBracket(size: number, values: string[] | undefined): string | null {
  if (!values) return null;
  for (const raw of values) {
    const clean = raw.trim();
    if (clean.startsWith("≤") || clean.startsWith("<=")) {
      const upper = parseFloat(clean.match(/(\d+(?:[.,]\d+)?)/)?.[1]?.replace(",", ".") ?? "");
      if (Number.isFinite(upper) && size <= upper) return raw;
      continue;
    }
    if (clean.startsWith(">")) {
      const lower = parseFloat(clean.match(/(\d+(?:[.,]\d+)?)/)?.[1]?.replace(",", ".") ?? "");
      if (Number.isFinite(lower) && size > lower) return raw;
      continue;
    }
    const range = clean.match(/(\d+(?:[.,]\d+)?)\s*-\s*(\d+(?:[.,]\d+)?)/);
    if (range) {
      const lo = parseFloat(range[1].replace(",", "."));
      const hi = parseFloat(range[2].replace(",", "."));
      if (size >= lo && size <= hi) return raw;
    }
  }
  return null;
}

/**
 * Alleen de orders die bij Mediatask op naam van deze gebruiker staan.
 *
 * De orderlijst die Mediatask teruggeeft is die van het hele bureau, ook als
 * je hem met je eigen sleutel opvraagt. Wie dat over het hoofd ziet, bouwt een
 * "jouw werk"-lijst waar het werk van collega's in staat — zo verscheen de
 * scan van de een op het dashboard van de ander.
 *
 * Een order zonder eigenaar valt af. Dat is de veilige kant: liever een order
 * missen die van jou is (hij staat ook bij Mediatask zelf) dan er een tonen
 * die van iemand anders is.
 */
export function eigenOrders<T extends { owner?: { id: number } | null }>(
  orders: T[],
  gebruikerId: number
): T[] {
  return orders.filter((o) => o.owner?.id === gebruikerId);
}
