import { NextResponse } from "next/server";
import { draaiControles } from "@/lib/health";
import { mailBijStoring } from "@/lib/health-mail";
import { SESSION_COOKIE, authConfig, isValidSession } from "@/lib/auth";
import { isInternRequest } from "@/lib/intern-auth";
import { cookies } from "next/headers";

export const maxDuration = 300;

/**
 * Ochtendcontrole van de hele keten. Draait automatisch via Vercel Cron en is
 * ook met de hand op te vragen als je ingelogd bent.
 *
 * Deze route staat buiten de inlog (de cron heeft geen sessie), dus beveiligt
 * hij zichzelf: óf een geldige sessie, óf het geheim dat alleen Vercel meestuurt,
 * óf het dienst-token van het Business Control Center.
 *
 * Dat derde pad bestaat zodat het control center niet ook nog het cron-geheim
 * hoeft te kennen. Eén geheim minder dat gekopieerd, bewaard en ooit gelekt
 * kan worden — en het kan los ingetrokken worden zonder de cron te breken.
 */
export async function GET(request: Request) {
  const { secret } = authConfig();
  const cronSecret = process.env.CRON_SECRET;
  const auth = request.headers.get("authorization");

  const viaCron = !!cronSecret && auth === `Bearer ${cronSecret}`;
  const viaControlCenter = isInternRequest(request);
  const viaSessie = await isValidSession(secret, (await cookies()).get(SESSION_COOKIE)?.value);

  if (!viaCron && !viaSessie && !viaControlCenter) {
    return NextResponse.json({ error: "niet_toegestaan" }, { status: 401 });
  }

  const rapport = await draaiControles();

  // Een alarm dat nooit heeft afgegaan is geen alarm. Met ?proef=1 wordt er een
  // nepstoring aan het rapport geplakt zodat de hele meldketen één keer echt
  // doorlopen wordt. Verandert niets aan de echte controles en zit achter
  // dezelfde inlog.
  const proef = new URL(request.url).searchParams.get("proef") === "1";
  if (proef) {
    rapport.controles.push({
      naam: "Dropbox",
      ok: false,
      niveau: "fout",
      detail: "PROEFMELDING — dit is een test, er is niets kapot",
      ms: 0,
      pogingen: 3,
    });
    rapport.allesGoed = false;
  }
  // Melden gaat na het rapport en nooit blokkerend: een haperende mailkoppeling
  // mag de controle zelf niet laten mislukken.
  // Het control center vraagt dit scherm elke tien minuten op; daar hoort geen
  // mail bij. De ochtendmail blijft aan de cron hangen, waar hij thuishoort.
  const melding = viaControlCenter && !proef
    ? "niet gemeld (opgevraagd door control center)"
    : await mailBijStoring(rapport, proef).catch((e) =>
        `mail mislukt (${e instanceof Error ? e.message : "onbekend"})`
      );
  // Faalt er iets, dan een 503: zo ziet Vercel de mislukte cron ook als fout
  // in het overzicht i.p.v. als geslaagde run met een nare inhoud.
  return NextResponse.json({ ...rapport, melding }, { status: rapport.allesGoed ? 200 : 503 });
}
