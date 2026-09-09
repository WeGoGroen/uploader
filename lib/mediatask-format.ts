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
