import type { DraftSoort } from "@/lib/drafts";

/**
 * Waar een onafgemaakte opname weer opengaat.
 *
 * Eén plek, omdat dit al twee keer op twee schermen los is bedacht en beide
 * keren op /energielabel uitkwam — ook voor NEN-opnames. Wie geen
 * energielabelrecht heeft (Jelle doet NEN2580 en media) werd daardoor bij het
 * klikken meteen teruggestuurd naar het dashboard: de knop "verder afmaken"
 * leidde naar een deur die voor hem dicht zat.
 *
 * NEN opent op adres en niet op concept-id: die opnames hebben geen echt
 * formulierconcept maar een pseudo-id ("nen-<adres>"), en de NEN-pagina zoekt
 * het adres zelf weer op.
 */
export function opnameLink(opname: {
  id: string;
  soort?: DraftSoort;
  straatnaam?: string;
  titel?: string;
  heeftMediatask?: boolean;
}): string {
  // heeftMediatask blijft de terugval voor opnames van vóór het soort-veld.
  const isNen = opname.soort === "nen" || (!opname.soort && opname.heeftMediatask);
  if (!isNen) return `/energielabel?draft=${opname.id}`;

  const adres = (opname.straatnaam || opname.titel || "").trim();
  return adres ? `/nen?addr=${encodeURIComponent(adres)}` : "/nen";
}
