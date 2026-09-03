import { NextResponse } from "next/server";
import { isInternRequest } from "@/lib/intern-auth";
import { stuurMail } from "@/lib/mail";
import { bccUitnodiging } from "@/lib/mail-sjablonen";

export const maxDuration = 30;

/**
 * Stuurt de opgemaakte welkomstmail voor een nieuw BCC-account.
 *
 * Het control center kent zelf geen Resend-sleutel (zie lib/mail.ts) en heeft
 * ook geen zicht op de opmaak — die hoort hier, naast de mailkoppeling, zodat
 * er precies één plek is waar deze mail bestaat. De uploader-app stuurt zijn
 * eigen uitnodiging (toegang tot de opname-app) rechtstreeks, zonder deze
 * route: dat gebeurt in dezelfde app als waar de mail vandaan komt.
 */
export async function POST(request: Request) {
  if (!isInternRequest(request)) {
    return NextResponse.json({ error: "niet_toegestaan" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as {
    email?: string;
    naam?: string;
    code?: string;
    beheerder?: string | null;
  } | null;

  const email = body?.email?.trim() ?? "";
  const naam = body?.naam?.trim() ?? "";
  const code = body?.code?.trim() ?? "";
  if (!email || !naam || !/^[0-9]{4}$/.test(code)) {
    return NextResponse.json({ error: "email, naam en een viercijferige code zijn verplicht" }, { status: 400 });
  }

  const { onderwerp, html } = bccUitnodiging({ naam, code, beheerder: body?.beheerder ?? null });
  const resultaat = await stuurMail(onderwerp, html, [email]);
  return NextResponse.json(resultaat);
}
