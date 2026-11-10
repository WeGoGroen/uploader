import { NextResponse } from "next/server";
import { laatsteScans, PolycamApiError, PolycamNietIngesteld } from "@/lib/polycam";

/** De laatste scans uit de Polycam-werkruimte, nieuwste eerst. */
export async function GET() {
  try {
    return NextResponse.json({ scans: await laatsteScans(12) });
  } catch (err) {
    if (err instanceof PolycamNietIngesteld) {
      return NextResponse.json({ error: "niet_ingesteld" }, { status: 503 });
    }
    console.error("[polycam/scans]", err);
    const geenToegang = err instanceof PolycamApiError && (err.status === 401 || err.status === 403);
    return NextResponse.json({ error: geenToegang ? "geen_toegang" : "ophalen_mislukt" }, { status: 502 });
  }
}
