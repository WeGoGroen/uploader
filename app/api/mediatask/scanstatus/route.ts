import { NextResponse } from "next/server";
import { listOrders, listPointclouds } from "@/lib/mediatask";
import { getOptionalRedis } from "@/lib/redis";
import { leesOrderTijd } from "@/lib/mediatask-pointclouds";

/**
 * Per recente order: hoeveel scans er verwerkt zijn bij Mediatask.
 *
 * Bestaat omdat je dit anders alleen tijdens de upload-pop-up kon zien. Sluit
 * de opnemer die af — en dat mag, verwerking duurt een kwartier — dan was er
 * geen enkele plek meer waar je kon zien of het goed is gekomen. Dan moest je
 * in Mediatask zelf gaan kijken.
 *
 * Elke order kost een aparte aanroep bij Mediatask, dus het antwoord gaat een
 * paar minuten in de cache: dit is een overzicht, geen live meter.
 */
export const maxDuration = 60;

const CACHE_KEY = "mediatask:scanstatus";
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

  if (!ververs && redis) {
    const bewaard = await redis.get(CACHE_KEY).catch(() => null);
    if (bewaard) {
      try {
        return NextResponse.json({ ...JSON.parse(bewaard), uitCache: true });
      } catch {
        // Onleesbare cache: gewoon opnieuw ophalen.
      }
    }
  }

  try {
    const orders = (await listOrders()).slice(0, 8);
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
    if (redis) await redis.set(CACHE_KEY, JSON.stringify(antwoord), "EX", CACHE_SECONDEN).catch(() => {});
    return NextResponse.json(antwoord);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Scanstatus ophalen mislukt" },
      { status: 502 }
    );
  }
}
