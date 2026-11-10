import { NextResponse } from "next/server";
import { isInternRequest } from "@/lib/intern-auth";
import { getMetadata, getSharedAccessToken, safeHeaderJson } from "@/lib/dropbox";
import { isProjectmap, leesInvoer } from "@/lib/afhandel-log";

export const maxDuration = 30;

const DROPBOX_CONTENT_BASE = "https://content.dropboxapi.com/2";

/**
 * Het afhandel-log van de Energielabel Afhandel-agent in de projectmap zetten.
 *
 * Bestaat naast bestand-plaatsen, en niet als uitbreiding daarvan: die route
 * neemt alleen een PDF aan, in de submap "EP-Online", omdat de checklist die
 * submap als de plek van het afschrift ziet. Een log daar zou "afschrift
 * aanwezig" laten zeggen terwijl het er niet is. Dit log komt direct in de
 * projectmap.
 *
 * Grenzen:
 *  - De map komt van het folder-ID dat het control center bij het project
 *    bewaart, nooit van een pad of adres. Het pad dat Dropbox erbij teruggeeft
 *    moet een projectmap onder "Automatie Energielabels" zijn.
 *  - Nooit overschrijven: Dropbox uploadt met mode "add" en autorename uit.
 *    Bestaat de naam al, dan is het antwoord 409 en blijft het oude bestand
 *    staan. De naam bevat datum en tijd, dus dat gebeurt alleen bij een
 *    herhaalde aanroep binnen dezelfde minuut.
 *  - Er wordt geen map aangemaakt.
 *
 * Het bestand is klein (hooguit 100 kB) en gaat daarom wél door deze server,
 * in één files/upload, in plaats van via een tijdelijke uploadlink.
 */
export async function POST(request: Request) {
  if (!isInternRequest(request)) {
    return NextResponse.json({ error: "niet_toegestaan" }, { status: 401 });
  }

  const invoer = leesInvoer(await request.json().catch(() => null));
  if (!invoer.ok) return NextResponse.json({ error: invoer.fout }, { status: 400 });

  let token: string;
  try {
    token = await getSharedAccessToken();
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message.slice(0, 200) : "Dropbox niet gekoppeld" },
      { status: 503 }
    );
  }

  let map: Awaited<ReturnType<typeof getMetadata>>;
  try {
    map = await getMetadata(token, invoer.folderId);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message.slice(0, 200) : "Dropbox niet te bevragen" },
      { status: 502 }
    );
  }
  if (!map || map[".tag"] !== "folder" || !map.path_display) {
    return NextResponse.json({ error: `geen map bij ${invoer.folderId}` }, { status: 404 });
  }
  if (!isProjectmap(map.path_display)) {
    return NextResponse.json(
      { error: `${map.path_display} is geen projectmap onder /Automatie Energielabels` },
      { status: 400 }
    );
  }

  const pad = `${map.path_display}/${invoer.bestandsnaam}`;
  const res = await fetch(`${DROPBOX_CONTENT_BASE}/files/upload`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/octet-stream",
      // "add" zonder autorename: bestaat de naam al, dan 409 en blijft het oude staan.
      "Dropbox-API-Arg": safeHeaderJson({ path: pad, mode: "add", autorename: false, mute: true }),
    },
    body: new Uint8Array(Buffer.from(invoer.inhoud, "utf8")),
    signal: AbortSignal.timeout(20_000),
  });
  if (res.ok) return NextResponse.json({ ok: true, pad });

  const tekst = await res.text().catch(() => "");
  if (res.status === 409 && /conflict/.test(tekst)) {
    return NextResponse.json({ error: `${pad} bestaat al; er wordt niets overschreven` }, { status: 409 });
  }
  return NextResponse.json({ error: `Dropbox gaf ${res.status}: ${tekst.slice(0, 160)}` }, { status: 502 });
}
