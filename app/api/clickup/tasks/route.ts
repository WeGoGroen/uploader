import { NextResponse } from "next/server";
import { getRecentTaskNames, requireClickUpConfig } from "@/lib/clickup";
import { getActiveAccountName } from "@/lib/active-account";
import { getOptionalRedis } from "@/lib/redis";

const CACHE_KEY = "clickup:taaknamen";
/**
 * Kort cachen. Deze lijst wordt bij élke dashboardlading opgehaald, en met
 * meerdere opnemers tegelijk zou dat bij vijf pagina's een veelvoud aan
 * ClickUp-aanroepen geven. Een paar minuten oud is ruim genoeg: het gaat om
 * "is dit adres al gedaan", niet om iets dat per seconde verandert.
 */
const CACHE_SECONDEN = 180;

export async function GET() {
  const redis = getOptionalRedis();
  if (redis) {
    const gecachet = await redis.get(CACHE_KEY).catch(() => null);
    if (gecachet) {
      try {
        return NextResponse.json({ names: JSON.parse(gecachet) as string[], uitCache: true });
      } catch {
        // Onleesbare cache: gewoon opnieuw ophalen.
      }
    }
  }

  try {
    const activeAccount = await getActiveAccountName();
    const { token, listId } = await requireClickUpConfig(activeAccount);
    const names = await getRecentTaskNames(token, listId);
    if (redis) {
      await redis.set(CACHE_KEY, JSON.stringify(names), "EX", CACHE_SECONDEN).catch(() => {});
    }
    return NextResponse.json({ names });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Taken ophalen mislukt" },
      { status: 502 }
    );
  }
}
