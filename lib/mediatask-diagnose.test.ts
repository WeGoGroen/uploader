import { describe, expect, it } from "vitest";
import { herstelOpmerking, leesOpmerking, opmerkingenVanMediatask, stelDiagnose } from "@/lib/mediatask-diagnose";

const basis = {
  orderId: 381180,
  state: "action required",
  pad: "/Automatie NEN2580/Teststraat 1, Amsterdam",
  puntenwolken: 2,
  afgekeurd: [] as string[],
  aanwezig: new Set(["a.dp", "b.dp"]),
  inDropbox: ["a.dp", "b.dp"] as string[] | null,
  opmerkingen: [],
};

describe("stelDiagnose", () => {
  it("een afgekeurde scan die nog in Dropbox staat is herstelbaar", () => {
    const d = stelDiagnose({ ...basis, afgekeurd: ["a.dp"] });
    expect(d.herstelbaar).toBe(true);
    expect(d.samenvatting).toContain("keurde de scan af (a.dp)");
  });

  it("een scan die wel in Dropbox staat maar niet bij Mediatask is herstelbaar", () => {
    const d = stelDiagnose({ ...basis, aanwezig: new Set(["a.dp"]) });
    expect(d.ontbreekt).toEqual(["b.dp"]);
    expect(d.herstelbaar).toBe(true);
  });

  it("zonder bekende Dropbox-map is niets automatisch te herstellen", () => {
    const d = stelDiagnose({ ...basis, pad: null, inDropbox: null, afgekeurd: ["a.dp"] });
    expect(d.herstelbaar).toBe(false);
    expect(d.samenvatting).toContain("alleen met de hand");
  });

  it("niets mis aan de scans: eerlijk zeggen dat de reden in Mediatask staat", () => {
    const d = stelDiagnose(basis);
    expect(d.herstelbaar).toBe(false);
    expect(d.samenvatting).toBe("Aan de scans is niets te zien; de reden staat alleen in Mediatask zelf.");
  });

  it("neemt de laatste opmerking van Mediatask mee", () => {
    const d = stelDiagnose({ ...basis, opmerkingen: [{ tekst: "Kitchen photos missing", door: "Anna", op: null }] });
    expect(d.samenvatting).toContain('Mediatask schreef: "Kitchen photos missing"');
  });
});

describe("opmerkingen", () => {
  it("leest de gangbare vormen en slaat die van ons over", () => {
    const lijst = opmerkingenVanMediatask([
      { comment: "Scan of 1st floor is broken", user: { full_name: "Piotr" }, created_at: "2026-10-07T10:00:00Z" },
      { body: "We have re-uploaded the point cloud: a.dp.\n\n— Floris (WeGoGroen)", created_at: "2026-10-08T10:00:00Z" },
      { text: "" },
      42,
    ]);
    expect(lijst).toEqual([{ tekst: "Scan of 1st floor is broken", door: "Piotr", op: "2026-10-07T10:00:00Z" }]);
    expect(leesOpmerking("los")).toEqual({ tekst: "los", door: null, op: null });
  });

  it("de herstelopmerking is Engels en draagt de naam", () => {
    expect(herstelOpmerking(["a.dp"], "Floris")).toBe(
      "We have (re-)uploaded the point cloud: a.dp. Please continue processing the order.\n\n— Floris (WeGoGroen)"
    );
  });
});
