import { NextResponse } from "next/server";
import { isInternRequest } from "@/lib/intern-auth";
import { createFolder, folderExists, getSharedAccessToken, uploadFile } from "@/lib/dropbox";
import { FOTOMAP, isKopieNaam, isProjectmap } from "@/lib/fotos-opruimen";

export const maxDuration = 60;

/**
 * Zet een opgemaakte kopie van een foto in de map "Foto's" van het project: de
 * foto met het plaatje aangewezen, en rechts het knipstuk en wat erop staat.
 * Het control center maakt het beeld; deze app heeft de Dropbox-sleutel.
 *
 * Alleen een projectmap van een energielabel, en alleen een bestand met het
 * achtervoegsel van een kopie. Daardoor kan deze route geen origineel raken: een
 * tweede ronde overschrijft hooguit de eigen kopie.
 */
export async function POST(request: Request) {
  if (!isInternRequest(request)) {
    return NextResponse.json({ error: "niet_toegestaan" }, { status: 401 });
  }
  const body = (await request.json().catch(() => null)) as
    | { projectmap?: string; naam?: string; data?: string }
    | null;
  const projectmap = body?.projectmap?.trim() ?? "";
  const naam = body?.naam?.trim() ?? "";
  if (!isProjectmap(projectmap)) {
    return NextResponse.json({ error: `geen projectmap: "${projectmap}"` }, { status: 400 });
  }
  if (!isKopieNaam(naam)) {
    return NextResponse.json({ error: `geen naam van een kopie: "${naam}"` }, { status: 400 });
  }
  if (!body?.data) return NextResponse.json({ error: "data ontbreekt" }, { status: 400 });

  try {
    const token = await getSharedAccessToken();
    const map = `${projectmap}/${FOTOMAP}`;
    if (!(await folderExists(token, map))) await createFolder(token, map);
    const pad = `${map}/${naam}`;
    await uploadFile(token, pad, Buffer.from(body.data, "base64"));
    return NextResponse.json({ ok: true, pad });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message.slice(0, 300) : "onbekende fout" },
      { status: 502 }
    );
  }
}
