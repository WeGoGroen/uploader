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
 */
const KEY = (street: string) => `klaar-melding:${adresSleutel(splitAddress(street).street)}`;

// Een agendadag is voldoende, maar afspraken schuiven weleens door — twee
// weken geeft ruim de marge zonder dat de sleutel voor altijd blijft hangen.
const BEWAAR_SECONDEN = 14 * 24 * 60 * 60;

export async function meldKlaar(street: string): Promise<void> {
  const redis = requireRedis();
  await redis.set(KEY(street), String(Date.now()), "EX", BEWAAR_SECONDEN);
}

export async function isHandmatigKlaarGemeld(street: string): Promise<boolean> {
  const redis = requireRedis();
  return (await redis.exists(KEY(street))) === 1;
}

/** Voor de lijstweergave: in één keer alle meldingen die er zijn. */
export async function alleKlaarMeldingen(): Promise<Set<string>> {
  const redis = requireRedis();
  const keys = await redis.keys("klaar-melding:*");
  if (!keys.length) return new Set();
  return new Set(keys.map((k) => k.slice("klaar-melding:".length)));
}
