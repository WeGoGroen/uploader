import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE, authConfig, isValidSession } from "@/lib/auth";
import { listDrafts } from "@/lib/drafts";
import { getClickUpAccounts, getListMembers, requireClickUpConfig } from "@/lib/clickup";
import { getOptionalRedis } from "@/lib/redis";
import { stuurMail } from "@/lib/mail";
import { SOORT_LABEL, binnenWerkuren, stilTekst, teHerinneren, type Herinnering } from "@/lib/herinnering";

export const maxDuration = 300;

const BASIS = "https://energielabel-app.vercel.app";
const GEMELD_PREFIX = "herinnering:gemeld:";
/**
 * Hoe lang we onthouden dat er al een bericht uitging. Ruim langer dan een
 * werkdag: een opname die 's middags blijft liggen mag de volgende ochtend
 * niet opnieuw een mail opleveren.
 */
const GEMELD_BEWAARD_SECONDEN = 5 * 24 * 60 * 60;

function opmaak(h: Herinnering): string {
  const adres = h.draft.straatnaam || h.draft.titel || "onbekend adres";
  return `
  <div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;max-width:560px;color:#1a201c;line-height:1.5">
    <h2 style="margin:0 0 4px;font-size:19px">${SOORT_LABEL[h.soort]} niet afgemaakt</h2>
    <p style="margin:0 0 18px;color:#54605a;font-size:14px">
      Je bent ${stilTekst(h.stilMinuten)} geleden gestopt bij <strong>${adres}</strong> en de opname staat nog open.
    </p>
    <div style="background:#f4f6f4;border-left:3px solid #1a8748;padding:12px 14px;border-radius:6px;font-size:14px">
      Maak hem af zolang je de gegevens nog vers hebt. Staat er niets meer te doen,
      rond hem dan af of verwijder hem — dan verdwijnt hij ook uit je dashboard.
    </div>
    <p style="margin:16px 0 0">
      <a href="${h.href}" style="display:inline-block;background:#147a44;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-size:14px;font-weight:600">Opname afmaken</a>
    </p>
    <p style="margin:14px 0 0;font-size:12px;color:#8a938d">
      Je krijgt dit bericht één keer per opname.
    </p>
  </div>`;
}

/**
 * Stuurt de opnemer een bericht als zijn eigen opname blijft liggen.
 *
 * De route is bedoeld om vaak te draaien (elk kwartier), maar het Vercel
 * Hobby-plan staat maar één cron-run per dag toe — vandaar het dagelijkse
 * schema in vercel.json. Wil je sneller melden, dan hoeft er niets aan deze
 * code te veranderen: een externe planner die deze URL met het cron-geheim
 * aanroept, of een upgrade naar Vercel Pro, is genoeg.
 *
 * Beveiligt zichzelf: óf het cron-geheim, óf een geldige sessie (om het met
 * de hand te kunnen proberen).
 *
 * Met ?proef=1 wordt er niets verstuurd maar alleen teruggegeven wat er zou
 * uitgaan — zo is te controleren of de selectie klopt zonder iemand een mail
 * te bezorgen.
 */
export async function GET(request: Request) {
  const { secret } = authConfig();
  const cronSecret = process.env.CRON_SECRET;
  const auth = request.headers.get("authorization");
  const viaCron = !!cronSecret && auth === `Bearer ${cronSecret}`;
  const viaSessie = await isValidSession(secret, (await cookies()).get(SESSION_COOKIE)?.value);
  if (!viaCron && !viaSessie) {
    return NextResponse.json({ error: "niet_toegestaan" }, { status: 401 });
  }

  const proef = new URL(request.url).searchParams.get("proef") === "1";
  const nu = new Date();
  if (!binnenWerkuren(nu) && !proef) {
    return NextResponse.json({ overgeslagen: "buiten werkuren", verstuurd: 0 });
  }

  const redis = getOptionalRedis();
  const drafts = await listDrafts();

  // Welke er al een bericht kregen. Zonder Redis kunnen we dat niet bijhouden;
  // dan liever niets sturen dan elk kwartier dezelfde mail.
  if (!redis) {
    return NextResponse.json({ error: "geen opslag — herinneringen uitgeschakeld" }, { status: 503 });
  }
  const gemeldVlaggen = await Promise.all(
    drafts.map((d) => redis.get(`${GEMELD_PREFIX}${d.id}`).catch(() => null))
  );
  const alGemeld = new Set(drafts.filter((_, i) => gemeldVlaggen[i]).map((d) => d.id));

  const lijst = teHerinneren(drafts, nu.getTime(), alGemeld, BASIS);
  if (lijst.length === 0) return NextResponse.json({ verstuurd: 0, gevonden: 0 });

  // Eerst het adres dat bij de gebruiker zelf is ingesteld (Gebruikers-
  // pagina), dan pas ClickUp. Wie alleen NEN2580 of media uploadt hoeft geen
  // ClickUp-lid te zijn; die staat daar niet in en zou anders nooit een
  // bericht krijgen.
  const accounts = await getClickUpAccounts().catch(() => []);
  let leden: { name: string; email: string }[] = [];
  try {
    const { token, listId } = await requireClickUpConfig(null);
    leden = await getListMembers(token, listId);
  } catch {
    leden = [];
  }
  const gelijk = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  const adresVan = (naam: string) =>
    accounts.find((a) => gelijk(a.name, naam))?.email ??
    leden.find((m) => gelijk(m.name, naam))?.email ??
    null;

  const resultaten: { id: string; naar: string | null; verstuurd: boolean; reden?: string }[] = [];
  for (const h of lijst) {
    const email = adresVan(h.draft.accountName!);
    if (!email) {
      resultaten.push({ id: h.draft.id, naar: null, verstuurd: false, reden: "geen mailadres ingesteld — zie Gebruikers" });
      continue;
    }
    if (proef) {
      resultaten.push({ id: h.draft.id, naar: email, verstuurd: false, reden: "proef" });
      continue;
    }
    const res = await stuurMail(
      `${SOORT_LABEL[h.soort]} niet afgemaakt — ${h.draft.straatnaam || h.draft.titel}`,
      opmaak(h),
      [email]
    );
    // Pas als vlag zetten ná verzending: mislukt het, dan mag de volgende
    // ronde het opnieuw proberen i.p.v. het stil te laten vallen.
    if (res.verstuurd) {
      await redis.set(`${GEMELD_PREFIX}${h.draft.id}`, "1", "EX", GEMELD_BEWAARD_SECONDEN).catch(() => {});
    }
    resultaten.push({ id: h.draft.id, naar: email, verstuurd: res.verstuurd, reden: res.reden });
  }

  return NextResponse.json({
    gevonden: lijst.length,
    verstuurd: resultaten.filter((r) => r.verstuurd).length,
    resultaten,
  });
}
