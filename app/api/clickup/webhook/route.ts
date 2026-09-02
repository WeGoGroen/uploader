import crypto from "node:crypto";
import { NextResponse, after } from "next/server";
import { getOptionalRedis } from "@/lib/redis";
import { overdrachtVoorTaak } from "@/lib/sharepoint-overdracht";

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

/**
 * De overdracht zelf staat in lib/sharepoint-overdracht.ts, zodat de
 * Energielabel AI Agent exact dezelfde handeling kan doen als deze webhook.
 * Hier blijft alleen wat écht bij de webhook hoort: de blokkade vasthouden
 * zolang het gelukt is, en vrijgeven zodra een nieuwe poging zinvol is.
 */
async function handleDone(taskId: string): Promise<void> {
  const uitkomst = await overdrachtVoorTaak(taskId);

  // Blokkade alleen vasthouden als het écht af is. Bij een halve of mislukte
  // overdracht moet een nieuwe poging meteen kunnen — anders zit de taak een
  // kwartier op slot terwijl er juist iets rechtgezet moet worden.
  if (!uitkomst.ok) await releaseClaim(taskId);
}
