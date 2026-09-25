import { NextResponse } from "next/server";
import { isInternRequest } from "@/lib/intern-auth";
import { createTemporaryUploadLink, getOrCreateSharedLink, getSharedAccessToken } from "@/lib/dropbox";
import { omgevingsfotoDoelPad, OMGEVINGSFOTO_HOOFDMAP } from "@/lib/omgevingsfoto-pad";

export const maxDuration = 30;

/**
 * Een uploadlink voor één omgevingsfoto in "/Omgevingsfoto's/<adres>".
 *
 * Voor de knop op de omgevingsfotokaart in het control center: die kopieert
 * de gekozen foto's uit de Master B-roll Library naar een map per adres. De
 * bytes gaan niet door deze server (een foto is tot dertig megabyte, een
 * verzoeklichaam hier vierenhalf); het control center krijgt een link die
 * voor precies dit ene pad geldt.
 *
 * De map ontstaat vanzelf bij de eerste upload. Overschrijven mag: dezelfde
 * foto twee keer toevoegen levert één bestand op, geen "(1)"-kopie.
 */
export async function POST(request: Request) {
  if (!isInternRequest(request)) {
    return NextResponse.json({ error: "niet_toegestaan" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as {
    adresmap?: string;
    bestandsnaam?: string;
  } | null;

  const pad = omgevingsfotoDoelPad(body?.adresmap ?? "", body?.bestandsnaam ?? "");
  if (!pad) {
    return NextResponse.json(
      { error: `adresmap moet een adres met huisnummer zijn en de bestandsnaam een beeldbestand` },
      { status: 400 }
    );
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

  try {
    const link = await createTemporaryUploadLink(token, pad);
    return NextResponse.json({ ok: true, link, pad, hoofdmap: `/${OMGEVINGSFOTO_HOOFDMAP}` });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message.slice(0, 200) : "uploadlink maken mislukt" },
      { status: 502 }
    );
  }
}

/**
 * De deelbare link naar een adresmap, nadat de foto's erin staan. Apart van
 * de uploadlink: bij het uitdelen van die link is de map er nog niet.
 */
export async function PUT(request: Request) {
  if (!isInternRequest(request)) {
    return NextResponse.json({ error: "niet_toegestaan" }, { status: 401 });
  }
  const body = (await request.json().catch(() => null)) as { adresmap?: string } | null;
  const pad = omgevingsfotoDoelPad(body?.adresmap ?? "", "x.jpg");
  if (!pad) return NextResponse.json({ error: "adresmap ongeldig" }, { status: 400 });
  const map = pad.slice(0, pad.lastIndexOf("/"));
  try {
    const token = await getSharedAccessToken();
    const link = await getOrCreateSharedLink(token, map);
    return NextResponse.json({ ok: true, link, pad: map });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message.slice(0, 200) : "deellink maken mislukt" },
      { status: 502 }
    );
  }
}
