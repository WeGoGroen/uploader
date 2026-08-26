import { NextResponse } from "next/server";
import { isInternRequest } from "@/lib/intern-auth";
import { getClickUpAccounts } from "@/lib/clickup";
import {
  getAccessTokenForAccount,
  getEventsBetween,
  GoogleInvalidGrantError,
} from "@/lib/google-calendar";

export const maxDuration = 60;

/**
 * Agenda's van álle medewerkers over een tijdvenster, voor het Business
 * Control Center.
 *
 * Bewust hier en niet in het control center zelf: de Google-refreshtokens
 * staan per medewerker in de Redis van deze app. Ze op twee plekken bewaren
 * betekent twee keer opnieuw inloggen als er iets verloopt, en twee kansen om
 * uit de pas te lopen.
 *
 * Een medewerker met een kapotte koppeling laat de rest niet vallen: die komt
 * als aparte foutregel terug, zodat het control center kan tonen wie er
 * opnieuw moet koppelen.
 */
export async function GET(request: Request) {
  if (!isInternRequest(request)) {
    return NextResponse.json({ error: "niet_toegestaan" }, { status: 401 });
  }

  const url = new URL(request.url);
  const vanaf = url.searchParams.get("vanaf");
  const tot = url.searchParams.get("tot");
  const start = vanaf ? new Date(vanaf) : new Date();
  const eind = tot ? new Date(tot) : new Date(start.getTime() + 14 * 86400_000);
  if (Number.isNaN(start.getTime()) || Number.isNaN(eind.getTime())) {
    return NextResponse.json({ error: "ongeldig_tijdvenster" }, { status: 400 });
  }

  const accounts = await getClickUpAccounts();
  const resultaten = await Promise.all(
    accounts.map(async (account) => {
      try {
        const token = await getAccessTokenForAccount(account.name);
        const events = await getEventsBetween(token, start, eind);
        return { medewerker: account.name, afspraken: events, fout: null as string | null };
      } catch (err) {
        const opnieuwKoppelen = err instanceof GoogleInvalidGrantError;
        return {
          medewerker: account.name,
          afspraken: [],
          fout: opnieuwKoppelen
            ? "Google-koppeling verlopen — opnieuw inloggen via Koppelingen"
            : err instanceof Error
              ? err.message.slice(0, 200)
              : "onbekende fout",
        };
      }
    })
  );

  return NextResponse.json({
    vanaf: start.toISOString(),
    tot: eind.toISOString(),
    medewerkers: resultaten,
  });
}
