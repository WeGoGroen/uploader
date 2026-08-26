import { NextResponse } from "next/server";
import { listDrafts, saveDraft, type DraftRecord } from "@/lib/drafts";

export async function GET() {
  try {
    const drafts = await listDrafts();
    return NextResponse.json({ drafts });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Kon concepten niet laden" },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  const body = (await request.json()) as Partial<DraftRecord> & { id: string };
  if (!body.id) {
    return NextResponse.json({ error: "missing_id" }, { status: 400 });
  }

  const now = body.updatedAt ?? Date.now();
  const record: DraftRecord = {
    id: body.id,
    status: body.status ?? "concept",
    titel: body.titel ?? "",
    straatnaam: body.straatnaam ?? "",
    postcode: body.postcode ?? "",
    woonplaats: body.woonplaats ?? "",
    accountName: body.accountName ?? null,
    soort: body.soort ?? "energielabel",
    clickupTaskUrl: body.clickupTaskUrl ?? null,
    incompleteDocs: body.incompleteDocs ?? [],
    // Afgeleid bij opslaan zodat lijsten de formulierstaat niet nodig hebben.
    // heeftMediatask kan de server zelf zien; adviseur en ontbrekende velden
    // vragen de ClickUp-veldenlijst, en die heeft de client al bij de hand.
    heeftMediatask: !!(body.state as { mediatask?: unknown } | undefined)?.mediatask,
    adviseur: body.adviseur ?? null,
    ontbrekendeVelden: body.ontbrekendeVelden ?? [],
    createdAt: body.createdAt ?? now,
    updatedAt: now,
    state: body.state ?? {},
  };

  try {
    await saveDraft(record);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Kon concept niet opslaan" },
      { status: 500 }
    );
  }
}
