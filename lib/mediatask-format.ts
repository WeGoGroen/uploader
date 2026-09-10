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
 * Vat de mislukte bestanden samen tot één leesbare regel per oorzaak.
 *
 * Eén weigering van Mediatask raakt alle bestanden tegelijk: de reden zit in
 * de order, niet in het bestand. De pagina plakte daar een foutregel per
 * bestand van aan elkaar, en bij een opname met dertig foto's en een paar
 * video's werd dat een scherm vol identieke zinnen waarin de ene echte
 * oorzaak niet meer te vinden was.
 *
 * Daarom: groeperen op de melding zelf, met de bestandsnamen erachter. Boven
 * de vier namen wordt het een telling — wie wíl weten welke dertig bestanden
 * het zijn, kijkt naar de lijst met stappen erboven, waar ze stuk voor stuk
 * staan.
 */
export function bundelFoutmeldingen(
  fouten: { naam: string; fout?: string }[],
  maxNamen = 4
): string {
  const perMelding = new Map<string, string[]>();
  for (const f of fouten) {
    const melding = f.fout?.trim() || "versturen mislukt";
    const namen = perMelding.get(melding) ?? [];
    namen.push(f.naam);
    perMelding.set(melding, namen);
  }

  return [...perMelding.entries()]
    .map(([melding, namen]) => {
      if (namen.length === 1) return `${namen[0]}: ${melding}`;
      const getoond = namen.slice(0, maxNamen).join(", ");
      const rest = namen.length - maxNamen;
      const lijst = rest > 0 ? `${getoond} en nog ${rest}` : getoond;
      return `${namen.length} bestanden (${lijst}): ${melding}`;
    })
    .join(" · ");
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
