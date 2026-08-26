import { NextResponse } from "next/server";
import { getOrCreateSharedLink, getSharedAccessToken, listFolderFiles } from "@/lib/dropbox";

/**
 * Lijst de bestanden in een submap van het project (zodat de documenten-
 * pagina automatisch kan tonen wat er al via Dropbox is geüpload) en geeft
 * er een deel-link bij, zodat de opnemer met één klik precies díe submap
 * kan openen om te uploaden.
 */
export async function POST(request: Request) {
  const body = (await request.json()) as { path?: string };
  if (!body.path) {
    return NextResponse.json({ error: "missing_path" }, { status: 400 });
  }

  try {
    const accessToken = await getSharedAccessToken();
    const [files, url] = await Promise.all([
      listFolderFiles(accessToken, body.path),
      getOrCreateSharedLink(accessToken, body.path).catch(() => null),
    ]);
    return NextResponse.json({ files, url });
  } catch (err) {
    console.error("Failed to list Dropbox folder", err);
    return NextResponse.json({ error: "list_failed" }, { status: 502 });
  }
}
