import { NextResponse } from "next/server";
import { isInternRequest } from "@/lib/intern-auth";
import { draaiInhaalronde } from "@/lib/sharepoint-inhaal";

export const maxDuration = 300;

/**
 * Controleert of elke opgeleverde SharePoint-map (Gereed) in een projectmap
 * onder /Automatie Energielabels staat, en haalt op wat er mist. Begrensd per
 * aanroep (?max=, standaard 8): elke map is een volledige overdracht, en
 * dertig tegelijk past niet in één serverless-aanroep. "nogTeDoen" in het
 * antwoord zegt of er nog een aanroep nodig is.
 */
export async function POST(request: Request) {
  if (!isInternRequest(request)) {
    return NextResponse.json({ error: "niet_toegestaan" }, { status: 401 });
  }
  const max = Number(new URL(request.url).searchParams.get("max")) || 8;
  try {
    const uitkomst = await draaiInhaalronde(Math.min(Math.max(max, 1), 20));
    return NextResponse.json(uitkomst);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message.slice(0, 300) : "onbekende fout" },
      { status: 502 }
    );
  }
}
