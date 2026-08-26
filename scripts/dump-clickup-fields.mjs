#!/usr/bin/env node
/**
 * Dumpt alle ClickUp Lists en hun custom fields naar clickup-fields.json.
 *
 * Gebruik:
 *   1. Haal een persoonlijk token op: ClickUp > Settings > Apps > API Token
 *      (begint met "pk_"). Zet die in .env.local:
 *
 *        CLICKUP_TOKEN=pk_...
 *
 *      Deel dit token met niemand en plak het niet in een chat.
 *
 *   2. Draai:
 *        node scripts/dump-clickup-fields.mjs              # alles
 *        node scripts/dump-clickup-fields.mjs 901234567    # alleen die List
 *
 * Het resultaat (clickup-fields.json) bevat per veld de naam, het type en
 * bij dropdowns alle opties met hun id. Die option-id's zijn nodig om een
 * dropdown via de API te kunnen invullen; de zichtbare tekst werkt niet.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://api.clickup.com/api/v2";

function loadToken() {
  if (process.env.CLICKUP_TOKEN) return process.env.CLICKUP_TOKEN.trim();
  try {
    const env = readFileSync(join(ROOT, ".env.local"), "utf8");
    const match = env.match(/^CLICKUP_TOKEN=(.+)$/m);
    if (match && match[1].trim()) return match[1].trim();
  } catch {
    // .env.local hoeft niet te bestaan
  }
  return null;
}

const token = loadToken();
if (!token) {
  console.error(
    "Geen token gevonden.\n\n" +
      "Zet CLICKUP_TOKEN=pk_... in .env.local, of draai:\n" +
      "  CLICKUP_TOKEN=pk_... node scripts/dump-clickup-fields.mjs\n\n" +
      "Token ophalen: ClickUp > Settings > Apps > API Token."
  );
  process.exit(1);
}

let calls = 0;

async function get(path) {
  calls++;
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: token },
  });

  if (res.status === 401) {
    throw new Error(
      "ClickUp weigert het token (401). Controleer of het een geldig " +
        'persoonlijk token is dat met "pk_" begint.'
    );
  }
  if (res.status === 429) {
    throw new Error(
      "Rate limit bereikt (429). Wacht een minuut en draai opnieuw, of " +
        "geef één List-id mee als argument."
    );
  }
  if (!res.ok) {
    throw new Error(`GET ${path} gaf ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

async function fieldsFor(list) {
  const { fields } = await get(`/list/${list.id}/field`);
  return {
    listId: list.id,
    listName: list.name,
    fields: (fields ?? []).map((f) => ({
      id: f.id,
      name: f.name,
      type: f.type,
      required: f.required ?? false,
      // Alleen dropdown-achtige velden hebben opties; die id's heb je nodig
      // om een waarde te kunnen zetten via de API.
      options:
        f.type_config?.options?.map((o) => ({
          id: o.id,
          name: o.name ?? o.label,
          orderindex: o.orderindex,
        })) ?? null,
    })),
  };
}

async function collectLists() {
  const onlyList = process.argv[2];
  if (onlyList) return [{ id: onlyList, name: `List ${onlyList}` }];

  const lists = [];
  const { teams } = await get("/team");

  for (const team of teams) {
    const { spaces } = await get(`/team/${team.id}/space?archived=false`);
    for (const space of spaces) {
      const { lists: folderless } = await get(
        `/space/${space.id}/list?archived=false`
      );
      folderless.forEach((l) =>
        lists.push({ id: l.id, name: `${space.name} / ${l.name}` })
      );

      const { folders } = await get(`/space/${space.id}/folder?archived=false`);
      for (const folder of folders) {
        const { lists: inFolder } = await get(
          `/folder/${folder.id}/list?archived=false`
        );
        inFolder.forEach((l) =>
          lists.push({
            id: l.id,
            name: `${space.name} / ${folder.name} / ${l.name}`,
          })
        );
      }
    }
  }
  return lists;
}

try {
  const lists = await collectLists();
  console.log(`${lists.length} List(s) gevonden. Custom fields ophalen...\n`);

  const out = [];
  for (const list of lists) {
    const result = await fieldsFor(list);
    out.push(result);

    console.log(`${result.listName}  (id ${result.listId})`);
    if (!result.fields.length) {
      console.log("   geen custom fields\n");
      continue;
    }
    for (const f of result.fields) {
      const opts = f.options
        ? `  [${f.options.length} opties: ${f.options
            .slice(0, 4)
            .map((o) => o.name)
            .join(", ")}${f.options.length > 4 ? ", ..." : ""}]`
        : "";
      console.log(`   - ${f.name}  (${f.type})${opts}`);
    }
    console.log("");
  }

  const target = join(ROOT, "clickup-fields.json");
  writeFileSync(target, JSON.stringify(out, null, 2));
  console.log(`Geschreven naar ${target}  (${calls} API-calls)`);
} catch (err) {
  console.error("\n" + err.message);
  process.exit(1);
}
