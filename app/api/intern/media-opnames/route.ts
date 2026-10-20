import { NextResponse } from "next/server";
import { isInternRequest } from "@/lib/intern-auth";
import { listDrafts } from "@/lib/drafts";

export const maxDuration = 30;

/** Ruim genoeg voor de 90 dagen die een afgeronde opname bewaard blijft. */
const LIMIET = 1000;

/**
 * Wie welke media-opname deed, voor de kolom "Geüpload door" in het Business
 * Control Center.
 *
 * Een media-opname legt haar id vast als `media-${folder.path}` (zie
 * MediaFlow) — de Dropbox-projectmap, met het account dat ingelogd was. Dat
 * is de enige plek waar de uploader onthoudt wie er uploadde: de bestanden
 * zelf gaan met het gedeelde Dropbox-token, dus Dropbox weet het niet.
 *
 * Alleen map, account en tijd; geen formulierstaat.
 */
export async function GET(request: Request) {
  if (!isInternRequest(request)) {
    return NextResponse.json({ error: "niet_toegestaan" }, { status: 401 });
  }

  const opnames = (await listDrafts(LIMIET))
    .filter((d) => d.soort === "media" && d.id.startsWith("media-/"))
    .map((d) => ({
      map: d.id.slice("media-".length),
      account: d.adviseur ?? d.accountName,
      status: d.status,
      bijgewerktOp: d.updatedAt,
    }));

  return NextResponse.json({ opnames });
}
