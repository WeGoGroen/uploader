import { NextResponse } from "next/server";
import { getSharedAccessToken } from "@/lib/dropbox";

/**
 * Geeft een kortlopend Dropbox-toegangstoken aan de browser, zodat grote
 * scans rechtstreeks — en in grote, parallelle blokken — naar Dropbox kunnen
 * i.p.v. via onze server in stukjes van 4MB. Dat is de snelste weg die
 * Dropbox biedt voor bestanden boven de 150MB.
 *
 * Dit token geeft toegang tot het hele Dropbox-account, dus deze route is
 * alleen bruikbaar achter de inlog (zie middleware.ts). Het token wordt in de
 * browser uitsluitend in het geheugen gehouden, nooit opgeslagen.
 */
export async function GET() {
  try {
    const token = await getSharedAccessToken();
    return NextResponse.json(
      { token },
      // Nooit in een tussenliggende cache belanden.
      { headers: { "Cache-Control": "no-store, private" } }
    );
  } catch (err) {
    console.error("Failed to mint Dropbox session token", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Token ophalen mislukt" },
      { status: 502 }
    );
  }
}
