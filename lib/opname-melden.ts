import type { DraftSoort } from "@/lib/drafts";

/**
 * Meldt aan de server dat er een opname loopt, en houdt hem daarna "levend".
 *
 * Waarom nodig: NEN2580 en media schreven niets naar de server, dus daar kon
 * niemand zien dát er een opname gestart was — laat staan dat hij bleef
 * liggen. En `updatedAt` liep alleen mee bij een wijziging in het formulier;
 * sta je een uur te fotograferen, dan zou de opname stil lijken te liggen en
 * kreeg je een herinnering terwijl je gewoon bezig was.
 */
const HARTSLAG_MS = 5 * 60 * 1000;

export interface OpnameMelding {
  id: string;
  soort: DraftSoort;
  straatnaam: string;
  postcode: string;
  woonplaats: string;
  accountName: string | null;
}

async function schrijf(melding: OpnameMelding, status: "concept" | "uploaded"): Promise<void> {
  await fetch("/api/drafts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...melding, status, titel: melding.straatnaam }),
    // Best-effort: een mislukte administratie mag het echte werk nooit
    // blokkeren.
  }).catch(() => {});
}

export function meldGestart(melding: OpnameMelding): void {
  void schrijf(melding, "concept");
}

export function meldAfgerond(melding: OpnameMelding): void {
  void schrijf(melding, "uploaded");
}

/**
 * Houdt de opname levend zolang de pagina open is. Geeft een opruimfunctie
 * terug voor het effect dat 'm startte.
 */
export function startHartslag(melding: OpnameMelding): () => void {
  const timer = setInterval(() => schrijf(melding, "concept"), HARTSLAG_MS);
  return () => clearInterval(timer);
}
