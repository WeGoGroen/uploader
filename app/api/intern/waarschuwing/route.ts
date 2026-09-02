import { NextResponse } from "next/server";
import { isInternRequest } from "@/lib/intern-auth";
import { getClickUpAccounts } from "@/lib/clickup";
import { stuurMail } from "@/lib/mail";

export const maxDuration = 30;

/**
 * Verstuurt een waarschuwing per mail namens het Business Control Center.
 *
 * Het BCC heeft zelf geen mailkoppeling en kent ook de e-mailadressen van het
 * team niet — die staan hier, bij de accounts. Deze route vertaalt namen van
 * opnemers naar hun adres en verstuurt via de bestaande Resend-koppeling.
 * Levert een naam niets op, dan gaat de mail naar de vaste ontvangers: een
 * waarschuwing die stilletjes nergens aankomt is erger dan een die bij de
 * verkeerde binnenvalt.
 */
export async function POST(request: Request) {
  if (!isInternRequest(request)) {
    return NextResponse.json({ error: "niet_toegestaan" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as {
    onderwerp?: string;
    html?: string;
    /** Namen van opnemers (zoals Mediatask ze kent) of directe e-mailadressen. */
    opnemers?: string[];
  } | null;

  if (!body?.onderwerp || !body.html) {
    return NextResponse.json({ error: "onderwerp en html zijn verplicht" }, { status: 400 });
  }

  const accounts = await getClickUpAccounts().catch(() => []);
  const glad = (s: string) => s.trim().toLowerCase();

  const aan = new Set<string>();
  const onbekend: string[] = [];
  for (const wie of body.opnemers ?? []) {
    if (/@/.test(wie)) {
      aan.add(wie.trim());
      continue;
    }
    // Mediatask en ClickUp spellen namen net anders ("Floris" vs "Floris de
    // Laat"); de een als begin van de ander is dan de match die je bedoelt.
    const naam = glad(wie);
    const account = accounts.find((a) => {
      const an = glad(a.name ?? "");
      return an === naam || an.startsWith(naam) || naam.startsWith(an);
    });
    if (account?.email) aan.add(account.email);
    else onbekend.push(wie);
  }

  const resultaat = await stuurMail(body.onderwerp, body.html, aan.size > 0 ? [...aan] : undefined);
  return NextResponse.json({ ...resultaat, onbekend });
}
