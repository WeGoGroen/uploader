import { describe, expect, it } from "vitest";
import {
  GEVELS,
  energielabelMapVoor,
  lijnDikte,
  ramenBestandsnaam,
} from "@/lib/ramen-inkleuren";

describe("ramenBestandsnaam", () => {
  const moment = new Date(2026, 9, 20, 14, 5, 9);

  it("zet de gevel en het moment in de naam", () => {
    expect(ramenBestandsnaam(GEVELS[0], moment)).toBe("Voorgevel 2026-10-20 14.05.09.jpg");
  });

  it("heet Buitengevel zonder gekozen gevel", () => {
    expect(ramenBestandsnaam(null, moment)).toBe("Buitengevel 2026-10-20 14.05.09.jpg");
  });

  it("geeft twee foto's van dezelfde gevel nooit dezelfde naam", () => {
    const later = new Date(2026, 9, 20, 14, 5, 10);
    expect(ramenBestandsnaam(GEVELS[1], moment)).not.toBe(ramenBestandsnaam(GEVELS[1], later));
  });
});

describe("lijnDikte", () => {
  it("schaalt mee met de foto", () => {
    expect(lijnDikte("kleur", 4000)).toBe(64);
    expect(lijnDikte("kleur", 2000)).toBe(32);
  });

  it("maakt een schrijflijn dunner dan een inkleurlijn", () => {
    expect(lijnDikte("schrijf", 2000)).toBeLessThan(lijnDikte("kleur", 2000));
  });
});

describe("energielabelMapVoor", () => {
  it("volgt de opbouw van de projectmap", () => {
    expect(energielabelMapVoor("Amsterdam", "Damrak 1")).toBe("/Automatie Energielabels/Damrak 1, Amsterdam");
  });

  it("haalt padtekens uit de naam", () => {
    expect(energielabelMapVoor("Den  Haag", "Laan 3/A")).toBe("/Automatie Energielabels/Laan 3-A, Den Haag");
  });
});
