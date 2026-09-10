import { describe, expect, it } from "vitest";
import { bouwOpnameDossier, veilig } from "@/lib/opname-pdf";

describe("veilig", () => {
  it("houdt Nederlandse tekst heel", () => {
    expect(veilig("Oriëntatie voorgevel, 78 m²")).toBe("Oriëntatie voorgevel, 78 m²");
  });

  it("plakt de twee regels van het adresveld niet aan elkaar", () => {
    // Zonder deze regel werd "Nieuwendijk 104 E\n1012 MR" tot "104 E1012 MR".
    expect(veilig("Nieuwendijk 104 E\n1012 MR  AMSTERDAM")).toBe("Nieuwendijk 104 E 1012 MR AMSTERDAM");
  });

  it("gooit tekens weg die het lettertype niet kent", () => {
    // Een mapnaam met een statusbolletje erin liet het genereren anders midden
    // in de rit omvallen — en dan is er géén dossier.
    expect(veilig("🟢 Damrak 1 — ‘klaar’")).toBe("Damrak 1 - 'klaar'");
  });
});

describe("bouwOpnameDossier", () => {
  it("maakt een PDF van een formulier zonder foto's", async () => {
    const pdf = await bouwOpnameDossier({
      adres: "Damrak 1",
      postcodePlaats: "1012 LG Amsterdam",
      taakId: "86abc",
      taakNaam: "1 1012 LG WG",
      status: "complete",
      adviseur: "F. de Laat",
      gebouwtype: "Appartement",
      bouwjaar: "1931",
      aangemaaktMs: Date.UTC(2026, 3, 13, 9, 15),
      streefdatumMs: Date.UTC(2026, 3, 14),
      groepen: [
        {
          letter: "A",
          titel: "Algemeen",
          velden: [
            { code: "A1", label: "Adres", waarde: "Damrak 1" },
            { code: "A3", label: "Bouwjaar", waarde: "1931" },
            { code: "A7", label: "Type dak", waarde: null },
          ],
        },
        {
          letter: "C",
          titel: "Aanbouw",
          velden: [
            { code: "C1", label: "Aanbouw bouwjaar", waarde: null },
            { code: "C2", label: "Aanbouw vloer grenst aan", waarde: null },
          ],
        },
      ],
      fotos: [],
      andereBijlagen: [{ code: "D4", naam: "scan.laz" }],
      opgehaaldOp: new Date(Date.UTC(2026, 3, 13, 12, 0)),
    });

    expect(Buffer.from(pdf.slice(0, 5)).toString()).toBe("%PDF-");
    expect(pdf.byteLength).toBeGreaterThan(1000);
  });
});
