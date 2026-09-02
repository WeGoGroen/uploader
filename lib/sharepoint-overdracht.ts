import { createTaskComment, getTask, requireClickUpConfig } from "@/lib/clickup";
import { taskToAddress } from "@/lib/sharepoint-match";
import { SyncError, syncSharePointFiles } from "@/lib/sharepoint-sync";

/**
 * De overdracht van één adres: map van SharePoint ophalen en in de
 * Dropbox-projectmap zetten, en op de ClickUp-taak schrijven wat er gebeurd is.
 *
 * Stond eerst alleen in de webhook-route. Dat werkte zolang de webhook de enige
 * aanleiding was, maar hij is precies het soort gebeurtenis dat je één keer
 * krijgt en niet terug: een gemiste webhook, een taak die op klaar stond vóór
 * de koppeling bestond, een SharePoint die er even uit lag. Er is dus een
 * tweede aanleiding nodig — een agent die achteraf controleert — en dan mag de
 * handeling niet in een route vastzitten die alleen ClickUp kan aanroepen.
 *
 * Vandaar deze module: één beschrijving van "wat gebeurt er als een adres klaar
 * is", met de webhook en de agent als twee aanleidingen ervoor.
 */

export interface OverdrachtUitkomst {
  /** Alleen waar als álles er staat. Half overgezet is niet ok. */
  ok: boolean;
  /** Het bolletje dat de projectmap gekregen heeft. */
  status: "compleet" | "bezig" | "ontbreekt";
  /** Bij een SyncError: waaróm het niet kon. Bepaalt of opnieuw proberen zin
      heeft — "geen_projectmap" lost zichzelf nooit op, een netwerkfout wel. */
  code: "geen_adres" | "niets_gevonden" | "geen_projectmap" | "onbekend" | null;
  reden: string | null;
  /** Het adres zoals het herkend is; handig in een logregel bij de agent. */
  adres: string | null;
  targetPaths: string[];
  copied: string[];
  skipped: string[];
  pending: string[];
  failed: { name: string; error: string }[];
}

function leeg(): Omit<OverdrachtUitkomst, "ok" | "status" | "code" | "reden" | "adres"> {
  return { targetPaths: [], copied: [], skipped: [], pending: [], failed: [] };
}

/** De regels die als opmerking op de taak komen. Zelfde tekst voor beide
    aanleidingen: je wil in ClickUp niet kunnen zien wie het gestart heeft, je
    wil kunnen zien wat er staat. */
function melding(u: OverdrachtUitkomst): string {
  if (!u.ok && u.copied.length === 0 && u.failed.length === 0) {
    return `⚠️ ${u.reden ?? "Ophalen van SharePoint is mislukt."} Haal de bestanden deze keer met de hand op.`;
  }
  const bolletje = u.status === "compleet" ? "🟢" : u.status === "bezig" ? "🟠" : "🔴";
  return [
    `${bolletje} ${u.copied.length} bestand${u.copied.length === 1 ? "" : "en"} opgehaald van SharePoint naar Dropbox: ${u.targetPaths.join(", ")}`,
    u.copied.length ? u.copied.map((n) => `• ${n}`).join("\n") : null,
    u.skipped.length ? `Overgeslagen (stond er al): ${u.skipped.join(", ")}` : null,
    u.pending.length
      ? `⏳ Nog onderweg bij Dropbox: ${u.pending.join(", ")}. De map blijft oranje tot dit is afgerond.`
      : null,
    u.failed.length
      ? `⚠️ Mislukt: ${u.failed.map((f) => `${f.name} (${f.error})`).join("; ")}`
      : null,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Haalt de opgeleverde map van deze ClickUp-taak op en zet hem in de
 * projectmap onder "Automatie Energielabels".
 *
 * Het adres komt uit de taak zelf (veld "A1 Adres:", anders de taaknaam) en
 * niet van de aanroeper. Dat is bewust: de mapnamen van MO Consultancy zijn
 * gebouwd op postcode + huisnummer, en die postcode staat alleen in dat veld.
 * Een aanroeper die alleen "Kerkstraat 12, Amsterdam" doorgeeft, zou de map
 * gegarandeerd niet vinden — en dat zou lijken op "er staat niets in
 * SharePoint" terwijl het er gewoon is.
 */
export async function overdrachtVoorTaak(
  taskId: string,
  opties: { melden?: boolean } = {}
): Promise<OverdrachtUitkomst> {
  const melden = opties.melden ?? true;
  const { token } = await requireClickUpConfig();
  const task = await getTask(token, taskId);

  const address = taskToAddress(task);
  if (!address) {
    // Geen adres in het veld en ook niet in de naam: dit is een gewone taak,
    // geen opname. Geen opmerking plaatsen — daar wordt niemand wijzer van.
    return {
      ok: false,
      status: "ontbreekt",
      code: "geen_adres",
      reden: `Taak "${task.name}" bevat geen leesbaar adres; dit lijkt geen opname.`,
      adres: null,
      ...leeg(),
    };
  }

  const adres = `${address.addressLine}, ${address.woonplaats}`;

  let uitkomst: OverdrachtUitkomst;
  try {
    const result = await syncSharePointFiles({
      kind: "energielabel",
      addressLine: address.addressLine,
      woonplaats: address.woonplaats,
      postcodeRegel: address.postcodeRegel,
    });
    uitkomst = {
      ok: result.status === "compleet",
      status: result.status,
      code: null,
      reden:
        result.status === "compleet"
          ? null
          : result.failed.length > 0
            ? result.failed.map((f) => `${f.name}: ${f.error}`).join(" · ").slice(0, 300)
            : `${result.pending.length} bestand(en) zijn nog onderweg bij Dropbox`,
      adres,
      targetPaths: result.targetPaths,
      copied: result.copied,
      skipped: result.skipped,
      pending: result.pending,
      failed: result.failed,
    };
  } catch (err) {
    uitkomst = {
      ok: false,
      status: "ontbreekt",
      code: err instanceof SyncError ? err.code : "onbekend",
      reden:
        err instanceof SyncError
          ? err.message
          : `Ophalen van SharePoint is mislukt: ${err instanceof Error ? err.message : String(err)}`,
      adres,
      ...leeg(),
    };
  }

  if (melden) {
    // Een mislukte opmerking mag de uitkomst niet omgooien: de bestanden staan
    // er dan al, en de agent hoort dat te weten.
    await createTaskComment(token, taskId, melding(uitkomst)).catch(() => {});
  }
  return uitkomst;
}
