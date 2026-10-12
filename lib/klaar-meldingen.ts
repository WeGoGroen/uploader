import { requireRedis } from "@/lib/redis";
import { adresSleutel, splitAddress } from "@/lib/address-format";

/**
 * Vangnet voor wanneer de automatische matching (ClickUp-taaknaam of concept
 * exact tegen de agenda-adrestekst) een echt afgeronde opname toch als
 * "nog niet uitgewerkt" laat zien — bijvoorbeeld omdat de opnemer bij het
 * starten een net iets andere schrijfwijze koos (bv. via "Bedoelde je?" een
 * ander BAG-adres aanklikte dan de agenda-tekst). Zonder dit vangnet blijft
 * zo'n afspraak dan voorgoed rood staan, terwijl het werk allang klaar is —
 * en dat is precies het signaal dat de opnemer niet meer vertrouwt.
 *
 * Bewust geen aparte "adres corrigeren"-stroom: dit is een expliciete
 * menselijke bevestiging ("ik heb dit echt gedaan"), geen automatische gok.
 * Daarom géén fuzzy matching hier — alleen de exacte straatregel die de
 * opnemer op dat moment zag, zodat een verkeerde klik nooit een ander adres
 * groen kleurt.
 *
 * Per dienst apart: "energielabel al gedaan" zegt niets over de NEN2580 op
 * hetzelfde adres. Meldingen van vóór die splitsing (`klaar-melding:<adres>`)
 * golden alleen voor energielabel en worden ook zo gelezen.
 */
export type KlaarDienst = "energielabel" | "nen";

const PREFIX = "klaar-melding:";
const DIENSTEN: KlaarDienst[] = ["energielabel", "nen"];
const sleutel = (street: string) => adresSleutel(splitAddress(street).street);
const KEY = (dienst: KlaarDienst, street: string) => `${PREFIX}${dienst}:${sleutel(street)}`;
const OUDE_KEY = (street: string) => `${PREFIX}${sleutel(street)}`;

// Een agendadag is voldoende, maar afspraken schuiven weleens door — twee
// weken geeft ruim de marge zonder dat de sleutel voor altijd blijft hangen.
const BEWAAR_SECONDEN = 14 * 24 * 60 * 60;

export async function meldKlaar(street: string, dienst: KlaarDienst = "energielabel"): Promise<void> {
  const redis = requireRedis();
  await redis.set(KEY(dienst, street), String(Date.now()), "EX", BEWAAR_SECONDEN);
}

/** Een melding terugdraaien — een verkeerde tik moet ongedaan te maken zijn. */
export async function trekKlaarIn(street: string, dienst: KlaarDienst): Promise<void> {
  const redis = requireRedis();
  const keys = [KEY(dienst, street)];
  if (dienst === "energielabel") keys.push(OUDE_KEY(street));
  await redis.del(...keys);
}

/** Voor de lijstweergave: in één keer alle meldingen, per dienst. */
export async function alleKlaarMeldingen(): Promise<Record<KlaarDienst, Set<string>>> {
  const redis = requireRedis();
  const uit: Record<KlaarDienst, Set<string>> = { energielabel: new Set(), nen: new Set() };
  const keys = await redis.keys(`${PREFIX}*`);
  for (const k of keys) {
    const rest = k.slice(PREFIX.length);
    const dienst = DIENSTEN.find((d) => rest.startsWith(`${d}:`));
    if (dienst) uit[dienst].add(rest.slice(dienst.length + 1));
    else uit.energielabel.add(rest);
  }
  return uit;
}

export function isKlaarDienst(v: unknown): v is KlaarDienst {
  return v === "energielabel" || v === "nen";
}
