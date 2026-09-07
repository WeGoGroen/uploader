import { NextResponse } from "next/server";
import { isInternRequest } from "@/lib/intern-auth";
import { getSharedAccessToken, verwijderStatusMarkers } from "@/lib/dropbox";

export const maxDuration = 300;

const HOOFDMAPPEN = ["/Automatie Energielabels", "/Automatie NEN2580", "/Automatie Media"];

/**
 * Eenmalige opruimronde: haalt de statusbolletjes uit alle projectmapnamen.
 *
 * De bolletjes bleken op Windows opslag- en openproblemen te geven (emoji in
 * het pad, plus een hernoeming bij elke statuswissel), dus de status is
 * verhuisd naar Redis. Deze route ruimt de bestaande namen op; de status die
 * in de naam zat wordt eerst bewaard, er gaat niets verloren. Idempotent —
 * een tweede aanroep vindt niets meer om te hernoemen.
 */
export async function POST(request: Request) {
  if (!isInternRequest(request)) {
    return NextResponse.json({ error: "niet_toegestaan" }, { status: 401 });
  }

  const token = await getSharedAccessToken();
  const uitkomsten = [];
  for (const root of HOOFDMAPPEN) {
    try {
      const { hernoemd, overgeslagen } = await verwijderStatusMarkers(token, root);
      uitkomsten.push({ root, hernoemd, overgeslagen, fout: null as string | null });
    } catch (err) {
      uitkomsten.push({
        root,
        hernoemd: [],
        overgeslagen: [],
        fout: err instanceof Error ? err.message.slice(0, 200) : "onbekende fout",
      });
    }
  }
  return NextResponse.json({ uitkomsten });
}
