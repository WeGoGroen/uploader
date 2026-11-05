import { describe, expect, it } from "vitest";
import { productVoorSoort } from "./mediatask-format";

const producten = [
  { id: 6, full_name: "Floorplanner NEN2580 plans NEW" },
  { id: 2, full_name: "Floorplanner NEN2580 plans" },
  { id: 9, full_name: "Floorplanner basic plans" },
];

describe("productVoorSoort", () => {
  it("kiest zonder soort het NEN2580-product", () => {
    expect(productVoorSoort(producten, "")?.id).toBe(6);
  });

  it("kiest bij huurpunten en commercieel het basisproduct", () => {
    expect(productVoorSoort(producten, "huurpunten")?.id).toBe(9);
    expect(productVoorSoort(producten, "commercieel")?.id).toBe(9);
  });

  it("vindt het basisproduct ook bij een iets andere naam", () => {
    expect(productVoorSoort([{ id: 4, full_name: "Floorplanner Basic plans 2026" }], "huurpunten")?.id).toBe(4);
  });

  it("geeft null als het product er niet is", () => {
    expect(productVoorSoort([{ id: 6, full_name: "Floorplanner NEN2580 plans NEW" }], "commercieel")).toBeNull();
  });
});
