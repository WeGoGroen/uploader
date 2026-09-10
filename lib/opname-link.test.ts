import { describe, expect, it } from "vitest";
import { opnameLink } from "./opname-link";

/**
 * Waar "verder afmaken" heen gaat. Dit is twee keer los bedacht op twee
 * schermen en kwam beide keren op /energielabel uit, ook voor NEN — waardoor
 * wie geen energielabelrecht heeft bij het klikken werd teruggestuurd naar
 * het dashboard, en dus niet meer bij zijn eigen upload kon.
 */
describe("opnameLink", () => {
  it("stuurt een NEN-opname naar de NEN-pagina, op adres", () => {
    expect(
      opnameLink({ id: "nen-Herengracht 518-H, Amsterdam", soort: "nen", straatnaam: "Herengracht 518-H" })
    ).toBe("/nen?addr=Herengracht%20518-H");
  });

  it("stuurt een energielabel-opname naar zijn concept", () => {
    expect(opnameLink({ id: "abc", soort: "energielabel", straatnaam: "Dam 5" })).toBe(
      "/energielabel?draft=abc"
    );
  });

  it("herkent oude NEN-opnames zonder soort aan hun Mediatask-order", () => {
    expect(opnameLink({ id: "oud", heeftMediatask: true, straatnaam: "Dam 5" })).toBe("/nen?addr=Dam%205");
  });

  it("valt terug op de NEN-pagina zonder adres in plaats van een kapotte link", () => {
    expect(opnameLink({ id: "leeg", soort: "nen" })).toBe("/nen");
  });
});
