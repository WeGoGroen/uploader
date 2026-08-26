import { NextResponse } from "next/server";
import { isInternRequest } from "@/lib/intern-auth";
import { createTask, getListCustomFields, requireClickUpConfig } from "@/lib/clickup";
import { ensureProjectFolder } from "@/lib/dropbox";
import { getDraft, saveDraft } from "@/lib/drafts";
import { getOptionalRedis } from "@/lib/redis";
import { ontbrekendeVelden, type FieldValue } from "@/lib/required-fields";
import type { AddressDetails } from "@/lib/pdok";

export const maxDuration = 300;

const PRIORITEIT: Record<string, number | null> = {
  Clear: null,
  Urgent: 1,
  High: 2,
  Normal: 3,
  Low: 4,
};

function adresRegel(a: AddressDetails): string {
  const nummer = [a.huisnummer, a.huisletter, a.huisnummertoevoeging]
    .filter(Boolean)
    .join(a.huisletter ? "" : "-");
  return `${a.straatnaam} ${nummer}`;
}

/**
 * Zet een compleet ingevuld concept alsnog door naar ClickUp en Dropbox.
 *
 * Dit is de stap die de opnemer in het veld normaal zelf zet. Blijft hij
 * hangen — batterij leeg, geen bereik, of gewoon vergeten — dan staat er een
 * volledig ingevulde opname op een iPad waar niemand iets van weet.
 *
 * Bewust dezelfde weg als de app: dezelfde taaknaam, dezelfde omschrijving,
 * dezelfde mapstructuur, en dezelfde bescherming tegen dubbele taken via de
 * opname-id. Zou een agent een eigen route nemen, dan krijg je twee soorten
 * taken in ClickUp die net iets van elkaar verschillen.
 *
 * Weigert een opname met lege verplichte velden. Die gegevens zitten in het
 * hoofd van de opnemer; daar heeft een agent niets te zoeken.
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
  if (draft.status !== "concept") {
    return NextResponse.json({ ok: true, reden: "deze opname is al doorgezet" });
  }

  const state = (draft.state ?? {}) as {
    address?: AddressDetails;
    titel?: string;
    assigneeId?: number | null;
    priority?: string;
    taskStatus?: string;
    beschrijving?: string;
    fieldValues?: Record<string, FieldValue>;
  };

  const address = state.address;
  if (!address?.straatnaam) {
    return NextResponse.json(
      { error: "deze opname heeft geen gevalideerd adres — een mens moet dat afmaken" },
      { status: 422 }
    );
  }

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

  const velden = await getListCustomFields(token, listId);

  // Verplichte velden opnieuw controleren op de bron, niet op wat er in de
  // samenvatting van het concept staat: die kan verouderd zijn.
  const waarden = state.fieldValues ?? {};
  const leeg = ontbrekendeVelden(velden, waarden);
  if (leeg.length > 0) {
    return NextResponse.json(
      {
        error: `nog ${leeg.length} verplicht(e) veld(en) leeg: ${leeg.join(", ")}`,
        ontbrekend: leeg,
      },
      { status: 422 }
    );
  }

  // Dezelfde opbouw als in de app: lege waarden worden weggelaten, checkboxes
  // alleen als ze aan staan.
  const customFields: { id: string; value: string | boolean | string[] }[] = [];
  for (const f of velden) {
    const v = waarden[f.id];
    if (v === undefined) continue;
    if (f.type === "checkbox") {
      if (v === true) customFields.push({ id: f.id, value: true });
      continue;
    }
    if (f.type === "labels") {
      if (Array.isArray(v) && v.length > 0) customFields.push({ id: f.id, value: v });
      continue;
    }
    if (typeof v === "string" && v.trim() !== "") customFields.push({ id: f.id, value: v });
  }

  const regel = adresRegel(address);
  const taakNaam = state.titel?.trim() || `${regel}, ${address.postcode} ${address.woonplaatsnaam}`;

  // Al eens doorgezet? Dan diezelfde taak teruggeven. Zelfde slot als de app
  // gebruikt, zodat agent en mens elkaar niet dubbel doen.
  const redis = getOptionalRedis();
  const slot = `clickup:taak:${draftId}`;
  if (redis) {
    const eerder = await redis.get(slot).catch(() => null);
    if (eerder) {
      try {
        return NextResponse.json({ ...JSON.parse(eerder), hergebruikt: true, ok: true });
      } catch {
        // Onleesbaar: gewoon opnieuw aanmaken.
      }
    }
  }

  const map = await ensureProjectFolder("energielabel", address.woonplaatsnaam, regel).catch(() => null);

  const omschrijving = [
    `${regel}, ${address.postcode} ${address.woonplaatsnaam}`,
    address.bouwjaar !== null ? `Bouwjaar: ${address.bouwjaar} (BAG)` : null,
    `BAG-objectnummer: ${address.adresseerbaarobjectId}`,
    map ? `Dropbox-map: ${map.url}` : null,
    "",
    "Doorgezet door de Doorzet-agent — het concept bleef staan in de uploader.",
    state.beschrijving?.trim() ?? null,
  ].filter((r): r is string => r !== null);

  try {
    const taak = await createTask(token, listId, {
      name: taakNaam,
      customFields,
      markdownDescription: omschrijving.join("\n"),
      assignees: state.assigneeId ? [state.assigneeId] : undefined,
      priority: state.priority && state.priority in PRIORITEIT ? PRIORITEIT[state.priority] : null,
      status: state.taskStatus,
    });

    const antwoord = {
      ok: true,
      task: taak,
      dropboxFolderUrl: map?.url ?? null,
      dropboxFolderPath: map?.path ?? null,
    };
    if (redis) {
      await redis.set(slot, JSON.stringify(antwoord), "EX", 30 * 24 * 60 * 60).catch(() => {});
    }

    // Het concept afsluiten, zodat hij niet blijft opduiken als openstaand werk.
    await saveDraft({
      ...draft,
      status: "uploaded",
      clickupTaskUrl: taak.url ?? draft.clickupTaskUrl,
      updatedAt: Date.now(),
    });

    return NextResponse.json(antwoord);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message.slice(0, 200) : "taak aanmaken mislukt" },
      { status: 502 }
    );
  }
}
