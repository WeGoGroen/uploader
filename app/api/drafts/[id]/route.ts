import { NextResponse } from "next/server";
import { deleteDraft, getDraft } from "@/lib/drafts";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const draft = await getDraft(id);
    if (!draft) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ draft });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Kon concept niet laden" },
      { status: 500 }
    );
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    await deleteDraft(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Kon concept niet verwijderen" },
      { status: 500 }
    );
  }
}
