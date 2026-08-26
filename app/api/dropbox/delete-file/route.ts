import { NextResponse } from "next/server";
import { deleteFile, getSharedAccessToken } from "@/lib/dropbox";

/**
 * Verwijdert één bestand uit Dropbox — gebruikt om een RAW-scan die per
 * ongeluk in de Optimized-map is gekozen weer weg te halen (die hoort in
 * RAW, niet in Optimized).
 */
export async function POST(request: Request) {
  const body = (await request.json()) as { path?: string };
  if (!body.path) return NextResponse.json({ error: "missing_fields" }, { status: 400 });

  try {
    const accessToken = await getSharedAccessToken();
    await deleteFile(accessToken, body.path);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("Failed to delete file from Dropbox", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Verwijderen mislukt" },
      { status: 502 }
    );
  }
}
