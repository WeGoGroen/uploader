import { NextResponse } from "next/server";
import { isInternRequest } from "@/lib/intern-auth";
import { attachOneDocument } from "@/lib/attachments";
import { requireClickUpConfig } from "@/lib/clickup";
import { getDraft, saveDraft } from "@/lib/drafts";
import { DOCUMENT_FOLDER_MAP } from "@/lib/documents";
import { projectFolderPath } from "@/lib/dropbox";

export const maxDuration = 300;

/**
 * Zet alsnog de bijlages over die bij het afronden van een opname niet in
 * ClickUp terechtkwamen.
 *
 * Dit is het gevaarlijkste soort openstaand werk: de taak staat in ClickUp op
 * klaar en ziet er afgerond uit, terwijl de foto's of de LAZ-scan er nooit bij
 * gekomen zijn. Niemand merkt het, tot een assessor de taak opent.
 *
 * De bestanden staan gewoon in Dropbox — er hoeft alleen iemand op de knop te
 * drukken die de opnemer destijds niet zag of niet afwachtte. Precies werk voor
 * een agent: geen oordeel, wel een controle achteraf.
 */
export async function POST(request: Request) {
  if (!isInternRequest(request)) {
    return NextResponse.json({ error: "niet_toegestaan" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as { draftId?: string } | null;
  const draftId = body?.draftId?.trim() ?? "";
  if (!draftId) return NextResponse.json({ error: "draftId ontbreekt" }, { status: 400 });

  const draft = await getDraft(draftId);
  if (!draft) return NextResponse.json({ error: "opname niet gevonden" }, { status: 404 });

  const ontbreekt = draft.incompleteDocs ?? [];
  if (ontbreekt.length === 0) {
    return NextResponse.json({ ok: true, hersteld: [], reden: "er ontbrak niets" });
  }

  // Taak-id uit de ClickUp-URL: die staat op het concept, een los veld is er niet.
  const taskId = draft.clickupTaskUrl?.split("/").filter(Boolean).pop() ?? "";
  if (!taskId) {
    return NextResponse.json(
      { error: "deze opname heeft geen ClickUp-taak; er valt niets aan te hangen" },
      { status: 422 }
    );
  }

  const map = projectFolderPath("energielabel", draft.woonplaats, draft.straatnaam);

  let token: string;
  let listId: string;
  try {
    ({ token, listId } = await requireClickUpConfig(draft.accountName));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message.slice(0, 200) : "ClickUp niet geconfigureerd" },
      { status: 500 }
    );
  }

  const hersteld: string[] = [];
  const mislukt: string[] = [];

  for (const label of ontbreekt) {
    // De opname bewaart het label ("D5 Algemene foto's"); attachOneDocument wil
    // de sleutel ("D5").
    const doc = DOCUMENT_FOLDER_MAP.find((d) => label.startsWith(d.key) || d.label === label);
    if (!doc) {
      mislukt.push(`${label}: onbekende categorie`);
      continue;
    }
    try {
      /**
       * Doorgaan tot de categorie echt op is.
       *
       * attachOneDocument kapt zichzelf af als hij tegen de tijdslimiet aanloopt
       * en geeft dan terug waar een volgende poging moet beginnen. Eén aanroep
       * doen en klaar melden zou betekenen dat een categorie met veertig foto's
       * half overgezet wordt en toch van de lijst verdwijnt.
       */
      let skip = 0;
      let totaalMislukt: string[] = [];
      let rondes = 0;
      for (;;) {
        const uitkomst = await attachOneDocument(token, listId, taskId, map, doc.key, { skip });
        totaalMislukt = [...totaalMislukt, ...uitkomst.mislukt];
        if (!uitkomst.afgekapt || ++rondes > 10) break;
        skip = uitkomst.volgendeSkip;
      }

      if (totaalMislukt.length > 0) {
        mislukt.push(`${label}: ${totaalMislukt.length} bestand(en) mislukten`);
      } else {
        hersteld.push(label);
      }
    } catch (err) {
      mislukt.push(`${label}: ${err instanceof Error ? err.message.slice(0, 90) : "onbekende fout"}`);
    }
  }

  // Alleen wat écht gelukt is van de lijst halen. Alles wegstrepen omdat de
  // route klaar is, zou het probleem onzichtbaar maken in plaats van oplossen.
  const resterend = ontbreekt.filter((l) => !hersteld.includes(l));
  if (resterend.length !== ontbreekt.length) {
    await saveDraft({ ...draft, incompleteDocs: resterend.length > 0 ? resterend : undefined });
  }

  const goed = resterend.length === 0;
  return NextResponse.json(
    {
      ok: goed,
      taskId,
      map,
      hersteld,
      resterend,
      reden: goed ? null : mislukt.join(" · ") || "niet alles kon overgezet worden",
    },
    { status: goed ? 200 : 422 }
  );
}
