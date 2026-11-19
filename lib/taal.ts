/**
 * De taal van de uploader: alleen de schermteksten, niet de workflow.
 *
 * Mapnamen in Dropbox, ClickUp-velden, Mediatask-orders en alles wat naar
 * buiten gaat blijft Nederlands — dat zijn afspraken met andere systemen, geen
 * tekst voor de gebruiker. Hier staat alleen wat iemand op het scherm leest.
 *
 * Nederlands is de bron. Ontbreekt een Engelse vertaling, dan valt t() terug
 * op het Nederlands in plaats van een sleutel of een lege knop te tonen.
 */

import * as algemeen from "@/lib/vertalingen/algemeen";
import * as energielabel from "@/lib/vertalingen/energielabel";
import * as nen from "@/lib/vertalingen/nen";
import * as nenDocumenten from "@/lib/vertalingen/nenDocumenten";
import * as media from "@/lib/vertalingen/media";
import * as dashboard from "@/lib/vertalingen/dashboard";
import * as beheer from "@/lib/vertalingen/beheer";

export type Taal = "nl" | "en";

export const TALEN: Taal[] = ["nl", "en"];
export const STANDAARD_TAAL: Taal = "nl";
export const TAAL_COOKIE = "taal";

export function isTaal(v: unknown): v is Taal {
  return v === "nl" || v === "en";
}

/*
  Eén woordenboekbestand per onderdeel in lib/vertalingen/, zodat aanpassingen
  aan het ene scherm niet botsen met die aan het andere.
*/
const nl = {
  ...algemeen.nl,
  ...energielabel.nl,
  ...nen.nl,
  ...nenDocumenten.nl,
  ...media.nl,
  ...dashboard.nl,
  ...beheer.nl,
};

export type TaalSleutel = keyof typeof nl;

const en: Partial<Record<TaalSleutel, string>> = {
  ...algemeen.en,
  ...energielabel.en,
  ...nen.en,
  ...nenDocumenten.en,
  ...media.en,
  ...dashboard.en,
  ...beheer.en,
};

const WOORDENBOEK: Record<Taal, Partial<Record<TaalSleutel, string>>> = { nl, en };

/** Vertaal een sleutel; {naam}-plekken worden ingevuld vanuit `waarden`. */
export function vertaal(taal: Taal, sleutel: TaalSleutel, waarden?: Record<string, string | number>): string {
  const tekst = WOORDENBOEK[taal][sleutel] ?? nl[sleutel] ?? sleutel;
  if (!waarden) return tekst;
  return tekst.replace(/\{(\w+)\}/g, (_, k: string) => String(waarden[k] ?? `{${k}}`));
}

/** Locale voor datums en getallen (toLocaleDateString, Intl.NumberFormat, …). */
export function taalLocale(taal: Taal): string {
  return taal === "en" ? "en-GB" : "nl-NL";
}
