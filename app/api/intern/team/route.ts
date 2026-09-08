import { NextResponse } from "next/server";
import { isInternRequest } from "@/lib/intern-auth";
import {
  getClickUpAccounts,
  patchClickUpAccount,
  rechtenVan,
  type UploadRechten,
} from "@/lib/clickup";
import { stuurMail } from "@/lib/mail";
import { uploaderUitnodiging } from "@/lib/mail-sjablonen";
import { STARTCODE } from "@/lib/auth";

export const maxDuration = 30;

/**
 * Team en uploadrechten, beheerd vanuit het Business Control Center.
 *
 * Wie wat mag uploaden hoort thuis bij de beheerder op kantoor, niet op de
 * iPad in het veld — daar is iedereen ingelogd met hetzelfde apparaat en zou
 * elke opnemer zijn eigen rechten kunnen uitbreiden.
 *
 * Geeft nooit tokens terug, alleen of iemand er een heeft. Een persoonlijk
 * ClickUp-token is een sleutel tot de hele werkruimte; die hoort de ene app
 * niet aan de andere door te geven, ook niet achter een dienst-token.
 */
export async function GET(request: Request) {
  if (!isInternRequest(request)) {
    return NextResponse.json({ error: "niet_toegestaan" }, { status: 401 });
  }

  const accounts = await getClickUpAccounts();
  return NextResponse.json({
    team: accounts.map((a) => ({
      naam: a.name,
      email: a.email ?? null,
      avatar: a.avatar ?? null,
      heeftToken: Boolean(a.token),
      rechten: rechtenVan(a),
    })),
  });
}

/** Nodigt iemand uit of werkt zijn rechten bij. */
export async function POST(request: Request) {
  if (!isInternRequest(request)) {
    return NextResponse.json({ error: "niet_toegestaan" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as {
    naam?: string;
    email?: string | null;
    rechten?: Partial<UploadRechten>;
  } | null;

  const naam = body?.naam?.trim() ?? "";
  if (naam.length < 2) return NextResponse.json({ error: "Vul een naam in." }, { status: 400 });

  const email = body?.email?.trim() || null;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "Dat is geen geldig e-mailadres." }, { status: 400 });
  }

  const rechten: Partial<UploadRechten> = {
    energielabel: Boolean(body?.rechten?.energielabel),
    nen: Boolean(body?.rechten?.nen),
    media: Boolean(body?.rechten?.media),
  };
  if (!rechten.energielabel && !rechten.nen && !rechten.media) {
    return NextResponse.json(
      { error: "Kies minstens één uploadsoort, anders kan deze persoon niets." },
      { status: 400 }
    );
  }

  /*
    Vóór het opslaan kijken of deze naam al bestond: dit endpoint bedient én
    het uitnodigen van iemand nieuws, én het wijzigen van rechten van iemand
    die er al staat (dezelfde form, hetzelfde POST). Alleen bij een naam die
    er nog niet was, is er iets om een welkomstmail over te sturen — anders
    kreeg iemand bij elke rechtenwijziging opnieuw een "welkom".
  */
  const voorAf = await getClickUpAccounts().catch(() => []);
  const bestondAl = voorAf.some((a) => a.name === naam);

  try {
    await patchClickUpAccount({ name: naam, email, rechten });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message.slice(0, 200) : "opslaan mislukt" },
      { status: 500 }
    );
  }

  let gemaild = false;
  if (!bestondAl && email) {
    // Geen gedeeld wachtwoord meer in de mail: iedereen logt in onder zijn
    // eigen naam en begint op de startcode, die hij daarna zelf vervangt.
    const { onderwerp, html } = uploaderUitnodiging({
      naam,
      startcode: STARTCODE,
      rechten: rechten as { energielabel: boolean; nen: boolean; media: boolean },
    });
    const resultaat = await stuurMail(onderwerp, html, [email], "uitnodiging_upload");
    gemaild = resultaat.verstuurd;
  }

  const accounts = await getClickUpAccounts();
  const account = accounts.find((a) => a.name === naam);
  return NextResponse.json({
    ok: true,
    naam,
    heeftToken: Boolean(account?.token),
    rechten: rechtenVan(account),
    nieuw: !bestondAl,
    gemaild,
  });
}
