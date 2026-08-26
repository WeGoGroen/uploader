import { NextResponse } from "next/server";
import type { ProjectKind } from "@/lib/dropbox";
import { taskNameToAddress } from "@/lib/sharepoint-match";
import { SyncError, syncSharePointFiles } from "@/lib/sharepoint-sync";

/**
 * Handmatig de finale bestanden uit SharePoint ophalen voor één adres.
 * Dezelfde actie die de ClickUp-webhook automatisch doet, maar dan met een
 * knop — voor taken van vóór de webhook, of als er achteraf nog een bestand
 * bij komt.
 */
export async function POST(request: Request) {
  const body = (await request.json()) as {
    /** Of: straatregel + woonplaats los. */
    addressLine?: string;
    woonplaats?: string;
    /** Of: de volledige ClickUp-taaknaam ("Kerkstraat 12, 1234 AB Utrecht"). */
    taskName?: string;
    kind?: ProjectKind;
  };

  let addressLine = body.addressLine?.trim();
  let woonplaats = body.woonplaats?.trim();

  if ((!addressLine || !woonplaats) && body.taskName) {
    const parsed = taskNameToAddress(body.taskName);
    if (parsed) {
      addressLine = parsed.addressLine;
      woonplaats = parsed.woonplaats;
    }
  }

  if (!addressLine || !woonplaats) {
    return NextResponse.json({ error: "missing_address" }, { status: 400 });
  }

  try {
    const result = await syncSharePointFiles({
      kind: body.kind ?? "energielabel",
      addressLine,
      woonplaats,
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof SyncError) {
      return NextResponse.json({ error: err.code, detail: err.message }, { status: 404 });
    }
    console.error("SharePoint sync failed", err);
    return NextResponse.json(
      { error: "sync_failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
