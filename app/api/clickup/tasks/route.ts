import { NextResponse } from "next/server";
import { getRecentTasks, requireClickUpConfig } from "@/lib/clickup";
import { getActiveAccountName } from "@/lib/active-account";
import { getOptionalRedis } from "@/lib/redis";
import { CACHE_KEY, CACHE_SECONDEN } from "@/lib/clickup-taken-cache";

type Taak = { name: string; created: number | null };

/**
 * De recente taken van de energielabellijst, met aanmaakmoment. `names` blijft
 * erbij voor oudere aanroepers die alleen de namen kennen.
 */
export async function GET() {
  const redis = getOptionalRedis();
  if (redis) {
    const gecachet = await redis.get(CACHE_KEY).catch(() => null);
    if (gecachet) {
      try {
        const tasks = JSON.parse(gecachet) as Taak[];
        return NextResponse.json({ tasks, names: tasks.map((t) => t.name), uitCache: true });
      } catch {
        // Onleesbare cache: gewoon opnieuw ophalen.
      }
    }
  }

  try {
    const activeAccount = await getActiveAccountName();
    const { token, listId } = await requireClickUpConfig(activeAccount);
    const tasks = await getRecentTasks(token, listId);
    if (redis) {
      await redis.set(CACHE_KEY, JSON.stringify(tasks), "EX", CACHE_SECONDEN).catch(() => {});
    }
    return NextResponse.json({ tasks, names: tasks.map((t) => t.name) });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Taken ophalen mislukt" },
      { status: 502 }
    );
  }
}
