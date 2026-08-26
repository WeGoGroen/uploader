import crypto from "node:crypto";
import { NextResponse, after } from "next/server";
import { createTaskComment, getTask, requireClickUpConfig } from "@/lib/clickup";
import { getOptionalRedis } from "@/lib/redis";
import { taskToAddress } from "@/lib/sharepoint-match";
import { SyncError, syncSharePointFiles } from "@/lib/sharepoint-sync";

/**
 * Ontvangt ClickUp-webhooks. Zodra een energielabel-taak op "klaar" gezet
 * wordt, haalt de app de finale bestanden van SharePoint en zet ze in de
 * Dropbox-projectmap die bij het aanmaken van de taak al is klaargezet — de
 * handeling die tot nu toe met de hand gebeurde.
 *
 * Deze route staat buiten de inlog (ClickUp heeft geen sessie) en beveiligt
 * zichzelf met de handtekening die ClickUp over de ruwe body zet.
 */

// Het ophalen zelf loopt door in after(), nadat ClickUp al een 200 heeft
// gekregen. Zonder deze regel kapt Vercel die functie na de standaardtijd af —
// en dan stopt een overdracht van een groot Revit-model halverwege, zonder dat
// iemand een fout ziet.
export const maxDuration = 300;

function doneStatuses(): string[] {
  return (process.env.CLICKUP_DONE_STATUSES || "complete,done,klaar,afgerond")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function signatureMatches(secret: string, rawBody: string, signature: string | null): boolean {
  if (!signature) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  // Lengtes moeten gelijk zijn vóór timingSafeEqual, anders gooit die zelf.
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

interface WebhookBody {
  event?: string;
  task_id?: string;
  history_items?: { field?: string; after?: { status?: string } }[];
}

/**
 * Voorkomt dat dezelfde taak twee keer wordt opgehaald: ClickUp stuurt een
 * webhook opnieuw als hij niet snel genoeg een 200 krijgt, en iemand die de
 * status heen en weer zet triggert 'm ook opnieuw. Zonder Redis slaan we deze
 * bescherming over — dan is dubbel ophalen nog steeds onschadelijk, want
 * bestanden die er al staan worden overgeslagen.
 */
async function claim(taskId: string): Promise<boolean> {
  const redis = getOptionalRedis();
  if (!redis) return true;
  const result = await redis.set(`sharepoint:sync:${taskId}`, "1", "EX", 900, "NX");
  return result === "OK";
}

async function releaseClaim(taskId: string): Promise<void> {
  const redis = getOptionalRedis();
  if (!redis) return;
  await redis.del(`sharepoint:sync:${taskId}`);
}

export async function POST(request: Request) {
  const secret = process.env.CLICKUP_WEBHOOK_SECRET;
  if (!secret) {
    // Bewust dicht: zonder geheim kan iedereen die de URL kent onze
    // SharePoint laten uitlezen.
    return NextResponse.json({ error: "webhook_secret_niet_ingesteld" }, { status: 503 });
  }

  const rawBody = await request.text();
  if (!signatureMatches(secret, rawBody, request.headers.get("x-signature"))) {
    return NextResponse.json({ error: "ongeldige_handtekening" }, { status: 401 });
  }

  let body: WebhookBody;
  try {
    body = JSON.parse(rawBody) as WebhookBody;
  } catch {
    return NextResponse.json({ error: "ongeldige_json" }, { status: 400 });
  }

  const taskId = body.task_id;
  const newStatus = body.history_items?.find((h) => h.field === "status")?.after?.status;

  if (body.event !== "taskStatusUpdated" || !taskId || !newStatus) {
    return NextResponse.json({ ok: true, actie: "genegeerd" });
  }
  if (!doneStatuses().includes(newStatus.toLowerCase())) {
    return NextResponse.json({ ok: true, actie: "nog_niet_klaar" });
  }
  if (!(await claim(taskId))) {
    return NextResponse.json({ ok: true, actie: "al_bezig" });
  }

  // Meteen 200 terug: ClickUp verwacht binnen enkele seconden antwoord en
  // stuurt de webhook anders opnieuw. Het ophalen zelf loopt door in after().
  after(async () => {
    try {
      await handleDone(taskId);
    } catch (err) {
      console.error("SharePoint sync via webhook failed", err);
      // Claim vrijgeven, zodat een volgende poging (of de handmatige knop)
      // niet tegen "al bezig" aanloopt.
      await releaseClaim(taskId).catch(() => {});
    }
  });

  return NextResponse.json({ ok: true, actie: "opgestart" });
}

async function handleDone(taskId: string): Promise<void> {
  const { token } = await requireClickUpConfig();
  const task = await getTask(token, taskId);

  const address = taskToAddress(task);
  if (!address) {
    // Geen adres in het veld "A1 Adres:" en ook niet in de naam: dit is een
    // gewone taak, geen opname. Stilzwijgend overslaan — daar hoort geen
    // opmerking bij.
    await releaseClaim(taskId);
    return;
  }

  try {
    const result = await syncSharePointFiles({
      kind: "energielabel",
      addressLine: address.addressLine,
      woonplaats: address.woonplaats,
      postcodeRegel: address.postcodeRegel,
    });

    const bolletje =
      result.status === "compleet" ? "🟢" : result.status === "bezig" ? "🟠" : "🔴";

    const lines = [
      `${bolletje} ${result.copied.length} bestand${result.copied.length === 1 ? "" : "en"} opgehaald van SharePoint naar Dropbox: ${result.targetPaths.join(", ")}`,
      result.copied.length ? result.copied.map((n) => `• ${n}`).join("\n") : null,
      result.skipped.length ? `Overgeslagen (stond er al): ${result.skipped.join(", ")}` : null,
      result.pending.length
        ? `⏳ Nog onderweg bij Dropbox: ${result.pending.join(", ")}. De map blijft oranje tot dit is afgerond.`
        : null,
      result.failed.length
        ? `⚠️ Mislukt: ${result.failed.map((f) => `${f.name} (${f.error})`).join("; ")}`
        : null,
    ].filter(Boolean);

    await createTaskComment(token, taskId, lines.join("\n"));

    // Blokkade alleen vasthouden als het écht af is. Bij een halve of mislukte
    // overdracht moet een nieuwe poging meteen kunnen — anders zit de taak een
    // kwartier op slot terwijl er juist iets rechtgezet moet worden.
    if (result.status !== "compleet") await releaseClaim(taskId);
  } catch (err) {
    const message =
      err instanceof SyncError
        ? err.message
        : `Ophalen van SharePoint is mislukt: ${err instanceof Error ? err.message : String(err)}`;
    await createTaskComment(token, taskId, `⚠️ ${message} Haal de bestanden deze keer met de hand op.`);
    await releaseClaim(taskId);
  }
}
