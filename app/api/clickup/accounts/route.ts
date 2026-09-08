import { NextResponse } from "next/server";
import { addClickUpAccount, getAuthorizedUser, getClickUpAccounts, patchClickUpAccount } from "@/lib/clickup";
import { getActiveAccountName } from "@/lib/active-account";

/** Lijst van geconfigureerde gebruikers + wie er nu actief is (geen tokens). */
export async function GET() {
  const accounts = await getClickUpAccounts();
  const active = (await getActiveAccountName()) ?? accounts[0]?.name ?? null;
  return NextResponse.json({
    accounts: accounts.map((a) => ({
      name: a.name,
      avatar: a.avatar ?? null,
      email: a.email ?? null,
    })),
    active,
  });
}

/**
 * Accountgegevens bijwerken: mailadres, avatar of ClickUp-token.
 *
 * Van gebruiker wisselen kan hier niet meer. Dat gebeurde vroeger met een
 * cookie die iedereen kon omzetten; nu zit de naam in de ondertekende sessie,
 * dus wisselen is uitloggen en opnieuw inloggen onder je eigen code.
 */
export async function POST(request: Request) {
  const body = (await request.json()) as {
    name?: string;
    token?: string;
    avatar?: string | null;
    email?: string | null;
  };

  // Alleen het mailadres bijwerken; token en avatar blijven ongewijzigd.
  if (body.email !== undefined && !body.token) {
    const name = body.name?.trim();
    if (!name) return NextResponse.json({ error: "missing_fields" }, { status: 400 });
    const email = body.email?.trim() || null;
    // Alleen een adres met een @ en een punt erachter; een typefout hier
    // betekent dat iemand stilletjes geen meldingen meer krijgt.
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ error: "ongeldig_adres" }, { status: 400 });
    }
    try {
      await patchClickUpAccount({ name, email });
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Kon mailadres niet opslaan" },
        { status: 500 }
      );
    }
    return NextResponse.json({ ok: true });
  }

  // Alleen de avatar bijwerken van een bestaand account, token blijft ongewijzigd.
  if (body.avatar !== undefined && !body.token) {
    const name = body.name?.trim();
    if (!name) return NextResponse.json({ error: "missing_fields" }, { status: 400 });
    try {
      await patchClickUpAccount({ name, avatar: body.avatar });
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Kon avatar niet opslaan" },
        { status: 500 }
      );
    }
    return NextResponse.json({ ok: true });
  }

  // Nieuw account toevoegen, of token van een bestaand account aanpassen: {name, token}. Wisselen: {name} zonder token.
  if (body.token) {
    const name = body.name?.trim();
    const token = body.token.trim();
    if (!name || !token) {
      return NextResponse.json({ error: "missing_fields" }, { status: 400 });
    }
    let user: { username: string };
    try {
      user = await getAuthorizedUser(token);
    } catch {
      return NextResponse.json({ error: "invalid_token" }, { status: 400 });
    }
    try {
      const existing = (await getClickUpAccounts()).find((a) => a.name === name);
      await addClickUpAccount({
        name,
        token,
        avatar: existing?.avatar,
        email: body.email?.trim() || existing?.email,
      });
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Kon account niet opslaan" },
        { status: 500 }
      );
    }

    // Bewust geen cookie meer: een token toevoegen voor een collega maakte je
    // vroeger stilletjes die collega.
    return NextResponse.json({ ok: true, username: user.username });
  }

  return NextResponse.json(
    { error: "Wisselen gaat via uitloggen: log opnieuw in onder je eigen naam en code." },
    { status: 400 }
  );
}
