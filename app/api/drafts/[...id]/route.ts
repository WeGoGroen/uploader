import { NextResponse } from "next/server";
import { deleteDraft, draftIdUitPad, getDraft } from "@/lib/drafts";

/*
  Bewust een catch-all ([...id]) en niet [id].

  Niet elk concept-id is één pad-segment. De media-opname legt haar id vast als
  `media-${folder.path}`, en dat is een Dropbox-pad: "media-/Automatie
  Media/Rustenburgerstraat 356-1, Amsterdam". Met [id] matchte zo'n verzoek
  deze route niet — DELETE liep op 502 en het concept bleef gewoon staan.

  Voor de gebruiker zag dat eruit alsof verwijderen niets deed: de opname
  verdween wel uit de lijst en stond daarna onverminderd op het dashboard, met
  zijn oorspronkelijke datum, want er was nooit iets weggehaald.

  De segmenten weer aan elkaar plakken levert exact het opgeslagen id op, ook
  als de client het van tevoren heeft gecodeerd: dan is het één segment en is
  de join een no-op. Zo werken oude en nieuwe aanroepen allebei.
*/

export async function GET(request: Request, { params }: { params: Promise<{ id: string[] }> }) {
  const id = draftIdUitPad((await params).id);
  if (!id) return NextResponse.json({ error: "missing_id" }, { status: 400 });
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

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string[] }> }) {
  const id = draftIdUitPad((await params).id);
  if (!id) return NextResponse.json({ error: "missing_id" }, { status: 400 });
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
