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

  it("let niet op de schrijfwijze, net als Dropbox", () => {
    /*
      De mappen heten sinds kort OUT in plaats van out, en de twee kanten — het
      control center en deze route — rollen niet op hetzelfde moment uit. Op de
      letter vergelijken zou betekenen dat er tussen die twee uitrollen in
      bestanden geweigerd worden die gewoon naar de goede map hadden gemoeten.
    */
    expect(isMediaSubmap("out/360")).toBe(true);
    expect(isMediaSubmap("OUT/360")).toBe(true);
    expect(isMediaSubmap("Out/360/Review")).toBe(true);
    // Maar een map die er niet op staat blijft geweigerd, in welke schrijfwijze ook.
    expect(isMediaSubmap("IN/360")).toBe(false);
    expect(isMediaSubmap("out/geheim")).toBe(false);
  });

  it("laat de fotografie-uitvoermap toe, met de apostrof erin", () => {
    /*
      Hier liep de Foto Edit Agent op vast: negen bewerkte foto's stonden klaar
      bij Imagen en mochten de map niet in, met "submap moet een van OUT/360,
      OUT/360/review, out/Omgevingsfoto's zijn — kreeg submap OUT/Photo's".

      De schrijfwijze doet er niet toe (Dropbox kijkt er ook niet naar), maar de
      apostrof wél: de map heet Photo's, niet Photos.
    */
    expect(isMediaSubmap("OUT/Photo's")).toBe(true);
    expect(isMediaSubmap("out/photo's")).toBe(true);
    expect(isMediaSubmap("OUT/Photos")).toBe(false);
    expect(
      mediaDoelPad("/Automatie Media/Dam 5, Amsterdam", "OUT/Photo's", "DSC01199-HDR.jpg")
    ).toBe("/Automatie Media/Dam 5, Amsterdam/OUT/Photo's/DSC01199-HDR.jpg");
  });

  it("laat de invoermap van de fotografie niet toe", () => {
    // De originelen moeten overleven; een agent die daar mag schrijven kan een
    // RAW overschrijven met zijn eigen uitvoer.
    expect(isMediaSubmap("In/Raw/Photo's")).toBe(false);
    expect(isMediaSubmap("in/Photo's")).toBe(false);
  });

  it("laat omgevingsfoto's toe naast de oplevering", () => {
    expect(isMediaSubmap("out/Omgevingsfoto's")).toBe(true);
    expect(mediaDoelPad("/Automatie Media/Dam 5, Amsterdam", "out/Omgevingsfoto's", "Javastraat 02.jpg")).toBe(
      "/Automatie Media/Dam 5, Amsterdam/out/Omgevingsfoto's/Javastraat 02.jpg"
    );
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

describe("de aanlevermap", () => {
  /*
    Twee lijsten, en dat is het hele punt van deze reeks.

    De nadir-agent mag alleen naar de uitvoermappen schrijven: daar staat de
    bewerking, en de originelen in In/Raw moeten een tegenvallende patch
    overleven. Een mens die op het portaal een shoot aanlevert is een andere
    actor met de omgekeerde behoefte — die zet juist originelen neer.

    Zou "In/Raw/360" bij MEDIA_SUBMAPPEN komen, dan mag de agent er vanaf dat
    moment ook in en is die bescherming stilletjes weg. Vandaar de scheiding, en
    vandaar deze tests.
  */
  it("weigert de invoermap zolang er niet om aanlevering gevraagd wordt", () => {
    expect(mediaDoelPad("/Automatie Media/Dam 5", "In/Raw/360", "pano.jpg")).toBeNull();
  });

  it("laat de invoermap toe bij een aanlevering", () => {
    expect(mediaDoelPad("/Automatie Media/Dam 5", "In/Raw/360", "pano.jpg", "aanlevering")).toBe(
      "/Automatie Media/Dam 5/In/Raw/360/pano.jpg"
    );
  });

  it("laat een aanlevering niet in de uitvoermap schrijven", () => {
    // Andersom moet net zo dicht zitten: het aanleverscherm hoort niet in de
    // map te kunnen die naar de klant gaat.
    expect(mediaDoelPad("/Automatie Media/Dam 5", "OUT/360", "pano.jpg", "aanlevering")).toBeNull();
  });

  it("blijft hoofdletterongevoelig, want Dropbox is dat ook", () => {
    expect(mediaDoelPad("/Automatie Media/Dam 5", "in/raw/360", "pano.jpg", "aanlevering")).toBe(
      "/Automatie Media/Dam 5/in/raw/360/pano.jpg"
    );
  });

  it("houdt de projectmapgrens ook bij een aanlevering", () => {
    expect(mediaDoelPad("/Automatie Media", "In/Raw/360", "pano.jpg", "aanlevering")).toBeNull();
    expect(
      mediaDoelPad("/Automatie Energielabels/Dam 5", "In/Raw/360", "pano.jpg", "aanlevering")
    ).toBeNull();
  });
});

describe("OUT/Video — de montage van de Video Edit Agent", () => {
  const adres = "/Automatie Media/Dam 5, Amsterdam";

  it("laat een video toe in OUT/Video, in welke schrijfwijze ook", () => {
    expect(mediaDoelPad(adres, "OUT/Video", "Dam 5, Amsterdam.mp4")).toBe(
      `${adres}/OUT/Video/Dam 5, Amsterdam.mp4`
    );
    expect(mediaDoelPad(adres, "out/video", "montage.MOV")).toBe(`${adres}/out/video/montage.MOV`);
  });

  it("laat in OUT/Video geen foto of iets anders toe", () => {
    expect(mediaDoelPad(adres, "OUT/Video", "still.jpg")).toBeNull();
    expect(mediaDoelPad(adres, "OUT/Video", "rapport.pdf")).toBeNull();
  });

  it("laat een video nergens anders toe", () => {
    // Anders mag de nadir-agent ook video in OUT/360 zetten, en dat is nooit de bedoeling.
    expect(mediaDoelPad(adres, "OUT/360", "rondgang.mp4")).toBeNull();
    expect(mediaDoelPad(adres, "OUT/Photo's", "clip.mov")).toBeNull();
  });

  it("laat de invoermap van de video niet toe", () => {
    expect(isMediaSubmap("In/Raw/Video")).toBe(false);
    expect(isMediaSubmap("in/Video")).toBe(false);
  });
});
