import { describe, expect, it } from "vitest";
import { bijlagenUitVelden, bouwGroepen, splitsCode, veldTekst } from "@/lib/opname-velden";

describe("splitsCode", () => {
  it("leest de code en het label van een formulierveld", () => {
    expect(splitsCode("A1 Adres:")).toMatchObject({ letter: "A", code: "A1", label: "Adres" });
    expect(splitsCode("D8.2 Polycam link - 1e verdieping (indien aanwezig)")).toMatchObject({
      code: "D8.2",
      label: "Polycam link - 1e verdieping (indien aanwezig)",
    });
  });

  it("laat alles staan wat niet bij het aanvraagformulier hoort", () => {
    // De Mo-velden vult MO Consultancy ná de aanvraag in, en "Created" is een
    // veld van ClickUp zelf. Allebei horen ze niet in dit dossier.
    expect(splitsCode("Mo-1 Check Vloer")).toBeNull();
    expect(splitsCode("Mo- Check BJ")).toBeNull();
    expect(splitsCode("Created")).toBeNull();
  });
});

describe("veldTekst", () => {
  const dropdown = {
    name: "B6 Isolatie beglazing",
    type: "drop_down",
    value: "opt-2",
    type_config: {
      options: [
        { id: "opt-1", name: "Enkel glas" },
        { id: "opt-2", name: "HR++ glas" },
      ],
    },
  };

  it("vertaalt een optie-id naar de tekst die de opnemer zag", () => {
    expect(veldTekst(dropdown)).toBe("HR++ glas");
  });

  it("telt bijlagen in plaats van ze op te sommen", () => {
    expect(veldTekst({ name: "D5 Algemene foto's", type: "attachment", value: [{}, {}, {}] })).toBe(
      "3 bestanden"
    );
    expect(veldTekst({ name: "D4 LAZ-bestanden", type: "attachment", value: [{}] })).toBe("1 bestand");
  });

  it("noemt een leeg veld leeg, in al zijn vormen", () => {
    expect(veldTekst({ name: "B8 Renovatiejaar", type: "drop_down", value: null })).toBeNull();
    expect(veldTekst({ name: "D3 Plattegrond schets", type: "attachment", value: [] })).toBeNull();
    // Een uitgevinkt vakje en een vakje waar niemand naar keek zijn hetzelfde:
    // in dit formulier betekent alleen een vínkje iets.
    expect(veldTekst({ name: "B7 Isolatie Deur", type: "checkbox", value: false })).toBeNull();
    expect(veldTekst({ name: "B7 Isolatie Deur", type: "checkbox", value: true })).toBe("Ja");
  });
});

describe("bouwGroepen", () => {
  const velden = [
    { name: "B1 Vloer grenst aan", type: "short_text", value: "Kruipruimte" },
    { name: "A10 Verzonnen veld", type: "short_text", value: "tien" },
    { name: "A2 Opnemende adviseur", type: "short_text", value: "F. de Laat" },
    { name: "Mo-1 Check Vloer", type: "labels", value: ["x"] },
    { name: "Created", type: "date", value: "1776071713727" },
  ];

  it("groepeert op letter en houdt de volgorde van het formulier aan", () => {
    const groepen = bouwGroepen(velden);
    expect(groepen.map((g) => g.letter)).toEqual(["A", "B"]);
    expect(groepen[0].titel).toBe("Algemeen");
    // A10 hoort ná A2 te staan; alfabetisch sorteren zou hem ervóór zetten.
    expect(groepen[0].velden.map((v) => v.code)).toEqual(["A2", "A10"]);
  });

  it("laat de controles van MO Consultancy en de velden van ClickUp zelf weg", () => {
    const alle = bouwGroepen(velden).flatMap((g) => g.velden.map((v) => v.code));
    expect(alle).not.toContain("Mo-1");
    expect(alle.length).toBe(3);
  });
});

describe("bijlagenUitVelden", () => {
  it("pakt de grote miniatuur en onthoudt onder welk veld de foto hing", () => {
    const bijlagen = bijlagenUitVelden([
      {
        name: "D2 Foto's Buitengevels",
        type: "attachment",
        value: [
          {
            title: "gevel-01.jpg",
            url: "https://voorbeeld/gevel-01.jpg",
            thumbnail_medium: "https://voorbeeld/gevel-01_medium.jpg",
            thumbnail_large: "https://voorbeeld/gevel-01_large.jpg",
            mimetype: "image/jpeg",
          },
        ],
      },
    ]);

    // De grote is 900x1200 en de middelste 225x300: alleen op de grote is een
    // typeplaatje te lezen als je in de PDF inzoomt.
    expect(bijlagen).toHaveLength(1);
    expect(bijlagen[0]).toMatchObject({
      code: "D2",
      label: "Foto's Buitengevels",
      naam: "gevel-01.jpg",
      miniatuurUrl: "https://voorbeeld/gevel-01_large.jpg",
    });
  });

  it("negeert velden die geen bijlageveld zijn", () => {
    expect(bijlagenUitVelden([{ name: "A1 Adres:", type: "short_text", value: "Damrak 1" }])).toEqual([]);
  });
});
