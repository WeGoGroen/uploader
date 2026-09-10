import { NextResponse } from "next/server";
import { huidigeMediataskGebruiker, listOrders, listPointclouds } from "@/lib/mediatask";
import { getActiveAccountName } from "@/lib/active-account";
import { eigenOrders } from "@/lib/mediatask-format";
import { getOptionalRedis } from "@/lib/redis";
import { leesOrderTijd } from "@/lib/mediatask-pointclouds";

/**
 * Per recente order van jóu: hoeveel scans er verwerkt zijn bij Mediatask.
 *
 * Bestaat omdat je dit anders alleen tijdens de upload-pop-up kon zien. Sluit
 * de opnemer die af — en dat mag, verwerking duurt een kwartier — dan was er
 * geen enkele plek meer waar je kon zien of het goed is gekomen. Dan moest je
 * in Mediatask zelf gaan kijken.
 *
 * "Van jou" is hier het hele punt. De orderlijst van Mediatask is die van het
 * hele bureau, en deze kaart hing bovendien aan één cachesleutel voor de hele
 * app: wie als eerste zijn dashboard opende vulde hem, en daarna keek iedereen
 * naar diezelfde scans. Zo stond de scan van Yannick op het dashboard van
 * Nicette. Sinds iedereen zijn eigen Mediatask-sleutel heeft, zegt Mediatask
 * zelf bij elke order wie de eigenaar is — dat is het antwoord, en de cache
 * staat per persoon.
 *
 * Elke order kost een aparte aanroep bij Mediatask, dus het antwoord gaat een
 * paar minuten in de cache: dit is een overzicht, geen live meter.
 */
export const maxDuration = 60;

const CACHE_PREFIX = "mediatask:scanstatus:";
const CACHE_SECONDEN = 180;

export interface ScanStatus {
  orderId: number;
  adres: string;
  totaal: number;
  klaar: number;
  /** "verwerkt" = alles goed, "bezig" = nog niet klaar, "mislukt" = afgekeurd. */
  stand: "verwerkt" | "bezig" | "mislukt" | "geen";
  /** Hoe lang de order al bestaat, in uren — na een dag is "bezig" geen wachten meer maar een probleem. */
  ouderdomUur: number | null;
}

export async function GET(request: Request) {
  const ververs = new URL(request.url).searchParams.get("ververs") === "1";
  const redis = getOptionalRedis();

  // Zonder sessie is er geen "jouw werk" om te tonen. De cachesleutel hangt aan
  // de naam uit die sessie, zodat niemand het antwoord van een ander leest.
  const ikBen = await getActiveAccountName();
  if (!ikBen) return NextResponse.json({ statussen: [] });
  const cacheKey = `${CACHE_PREFIX}${ikBen}`;

  if (!ververs && redis) {
    const bewaard = await redis.get(cacheKey).catch(() => null);
    if (bewaard) {
      try {
        return NextResponse.json({ ...JSON.parse(bewaard), uitCache: true });
      } catch {
        // Onleesbare cache: gewoon opnieuw ophalen.
      }
    }
  }

  try {
    /*
      Alleen de orders die bij Mediatask op jouw naam staan.

      Wie nog geen eigen sleutel heeft, werkt op de gedeelde: zijn orders komen
      daar dan onder de eigenaar van díe sleutel te staan, en zijn dus niet van
      die van de eigenaar te onderscheiden. Dan liever een lege kaart dan het
      werk van iemand anders — de werknemerspagina in het Business Control
      Center vraagt intussen om zijn sleutel.
    */
    const ik = await huidigeMediataskGebruiker();
    if (!ik?.eigen) return NextResponse.json({ statussen: [] });

    // Eerst filteren, dan pas afkappen: anders duwt een drukke collega jouw
    // eigen scans uit de lijst van acht.
    const orders = eigenOrders(await listOrders(), ik.id).slice(0, 8);
    const statussen: ScanStatus[] = [];

    for (const o of orders) {
      const pcs = await listPointclouds(o.id).catch(() => []);
      if (pcs.length === 0) continue;

      const klaar = pcs.filter((p) => (p.images?.length ?? 0) > 0).length;
      // Mediatask geeft geen aanmaakmoment terug; we gebruiken het moment
      // waarop wij de order aanmaakten (vastgelegd bij het versturen).
      const gemaakt = await leesOrderTijd(o.id);
      const ouderdomUur = gemaakt ? Math.round((Date.now() - gemaakt) / 3600000) : null;

      // Een scan die na een dag nog geen beelden heeft is niet meer "bezig".
      // Dat blijven melden als bezig houdt een probleem verborgen.
      //
      // Onbekende ouderdom telt óók als oud: dat zijn orders van vóór we het
      // aanmaakmoment gingen vastleggen, of orders die buiten deze app om zijn
      // gemaakt. Die zijn per definitie niet "net verstuurd", en ze eeuwig als
      // bezig tonen zou de kaart vullen met wachtberichten die nooit omslaan.
      const oud = ouderdomUur === null || ouderdomUur >= 24;
      const stand: ScanStatus["stand"] =
        klaar === pcs.length ? "verwerkt" : oud ? "mislukt" : "bezig";

      statussen.push({
        orderId: o.id,
        adres: o.address || `Order #${o.id}`,
        totaal: pcs.length,
        klaar,
        stand,
        ouderdomUur,
      });
    }

    const antwoord = { statussen, opgehaald: new Date().toISOString() };
    if (redis) await redis.set(cacheKey, JSON.stringify(antwoord), "EX", CACHE_SECONDEN).catch(() => {});
    return NextResponse.json(antwoord);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Scanstatus ophalen mislukt" },
      { status: 502 }
    );
  }
}
