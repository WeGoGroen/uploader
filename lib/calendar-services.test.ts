import { describe, expect, it } from "vitest";
import { detectServices, extractGrossFloorArea, matchServices } from "./calendar-services";

describe("matchServices", () => {
  it("recognizes NEN2580 in various spellings", () => {
    expect(matchServices("NEN2580 opname", null)).toEqual({ energielabel: false, nen: true });
    expect(matchServices("NEN 2580 opname", null)).toEqual({ energielabel: false, nen: true });
    expect(matchServices("nen-2580", null)).toEqual({ energielabel: false, nen: true });
  });

  it("recognizes energielabel in various spellings", () => {
    expect(matchServices("Energielabel opname", null)).toEqual({ energielabel: true, nen: false });
    expect(matchServices("Energie label opname", null)).toEqual({ energielabel: true, nen: false });
    expect(matchServices("EPA opname", null)).toEqual({ energielabel: true, nen: false });
  });

  it("recognizes both when both keywords are present", () => {
    expect(matchServices("Energielabel + NEN2580", null)).toEqual({ energielabel: true, nen: true });
  });

  it("checks the description too, not just the summary", () => {
    expect(matchServices("Bezichtiging", "graag ook NEN2580 meenemen")).toEqual({
      energielabel: false,
      nen: true,
    });
  });

  it("matches neither for an unrelated appointment", () => {
    expect(matchServices("Sleutels ophalen", null)).toEqual({ energielabel: false, nen: false });
  });

  describe("with a structured 'Diensten:' field in the description", () => {
    // Regressie: Pienemanstraat 68 kreeg zowel Energielabel als NEN2580 als
    // tag, terwijl de agenda-afspraak alleen een Quickscan (energielabel)
    // was. Oorzaak: "Quickscan" matchte geen enkel trefwoord, dus viel de
    // detectie terug op "allebei tonen". "Quickscan" moet dus zelf als
    // energielabel-trefwoord herkend worden, en het Diensten-veld moet
    // voorrang krijgen boven de rest van de omschrijving (klant/adres/
    // notities), zodat toevallige woorden daar niets kunnen matchen.
    const description = (diensten: string) =>
      `Klant: Voortman & Fransen\nAdres: Pienemanstraat 68 1072 KV Amsterdam\nMedewerker: Floris\nDiensten: ${diensten}\nNotities: Toestemming om gaatje te boren indien nodig.`;

    it("recognizes Quickscan as energielabel-only", () => {
      expect(matchServices("Voortman & Fransen | Quickscan", description("Quickscan"))).toEqual({
        energielabel: true,
        nen: false,
      });
    });

    it("recognizes 'Inmeting NEN2580' as NEN-only", () => {
      expect(matchServices("Makelaar Bert | Inmeting NEN2580", description("Inmeting NEN2580"))).toEqual({
        energielabel: false,
        nen: true,
      });
    });

    it("recognizes 'Energielabels Woningen EPA-W' as energielabel-only", () => {
      expect(matchServices("Pronk Beheer | Energielabels Woningen EPA-W", description("Energielabels Woningen EPA-W"))).toEqual({
        energielabel: true,
        nen: false,
      });
    });

    it("ignores stray keywords elsewhere in the description outside the Diensten-field", () => {
      const desc =
        "Klant: NEN2580 Makelaars B.V.\nAdres: Pienemanstraat 68\nDiensten: Quickscan\nNotities: -";
      expect(matchServices("Afspraak", desc)).toEqual({ energielabel: true, nen: false });
    });
  });
});

describe("detectServices", () => {
  it("falls back to both when nothing is explicitly recognized", () => {
    expect(detectServices("Bezichtiging", null)).toEqual({ energielabel: true, nen: true, explicit: false });
  });

  it("returns only the matched service when one is explicit", () => {
    expect(detectServices("NEN2580 opname", null)).toEqual({ energielabel: false, nen: true, explicit: true });
  });
});

describe("extractGrossFloorArea", () => {
  it("reads an area with m2", () => {
    expect(extractGrossFloorArea("Notities: ca. 90m2 volgens eigenaar")).toBe(90);
  });

  it("reads an area with m² and a space", () => {
    expect(extractGrossFloorArea("Notities: circa 145 m² BVO")).toBe(145);
  });

  it("reads a decimal area", () => {
    expect(extractGrossFloorArea("Oppervlakte: 87,5m2")).toBe(87.5);
  });

  it("returns null when no area is mentioned", () => {
    expect(extractGrossFloorArea("Notities: sleutel bij de buren")).toBeNull();
    expect(extractGrossFloorArea(null)).toBeNull();
  });
});
