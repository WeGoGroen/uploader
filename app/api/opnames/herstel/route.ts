import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE, authConfig, isValidSession } from "@/lib/auth";
import { archiveerOudeOpnames, getDraft, listDraftsByStatus, saveDraft } from "@/lib/drafts";
import { attachOneDocument } from "@/lib/attachments";
import { requireClickUpConfig } from "@/lib/clickup";
import { DOCUMENT_FOLDER_MAP } from "@/lib/documents";

/**
 * Vraagt om ruimte: het overzetten van bijlages naar ClickUp is de traagste
 * stap in de hele keten. Op Vercel Pro mag dit 300 seconden duren, zodat een
 * categorie met veel foto's in één keer over kan i.p.v. in stukjes.
 */
export const maxDuration = 300;

/** Hoeveel opnames per ronde. Rustig aan: dit draait elk kwartier. */
const MAX_PER_RONDE = 5;
/** Zoveel keer proberen we het automatisch; daarna is het echt handwerk. */
const MAX_POGINGEN = 5;

/**
 * Herstelwerker. Zoekt opnames waarvan bijlages niet in ClickUp zijn gekomen
 * en probeert die alsnog over te zetten — zonder dat iemand de app hoeft te
 * openen.
 *
 * Zonder dit bleef `incompleteDocs` staan tot een mens het zag en op
 * "Bijlages opnieuw uploaden" klikte. Bij tientallen opnames per dag is dat
 * het verschil tussen een systeem dat je moet bewaken en een systeem dat
 * zichzelf herstelt.
 *
 * Ruimt in dezelfde ronde afgeronde opnames op die ouder zijn dan 90 dagen;
 * die hoeven niet meer in de lijsten mee te tellen.
 */
export async function GET(request: Request) {
  const { secret } = authConfig();
  const cronSecret = process.env.CRON_SECRET;
  const viaCron = !!cronSecret && request.headers.get("authorization") === `Bearer ${cronSecret}`;
  const viaSessie = await isValidSession(secret, (await cookies()).get(SESSION_COOKIE)?.value);
  if (!viaCron && !viaSessie) {
    return NextResponse.json({ error: "niet_toegestaan" }, { status: 401 });
  }

  const proef = new URL(request.url).searchParams.get("proef") === "1";

  const geupload = await listDraftsByStatus("uploaded");
  const stuk = geupload.filter((d) => (d.incompleteDocs?.length ?? 0) > 0).slice(0, MAX_PER_RONDE);

  if (proef) {
    return NextResponse.json({
      zouHerstellen: stuk.map((d) => ({ id: d.id, adres: d.straatnaam, mist: d.incompleteDocs })),
    });
  }

  const resultaten: { id: string; hersteld: string[]; blijftStaan: string[] }[] = [];

  for (const kort of stuk) {
    // De volledige opname is nodig voor de taak-id en het Dropbox-pad; die
    // staan in de formulierstaat, niet in de samenvatting.
    const draft = await getDraft(kort.id);
    if (!draft) continue;

    const taakId = taakIdUit(draft.clickupTaskUrl);
    const pad = (draft.state?.dropboxFolder as { path?: string } | undefined)?.path;
    if (!taakId || !pad) {
      resultaten.push({ id: draft.id, hersteld: [], blijftStaan: draft.incompleteDocs ?? [] });
      continue;
    }

    // Hoe vaak we het al probeerden; na MAX_POGINGEN stoppen we automatisch
    // herstellen, zodat een structureel probleem niet elk kwartier terugkomt.
    const pogingen = Number((draft.state?.herstelPogingen as number | undefined) ?? 0);
    if (pogingen >= MAX_POGINGEN) continue;

    let token: string;
    let listId: string;
    try {
      ({ token, listId } = await requireClickUpConfig(draft.accountName));
    } catch {
      continue;
    }

    const hersteld: string[] = [];
    const blijftStaan: string[] = [];

    for (const label of draft.incompleteDocs ?? []) {
      const doc = DOCUMENT_FOLDER_MAP.find((d) => d.label === label);
      if (!doc) continue;
      try {
        // Doorlopen tot er niets meer afgekapt wordt — dezelfde hervatlogica
        // als de app zelf gebruikt.
        let skip = 0;
        for (let ronde = 0; ronde < 12; ronde++) {
          const r = await attachOneDocument(token, listId, taakId, pad, doc.key, { skip });
          skip = r.volgendeSkip;
          if (!r.afgekapt) {
            if (r.mislukt.length === 0) hersteld.push(label);
            else blijftStaan.push(label);
            break;
          }
        }
      } catch {
        blijftStaan.push(label);
      }
    }

    await saveDraft({
      ...draft,
      incompleteDocs: blijftStaan,
      updatedAt: Date.now(),
      state: { ...draft.state, herstelPogingen: pogingen + 1 },
    });
    resultaten.push({ id: draft.id, hersteld, blijftStaan });
  }

  const opgeruimd = await archiveerOudeOpnames(90).catch(() => 0);

  return NextResponse.json({
    bekeken: stuk.length,
    hersteld: resultaten.filter((r) => r.blijftStaan.length === 0).length,
    resultaten,
    gearchiveerd: opgeruimd,
  });
}

/** "https://app.clickup.com/t/abc123" → "abc123". */
function taakIdUit(url: string | null): string | null {
  if (!url) return null;
  const m = url.match(/\/t\/([^/?#]+)/);
  return m ? m[1] : null;
}
