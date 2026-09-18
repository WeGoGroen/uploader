import { NextResponse } from "next/server";
import { haalBijlagen } from "@/lib/inkomende-mail";
import { isInternRequest } from "@/lib/intern-auth";

export const maxDuration = 30;

/**
 * Een verse downloadlink voor één bijlage uit een binnengekomen mail.
 *
 * Het control center kreeg bij binnenkomst alleen te horen dát er een bijlage
 * is; de link hoort hier vandaan te komen omdat de Resend-sleutel hier staat.
 * En hij wordt pas op het moment van gebruik opgehaald: zo'n link is ongeveer
 * een uur geldig, en een mail die vanochtend binnenkwam kan vanmiddag pas
 * geplaatst worden als Dropbox er even uit lag.
 *
 * De link wijst naar Resend, niet naar ons: het bestand komt niet door deze
 * server heen.
 */
export async function POST(request: Request) {
  if (!isInternRequest(request)) {
    return NextResponse.json({ error: "niet_toegestaan" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as {
    email_id?: string;
    bijlage_id?: string;
  } | null;
  const emailId = body?.email_id?.trim() ?? "";
  const bijlageId = body?.bijlage_id?.trim() ?? "";
  if (!emailId || !bijlageId) {
    return NextResponse.json({ error: "email_id en bijlage_id zijn verplicht" }, { status: 400 });
  }

  let bijlagen;
  try {
    bijlagen = await haalBijlagen(emailId);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message.slice(0, 200) : "Resend niet te bevragen" },
      { status: 502 }
    );
  }

  const bijlage = bijlagen.find((b) => b.id === bijlageId);
  if (!bijlage) {
    // 404 en geen 502: de mail is er wel, deze bijlage niet (meer). Opnieuw
    // proberen heeft dan geen zin.
    return NextResponse.json({ error: `bijlage ${bijlageId} zit niet in ${emailId}` }, { status: 404 });
  }

  return NextResponse.json({
    ok: true,
    download_url: bijlage.download_url,
    expires_at: bijlage.expires_at ?? null,
    filename: bijlage.filename,
    size: bijlage.size ?? null,
  });
}
