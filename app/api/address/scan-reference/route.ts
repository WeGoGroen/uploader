import { NextResponse } from "next/server";
import { get3dBagHeights } from "@/lib/bag-pdf";
import { getAddressDetails, suggestAddresses } from "@/lib/pdok";

/**
 * Levert de twee getallen waarmee de scancontrole kan toetsen of er niets
 * ontbreekt: de gebruiksoppervlakte uit de BAG en het aantal bouwlagen uit
 * 3DBAG (afgeleid uit AHN-hoogtemetingen).
 *
 * Waarom apart van /api/address/details: de documentenpagina kent alleen het
 * adres uit de URL, niet het BAG-id. Deze route zoekt dat er zelf bij.
 *
 * Best-effort, met opzet. Beide registraties kloppen regelmatig niet — een
 * verbouwing die nooit is doorgegeven, een vlieghoogtemeting die er naast zit,
 * een verblijfsobject dat anders is ingedeeld dan de BAG denkt. Vandaar dat een
 * mislukte opzoeking hier gewoon `null` oplevert in plaats van een fout: de
 * controle draait door zonder deze vergelijking, en een verschil dat wél
 * gevonden wordt kleurt rood zonder de opname tegen te houden.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const q = url.searchParams.get("q")?.trim();
  if (!q) return NextResponse.json({ error: "missing_query" }, { status: 400 });

  try {
    const suggesties = await suggestAddresses(q);
    if (suggesties.length === 0) {
      return NextResponse.json({ oppervlakte: null, bouwlagen: null, gevonden: false });
    }

    const details = await getAddressDetails(suggesties[0].id);
    const hoogtes = details.pandIdentificatie
      ? await get3dBagHeights(details.pandIdentificatie).catch(() => null)
      : null;

    return NextResponse.json({
      gevonden: true,
      adres: `${details.straatnaam} ${details.huisnummer}`,
      oppervlakte: details.oppervlakte,
      bouwlagen: hoogtes?.bouwlagen ?? null,
    });
  } catch (err) {
    console.error("Referentiegegevens ophalen mislukt", err);
    // Geen 502: dit is aanvullende informatie, geen voorwaarde.
    return NextResponse.json({ oppervlakte: null, bouwlagen: null, gevonden: false });
  }
}
