import { NextResponse } from "next/server";
import { isInternRequest } from "@/lib/intern-auth";
import { createTemporaryUploadLink, deleteFile, getSharedAccessToken } from "@/lib/dropbox";
import { bibliotheekPad, uploadPad } from "@/lib/bibliotheek-pad";

export const maxDuration = 30;

/**
 * Omgevingsfoto's in de Master B-roll Library beheren vanuit het control
 * center: nieuwe foto's zetten (POST) en foto's verwijderen (DELETE). De
 * grenzen staan in lib/bibliotheek-pad.ts.
 *
 * POST geeft een uploadlink voor precies dat ene pad; de bytes gaan buiten
 * deze server om (een foto is tot dertig megabyte, een verzoeklichaam hier
 * vierenhalf).
 *
 * DELETE gaat via files/delete_v2: in Dropbox staat de foto daarna onder
 * "Verwijderde bestanden" en is hij terug te zetten.
 */
async function token(): Promise<string | NextResponse> {
  try {
    return await getSharedAccessToken();
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message.slice(0, 200) : "Dropbox niet gekoppeld" },
      { status: 503 }
    );
  }
}

export async function POST(request: Request) {
  if (!isInternRequest(request)) return NextResponse.json({ error: "niet_toegestaan" }, { status: 401 });
  const body = (await request.json().catch(() => null)) as { pad?: string } | null;
  const pad = uploadPad(body?.pad ?? "");
  if (!pad) {
    return NextResponse.json(
      { error: `alleen een beeldbestand onder Uploads/ in de bibliotheek — kreeg "${body?.pad ?? ""}"` },
      { status: 400 }
    );
  }
  const t = await token();
  if (typeof t !== "string") return t;
  try {
    return NextResponse.json({ ok: true, link: await createTemporaryUploadLink(t, pad), pad });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message.slice(0, 200) : "uploadlink maken mislukt" },
      { status: 502 }
    );
  }
}

export async function DELETE(request: Request) {
  if (!isInternRequest(request)) return NextResponse.json({ error: "niet_toegestaan" }, { status: 401 });
  const body = (await request.json().catch(() => null)) as { pad?: string } | null;
  const pad = bibliotheekPad(body?.pad ?? "");
  if (!pad) {
    return NextResponse.json(
      { error: `alleen een beeldbestand in de bibliotheek — kreeg "${body?.pad ?? ""}"` },
      { status: 400 }
    );
  }
  const t = await token();
  if (typeof t !== "string") return t;
  try {
    await deleteFile(t, pad);
    return NextResponse.json({ ok: true, pad });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message.slice(0, 200) : "verwijderen mislukt" },
      { status: 502 }
    );
  }
}
