import { relaxedBagQueries } from "@/lib/address-format";

export interface BagCheckResult {
  /** `false` = bevestigd niet in de BAG gevonden. */
  ok: boolean;
  /** Adressen die er sterk op lijken (zelfde huisnummer/straat), max 5. */
  similar: string[];
}

async function searchLabels(query: string): Promise<string[] | null> {
  try {
    const res = await fetch(`/api/address/search?q=${encodeURIComponent(query)}`);
    if (!res.ok) return null;
    const data = await res.json();
    return ((data.suggestions ?? []) as { label: string }[]).map((s) => s.label);
  } catch {
    return null;
  }
}

/**
 * Controleert of een agenda-adres in de BAG bestaat en zoekt, als dat niet
 * zo is, meteen zelf naar adressen die erop lijken — zodat een typefout in
 * de agenda ("Kalverstraat 220 DP" i.p.v. "220A") direct met de juiste
 * alternatieven te herstellen is i.p.v. alleen een waarschuwing te geven.
 *
 * Bij een netwerkfout bewust `ok: true`: alleen een bevestigde "0
 * resultaten" mag als waarschuwing gelden, anders krijg je vals alarm zodra
 * het netwerk hapert.
 */
export async function checkBagAddress(query: string): Promise<BagCheckResult> {
  const exact = await searchLabels(query);
  if (exact === null) return { ok: true, similar: [] };
  if (exact.length > 0) return { ok: true, similar: [] };

  for (const relaxed of relaxedBagQueries(query)) {
    const labels = await searchLabels(relaxed);
    if (labels && labels.length > 0) return { ok: false, similar: labels.slice(0, 5) };
  }
  return { ok: false, similar: [] };
}
