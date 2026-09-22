import { NextResponse } from "next/server";
import { isInternRequest } from "@/lib/intern-auth";
import { dossierVoorTaak } from "@/lib/opname-dossier";
import type { DossierGroep } from "@/lib/opname-velden";

export const maxDuration = 300;

/**
 * Zet het opnameformulier van deze ClickUp-taak als PDF in de projectmap.
 *
 * Aangeroepen door de Energielabel AI Agent in het control center, die
 * bijhoudt welke opdracht nog geen dossier heeft. Dezelfde route doet de
 * inhaalslag over oud werk — één handeling, meerdere aanleidingen.
 *
 * Standaard gebeurt er niets als het bestand er al staat; met `opnieuw: true`
 * wordt het overschreven, bijvoorbeeld nadat er in ClickUp iets is bijgewerkt.
 */
export async function POST(request: Request) {
  if (!isInternRequest(request)) {
    return NextResponse.json({ error: "niet_toegestaan" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as
    | { taskId?: string; opnieuw?: boolean; extraGroepen?: DossierGroep[] }
    | null;
  const taskId = body?.taskId?.trim() ?? "";
  if (!taskId) return NextResponse.json({ error: "taskId ontbreekt" }, { status: 400 });

  try {
    /*
      extraGroepen komt van het Control Center: sectie F met wat er uit de
      opnamefoto's is gelezen. De uploader beoordeelt die inhoud niet — wie de
      velden bepaalt, bepaalt ook wat erin staat; hier worden ze alleen
      getekend.
    */
    const uitkomst = await dossierVoorTaak(taskId, {
      opnieuw: body?.opnieuw === true,
      extraGroepen: Array.isArray(body?.extraGroepen) ? body.extraGroepen : undefined,
    });
    // 200 ook als het dossier er niet kwam: dít verzoek is gelukt, en de agent
    // heeft de code nodig om te bepalen of opnieuw proberen zin heeft. Een 5xx
    // zou "geen adres in de taak" en "Dropbox lag eruit" op één hoop gooien.
    return NextResponse.json(uitkomst);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message.slice(0, 300) : "onbekende fout" },
      { status: 502 }
    );
  }
}
