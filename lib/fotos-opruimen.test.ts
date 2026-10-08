import { describe, expect, it } from "vitest";
import { isProjectmap, kiesLosseFotos } from "@/lib/fotos-opruimen";

/**
 * /api/intern/fotos-opruimen is de enige route in deze app die een bestand van
 * iemand anders verplaatst; dit is de zeef die hij gebruikt. De tests hieronder
 * bewaken daarom niet of hij werkt, maar of hij zich inhoudt: wat hij níét mag
 * aanraken is het hele punt.
 */

const b = (pad: string) => ({ pad, naam: pad.split("/").pop() ?? pad });

describe("kiesLosseFotos", () => {
  it("pakt de foto's die los in de projectmap liggen", () => {
    const uit = kiesLosseFotos([b("IMG_1825.jpeg"), b("IMG_1826.HEIC"), b("gevel.png")]);
    expect(uit.map((x) => x.naam)).toEqual(["IMG_1825.jpeg", "IMG_1826.HEIC", "gevel.png"]);
  });

  it("laat alles in een submap staan, ook als het een foto is", () => {
    // De oplevermap van MO en "onderbouwing" zijn andermans werk. Daar foto's
    // weghalen maakt een oplevering stuk, en dat valt pas veel later op.
    const uit = kiesLosseFotos([
      b("foto's/IMG_1.jpeg"),
      b("Van Eeghenstraat 12-1/aanzicht.jpg"),
      b("onderbouwing/detail.png"),
    ]);
    expect(uit).toEqual([]);
  });

  it("raakt geen enkel bestand aan dat geen afbeelding is", () => {
    const uit = kiesLosseFotos([
      b("Energielabel afschrift.pdf"),
      b("Bijlage G.pdf"),
      b("scan.laz"),
      b("meetstaat.xlsx"),
      b("notities.txt"),
      b("project.indd"),
    ]);
    expect(uit).toEqual([]);
  });

  it("laat een video liggen, al staat die wel in de checklist", () => {
    /*
      De checklist in het control center telt .mov en .mp4 mee als opnamefoto's,
      maar verplaatsen is iets anders dan tellen: een video los in de map kan
      net zo goed een oplevering van MO zijn. Liever laten liggen en melden.
    */
    expect(kiesLosseFotos([b("rondgang.mov"), b("clip.mp4")])).toEqual([]);
  });

  it("trapt niet in een naam die alleen op een foto lijkt", () => {
    expect(kiesLosseFotos([b("jpeg"), b("foto.jpeg.pdf"), b("png.docx")])).toEqual([]);
  });
});

describe("isProjectmap", () => {
  it("laat een projectmap door, direct en in het archief", () => {
    expect(isProjectmap("/Automatie Energielabels/Balboastraat 12-3")).toBe(true);
    expect(isProjectmap("/Automatie Energielabels/Afgerond/Balboastraat 12-3")).toBe(true);
  });

  it("weigert de hoofdmap zelf en het archief zelf", () => {
    // Zou dit doorgaan, dan gold elke submap van 450 projecten als losse foto.
    expect(isProjectmap("/Automatie Energielabels")).toBe(false);
    expect(isProjectmap("/Automatie Energielabels/Afgerond")).toBe(false);
  });

  it("weigert een andere dienst, een submap en een uitstapje omhoog", () => {
    expect(isProjectmap("/Automatie NEN2580/Balboastraat 12-3")).toBe(false);
    expect(isProjectmap("/Automatie Energielabels/Balboastraat 12-3/foto's")).toBe(false);
    expect(isProjectmap("/Automatie Energielabels/../Privé")).toBe(false);
  });
});
