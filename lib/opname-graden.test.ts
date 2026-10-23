import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/pdok", () => ({ voorgevelVoorAdres: vi.fn() }));
const { voegGradenToe, gemetenGraden } = await import("@/lib/opname-dossier");
import type { DossierGroep } from "@/lib/opname-velden";

/**
 * A8 kent in ClickUp alleen acht windrichtingen. Het formulier zet de graden
 * ernaast, en zegt het als de kaart het oneens is met de opnemer.
 */
function groepen(a8: string | null): DossierGroep[] {
  return [{ letter: "A", titel: "Algemeen", velden: [{ code: "A8", label: "Orientatie voorgevel", waarde: a8 }] }];
}
const a8 = (g: DossierGroep[]) => g[0].velden[0];

describe("voegGradenToe", () => {
  const kaart = (kompas: string, graden: number) => async () => ({ kompas, graden });

  it("zet de kompasmeting van de opnemer erbij, en vraagt de kaart dan niet eens", async () => {
    const g = groepen("O");
    const zoek = vi.fn(kaart("Z", 202));
    await voegGradenToe(g, "x", 94, zoek);
    expect(a8(g).waarde).toBe("O — 94° (kompas)");
    expect(zoek).not.toHaveBeenCalled();
  });

  it("gebruikt zonder meting de kaart, met de bron erbij", async () => {
    const g = groepen("O");
    await voegGradenToe(g, "x", null, kaart("O", 92), true);
    expect(a8(g).waarde).toBe("O — 92° (kaart)");
    expect(a8(g).reden ?? null).toBeNull();
  });

  it("houdt de keuze van de opnemer als de kaart het oneens is, en meldt het verschil", async () => {
    // Mandenmakerssteeg 2C, 23-10: opnemer "O", kaart "Z, 202°".
    const g = groepen("O");
    await voegGradenToe(g, "x", null, kaart("Z", 202), true);
    expect(a8(g).waarde).toBe("O");
    expect(a8(g).reden).toContain("Z, 202°");
  });

  it("laat A8 staan zoals het was als de kaart niets zekers oplevert", async () => {
    const g = groepen("NW");
    await voegGradenToe(g, "x", null, async () => null, true);
    expect(a8(g).waarde).toBe("NW");
    await voegGradenToe(g, "x", null, async () => {
      throw new Error("PDOK eruit");
    }, true);
    expect(a8(g).waarde).toBe("NW");
  });
});

describe("zonder meting, standaard", () => {
  it("vraagt de kaart niet en tekent geen kompas — alleen uit de uploader", async () => {
    const g = groepen("O");
    const zoek = vi.fn(async () => ({ kompas: "Z", graden: 202 }));
    const v = await voegGradenToe(g, "x", null, zoek);
    expect(zoek).not.toHaveBeenCalled();
    expect(v).toBeNull();
    expect(a8(g).waarde).toBe("O");
  });
});

describe("gemetenGraden", () => {
  it("leest de regel die de uploader in de beschrijving zet", () => {
    expect(gemetenGraden("Bouwjaar: 1764 (BAG)\nVoorgevel: 94° (gemeten met kompas)\nDropbox-map: x")).toBe(94);
  });
  it("geeft null zonder meting of bij onzin", () => {
    expect(gemetenGraden("Bouwjaar: 1764 (BAG)")).toBeNull();
    expect(gemetenGraden("Voorgevel: 400°")).toBeNull();
  });
});
