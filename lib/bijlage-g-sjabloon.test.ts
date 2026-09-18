import { describe, expect, it } from "vitest";
import { BIJLAGE_G_BESTANDSNAAM, bijlageGInhoud } from "@/lib/bijlage-g-sjabloon";

describe("Bijlage G-sjabloon", () => {
  it("levert een echt xlsx-bestand op", () => {
    const buf = bijlageGInhoud();
    // Een xlsx is een zip; die begint altijd met "PK". Zonder deze controle
    // zou een half overgenomen base64-blok pas opvallen als iemand het bestand
    // in Dropbox probeert te openen.
    expect(buf.subarray(0, 2).toString("latin1")).toBe("PK");
    expect(buf.length).toBeGreaterThan(10_000);
  });

  it("heeft een naam waarin de herkenning 'bijlage g' zit", () => {
    // voegBijlageGToe slaat over als er al iets met "bijlage g" in de naam
    // staat; als de sjabloonnaam daar zelf niet aan voldoet, zou hij bij elke
    // ronde een tweede kopie neerzetten.
    expect(BIJLAGE_G_BESTANDSNAAM.toLowerCase()).toContain("bijlage g");
    expect(BIJLAGE_G_BESTANDSNAAM.endsWith(".xlsx")).toBe(true);
  });
});
