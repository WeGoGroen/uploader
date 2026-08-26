import type { ClickUpCustomField } from "./clickup";

/**
 * ClickUp verwacht voor een drop_down-veld het id van de optie, niet de
 * zichtbare tekst. Deze helper zoekt het veld op naam en vertaalt een
 * gekozen label naar het bijbehorende option-id.
 */

export interface CustomFieldValue {
  id: string;
  value: string | number;
}

export interface MappingResult {
  customFields: CustomFieldValue[];
  /** Antwoorden waarvoor geen ClickUp-veld bestaat. */
  unmapped: { name: string; value: string }[];
  /** Velden die wel bestaan, maar waar de gekozen optie ontbreekt. */
  unknownOptions: { name: string; value: string }[];
}

interface FieldWithOptions extends ClickUpCustomField {
  type_config?: {
    options?: { id: string; name?: string; label?: string; orderindex?: number }[];
  };
}

/**
 * Vergelijkt namen zonder accenten, hoofdletters of afsluitende dubbele punt,
 * zodat "Orientatie" ook "Oriëntatie" vindt en "Klant" ook "Klant:". Een
 * typefout bij het aanmaken in ClickUp breekt de koppeling dan niet stil.
 */
function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/:$/, "")
    .trim();
}

function findField(
  fields: FieldWithOptions[],
  name: string
): FieldWithOptions | undefined {
  const wanted = normalize(name);
  return fields.find((f) => normalize(f.name) === wanted);
}

function optionId(field: FieldWithOptions, label: string): string | null {
  const options = field.type_config?.options ?? [];
  const wanted = normalize(label);
  const match = options.find(
    (o) => normalize(o.name ?? o.label ?? "") === wanted
  );
  return match?.id ?? null;
}

/**
 * Zet een set antwoorden ({ "Klant:": "Broersma", ... }) om naar het
 * custom_fields-formaat van de ClickUp API.
 */
export function mapAnswersToCustomFields(
  fields: ClickUpCustomField[],
  answers: Record<string, string>
): MappingResult {
  const typed = fields as FieldWithOptions[];
  const customFields: CustomFieldValue[] = [];
  const unmapped: { name: string; value: string }[] = [];
  const unknownOptions: { name: string; value: string }[] = [];

  for (const [name, rawValue] of Object.entries(answers)) {
    const value = (rawValue ?? "").trim();
    if (!value) continue;

    const field = findField(typed, name);
    if (!field) {
      unmapped.push({ name, value });
      continue;
    }

    if (field.type === "drop_down") {
      const id = optionId(field, value);
      if (!id) {
        unknownOptions.push({ name, value });
        continue;
      }
      customFields.push({ id: field.id, value: id });
      continue;
    }

    if (field.type === "number") {
      const num = Number(value.replace(",", "."));
      if (Number.isNaN(num)) {
        unknownOptions.push({ name, value });
        continue;
      }
      customFields.push({ id: field.id, value: num });
      continue;
    }

    customFields.push({ id: field.id, value });
  }

  return { customFields, unmapped, unknownOptions };
}

/**
 * Antwoorden zonder eigen ClickUp-veld gaan als leesbare lijst mee in de
 * taakomschrijving, zodat er niets verloren gaat zolang die velden nog
 * niet in ClickUp bestaan.
 */
export function describeUnmapped(
  unmapped: { name: string; value: string }[]
): string {
  if (!unmapped.length) return "";
  return [
    "## Opnamegegevens",
    "",
    ...unmapped.map((u) => `- **${u.name}:** ${u.value}`),
  ].join("\n");
}
