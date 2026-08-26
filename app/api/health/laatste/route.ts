import { NextResponse } from "next/server";
import { laatsteRapport } from "@/lib/health";

/** Laatste uitslag van de ochtendcontrole, voor de melding op het dashboard. */
export async function GET() {
  const rapport = await laatsteRapport();
  if (!rapport) return NextResponse.json({ error: "nog geen controle gedraaid" }, { status: 404 });
  return NextResponse.json(rapport);
}
