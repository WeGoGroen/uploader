import { describe, expect, it } from "vitest";
import {
  MEDIA_SUBMAPPEN,
  isMediaProjectmap,
  isMediaSubmap,
  mediaBestandsnaam,
  mediaDoelPad,
} from "@/lib/media-pad";

/**
 * De grenzen van /api/intern/media-plaatsen.
 *
 * Deze route deelt een uploadlink uit, en een uploadlink is een schrijfrecht op
 * precies dat ene pad. Daarom staat hier wat er níét mag naast wat er wel mag:
 * een grens die alleen in de route staat en niet in een test, verschuift bij de
 * eerste de beste uitbreiding zonder dat iemand het merkt.
 */

describe("isMediaProjectmap", () => {
  it("laat een adresmap onder de mediahoofdmap toe", () => {
    expect(isMediaProjectmap("/Automatie Media/Stadionkade 18-H, Amsterdam")).toBe(true);
  });

  it("laat een gearchiveerde adresmap toe", () => {
    expect(isMediaProjectmap("/Automatie Media/Afgerond/Stadionkade 18-H, Amsterdam")).toBe(true);
  });

  it("weigert de hoofdmap zelf", () => {
    expect(isMediaProjectmap("/Automatie Media")).toBe(false);
    expect(isMediaProjectmap("/Automatie Media/")).toBe(false);
  });

  it("weigert het archief zelf, want dat is geen adres", () => {
    expect(isMediaProjectmap("/Automatie Media/Afgerond")).toBe(false);
  });

  it("kijkt naar de map en niet naar de schrijfwijze — Dropbox doet dat ook niet", () => {
    // Dit stond omgekeerd: het archief in kleine letters gold als adresmap, en
    // een écht gearchiveerd adres in kleine letters werd geweigerd.
    expect(isMediaProjectmap("/Automatie Media/afgerond")).toBe(false);
    expect(isMediaProjectmap("/Automatie Media/AFGEROND")).toBe(false);
    expect(isMediaProjectmap("/Automatie Media/afgerond/Dam 5, Amsterdam")).toBe(true);
    expect(isMediaProjectmap("/Automatie Media/AfGeRoNd/Dam 5, Amsterdam")).toBe(true);
  });

  it("weigert een niveau dieper — daar beslist de submap over", () => {
    expect(isMediaProjectmap("/Automatie Media/Stadionkade 18-H, Amsterdam/in")).toBe(false);
  });

  it("weigert een andere hoofdmap", () => {
    expect(isMediaProjectmap("/Automatie Energielabels/Dam 5, Amsterdam")).toBe(false);
    expect(isMediaProjectmap("/Automatie NEN2580/Dam 5, Amsterdam")).toBe(false);
  });

  it("weigert een pad dat omhoog probeert te lopen", () => {
    expect(isMediaProjectmap("/Automatie Media/../Automatie Energielabels")).toBe(false);
  });
});

describe("isMediaSubmap", () => {
  it("laat alleen de vaste lijst toe", () => {
    for (const s of MEDIA_SUBMAPPEN) expect(isMediaSubmap(s)).toBe(true);
  });

  it("weigert de invoermap — daar staan de originelen", () => {
    expect(isMediaSubmap("in/360")).toBe(false);
    expect(isMediaSubmap("in")).toBe(false);
  });

  it("weigert een vrij pad", () => {
    expect(isMediaSubmap("out/360/../../..")).toBe(false);
    expect(isMediaSubmap("")).toBe(false);
    expect(isMediaSubmap("out")).toBe(false);
  });
});

describe("mediaBestandsnaam", () => {
  it("laat de beeldformaten toe die de module oplevert", () => {
    for (const naam of ["vloer.jpg", "vloer.jpeg", "vloer.png", "vloer.webp", "rondgang.insp"]) {
      expect(mediaBestandsnaam(naam)).toBe(naam);
    }
  });

  it("weigert alles wat geen beeld is", () => {
    expect(mediaBestandsnaam("rapport.pdf")).toBeNull();
    expect(mediaBestandsnaam("rondgang.mov")).toBeNull();
    expect(mediaBestandsnaam("script.sh")).toBeNull();
  });

  it("schoont padtekens weg vóór het de extensie beoordeelt", () => {
    // Anders glipt dit door op de ".pdf" die er na het opschonen niet meer staat.
    expect(mediaBestandsnaam("vloer.jpg/../geheim.pdf")).toBeNull();
  });

  it("houdt een naam met spaties heel", () => {
    expect(mediaBestandsnaam("360 - warmoes-2.jpeg")).toBe("360 - warmoes-2.jpeg");
  });
});

describe("mediaDoelPad", () => {
  it("plakt de drie delen aan elkaar", () => {
    expect(
      mediaDoelPad("/Automatie Media/Stadionkade 18-H, Amsterdam", "out/360", "360 - warmoes-2.jpeg")
    ).toBe("/Automatie Media/Stadionkade 18-H, Amsterdam/out/360/360 - warmoes-2.jpeg");
  });

  it("kent de reviewmap", () => {
    expect(mediaDoelPad("/Automatie Media/Dam 5, Amsterdam", "out/360/review", "a.jpg")).toBe(
      "/Automatie Media/Dam 5, Amsterdam/out/360/review/a.jpg"
    );
  });

  it("geeft null zodra één van de drie niet deugt", () => {
    expect(mediaDoelPad("/Automatie Energielabels/Dam 5", "out/360", "a.jpg")).toBeNull();
    expect(mediaDoelPad("/Automatie Media/Dam 5, Amsterdam", "in/360", "a.jpg")).toBeNull();
    expect(mediaDoelPad("/Automatie Media/Dam 5, Amsterdam", "out/360", "a.pdf")).toBeNull();
  });
});
