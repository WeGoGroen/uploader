import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import {
  attachPointclouds,
  listPointclouds,
  requestPointcloudUploads,
  type PointcloudUploadRequest,
} from "@/lib/mediatask";
import { getSharedAccessToken, openFileStream } from "@/lib/dropbox";

/**
 * De twee serverkanten van het uploaden van een puntenwolk naar Mediatask.
 *
 * Het bestand zelf komt hier niet langs: dat gaat rechtstreeks van de browser
 * naar S3. Wat hier wél moet gebeuren is alles waar het API-token voor nodig
 * is, en dat token hoort niet in de browser.
 *
 *   "prepare" — meldt de bestanden aan en geeft de tijdelijke S3-links terug.
 *   "attach"  — koppelt de geüploade blobs aan de order.
 */
// Een scan van honderden MB's tweemaal doorsluizen kost meer dan een minuut.
export const maxDuration = 300;

interface Body {
  action?: "prepare" | "attach" | "vanuitDropbox";
  orderId?: number;
  files?: PointcloudUploadRequest[];
  pointclouds?: { pointcloud_id: number; signed_blob_id: string }[];
  /** Volledig Dropbox-pad van de scan, bv. "/Automatie NEN2580/…/Optimized/x.dp". */
  path?: string;
}

/**
 * Stuurt een scan vanuit Dropbox rechtstreeks naar de opslag van Mediatask.
 *
 * Waarom niet vanuit de browser, wat sneller zou zijn: de S3-bucket van
 * Mediatask geeft geen CORS-toestemming aan ons domein, dus een browser
 * weigert de upload al vóór hij begint (live vastgesteld). Onze server heeft
 * dat probleem niet — CORS is een browserregel.
 *
 * Het bestand komt nooit helemaal in het geheugen: het wordt in twee
 * doorgangen gestreamd. Eerst om de MD5 te berekenen (die tekent S3 mee in de
 * uploadlink, dus hij moet vooraf bekend zijn), daarna om te uploaden. Twee
 * keer downloaden is de prijs voor nul geheugengebruik — en dat is de goede
 * ruil, want een serverless-functie die 300 MB probeert vast te houden valt om.
 */
async function stuurVanuitDropbox(orderId: number, path: string) {
  const naam = path.split("/").pop() ?? "scan";
  const token = await getSharedAccessToken();

  // Doorgang 1: alleen meten en hashen.
  const eerste = await openFileStream(token, path);
  const hash = createHash("md5");
  let bytes = 0;
  for await (const blok of eerste.stream as unknown as AsyncIterable<Uint8Array>) {
    hash.update(blok);
    bytes += blok.byteLength;
  }
  const checksum = hash.digest("base64");
  const grootte = bytes || eerste.size;

  const doelen = await requestPointcloudUploads(orderId, [
    { filename: naam, byte_size: String(grootte), checksum, content_type: "application/octet-stream" },
  ]);
  const doel = doelen.pointclouds?.[0];
  if (!doel?.url) throw new Error("Mediatask gaf geen uploadlink terug");

  // Doorgang 2: dezelfde bytes rechtstreeks doorzetten naar S3.
  const tweede = await openFileStream(token, path);
  const put = await fetch(doel.url, {
    method: "PUT",
    headers: { ...doel.headers, "Content-Length": String(grootte) },
    body: tweede.stream,
    // Node stuurt een stroom alleen mee als je expliciet zegt dat je niet op
    // een antwoord wacht voordat je klaar bent met versturen.
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  if (!put.ok) {
    const body = await put.text().catch(() => "");
    throw new Error(`Amazon weigerde de scan (${put.status}). ${body.slice(0, 200)}`);
  }

  const uitkomst = await attachPointclouds(orderId, [
    { pointcloud_id: doel.pointcloud_id, signed_blob_id: doel.blob_id },
  ]);
  // Teruglezen is de enige harde bevestiging dat hij er ook echt hangt.
  const aanwezig = await listPointclouds(orderId).catch(() => []);
  return { ...uitkomst, filename: naam, bytes: grootte, pointclouds: aanwezig };
}

/** Wat er nu werkelijk aan een order hangt. De enige harde bevestiging dat een
    scan is aangekomen — het antwoord op "attach" zegt dat niet betrouwbaar. */
export async function GET(request: Request) {
  const orderId = Number(new URL(request.url).searchParams.get("orderId"));
  if (!orderId) return NextResponse.json({ error: "missing_order_id" }, { status: 400 });
  try {
    return NextResponse.json({ pointclouds: await listPointclouds(orderId) });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Ophalen mislukt" },
      { status: 502 }
    );
  }
}

export async function POST(request: Request) {
  const body = (await request.json()) as Body;
  if (!body.orderId) {
    return NextResponse.json({ error: "missing_order_id" }, { status: 400 });
  }

  try {
    if (body.action === "vanuitDropbox") {
      if (!body.path) return NextResponse.json({ error: "missing_path" }, { status: 400 });
      return NextResponse.json(await stuurVanuitDropbox(body.orderId, body.path));
    }

    if (body.action === "prepare") {
      if (!body.files?.length) {
        return NextResponse.json({ error: "missing_files" }, { status: 400 });
      }
      const data = await requestPointcloudUploads(body.orderId, body.files);
      return NextResponse.json(data);
    }

    if (body.action === "attach") {
      if (!body.pointclouds?.length) {
        return NextResponse.json({ error: "missing_pointclouds" }, { status: 400 });
      }
      const data = await attachPointclouds(body.orderId, body.pointclouds);
      // Meteen teruglezen wat er nu aan de order hangt: dat is de enige echte
      // bevestiging dat de scan is aangekomen, los van wat het antwoord zegt.
      const aanwezig = await listPointclouds(body.orderId).catch(() => []);
      return NextResponse.json({ ...data, pointclouds: aanwezig });
    }

    return NextResponse.json({ error: "unknown_action" }, { status: 400 });
  } catch (err) {
    console.error("Puntenwolk naar Mediatask mislukt", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Puntenwolk versturen mislukt" },
      { status: 502 }
    );
  }
}
