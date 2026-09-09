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

/**
 * De productconfiguratie voor een gekozen product, met verstandige standaarden.
 *
 * Bestaat omdat het wisselen van product de hele configuratie leegde. Dat lijkt
 * logisch — de velden van "Floorplanner basic plans" zijn niet die van
 * "Floorplanner NEN2580 plans NEW" — maar het gevolg was een lege configuratie
 * die nergens meer gevuld werd: de standaardwaarden werden alleen bij het laden
 * van de pagina gezet, en alleen voor het NEN-product. Wie op "basis" overstapte
 * hield dus niets over, en de order die daarna aangemaakt werd sneuvelde op
 * "de productconfiguratie is leeg".
 *
 * Wat de opnemer al gekozen heeft blijft staan zolang het veld in het nieuwe
 * product bestaat; de rest krijgt dezelfde standaard als bij het openen. Velden
 * die het nieuwe product niet kent vallen weg — dat is precies wat er bij een
 * wissel van NEN2580 naar basis moet gebeuren met de meetsoort en de meetdatum.
 */
export function configVoorProduct(
  product: { configuration?: { name: string; values?: string[] }[] } | null | undefined,
  opties: {
    /** Bruto vloeroppervlak uit de agenda-notitie, als dat er is. */
    m2?: number | null;
    /** Vandaag als jjjj-mm-dd; meegegeven zodat deze functie zonder klok werkt. */
    vandaag: string;
    /** Wat er nu ingevuld staat; blijft behouden waar het veld nog bestaat. */
    huidig?: Record<string, string>;
  }
): Record<string, string> {
  const uit: Record<string, string> = {};
  for (const veld of product?.configuration ?? []) {
    const bestaand = opties.huidig?.[veld.name];
    if (bestaand) {
      uit[veld.name] = bestaand;
      continue;
    }
    if (veld.name === "option") uit.option = "3D";
    else if (veld.name === "style") uit.style = "STD";
    else if (veld.name === "measurement_type") uit.measurement_type = "A";
    else if (veld.name === "measurement_date") uit.measurement_date = opties.vandaag;
    else if (veld.name === "gross_floor_area" && opties.m2) {
      const bak = matchGrossFloorAreaBracket(opties.m2, veld.values);
      if (bak) uit.gross_floor_area = bak;
    }
  }
  return uit;
}
