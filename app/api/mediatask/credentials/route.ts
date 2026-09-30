import { NextResponse } from "next/server";
import {
  getStoredMediataskCredentials,
  isToegestaneMediataskUrl,
  saveMediataskCredentials,
} from "@/lib/mediatask";

/** Handmatige invoer van het Mediatask-token/basis-URL via Koppelingen. */
export async function POST(request: Request) {
  const body = ((await request.json().catch(() => null)) ?? {}) as { token?: string; baseUrl?: string };
  const token = body.token?.trim();
  const baseUrl = body.baseUrl?.trim().replace(/\/$/, "");
  if (!token || !baseUrl) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }
  // Vóór de eerste aanroep: anders gaat het token al mee naar dat adres.
  const bekend = [process.env.MEDIATASK_API_BASE, (await getStoredMediataskCredentials().catch(() => null))?.baseUrl];
  if (!isToegestaneMediataskUrl(baseUrl, bekend)) {
    return NextResponse.json({ error: "invalid_base_url" }, { status: 400 });
  }

  try {
    const res = await fetch(`${baseUrl}/api/agencies`, {
      headers: { "X-Api-Token": token },
      cache: "no-store",
    });
    if (!res.ok) {
      return NextResponse.json({ error: "invalid_credentials" }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: "unreachable" }, { status: 400 });
  }

  try {
    await saveMediataskCredentials(token, baseUrl);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Opslaan is mislukt" },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true });
}
