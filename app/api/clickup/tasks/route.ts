import { NextResponse } from "next/server";
import { getRecentTaskNames, requireClickUpConfig } from "@/lib/clickup";
import { getActiveAccountName } from "@/lib/active-account";
import { getOptionalRedis } from "@/lib/redis";
import { CACHE_KEY, CACHE_SECONDEN } from "@/lib/clickup-taken-cache";

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
