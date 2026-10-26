import { describe, expect, it, vi } from "vitest";
import { leesAdres, maakProjectmap, type AanmaakDeps } from "@/lib/projectmap-aanmaken";

function deps(aanpassing: Partial<AanmaakDeps> = {}): AanmaakDeps & {
  maakMap: ReturnType<typeof vi.fn>;
} {
  return {
    zoekKandidaten: vi.fn(async () => []),
    maakMap: vi.fn(async (woonplaats: string, straat: string) => ({
      path: `/Automatie Energielabels/${straat}, ${woonplaats}`,
      url: "https://www.dropbox.com/scl/fo/abc",
    })),
    idVan: vi.fn(async () => "id:nieuw123"),
    ...aanpassing,
  } as AanmaakDeps & { maakMap: ReturnType<typeof vi.fn> };
}

describe("leesAdres", () => {
  it("leest de mapnaam die het control center meestuurt", () => {
    expect(leesAdres({ naam: "Kikvorsweide 2, Nieuwegein" })).toEqual({
      straatEnNummer: "Kikvorsweide 2",
      woonplaats: "Nieuwegein",
      mapnaam: "Kikvorsweide 2, Nieuwegein",
    });
  });

  it("valt terug op het ruwe adres met postcode", () => {
    expect(leesAdres({ adres: "Bankastraat 47-H, 1094EB Amsterdam" })?.mapnaam).toBe(
      "Bankastraat 47-H, Amsterdam"
    );
  });

  it("zet een woonplaats in hoofdletters om, zoals de bestaande mappen heten", () => {
    expect(leesAdres({ adres: "Jaap Speyerstraat 44\n1087 MK AMSTERDAM" })?.woonplaats).toBe("Amsterdam");
  });

  it("weigert een adres zonder huisnummer of woonplaats", () => {
    expect(leesAdres({ naam: "Kikvorsweide, Nieuwegein" })).toBeNull();
    expect(leesAdres({ adres: "Kikvorsweide 2" })).toBeNull();
    expect(leesAdres({})).toBeNull();
  });
});

describe("maakProjectmap", () => {
  it("maakt een map als er nergens een staat, en geeft het id terug", async () => {
    const d = deps();
    const uit = await maakProjectmap({ naam: "Kikvorsweide 2, Nieuwegein" }, d);
    expect(d.maakMap).toHaveBeenCalledWith("Nieuwegein", "Kikvorsweide 2");
    expect(uit).toEqual({
      ok: true,
      pad: "/Automatie Energielabels/Kikvorsweide 2, Nieuwegein",
      folder_id: "id:nieuw123",
      url: "https://www.dropbox.com/scl/fo/abc",
      bestond: false,
      reden: null,
    });
  });

  it("maakt nooit een tweede map naast een map in de oude indeling", async () => {
    const d = deps({
      zoekKandidaten: async () => [
        { id: "id:oud", pad: "/Certificering NL-EPBD/…/2025-03/Kikvorsweide 2, Nieuwegein", herkomst: "intern" },
      ],
    });
    const uit = await maakProjectmap({ naam: "Kikvorsweide 2, Nieuwegein" }, d);
    expect(d.maakMap).not.toHaveBeenCalled();
    expect(uit).toMatchObject({ ok: true, folder_id: "id:oud", bestond: true });
  });

  it("kiest niet tussen twee bestaande mappen", async () => {
    const d = deps({
      zoekKandidaten: async () => [
        { id: "id:a", pad: "/a", herkomst: "automatie" },
        { id: "id:b", pad: "/b", herkomst: "archief" },
      ],
    });
    const uit = await maakProjectmap({ naam: "Kikvorsweide 2, Nieuwegein" }, d);
    expect(d.maakMap).not.toHaveBeenCalled();
    expect(uit.ok).toBe(false);
    if (!uit.ok) expect(uit.reden).toContain("2 mappen");
  });

  it("weigert een onleesbaar adres zonder Dropbox aan te raken", async () => {
    const zoek = vi.fn(async () => []);
    const d = deps({ zoekKandidaten: zoek });
    const uit = await maakProjectmap({ adres: "ergens in Utrecht" }, d);
    expect(uit.ok).toBe(false);
    if (!uit.ok) expect(uit.reden).toContain("ongeldig adres");
    expect(zoek).not.toHaveBeenCalled();
    expect(d.maakMap).not.toHaveBeenCalled();
  });

  it("slaagt ook als het id nog niet op te vragen is", async () => {
    const uit = await maakProjectmap(
      { naam: "Kikvorsweide 2, Nieuwegein" },
      deps({ idVan: async () => Promise.reject(new Error("409")) })
    );
    expect(uit).toMatchObject({ ok: true, folder_id: null, bestond: false });
  });

  it("zegt het als Dropbox niet gekoppeld is", async () => {
    const uit = await maakProjectmap({ naam: "Kikvorsweide 2, Nieuwegein" }, deps({ maakMap: async () => null }));
    expect(uit).toMatchObject({ ok: false, reden: "Dropbox is niet gekoppeld" });
  });
});
