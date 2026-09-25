import { describe, expect, it } from "vitest";
import { omgevingsfotoAdresmap, omgevingsfotoDoelPad } from "@/lib/omgevingsfoto-pad";

describe("omgevingsfotoDoelPad", () => {
  it("zet een foto in de adresmap onder Omgevingsfoto's", () => {
    expect(omgevingsfotoDoelPad("Noordermarkt 4H, Amsterdam", "Noordermarkt 4-4, Amsterdam PHOTO 19.jpg")).toBe(
      "/Omgevingsfoto's/Noordermarkt 4H, Amsterdam/Noordermarkt 4-4, Amsterdam PHOTO 19.jpg"
    );
  });

  it("laat de adresmap niet uit zijn hoofdmap lopen", () => {
    expect(omgevingsfotoAdresmap("../Automatie Media")).toBeNull();
    expect(omgevingsfotoDoelPad("Dam 1/../../x", "a.jpg")).toBeNull();
  });

  it("weigert iets zonder huisnummer of een ander bestand dan beeld", () => {
    expect(omgevingsfotoAdresmap("Keizersgracht, Amsterdam")).toBeNull();
    expect(omgevingsfotoDoelPad("Dam 1, Amsterdam", "geheim.pdf")).toBeNull();
  });
});
