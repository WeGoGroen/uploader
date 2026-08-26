import { NextResponse } from "next/server";
import {
  appendUploadSession,
  finishUploadSession,
  getSharedAccessToken,
  startConcurrentUploadSession,
  startUploadSession,
} from "@/lib/dropbox";

export const maxDuration = 60;

/**
 * Chunked variant van /api/dropbox/upload-file — Vercel accepteert per
 * serverless-aanroep maximaal ~4,5MB body (zie lib/dropbox.ts). Deze route
 * stuurt elk blok apart door naar Dropbox's upload-session-API, aangestuurd
 * via query-parameters (de body is puur de bestandsbytes van dit blok, geen
 * multipart, zodat het bestand niet eerst als geheel in geheugen hoeft).
 */
export async function POST(request: Request) {
  const url = new URL(request.url);
  const action = url.searchParams.get("action");
  const sessionId = url.searchParams.get("sessionId") ?? undefined;
  const offset = Number(url.searchParams.get("offset") ?? "0");
  const path = url.searchParams.get("path");

  try {
    const accessToken = await getSharedAccessToken();
    const buffer = Buffer.from(await request.arrayBuffer());

    if (action === "start") {
      const newSessionId = await startUploadSession(accessToken, buffer);
      return NextResponse.json({ sessionId: newSessionId });
    }
    // Concurrent: blokken mogen hierna parallel en in willekeurige volgorde.
    if (action === "start-concurrent") {
      const newSessionId = await startConcurrentUploadSession(accessToken);
      return NextResponse.json({ sessionId: newSessionId });
    }
    if (action === "append") {
      if (!sessionId) return NextResponse.json({ error: "missing_session" }, { status: 400 });
      await appendUploadSession(accessToken, sessionId, offset, buffer, url.searchParams.get("close") === "1");
      return NextResponse.json({ ok: true });
    }
    if (action === "finish") {
      if (!sessionId || !path) return NextResponse.json({ error: "missing_fields" }, { status: 400 });
      await finishUploadSession(accessToken, sessionId, offset, path, buffer);
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: "unknown_action" }, { status: 400 });
  } catch (err) {
    console.error("Chunked Dropbox upload failed", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Uploaden mislukt" },
      { status: 502 }
    );
  }
}
