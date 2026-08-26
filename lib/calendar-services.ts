const NEN_RE = /\bnen[\s-]?2580\b/i;
// "Quickscan" en "EPA(-W)" zijn interne benamingen voor energielabel-diensten
// (zie het "Diensten:"-veld in de agenda-omschrijving hieronder).
const ENERGIELABEL_RE = /energielabel|energie[\s-]?label|\bepa(-w)?\b|quickscan/i;

// Het boekingssysteem zet een gestructureerde "Diensten: <...>"-regel in de
// omschrijving (naast Klant/Adres/Medewerker/Notities) — dat is de
// betrouwbaarste bron om op te matchen, want die bevat expliciet welke
// dienst het is en niets anders (geen klantnaam, adres, notities e.d. die
// toevallig een trefwoord kunnen bevatten).
const DIENSTEN_LINE_RE = /^diensten:\s*(.+)$/im;
const KLANT_LINE_RE = /^klant:\s*(.+)$/im;
const OPPERVLAKTE_RE = /(\d+(?:[.,]\d+)?)\s*m(?:2|²)(?![a-z0-9])/i;

export interface DetectedServices {
  energielabel: boolean;
  nen: boolean;
  /** Of er daadwerkelijk een trefwoord is gevonden, i.p.v. de terugval. */
  explicit: boolean;
}

function extractDienstenField(description: string | null): string | null {
  if (!description) return null;
  return description.match(DIENSTEN_LINE_RE)?.[1]?.trim() ?? null;
}

/** Leest het "Klant:"-veld uit de agenda-omschrijving, voor het automatisch filteren van het Mediatask-bureau. */
export function extractKlant(description: string | null): string | null {
  if (!description) return null;
  return description.match(KLANT_LINE_RE)?.[1]?.trim() ?? null;
}

/**
 * Leest een oppervlakte (bv. "90m2", "90 m²") uit de agenda-omschrijving —
 * meestal in de vrije "Notities:"-tekst — om het bruto vloeroppervlak bij
 * NEN2580 vast in te vullen. Zoekt in de hele omschrijving (niet alleen
 * Notities), want de plek waar dit staat verschilt per afspraak.
 */
export function extractGrossFloorArea(description: string | null): number | null {
  if (!description) return null;
  const m = description.match(OPPERVLAKTE_RE);
  if (!m) return null;
  const value = parseFloat(m[1].replace(",", "."));
  return Number.isFinite(value) ? value : null;
}

/**
 * Leest uit een agenda-afspraak welke dienst(en) het betreft, puur op basis
 * van trefwoorden — geen terugval. Handig voor UI-elementen (zoals een tag)
 * die alleen iets moeten tonen als er echt iets herkend is, i.p.v. altijd
 * een default te laten zien.
 *
 * Matcht bij voorkeur alleen tegen het "Diensten:"-veld uit de omschrijving
 * (zie DIENSTEN_LINE_RE) — dat voorkomt valse treffers uit de klantnaam,
 * het adres of notities. Zonder dat veld (oudere/andere agenda-items) wordt
 * op de volledige titel + omschrijving gezocht, als beste benadering.
 */
export function matchServices(summary: string, description: string | null): { energielabel: boolean; nen: boolean } {
  const diensten = extractDienstenField(description);
  const text = diensten ?? `${summary} ${description ?? ""}`;
  return { nen: NEN_RE.test(text), energielabel: ENERGIELABEL_RE.test(text) };
}

/**
 * Zelfde als matchServices, maar valt terug op "allebei" als er niets
 * expliciet herkend is — voor logica die per se een keuze moet maken (bv.
 * het dashboard, dat anders geen enkele status zou tonen). Staat geen van
 * beide expliciet in de tekst (bv. "Bezichtiging"), dan blijven we voor de
 * zekerheid allebei tonen — beter een overbodig statusje dan een gemiste
 * dienst.
 */
export function detectServices(summary: string, description: string | null): DetectedServices {
  const { nen, energielabel } = matchServices(summary, description);
  if (!nen && !energielabel) return { energielabel: true, nen: true, explicit: false };
  return { energielabel, nen, explicit: true };
}
