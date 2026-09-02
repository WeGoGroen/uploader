import { NextResponse } from "next/server";
import { isInternRequest } from "@/lib/intern-auth";
import { overdrachtVoorTaak } from "@/lib/sharepoint-overdracht";

export const maxDuration = 300;

/**
 * Haalt alsnog de opgeleverde map van MO Consultancy uit SharePoint en zet hem
 * in de Dropbox-projectmap onder "Automatie Energielabels".
 *
 * Dezelfde handeling die de ClickUp-webhook doet zodra een taak op klaar gaat,
 * maar dan als opdracht van het control center. Die tweede aanleiding is nodig
 * omdat een webhook een gebeurtenis is en geen toestand: hij komt één keer
 * langs, en als SharePoint op dat moment plat lag of de taak al op klaar stond
 * voordat de koppeling bestond, komt hij nooit meer terug. De Energielabel AI
 * Agent kijkt daarom achteraf welke projectmap nog geen 🟢 heeft, en roept dit
 * eindpunt aan tot het klopt.
 */
export async function POST(request: Request) {
  if (!isInternRequest(request)) {
    return NextResponse.json({ error: "niet_toegestaan" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as { taskId?: string } | null;
  const taskId = body?.taskId?.trim() ?? "";
  if (!taskId) return NextResponse.json({ error: "taskId ontbreekt" }, { status: 400 });

  try {
    const uitkomst = await overdrachtVoorTaak(taskId);
    // 200 ook als het niet gelukt is: dít verzoek is wél gelukt, en de agent
    // heeft de code nodig om te bepalen of opnieuw proberen zin heeft. Een 5xx
    // zou dat onderscheid platslaan tot "de uploader deed het niet".
    return NextResponse.json(uitkomst);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message.slice(0, 300) : "onbekende fout" },
      { status: 502 }
    );
  }
}
