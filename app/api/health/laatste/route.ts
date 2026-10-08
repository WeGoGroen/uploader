import { NextResponse } from "next/server";
import { laatsteRapport } from "@/lib/health";
import { huidigeSessie } from "@/lib/sessie-server";
import { isInternRequest } from "@/lib/intern-auth";

/**
 * Laatste uitslag van de ochtendcontrole, voor de melding op de
 * Koppelingen-pagina.
 *
 * Met een eigen controle: de middleware laat alles onder /api/health door
 * (de ochtendcontrole zelf draait via Vercel Cron zonder sessie), en daarmee
 * stond deze route open voor iedereen. De uitslag bevat foutteksten van
 * Microsoft, Dropbox en de mail, en dat hoort niet op straat.
 */
export async function GET(request: Request) {
  if (!(await huidigeSessie()) && !isInternRequest(request)) {
    return NextResponse.json({ error: "niet_ingelogd" }, { status: 401 });
  }
  const rapport = await laatsteRapport();
  if (!rapport) return NextResponse.json({ error: "nog geen controle gedraaid" }, { status: 404 });
  return NextResponse.json(rapport);
}
