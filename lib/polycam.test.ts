import { describe, expect, it } from "vitest";
import { leesStatus, normaliseerArtefacten, normaliseerScans, vindPuntenwolk } from "@/lib/polycam";
import { lasBestandsnaam, verdiepingUitVeldnaam } from "@/lib/polycam-velden";

describe("normaliseerScans", () => {
  it("leest een lijst onder 'captures' en zet de nieuwste bovenaan", () => {
    const scans = normaliseerScans({
      captures: [
        { id: "a", name: "Oud", createdAt: "2026-11-10T08:14:00Z", status: "completed", visibility: "public" },
        { id: "b", name: "Nieuw", createdAt: "2026-11-10T09:52:00Z", status: "processing", visibility: "private" },
      ],
    });
    expect(scans.map((s) => s.id)).toEqual(["b", "a"]);
    expect(scans[0]).toMatchObject({ status: "bezig", openbaar: false });
    expect(scans[1]).toMatchObject({ status: "klaar", openbaar: true, naam: "Oud" });
  });

  it("verdraagt andere veldnamen en een kale lijst", () => {
    const [s] = normaliseerScans([{ captureId: 42, title: "BG", created_at: { _seconds: 1_800_000_000 } }]);
    expect(s).toMatchObject({ id: "42", naam: "BG", openbaar: null, status: "bezig" });
    expect(s.gemaaktOp).toBe(new Date(1_800_000_000_000).toISOString());
  });

  it("slaat items zonder id over", () => {
    expect(normaliseerScans({ data: [{ name: "x" }] })).toEqual([]);
  });
});

describe("leesStatus", () => {
  it("herkent klaar, mislukt en bezig", () => {
    expect(leesStatus("READY")).toBe("klaar");
    expect(leesStatus("failed")).toBe("mislukt");
    expect(leesStatus("uploading")).toBe("bezig");
    expect(leesStatus(null)).toBe("bezig");
  });
});

describe("artefacten", () => {
  it("vindt de puntenwolk in een lijst", () => {
    const a = normaliseerArtefacten({
      artifacts: [
        { format: "glb", url: "https://x/model.glb" },
        { type: "LAS", downloadUrl: "https://x/points.las?sig=1" },
      ],
    });
    expect(vindPuntenwolk(a)).toEqual({ formaat: "las", url: "https://x/points.las?sig=1" });
  });

  it("leest een object per formaat en geeft LAZ voorrang", () => {
    const a = normaliseerArtefacten({ artifacts: { las: "https://x/a.las", laz: "https://x/a.laz" } });
    expect(vindPuntenwolk(a)?.formaat).toBe("laz");
  });

  it("herkent het formaat aan de URL als het veld ontbreekt", () => {
    const a = normaliseerArtefacten([{ url: "https://x/dl/scan.LAS?x=1" }]);
    expect(vindPuntenwolk(a)?.formaat).toBe("las");
  });

  it("geeft null zonder puntenwolk", () => {
    expect(vindPuntenwolk(normaliseerArtefacten({ artifacts: [{ format: "glb", url: "https://x/a.glb" }] }))).toBeNull();
  });
});

describe("verdiepingUitVeldnaam", () => {
  it("haalt code en 'Polycam link' weg", () => {
    expect(verdiepingUitVeldnaam("D8.1 Polycam link - Begane grond")).toBe("Begane grond");
    expect(verdiepingUitVeldnaam("D8.2 Polycam link - 1e verdieping (indien aanwezig)")).toBe("1e verdieping");
    expect(verdiepingUitVeldnaam("D8.3 - Polycam link - 2e verdieping (indien aanwezig)")).toBe("2e verdieping");
    expect(verdiepingUitVeldnaam("D8.6Polycam link - Extra 2")).toBe("Extra 2");
  });
});

describe("lasBestandsnaam", () => {
  it("maakt een veilige naam", () => {
    expect(lasBestandsnaam("Begane grond", "Scan 10/11 10:38", "las")).toBe("Begane grond - Scan 10-11 10-38.las");
  });
});
