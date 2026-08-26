import type { DraftSamenvatting, DraftSoort } from "@/lib/drafts";

/** Zoveel stilte voordat een opname als "blijven liggen" telt. */
export const STILTE_MINUTEN = 45;

/**
 * Alleen tijdens werkuren melden. Een opname die om 19:50 stilvalt levert
 * anders om 20:35 een bericht op waar niemand die avond nog iets mee doet —
 * en een herinnering die je 's avonds wegklikt lees je de volgende ochtend
 * niet opnieuw.
 */
export const WERKDAG_START = 7;
export const WERKDAG_EIND = 20;

export const SOORT_LABEL: Record<DraftSoort, string> = {
  energielabel: "Energielabel",
  nen: "NEN2580",
  media: "Media",
};

const SOORT_PAD: Record<DraftSoort, string> = {
  energielabel: "/energielabel",
  nen: "/nen",
  media: "/media",
};

export interface Herinnering {
  draft: DraftSamenvatting;
  soort: DraftSoort;
  /** Hoe lang er niets meer gebeurd is, in minuten. */
  stilMinuten: number;
  /** Waar de opnemer verdergaat. */
  href: string;
}

/**
 * Welke opnames een herinnering verdienen: gestart, niet afgerond, en al een
 * tijd geen teken van leven. Losse functie omdat hier de grens ligt tussen een
 * nuttig bericht en een loze melding — en dat wil je kunnen vastleggen in
 * tests i.p.v. in productie ontdekken.
 *
 * `alGemeld` bevat de id's waarover al een bericht uitging; zonder dat zou de
 * cron elk kwartier hetzelfde sturen.
 */
// Werkt op de samenvatting: een herinnering heeft de formulierstaat niet
// nodig, en die meeslepen zou de hele reden voor dat onderscheid ondergraven.
export function teHerinneren(
  drafts: DraftSamenvatting[],
  nu: number,
  alGemeld: Set<string>,
  basisUrl: string
): Herinnering[] {
  const grens = nu - STILTE_MINUTEN * 60_000;
  return drafts
    .filter((d) => d.status === "concept")
    .filter((d) => d.updatedAt <= grens)
    .filter((d) => !alGemeld.has(d.id))
    // Zonder naam is er niemand om aan te schrijven; die horen in de
    // ochtendcontrole thuis, niet in een persoonlijke herinnering.
    .filter((d) => !!d.accountName)
    .map((d) => {
      const soort: DraftSoort = d.soort ?? "energielabel";
      return {
        draft: d,
        soort,
        stilMinuten: Math.floor((nu - d.updatedAt) / 60_000),
        href:
          soort === "energielabel"
            ? `${basisUrl}${SOORT_PAD[soort]}?draft=${d.id}`
            : `${basisUrl}${SOORT_PAD[soort]}?addr=${encodeURIComponent(d.straatnaam)}`,
      };
    })
    .sort((a, b) => b.stilMinuten - a.stilMinuten);
}

/** Binnen werkuren? Buiten die tijden houdt de cron zich stil. */
export function binnenWerkuren(nu: Date, tijdzone = "Europe/Amsterdam"): boolean {
  const uur = Number(
    new Intl.DateTimeFormat("en-US", { timeZone: tijdzone, hour: "2-digit", hour12: false }).format(nu)
  );
  return uur >= WERKDAG_START && uur < WERKDAG_EIND;
}

/** "1 uur 5 min" — leesbaarder dan "65 min" zodra het oploopt. */
export function stilTekst(minuten: number): string {
  if (minuten < 60) return `${minuten} min`;
  const uren = Math.floor(minuten / 60);
  const rest = minuten % 60;
  return rest ? `${uren} uur ${rest} min` : `${uren} uur`;
}
