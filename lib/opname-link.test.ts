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

// Een media-opname heeft een pad als id. Onverpakt in een querystring gezet
// levert dat een link op die het id niet heelhuids overdraagt.
describe("een id dat een pad is", () => {
  it("survives the trip through the query string", () => {
    const id = "media-/Automatie Media/Rustenburgerstraat 356-1, Amsterdam";
    const link = opnameLink({ id, straatnaam: "Rustenburgerstraat 356-1" });
    const terug = new URL(link, "https://voorbeeld.nl").searchParams.get("draft");
    expect(terug).toBe(id);
  });
});

describe("een media-opname", () => {
  // Haar id is het pad van de projectmap, geen formulierconcept: de
  // mediapagina zoekt het adres zelf weer op, net als de NEN-pagina.
  it("opens the media page on the address", () => {
    expect(
      opnameLink({
        id: "media-/Automatie Media/Rustenburgerstraat 356-1, Amsterdam",
        soort: "media",
        straatnaam: "Rustenburgerstraat 356-1",
      })
    ).toBe("/media?addr=Rustenburgerstraat%20356-1");
  });

  it("falls back to the media page without an address", () => {
    expect(opnameLink({ id: "media-/leeg", soort: "media" })).toBe("/media");
  });
});
