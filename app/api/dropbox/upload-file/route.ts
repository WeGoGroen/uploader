import { NextResponse } from "next/server";
import { getSharedAccessToken, uploadFile } from "@/lib/dropbox";

// Grotere foto's/LAZ-scans mogen best even duren.
export const maxDuration = 60;

/**
 * Zet één bestand rechtstreeks vanuit de browser (bv. via de iPad-
 * documentkiezer) in een documentcategorie-map in Dropbox — gebruikt door de
 * "Bestand kiezen"-knoppen per map op de NEN2580-pagina.
 */
export async function POST(request: Request) {
  const form = await request.formData();
  const path = form.get("path");
  const file = form.get("file");
  if (typeof path !== "string" || !path || !(file instanceof File)) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  try {
    const accessToken = await getSharedAccessToken();
    const buffer = Buffer.from(await file.arrayBuffer());
    await uploadFile(accessToken, `${path}/${file.name}`, buffer);
    return NextResponse.json({ ok: true, name: file.name });
  } catch (err) {
    console.error("Failed to upload file to Dropbox", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Uploaden naar Dropbox mislukt" },
      { status: 502 }
    );
  }
}
