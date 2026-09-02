import { NextResponse } from "next/server";
import {
  attachPointclouds,
  listPointclouds,
  requestPointcloudUploads,
  type PointcloudUploadRequest,
} from "@/lib/mediatask";
import { alAanwezigeNamen, stuurScanVanuitDropbox } from "@/lib/mediatask-pointclouds";

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
  /** MD5 (base64) die de iPad al berekende toen het bestand nog in het
      geheugen zat — dan hoeft de server maar één keer door Dropbox. */
  checksum?: string;
  grootte?: number;
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
      // Hangt deze scan er al aan (bv. een hervatte upload na een herlaad-
      // beurt die 'm al eens doorstuurde), dan niet nóg eens — dat zou een
      // dubbele puntenwolk aan de order hangen.
      const naam = body.path.split("/").pop() ?? "";
      const aanwezig = await alAanwezigeNamen(body.orderId);
      if (naam && aanwezig.has(naam)) {
        return NextResponse.json({ filename: naam, alAanwezig: true });
      }
      // Waarom via de server en niet rechtstreeks vanaf de iPad: de S3-bucket
      // van Mediatask geeft ons domein geen CORS-toestemming (live
      // vastgesteld). Met de meegestuurde MD5 is één doorgang Dropbox → S3
      // genoeg; zonder valt de lib terug op hashen én versturen (twee
      // doorgangen), even betrouwbaar maar trager.
      const hint =
        body.checksum && body.grootte && body.grootte > 0
          ? { checksum: body.checksum, grootte: body.grootte }
          : null;
      const uitkomst = await stuurScanVanuitDropbox(body.orderId, body.path, undefined, hint);
      return NextResponse.json({ filename: naam, ...uitkomst });
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
