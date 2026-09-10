import { describe, expect, it } from "vitest";
import { configVoorProduct } from "./mediatask-format";

const NEN = {
  configuration: [
    { name: "gross_floor_area", values: ["≤110m2", "111-230m2", "231-390m2"] },
    { name: "option", values: ["2D", "3D"] },
    { name: "style", values: ["STD", "DLX"] },
    { name: "measurement_type", values: ["A", "B"] },
    { name: "measurement_date" },
  ],
};

const BASIS = {
  configuration: [
    { name: "gross_floor_area", values: ["≤110m2", "111-230m2", "231-390m2"] },
    { name: "option", values: ["2D", "3D"] },
    { name: "style", values: ["STD", "DLX"] },
  ],
};

const CAD = { configuration: [{ name: "house_type", values: ["A", "B", "C", "D"] }] };

describe("configVoorProduct", () => {
  it("vult de standaarden voor een NEN2580-product", () => {
    expect(configVoorProduct(NEN, { m2: 90, vandaag: "2026-09-09" })).toEqual({
      gross_floor_area: "≤110m2",
      option: "3D",
      style: "STD",
      measurement_type: "A",
      measurement_date: "2026-09-09",
    });
  });

  it("houdt bij een wissel naar basis over wat nog bestaat en laat de meetvelden vallen", () => {
    const huidig = {
      gross_floor_area: "111-230m2",
      option: "2D",
      style: "DLX",
      measurement_type: "B",
      measurement_date: "2026-09-01",
    };
    expect(configVoorProduct(BASIS, { m2: 90, vandaag: "2026-09-09", huidig })).toEqual({
      gross_floor_area: "111-230m2",
      option: "2D",
      style: "DLX",
    });
  });

  it("laat nooit een leeg antwoord achter voor een product met bekende velden", () => {
    // Dit is de hele reden dat deze functie bestaat: een lege configuratie
    // laat de order bij Mediatask sneuvelen.
    expect(Object.keys(configVoorProduct(BASIS, { vandaag: "2026-09-09" })).length).toBeGreaterThan(0);
  });

  it("verzint niets voor een product met onbekende velden", () => {
    expect(configVoorProduct(CAD, { m2: 90, vandaag: "2026-09-09" })).toEqual({});
  });

  it("slaat het oppervlak over als er geen m² bekend is", () => {
    const uit = configVoorProduct(NEN, { vandaag: "2026-09-09" });
    expect(uit.gross_floor_area).toBeUndefined();
    expect(uit.option).toBe("3D");
  });

  it("geeft een lege configuratie terug zonder product", () => {
    expect(configVoorProduct(null, { vandaag: "2026-09-09" })).toEqual({});
  });
});
