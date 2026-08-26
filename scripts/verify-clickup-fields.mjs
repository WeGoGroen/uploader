#!/usr/bin/env node
/**
 * Controleert of de custom fields uit clickup-required-fields.json echt in de
 * ClickUp-List staan, met de juiste naam, het juiste type en dezelfde
 * dropdown-opties.
 *
 * Gebruik:
 *   node scripts/verify-clickup-fields.mjs                 # List uit .env.local
 *   node scripts/verify-clickup-fields.mjs 901219761080    # expliciete List
 *
 * Vereist CLICKUP_TOKEN in .env.local (zie dump-clickup-fields.mjs).
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://api.clickup.com/api/v2";

const DEFAULT_LIST = "901219761080"; // Team Space / WeGoGroen / Energielabels

function fromEnv(key) {
  if (process.env[key]) return process.env[key].trim();
  try {
    const env = readFileSync(join(ROOT, ".env.local"), "utf8");
    const m = env.match(new RegExp("^" + key + "=(.+)$", "m"));
    if (m && m[1].trim()) return m[1].trim();
  } catch {
    /* .env.local hoeft niet te bestaan */
  }
  return null;
}

const token = fromEnv("CLICKUP_TOKEN");
if (!token) {
  console.error(
    "Geen CLICKUP_TOKEN gevonden in .env.local.\n" +
      "Ophalen via ClickUp > Settings > Apps > API Token."
  );
  process.exit(1);
}

const listId = process.argv[2] || fromEnv("CLICKUP_LIST_ID") || DEFAULT_LIST;

// Accent-ongevoelig vergelijken: "Orientatie" matcht ook "Oriëntatie", zodat
// een typefout bij het aanmaken in ClickUp de koppeling niet stilletjes breekt.
const norm = (s) =>
  (s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/:$/, "")
    .trim();

let spec;
try {
  spec = JSON.parse(readFileSync(join(ROOT, "clickup-required-fields.json"), "utf8"));
} catch {
  console.error(
    "clickup-required-fields.json niet gevonden. Dit bestand hoort naast " +
      "package.json te staan."
  );
  process.exit(1);
}

const res = await fetch(`${API}/list/${listId}/field`, {
  headers: { Authorization: token },
});
if (!res.ok) {
  console.error(
    res.status === 401
      ? "ClickUp weigert het token (401). Is het token vernieuwd?"
      : `ClickUp gaf ${res.status}: ${await res.text()}`
  );
  process.exit(1);
}
const live = (await res.json()).fields ?? [];

const byName = new Map(live.map((f) => [norm(f.name), f]));

const ok = [];
const missing = [];
const wrongType = [];
const optionIssues = [];

for (const want of spec) {
  const found = byName.get(norm(want.name));
  if (!found) {
    missing.push(want);
    continue;
  }

  if (found.type !== want.type) {
    wrongType.push({ name: want.name, expected: want.type, actual: found.type });
    continue;
  }

  if (want.options) {
    const liveOptions = (found.type_config?.options ?? []).map((o) =>
      norm(o.name ?? o.label)
    );
    const absent = want.options.filter((o) => !liveOptions.includes(norm(o)));
    if (absent.length) {
      optionIssues.push({ name: want.name, absent });
      continue;
    }
  }

  ok.push(want.name);
}

const line = "-".repeat(58);
console.log(`\nList ${listId} — ${live.length} custom fields aanwezig`);
console.log(line);
console.log(`in orde            ${ok.length} / ${spec.length}`);
console.log(`ontbreekt          ${missing.length}`);
console.log(`verkeerd type      ${wrongType.length}`);
console.log(`opties incompleet  ${optionIssues.length}`);
console.log(line);

if (missing.length) {
  console.log("\nNog aanmaken:");
  for (const m of missing) {
    console.log(`  - ${m.name}  (${m.type})`);
  }
}

if (wrongType.length) {
  console.log("\nVerkeerd veldtype:");
  for (const w of wrongType) {
    console.log(`  - ${w.name}: is ${w.actual}, moet ${w.expected} zijn`);
  }
}

if (optionIssues.length) {
  console.log("\nDropdown mist opties (let op spelling):");
  for (const o of optionIssues) {
    console.log(`  - ${o.name}: ${o.absent.join(", ")}`);
  }
}

const clean = !missing.length && !wrongType.length && !optionIssues.length;
console.log(
  clean
    ? "\nAlles staat goed. Het portaal kan elk antwoord als custom field wegschrijven.\n"
    : "\nMaak bovenstaande af en draai dit script opnieuw.\n"
);
process.exit(clean ? 0 : 1);
