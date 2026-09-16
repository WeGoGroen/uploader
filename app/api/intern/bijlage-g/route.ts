import { NextResponse } from "next/server";
import { isInternRequest } from "@/lib/intern-auth";
import { bijlageGVoorTaak } from "@/lib/bijlage-g";

export const maxDuration = 120;

/**
 * Zorgt dat Bijlage G (ISSO 82.1) in de projectmap van deze ClickUp-taak staat.
 *
 * Aangeroepen door de Energielabel AI Agent in het control center, die bijhoudt
 * welke opdracht de bijlage nog mist. Nieuwe projectmappen krijgen hem al bij
 * het aanmaken; deze route is voor alles wat daarvoor bestond.
 */
export async function POST(request: Request) {
  if (!isInternRequest(request)) {
    return NextResponse.json({ error: "niet_toegestaan" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as { taskId?: string } | null;
  const taskId = body?.taskId?.trim() ?? "";
  if (!taskId) return NextResponse.json({ error: "taskId ontbreekt" }, { status: 400 });

  try {
    const uitkomst = await bijlageGVoorTaak(taskId);
    // 200 ook als de bijlage er niet kwam: dít verzoek is gelukt, en de agent
    // heeft de code nodig om te bepalen of opnieuw proberen zin heeft.
    return NextResponse.json(uitkomst);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message.slice(0, 300) : "onbekende fout" },
      { status: 502 }
    );
  }
}
