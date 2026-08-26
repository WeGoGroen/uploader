import { NextResponse } from "next/server";
import { saveMediataskCredentials } from "@/lib/mediatask";

/** Handmatige invoer van het Mediatask-token/basis-URL via Koppelingen. */
export async function POST(request: Request) {
  const body = (await request.json()) as { token?: string; baseUrl?: string };
  const token = body.token?.trim();
  const baseUrl = body.baseUrl?.trim().replace(/\/$/, "");
  if (!token || !baseUrl) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
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
