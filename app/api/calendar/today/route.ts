import { NextResponse } from "next/server";
import { getAccessTokenForAccount, getTodayEvents } from "@/lib/google-calendar";
import { resolveActiveAccountName } from "@/lib/active-account";

export async function GET() {
  try {
    const accountName = await resolveActiveAccountName();
    const accessToken = await getAccessTokenForAccount(accountName);
    const events = await getTodayEvents(accessToken);
    return NextResponse.json({ events });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Agenda ophalen mislukt" },
      { status: 502 }
    );
  }
}
