// Snelle controle van de mapping tegen de echte veldstructuur uit ClickUp.
import { readFileSync } from "node:fs";
const dump = JSON.parse(readFileSync("clickup-fields.json", "utf8"));
const el = dump.find((l) => l.listName.endsWith("Energielabels"));

// Bootst lib/clickup-fields.ts na (JS-versie, zelfde logica).
const findField = (fields, name) => {
  const w = name.toLowerCase().replace(/:$/, "").trim();
  return fields.find((f) => f.name.toLowerCase().replace(/:$/, "").trim() === w);
};
const optionId = (f, label) =>
  (f.options ?? []).find((o) => (o.name ?? "").toLowerCase() === label.toLowerCase())?.id ?? null;

function map(fields, answers) {
  const customFields = [], unmapped = [], unknownOptions = [];
  for (const [name, raw] of Object.entries(answers)) {
    const value = (raw ?? "").trim();
    if (!value) continue;
    const f = findField(fields, name);
    if (!f) { unmapped.push({ name, value }); continue; }
    if (f.type === "drop_down") {
      const id = optionId(f, value);
      if (!id) { unknownOptions.push({ name, value }); continue; }
      customFields.push({ id: f.id, value: id });
      continue;
    }
    customFields.push({ id: f.id, value });
  }
  return { customFields, unmapped, unknownOptions };
}

const r = map(el.fields, {
  "Klant:": "Broersma",
  "Tags": "Energielabel",
  "Woningtype": "Rijwoning tussen",
  "Bouwjaar": "1920",
  "Klant": "Ameo",                 // zonder dubbele punt
  "Tags ": "Bestaat niet",         // ongeldige optie
});

console.log("custom_fields die naar ClickUp gaan:");
console.log(JSON.stringify(r.customFields, null, 1));
console.log("\ngeen ClickUp-veld (gaan naar omschrijving):", r.unmapped.map(u => u.name));
console.log("optie bestaat niet:", r.unknownOptions);
