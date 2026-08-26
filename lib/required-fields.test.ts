import { describe, expect, it } from "vitest";
import { isEmptyFieldValue, ontbrekendeVelden, veldCode } from "./required-fields";
import type { ClickUpCustomField } from "./clickup";

function veld(id: string, name: string, options: { id: string; name: string }[] = []): ClickUpCustomField {
  return { id, name, type: options.length ? "drop_down" : "text", required: false, options };
}

const A4_OPTIES = [
  { id: "egw", name: "Eengezinswoning" },
  { id: "app", name: "Appartement" },
];

const VELDEN: ClickUpCustomField[] = [
  veld("f-a2", "A2 Opnemende adviseur", [{ id: "fl", name: "F. de Laat" }]),
  veld("f-a3", "A3 Bouwjaar", [{ id: "y", name: "1914" }]),
  veld("f-a4", "A4 Gebouwtype", A4_OPTIES),
  veld("f-a6", "A6 Ligging (alleen bij appartement)", [{ id: "boven", name: "Boven" }]),
  veld("f-b9", "B9 kwaliteitsverklaring opmerking"),
];

describe("isEmptyFieldValue", () => {
  it("treats blank strings and empty lists as empty", () => {
    expect(isEmptyFieldValue(undefined)).toBe(true);
    expect(isEmptyFieldValue("   ")).toBe(true);
    expect(isEmptyFieldValue([])).toBe(true);
  });

  it("treats a false checkbox as filled in", () => {
    // "Ongeïsoleerd" is een antwoord, geen ontbrekend antwoord.
    expect(isEmptyFieldValue(false)).toBe(false);
  });
});

describe("ontbrekendeVelden", () => {
  it("lists required fields that are still empty, in form order", () => {
    const mist = ontbrekendeVelden(VELDEN, { "f-a3": "y" });
    expect(mist.map((f) => f.id)).toEqual(["f-a2", "f-a4"]);
  });

  it("ignores fields that are not required", () => {
    const mist = ontbrekendeVelden(VELDEN, { "f-a2": "fl", "f-a3": "y", "f-a4": "egw" });
    expect(mist).toEqual([]); // B9 is leeg maar niet verplicht
  });

  // A6 hangt van A4 af; anders zou elke eengezinswoning eeuwig "onvolledig" zijn.
  it("only requires A6 when the building type is an apartment", () => {
    const egw = ontbrekendeVelden(VELDEN, { "f-a2": "fl", "f-a3": "y", "f-a4": "egw" });
    expect(egw.map((f) => f.id)).not.toContain("f-a6");

    const app = ontbrekendeVelden(VELDEN, { "f-a2": "fl", "f-a3": "y", "f-a4": "app" });
    expect(app.map((f) => f.id)).toEqual(["f-a6"]);
  });

  it("does not require A6 while the building type itself is still empty", () => {
    const mist = ontbrekendeVelden(VELDEN, {});
    expect(mist.map((f) => f.id)).not.toContain("f-a6");
  });
});

describe("veldCode", () => {
  it("keeps just the field code", () => {
    expect(veldCode("A7 Type dak")).toBe("A7");
    expect(veldCode("B2 Isolatie vloer")).toBe("B2");
  });
});
