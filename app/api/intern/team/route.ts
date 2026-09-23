import { NextResponse } from "next/server";
import { isInternRequest } from "@/lib/intern-auth";
import {
  getClickUpAccounts,
  patchClickUpAccount,
  rechtenNaWijziging,
  rechtenVan,
  verwijderAccount,
  type UploadRechten,
} from "@/lib/clickup";
import { haalPersoneel, zetCode } from "@/lib/personeel";
import { controleerMediataskSleutel, requireGedeeldeMediataskConfig } from "@/lib/mediatask";
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

  /*
    De inlogcodes gaan hier wél mee, de ClickUp-tokens niet.

    Dat lijkt inconsequent maar is het niet: een inlogcode geeft toegang tot
    deze ene app en wordt door een beheerder uitgedeeld, dus die moet hij
    kunnen teruglezen om een collega op weg te helpen. Een ClickUp-token is een
    sleutel tot de hele werkruimte van iemand anders. En zodra iemand zijn code
    zelf vervangt staat er hier niets meer — dan kent alleen hij hem nog.
  */
  const mensen = await haalPersoneel();
  const accounts = await getClickUpAccounts();
  return NextResponse.json({
    team: accounts.map((a) => {
      const persoon = mensen.find((p) => p.naam === a.name);
      return {
        naam: a.name,
        email: a.email ?? null,
        avatar: a.avatar ?? null,
        heeftToken: Boolean(a.token),
        // Alleen of hij er een heeft. De sleutel zelf blijft hier, net als het
        // ClickUp-token: hij maakt orders op iemands eigen naam aan.
        heeftMediataskToken: Boolean(a.mediataskToken),
        rechten: rechtenVan(a),
        rol: persoon?.rol ?? "medewerker",
        codeGewijzigd: persoon?.codeGewijzigd ?? false,
        codeKlaar: persoon?.codeKlaar ?? null,
      };
    }),
  });
}

/**
 * Een account verwijderen.
 *
 * Alleen wat in Redis staat kan weg; een account uit de omgeving
 * (CLICKUP_ACCOUNTS/CLICKUP_TOKEN) komt bij de volgende aanroep terug, en dat
 * zeggen we dan ook in plaats van te doen alsof het gelukt is.
 */
export async function DELETE(request: Request) {
  if (!isInternRequest(request)) {
    return NextResponse.json({ error: "niet_toegestaan" }, { status: 401 });
  }
  const naam = new URL(request.url).searchParams.get("naam")?.trim() ?? "";
  if (!naam) return NextResponse.json({ error: "naam ontbreekt" }, { status: 400 });

  try {
    const weg = await verwijderAccount(naam);
    if (!weg) {
      return NextResponse.json(
        {
          error:
            "Dit account staat in de omgevingsvariabelen van de app en kan hier niet weg. Haal het uit CLICKUP_ACCOUNTS in Vercel.",
        },
        { status: 409 }
      );
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message.slice(0, 200) : "verwijderen mislukt" },
      { status: 500 }
    );
  }
}

/**
 * Een code of een Mediatask-sleutel instellen voor iemand.
 *
 * De sleutel wordt eerst bij Mediatask nagekeken. Een typefout stil opslaan
 * betekent dat de opnemer het pas merkt als hij in het veld een order wil
 * aanmaken — en dan staat hij met een klant in huis.
 */
export async function PATCH(request: Request) {
  if (!isInternRequest(request)) {
    return NextResponse.json({ error: "niet_toegestaan" }, { status: 401 });
  }
  const body = (await request.json().catch(() => null)) as
    | { naam?: string; code?: string; mediataskToken?: string; gedeeldeSleutel?: boolean }
    | null;
  const naam = body?.naam?.trim() ?? "";
  if (!naam) return NextResponse.json({ error: "naam ontbreekt" }, { status: 400 });

  /*
    "De gedeelde sleutel is van deze persoon."

    Die sleutel hoort bij één Mediatask-account, en al het werk dat erop
    gemaakt wordt staat dus al op zijn naam. Hem daar opnieuw laten plakken is
    onnodig — en erger: dan zou een sleutel die hier veilig staat alsnog via
    twee apps en een browser gaan reizen. Daarom kopieert de uploader hem
    intern, en gaat over de lijn alleen de vraag.
  */
  if (body?.gedeeldeSleutel) {
    try {
      const { token } = await requireGedeeldeMediataskConfig();
      const uitkomst = await controleerMediataskSleutel(token);
      if (!uitkomst.ok) {
        return NextResponse.json(
          { error: uitkomst.reden ?? "de gedeelde sleutel wordt door Mediatask geweigerd" },
          { status: 400 }
        );
      }
      await patchClickUpAccount({ name: naam, mediataskToken: token });
      return NextResponse.json({ ok: true, mediataskUserId: uitkomst.userId });
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message.slice(0, 200) : "opslaan mislukt" },
        { status: 500 }
      );
    }
  }

  const sleutel = body?.mediataskToken?.trim();
  if (sleutel) {
    const uitkomst = await controleerMediataskSleutel(sleutel);
    if (!uitkomst.ok) {
      return NextResponse.json({ error: uitkomst.reden ?? "sleutel afgekeurd" }, { status: 400 });
    }
    try {
      await patchClickUpAccount({ name: naam, mediataskToken: sleutel });
      return NextResponse.json({ ok: true, mediataskUserId: uitkomst.userId });
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message.slice(0, 200) : "opslaan mislukt" },
        { status: 500 }
      );
    }
  }

  const code = body?.code ?? "";
  if (!/^[0-9]{4}$/.test(code)) {
    return NextResponse.json({ error: "een viercijferige code of een Mediatask-sleutel is verplicht" }, { status: 400 });
  }
  try {
    await zetCode(naam, code, true);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message.slice(0, 200) : "opslaan mislukt" },
      { status: 500 }
    );
  }
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

  /*
    Vóór het opslaan kijken of deze naam al bestond: dit endpoint bedient én
    het uitnodigen van iemand nieuws, én het wijzigen van rechten van iemand
    die er al staat (dezelfde form, hetzelfde POST). Alleen bij een naam die
    er nog niet was, is er iets om een welkomstmail over te sturen — anders
    kreeg iemand bij elke rechtenwijziging opnieuw een "welkom".
  */
  const voorAf = await getClickUpAccounts().catch(() => []);
  const bestaand = voorAf.find((a) => a.name === naam);
  const bestondAl = Boolean(bestaand);

  const rechten = rechtenNaWijziging(bestaand, body?.rechten);
  if (!rechten.energielabel && !rechten.nen && !rechten.media) {
    return NextResponse.json(
      { error: "Kies minstens één uploadsoort, anders kan deze persoon niets." },
      { status: 400 }
    );
  }

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
      rechten,
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
