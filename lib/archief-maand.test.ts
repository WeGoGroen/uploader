import { describe, expect, it } from "vitest";
import { isMaandMap, maandMapNaam } from "@/lib/archief-maand";
import { isProjectmap } from "@/lib/fotos-opruimen";

describe("maandMapNaam", () => {
  it("geeft jaar, maandnummer en naam", () => {
    expect(maandMapNaam(new Date("2026-10-13T12:00:00Z"))).toBe("2026-10 Oktober");
  });

  it("rekent in Nederlandse tijd", () => {
    // 31 januari 23:30 UTC is 1 februari in Amsterdam.
    expect(maandMapNaam(new Date("2026-01-31T23:30:00Z"))).toBe("2026-02 Februari");
  });
});

describe("isMaandMap", () => {
  it("herkent een maandmap en geen adres", () => {
    expect(isMaandMap("2026-10 Oktober")).toBe(true);
    expect(isMaandMap("2026-10")).toBe(true);
    expect(isMaandMap("Eemsstraat 5-3, Amsterdam")).toBe(false);
    expect(isMaandMap("2e Hugo de Grootstraat 1, Amsterdam")).toBe(false);
  });
});

describe("isProjectmap met maandmappen", () => {
  it("accepteert een project in een maandmap van het archief", () => {
    expect(isProjectmap("/Automatie Energielabels/Afgerond/2026-10 Oktober/Kade 1, Amsterdam")).toBe(true);
  });

  it("ziet de maandmap zelf niet als projectmap", () => {
    expect(isProjectmap("/Automatie Energielabels/Afgerond/2026-10 Oktober")).toBe(false);
  });

  it("houdt het oude archief zonder maand geldig", () => {
    expect(isProjectmap("/Automatie Energielabels/Afgerond/Kade 1, Amsterdam")).toBe(true);
  });
});

describe("statusVeld met maandmappen", () => {
  it("valt terug op de hoofdmap, ook vanuit een maandmap", async () => {
    const { statusVeld } = await import("@/lib/dropbox");
    expect(statusVeld("/Automatie Energielabels/Afgerond/2026-10 Oktober", "Kade 1, Amsterdam")).toBe(
      "/automatie energielabels/kade 1, amsterdam"
    );
    expect(statusVeld("/Automatie Energielabels/Afgerond", "Kade 1, Amsterdam")).toBe(
      "/automatie energielabels/kade 1, amsterdam"
    );
  });
});
