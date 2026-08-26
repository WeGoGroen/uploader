import { NextResponse } from "next/server";
import { listDraftsByStatus, telOpnames } from "@/lib/drafts";

/**
 * Kerncijfers over het wérk, niet over de koppelingen. De ochtendcontrole
 * zegt of de diensten het doen; dit zegt of het werk doorstroomt — en dat is
 * bij honderden opnames per maand het cijfer waarop je stuurt.
 */
export async function GET() {
  try {
    const [aantallen, concepten, geupload] = await Promise.all([
      telOpnames(),
      listDraftsByStatus("concept"),
      listDraftsByStatus("uploaded"),
    ]);

    const nu = Date.now();
    const dag = 24 * 60 * 60 * 1000;
    const sinds = (ms: number) => (d: { updatedAt: number }) => d.updatedAt >= nu - ms;

    return NextResponse.json({
      open: aantallen.concept,
      afgerond: aantallen.uploaded,
      vandaag: geupload.filter(sinds(dag)).length,
      afgelopenWeek: geupload.filter(sinds(7 * dag)).length,
      // Werk dat er afgerond uitziet maar het niet is.
      bijlagesOntbreken: geupload.filter((d) => (d.incompleteDocs?.length ?? 0) > 0).length,
      langOpenstaand: concepten.filter((d) => d.updatedAt < nu - 7 * dag).length,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Cijfers ophalen mislukt" },
      { status: 500 }
    );
  }
}
