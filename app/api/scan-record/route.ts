import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import type { CheckStatus } from "@/lib/dp-checks";
import { addOrderComment } from "@/lib/mediatask";
import type { ScanFeatures } from "@/lib/scan-features";
import {
  linkScanToOrder,
  listScanRecords,
  samenvatting,
  saveScanRecord,
  type ScanCheckResult,
  type ScanRecord,
} from "@/lib/scan-record";

/**
 * Vastleggen van scancontroles.
 *
 *   POST  — een nieuwe controle bewaren; geeft het id terug.
 *   PATCH — die controle aan een Mediatask-order hangen en het oordeel daar
 *           als comment onder zetten.
 *   GET   — de laatste controles teruglezen.
 */

interface PostBody {
  version?: string;
  fileName?: string;
  fileSize?: number;
  address?: string;
  features?: ScanFeatures;
  results?: ScanCheckResult[];
  verdict?: CheckStatus;
  llmVerdict?: CheckStatus;
}

export async function POST(request: Request) {
  const body = (await request.json()) as PostBody;
  if (!body.features || !body.verdict || !body.version) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  const rec: ScanRecord = {
    id: randomUUID(),
    version: body.version,
    at: new Date().toISOString(),
    fileName: body.fileName ?? "onbekend",
    fileSize: body.fileSize ?? null,
    address: body.address ?? null,
    orderId: null,
    features: body.features,
    results: body.results ?? [],
    verdict: body.verdict,
    llmVerdict: body.llmVerdict ?? null,
    label: null,
  };

  const bewaard = await saveScanRecord(rec);
  // Ook als opslaan niet lukte geven we het id terug en geen fout: de opnemer
  // moet door kunnen. Het veld `bewaard` vertelt de aanroeper wat er gebeurd is.
  return NextResponse.json({ id: rec.id, bewaard });
}

interface PatchBody {
  id?: string;
  orderId?: number;
}

export async function PATCH(request: Request) {
  const body = (await request.json()) as PatchBody;
  if (!body.id || !body.orderId) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  const rec = await linkScanToOrder(body.id, body.orderId);
  if (!rec) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // De comment is een extraatje voor de operator bij Mediatask; mislukt hij,
  // dan is de koppeling zelf nog steeds gelegd en dat is wat telt.
  let comment = false;
  try {
    await addOrderComment(body.orderId, samenvatting(rec));
    comment = true;
  } catch (err) {
    console.error("Comment bij order plaatsen mislukt", err);
  }
  return NextResponse.json({ ok: true, comment });
}

export async function GET(request: Request) {
  const limit = Number(new URL(request.url).searchParams.get("limit") ?? 100);
  const records = await listScanRecords(Number.isFinite(limit) ? limit : 100);
  return NextResponse.json({ records });
}
