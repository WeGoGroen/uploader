import type { DraftSoort } from "@/lib/drafts";

/**
 * Waar een onafgemaakte opname weer opengaat.
 *
 * Eén plek, omdat dit al twee keer op twee schermen los is bedacht en beide
 * keren op /energielabel uitkwam — ook voor NEN- en media-opnames. Wie geen
 * energielabelrecht heeft (Jelle doet NEN2580 en media) werd daardoor bij het
 * klikken meteen teruggestuurd naar het dashboard: de knop "verder afmaken"
 * leidde naar een deur die voor hem dicht zat.
 *
 * NEN en media openen op adres en niet op concept-id: die opnames hebben geen
 * echt formulierconcept maar een pseudo-id ("nen-<adres>", "media-<pad van de
 * projectmap>"), en beide pagina's zoeken het adres zelf weer op.
 */
export function opnameLink(opname: {
  id: string;
  soort?: DraftSoort;
  straatnaam?: string;
  titel?: string;
  heeftMediatask?: boolean;
}): string {
  function opAdres(pagina: string): string {
    const adres = (opname.straatnaam || opname.titel || "").trim();
    return adres ? `${pagina}?addr=${encodeURIComponent(adres)}` : pagina;
  }

  if (opname.soort === "media") return opAdres("/media");

  // heeftMediatask blijft de terugval voor opnames van vóór het soort-veld.
  const isNen = opname.soort === "nen" || (!opname.soort && opname.heeftMediatask);
  if (isNen) return opAdres("/nen");

  // Coderen, want een concept-id is niet altijd een simpel woord; een pad
  // hoort niet kaal in een querystring.
  return `/energielabel?draft=${encodeURIComponent(opname.id)}`;
}
