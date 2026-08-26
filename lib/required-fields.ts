import type { ClickUpCustomField } from "@/lib/clickup";

export type FieldValue = string | string[] | boolean;

/**
 * Velden die ingevuld moeten zijn voordat een opname verstuurd mag worden.
 * A2/A3/A4/A5/A7/A8/A9 en B1 t/m B6 blokkeren "Verder naar Dropbox", D1
 * blokkeert "Verder naar Documenten". A6 ("Ligging, alleen bij appartement")
 * staat hier bewust niet in — die is alleen verplicht bij A4 = Appartement,
 * zie isRequiredField. De volgorde bepaalt ook de volgorde van de opsomming.
 */
export const REQUIRED_FIELD_PREFIXES = [
  "A2", "A3", "A4", "A5", "A7", "A8", "A9",
  "B1", "B2", "B3", "B4", "B5", "B6", "D1",
];

export function isEmptyFieldValue(value: FieldValue | undefined | null): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function findByPrefix(fields: ClickUpCustomField[], prefix: string): ClickUpCustomField | undefined {
  return fields.find((f) => f.name.startsWith(prefix));
}

/**
 * A6 "Ligging (alleen bij appartement)" is alleen verplicht als bij A4
 * Gebouwtype de optie "Appartement" gekozen is — voor elke andere woningvorm
 * is het veld niet van toepassing.
 */
export function isRequiredField(
  field: ClickUpCustomField,
  fields: ClickUpCustomField[],
  values: Record<string, FieldValue | undefined>
): boolean {
  if (field.name.startsWith("A6")) {
    const a4 = findByPrefix(fields, "A4");
    if (!a4) return false;
    return a4.options.find((o) => o.id === values[a4.id])?.name === "Appartement";
  }
  return REQUIRED_FIELD_PREFIXES.some((p) => field.name.startsWith(p));
}

/**
 * Welke verplichte velden nog leeg zijn, in de volgorde waarin ze op het
 * formulier staan. Gedeeld tussen het formulier zelf en het dashboard, zodat
 * beide hetzelfde "nog niet af" betekenen — een tweede lijstje zou vroeg of
 * laat uit de pas gaan lopen met de echte blokkade bij het versturen.
 */
export function ontbrekendeVelden(
  fields: ClickUpCustomField[],
  values: Record<string, FieldValue | undefined>
): ClickUpCustomField[] {
  return fields.filter((f) => isRequiredField(f, fields, values) && isEmptyFieldValue(values[f.id]));
}

/** Korte aanduiding zoals op het formulier: "A7 Type dak" → "A7". */
export function veldCode(naam: string): string {
  return naam.split(" ")[0] ?? naam;
}
