import { NextResponse } from "next/server";
import { getAgencies, getPriorities, getProducts } from "@/lib/mediatask";

/**
 * Haalt de vaste keuzelijsten op die nodig zijn om een NEN-order aan te
 * maken (bureaus, prioriteiten, producten + hun configuratie-opties) —
 * live bij Mediatask, geen kopie in de code.
 */
export async function GET() {
  try {
    const [agencies, priorities, products] = await Promise.all([getAgencies(), getPriorities(), getProducts()]);
    return NextResponse.json({ agencies, priorities, products });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Mediatask niet bereikbaar" },
      { status: 500 }
    );
  }
}
