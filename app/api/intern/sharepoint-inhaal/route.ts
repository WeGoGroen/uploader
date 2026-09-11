import { NextResponse } from "next/server";
import { isInternRequest } from "@/lib/intern-auth";
import { draaiInhaalronde, vergeetWerklijst } from "@/lib/sharepoint-inhaal";

export const maxDuration = 300;

/**
 * Controleert of elke opgeleverde SharePoint-map (Gereed) in een projectmap
 * onder /Automatie Energielabels staat, en haalt op wat er mist.
 *
 *   ?kijk=1   alleen rapporteren, niets overzetten
 *   ?vers=1   de bewaarde werklijst weggooien en opnieuw meten
 *   ?max=N    hoeveel mappen deze aanroep overzet (standaard 8)
 *
 * Begrensd per aanroep omdat elke map een volledige overdracht is; dertig
 * tegelijk past niet in één serverless-aanroep. "nogTeDoen" zegt of er nog
 * een aanroep nodig is.
 */
export async function POST(request: Request) {
  if (!isInternRequest(request)) {
    return NextResponse.json({ error: "niet_toegestaan" }, { status: 401 });
  }
  const params = new URL(request.url).searchParams;
  const max = Number(params.get("max")) || 8;
  // ?kijk=1 rapporteert alleen wat er mist, zonder iets over te zetten — dat
  // is de controle "zit alles erin". ?vers=1 gooit de bewaarde werklijst weg
  // en meet opnieuw, voor als er net iets is bijgekomen.
  const alleenKijken = params.get("kijk") === "1";
  try {
    if (params.get("vers") === "1") await vergeetWerklijst();
    const uitkomst = await draaiInhaalronde(Math.min(Math.max(max, 1), 20), alleenKijken);
    return NextResponse.json(uitkomst);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message.slice(0, 300) : "onbekende fout" },
      { status: 502 }
    );
  }
}
