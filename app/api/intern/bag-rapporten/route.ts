import { NextResponse } from "next/server";
import { isInternRequest } from "@/lib/intern-auth";
import { getSharedAccessToken, leesProjectmap } from "@/lib/dropbox";
import { zorgVoorBagRapporten } from "@/lib/bag-rapporten";
import { HOOFDMAP, isProjectmap } from "@/lib/fotos-opruimen";

export const maxDuration = 300;

/**
 * Het BAG-rapport en het 3D BAG-rapport achteraf in een projectmap zetten.
 *
 * Ze worden gemaakt bij het aanmaken van de projectmap, maar dat is
 * best-effort: lukte het toen niet, of is de map van vóór deze rapporten, dan
 * bleef het dossier voorgoed op "BAG-rapport ontbreekt" staan. Op 13 oktober
 * gold dat voor 57 projecten. De finalisatie in het control center roept dit
 * aan als het rapport ontbreekt.
 *
 * Grenzen: alleen een projectmap onder "Automatie Energielabels" (direct of in
 * "Afgerond"), aangewezen met zijn Dropbox-id; en nooit overschrijven — een
 * rapport dat er al staat blijft staan.
 */
export async function POST(request: Request) {
  if (!isInternRequest(request)) {
    return NextResponse.json({ error: "niet_toegestaan" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as {
    folder_id?: string;
    postcode?: string;
    huisnummer?: number;
    huisletter?: string | null;
    huisnummertoevoeging?: string | null;
  } | null;

  const folderId = body?.folder_id?.trim() ?? "";
  if (!/^id:[A-Za-z0-9_-]+$/.test(folderId)) {
    return NextResponse.json({ error: "folder_id (id:...) is verplicht" }, { status: 400 });
  }
  const postcode = (body?.postcode ?? "").replace(/\s+/g, "").toUpperCase();
  const huisnummer = Number(body?.huisnummer);
  if (!/^\d{4}[A-Z]{2}$/.test(postcode) || !Number.isInteger(huisnummer) || huisnummer <= 0) {
    return NextResponse.json({ error: "postcode en huisnummer zijn verplicht" }, { status: 400 });
  }

  let token: string;
  try {
    token = await getSharedAccessToken();
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message.slice(0, 200) : "Dropbox niet gekoppeld" },
      { status: 503 }
    );
  }

  let pad: string;
  try {
    pad = (await leesProjectmap(token, folderId, { diep: false })).pad;
  } catch (err) {
    const status = err instanceof Error && err.message.includes("404") ? 404 : 502;
    return NextResponse.json(
      { error: err instanceof Error ? err.message.slice(0, 200) : "map niet te lezen" },
      { status }
    );
  }
  if (!isProjectmap(pad)) {
    return NextResponse.json({ error: `alleen een projectmap onder /${HOOFDMAP} — kreeg "${pad}"` }, { status: 400 });
  }

  // De rapporten heten naar straat en huisnummer, zoals bij het aanmaken: de
  // projectmap heet "Lumièrestraat 88, Amsterdam".
  const straatEnNummer = (pad.split("/").pop() ?? "").split(",")[0].trim();

  const uit = await zorgVoorBagRapporten(
    token,
    pad,
    { postcode, huisnummer, huisletter: body?.huisletter ?? null, huisnummertoevoeging: body?.huisnummertoevoeging ?? null },
    straatEnNummer
  );
  return NextResponse.json({ ok: uit.fouten.length === 0, pad, ...uit });
}
