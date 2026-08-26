#!/usr/bin/env node
/**
 * Zet de ClickUp-webhook aan die het ophalen van de finale SharePoint-
 * bestanden start zodra een taak op klaar gaat.
 *
 * Gebruik:
 *   node scripts/create-clickup-webhook.mjs https://jouw-app.vercel.app
 *   node scripts/create-clickup-webhook.mjs --list       # bestaande tonen
 *   node scripts/create-clickup-webhook.mjs --delete <id>
 *
 * ClickUp geeft bij het aanmaken één keer een "secret" terug. Zet die in
 * Vercel (Project > Settings > Environment Variables) als
 * CLICKUP_WEBHOOK_SECRET en deploy opnieuw — zonder dat geheim weigert de
 * webhook-route álles, want die route staat buiten de inlog van de app.
 *
 * De webhook wordt beperkt tot de energielabel-List uit CLICKUP_LIST_ID, dus
 * taken in andere lijsten triggeren niets.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://api.clickup.com/api/v2";

function fromEnvFile(name) {
  try {
    const env = readFileSync(join(ROOT, ".env.local"), "utf8");
    const match = env.match(new RegExp(`^${name}=(.+)$`, "m"));
    return match && match[1].trim() ? match[1].trim() : null;
  } catch {
    return null;
  }
}

function envVar(name) {
  return process.env[name]?.trim() || fromEnvFile(name);
}

const token = envVar("CLICKUP_TOKEN") || JSON.parse(envVar("CLICKUP_ACCOUNTS") || "[]")[0]?.token;
if (!token) {
  console.error(
    "Geen ClickUp-token gevonden.\n\n" +
      "Zet CLICKUP_TOKEN=pk_... in .env.local (ClickUp > Settings > Apps > API Token)."
  );
  process.exit(1);
}

const listId = envVar("CLICKUP_LIST_ID");

async function call(path, init) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: token, "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`ClickUp ${path} gaf ${res.status}:\n${text}`);
    process.exit(1);
  }
  return text ? JSON.parse(text) : {};
}

const { teams } = await call("/team");
if (!teams.length) {
  console.error("Geen ClickUp-workspace gevonden voor dit token.");
  process.exit(1);
}

/**
 * De juiste workspace is die waar CLICKUP_LIST_ID in zit — niet zomaar de
 * eerste die ClickUp teruggeeft. Dit account ziet twee workspaces die allebei
 * "WeGoGroen" heten, en de energielabel-lijst is er via "Shared with me" maar
 * één van. Een webhook aanmaken op de verkeerde workspace geeft een
 * verwarrende "Team not authorized" — alsof het token te weinig rechten heeft,
 * terwijl het gewoon de verkeerde workspace was.
 */
async function teamVanLijst() {
  if (!listId) return teams[0];
  const lijst = await call(`/list/${listId}`);
  const spaceId = lijst.space?.id;
  for (const t of teams) {
    const { spaces } = await call(`/team/${t.id}/space?archived=false`);
    if (spaces.some((sp) => sp.id === String(spaceId))) return t;
  }
  // Lijst gedeeld vanuit een workspace waarvan we de spaces niet kunnen zien:
  // dan maar proberen op de eerste, en de fout spreekt voor zich.
  return teams[0];
}

const team = await teamVanLijst();

const [arg, second] = process.argv.slice(2);

if (arg === "--list") {
  const { webhooks } = await call(`/team/${team.id}/webhook`);
  if (!webhooks.length) console.log("Geen webhooks ingesteld.");
  for (const w of webhooks) {
    console.log(`${w.id}  ${w.endpoint}  [${w.events.join(", ")}]  ${w.health?.status ?? ""}`);
  }
  process.exit(0);
}

if (arg === "--delete") {
  if (!second) {
    console.error("Gebruik: node scripts/create-clickup-webhook.mjs --delete <webhook-id>");
    process.exit(1);
  }
  await call(`/webhook/${second}`, { method: "DELETE" });
  console.log(`Webhook ${second} verwijderd.`);
  process.exit(0);
}

if (!arg || !arg.startsWith("http")) {
  console.error(
    "Gebruik: node scripts/create-clickup-webhook.mjs https://jouw-app.vercel.app\n\n" +
      "Andere opties: --list, --delete <id>"
  );
  process.exit(1);
}

const endpoint = `${arg.replace(/\/+$/, "")}/api/clickup/webhook`;

const created = await call(`/team/${team.id}/webhook`, {
  method: "POST",
  body: JSON.stringify({
    endpoint,
    events: ["taskStatusUpdated"],
    ...(listId ? { list_id: Number(listId) } : {}),
  }),
});

console.log(`Webhook aangemaakt op ${endpoint}`);
if (listId) console.log(`Beperkt tot List ${listId}.`);
console.log("\nZet dit geheim in Vercel als CLICKUP_WEBHOOK_SECRET en deploy opnieuw:\n");
console.log(`  CLICKUP_WEBHOOK_SECRET=${created.webhook?.secret ?? created.secret}\n`);
