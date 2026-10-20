import { describe, expect, it } from "vitest";
import {
  MEDIA_SUBMAPPEN,
  isMediaProjectmap,
  isMediaSubmap,
  mediaBestandsnaam,
  mediaDoelPad,
  isLeegmaakUitvoer,
  mediaHernoemPaden,
  mediaVrijgeefPaden,
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
    // De bewaarplek van Imagens versie als iemand een foto bijwerkt.
    expect(isMediaSubmap("OUT/_controle/Photo's")).toBe(true);
    expect(
      mediaDoelPad("/Automatie Media/Dam 5, Amsterdam", "OUT/_controle/Photo's", "DSC01199-HDR.jpg")
    ).toBe("/Automatie Media/Dam 5, Amsterdam/OUT/_controle/Photo's/DSC01199-HDR.jpg");
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

describe("In/Raw/Video — clips aangeleverd via het Business Control Center", () => {
  const adres = "/Automatie Media/Dam 5, Amsterdam";

  it("laat een clip toe bij een aanlevering", () => {
    expect(mediaDoelPad(adres, "In/Raw/Video", "C3680.MP4", "aanlevering")).toBe(`${adres}/In/Raw/Video/C3680.MP4`);
  });

  it("weigert er een beeld, en weigert de map voor de agent zelf", () => {
    expect(mediaDoelPad(adres, "In/Raw/Video", "foto.jpg", "aanlevering")).toBeNull();
    expect(mediaDoelPad(adres, "In/Raw/Video", "C3680.MP4")).toBeNull();
  });

  it("laat geen video in de 360-invoermap", () => {
    expect(mediaDoelPad(adres, "In/Raw/360", "C3680.MP4", "aanlevering")).toBeNull();
  });
});

describe("In/Raw/Photo's — een shoot aangeleverd via het Business Control Center", () => {
  const adres = "/Automatie Media/Dam 5, Amsterdam";

  it("laat RAW en JPEG toe bij een aanlevering", () => {
    /*
      Hier liep de fotografie-uploadpagina van het control center op vast: elke
      foto kreeg "submap moet een van OUT/360, … zijn — kreeg submap In/Raw/Photo's",
      er kwam geen shoot in de administratie en er ging niets naar Imagen.
    */
    expect(mediaDoelPad(adres, "In/Raw/Photo's", "DSC01199.ARW", "aanlevering")).toBe(
      `${adres}/In/Raw/Photo's/DSC01199.ARW`
    );
    expect(mediaDoelPad(adres, "in/raw/photo's", "IMG_1.CR3", "aanlevering")).not.toBeNull();
    expect(mediaDoelPad(adres, "In/Raw/Photo's", "voor.jpg", "aanlevering")).not.toBeNull();
  });

  it("blijft dicht voor de agent zelf, en voor video", () => {
    expect(mediaDoelPad(adres, "In/Raw/Photo's", "DSC01199.ARW")).toBeNull();
    expect(mediaDoelPad(adres, "In/Raw/Photo's", "C3680.MP4", "aanlevering")).toBeNull();
  });

  it("laat RAW nergens anders toe", () => {
    expect(mediaDoelPad(adres, "OUT/Photo's", "DSC01199.ARW")).toBeNull();
    expect(mediaDoelPad(adres, "In/Raw/360", "DSC01199.ARW", "aanlevering")).toBeNull();
  });
});

describe("OUT/Video — de montage van de Video Edit Agent", () => {
  const adres = "/Automatie Media/Dam 5, Amsterdam";

  it("laat een video toe in OUT/Video, in welke schrijfwijze ook", () => {
    expect(mediaDoelPad(adres, "OUT/Video", "Dam 5, Amsterdam.mp4")).toBe(
      `${adres}/OUT/Video/Dam 5, Amsterdam.mp4`
    );
    expect(mediaDoelPad(adres, "out/video", "montage.MOV")).toBe(`${adres}/out/video/montage.MOV`);
    expect(mediaDoelPad(adres, "OUT/_controle/Video", "montage.mp4")).toBe(`${adres}/OUT/_controle/Video/montage.mp4`);
    expect(mediaDoelPad(adres, "OUT/_controle/Video", "foto.jpg")).toBeNull();
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

describe("mediaVrijgeefPaden", () => {
  it("schuift een gekeurd bestand van de wachtmap naar OUT/360, onder dezelfde naam", () => {
    expect(mediaVrijgeefPaden("/Automatie Media/Dam 5, Amsterdam", "Woestduin 360-3.jpg")).toEqual({
      van: "/Automatie Media/Dam 5, Amsterdam/OUT/_controle/360/Woestduin 360-3.jpg",
      naar: "/Automatie Media/Dam 5, Amsterdam/OUT/360/Woestduin 360-3.jpg",
    });
  });

  it("weigert een projectmap buiten Automatie Media", () => {
    // Anders is dit een verplaats-en-wisrecht op elke map in de Dropbox.
    expect(mediaVrijgeefPaden("/Automatie Energielabels/Dam 5, Amsterdam", "a.jpg")).toBeNull();
    expect(mediaVrijgeefPaden("/Automatie Media/../Automatie Energielabels", "a.jpg")).toBeNull();
  });

  it("weigert alles wat geen beeld is, en namen die de map uit willen", () => {
    expect(mediaVrijgeefPaden("/Automatie Media/Dam 5, Amsterdam", "rapport.pdf")).toBeNull();
    expect(mediaVrijgeefPaden("/Automatie Media/Dam 5, Amsterdam", "a.jpg/../b.pdf")).toBeNull();
  });

  it("de wachtmap ligt buiten OUT/360, zodat een deellink van OUT/360 hem niet meeneemt", () => {
    const paden = mediaVrijgeefPaden("/Automatie Media/Dam 5, Amsterdam", "a.jpg");
    expect(paden?.van.startsWith("/Automatie Media/Dam 5, Amsterdam/OUT/360/")).toBe(false);
  });
});

describe("In/Raw/Photo's — foto's aangeleverd via Media → Uploaden in het control center", () => {
  const adres = "/Automatie Media/Dam 5, Amsterdam";

  it("laat een RAW en een JPEG toe bij een aanlevering", () => {
    expect(mediaDoelPad(adres, "In/Raw/Photo's", "DSC01234.ARW", "aanlevering")).toBe(
      `${adres}/In/Raw/Photo's/DSC01234.ARW`
    );
    expect(mediaDoelPad(adres, "In/Raw/Photo's", "IMG_0001.CR3", "aanlevering")).not.toBeNull();
    expect(mediaDoelPad(adres, "In/Raw/Photo's", "voorgevel.jpg", "aanlevering")).not.toBeNull();
  });

  it("weigert de fotomap zonder aanlevering, en een clip of RAW op de verkeerde plek", () => {
    expect(mediaDoelPad(adres, "In/Raw/Photo's", "DSC01234.ARW")).toBeNull();
    expect(mediaDoelPad(adres, "In/Raw/Photo's", "C0001.MP4", "aanlevering")).toBeNull();
    expect(mediaDoelPad(adres, "In/Raw/360", "DSC01234.ARW", "aanlevering")).toBeNull();
    expect(mediaDoelPad(adres, "OUT/Photo's", "DSC01234.ARW")).toBeNull();
  });

  it("laat een 360-video van een Insta360 alleen in In/Raw/360 toe", () => {
    expect(mediaDoelPad(adres, "In/Raw/360", "VID_20261011_1.insv", "aanlevering")).not.toBeNull();
    expect(mediaDoelPad(adres, "In/Raw/Video", "VID_20261011_1.insv", "aanlevering")).toBeNull();
    expect(mediaDoelPad(adres, "OUT/360", "VID_20261011_1.insv")).toBeNull();
  });

  it("laat een DNG-panorama alleen als aanlevering in In/Raw/360 toe", () => {
    expect(mediaDoelPad(adres, "In/Raw/360", "AEB_20261012_150737_000001_360.dng", "aanlevering")).toBe(
      `${adres}/In/Raw/360/AEB_20261012_150737_000001_360.dng`
    );
    expect(mediaDoelPad(adres, "In/Raw/360", "PANO.DNG", "aanlevering")).not.toBeNull();
    // Nooit als uitvoer: de agent levert JPEG op.
    expect(mediaDoelPad(adres, "OUT/360", "PANO.dng")).toBeNull();
    expect(mediaDoelPad(adres, "OUT/_controle/360", "PANO.dng")).toBeNull();
    // Andere RAW blijft geweigerd in 360.
    expect(mediaDoelPad(adres, "In/Raw/360", "DSC01234.ARW", "aanlevering")).toBeNull();
  });
});

describe("mediaHernoemPaden", () => {
  const adres = "/Automatie Media/Dam 5, Amsterdam";

  it("hernoemt binnen OUT/Photo's naar adres, ruimte en nummer", () => {
    expect(mediaHernoemPaden(adres, "OUT/Photo's", "DSC02537-HDR.jpg", "Dam 5, Amsterdam - Keuken 2.jpg")).toEqual({
      van: `${adres}/OUT/Photo's/DSC02537-HDR.jpg`,
      naar: `${adres}/OUT/Photo's/Dam 5, Amsterdam - Keuken 2.jpg`,
    });
  });

  it("hernoemt binnen OUT/360 naar een tekst met nummer", () => {
    expect(mediaHernoemPaden(adres, "OUT/360", "AEB_20261012_150737_000001_Output.jpg", "Dam 5 1.jpg")).toEqual({
      van: `${adres}/OUT/360/AEB_20261012_150737_000001_Output.jpg`,
      naar: `${adres}/OUT/360/Dam 5 1.jpg`,
    });
  });

  it("hernoemt de controleversies mee: Imagens origineel en de Broersma-kolommen", () => {
    expect(mediaHernoemPaden(adres, "OUT/_controle/Photo's", "DSC02537-HDR - Broersma Klassiek.jpg", "Dam 5, Amsterdam - Keuken 2 - Broersma Klassiek.jpg")).toEqual({
      van: `${adres}/OUT/_controle/Photo's/DSC02537-HDR - Broersma Klassiek.jpg`,
      naar: `${adres}/OUT/_controle/Photo's/Dam 5, Amsterdam - Keuken 2 - Broersma Klassiek.jpg`,
    });
    for (const sub of ["OUT/_controle/Broersma Klassiek", "OUT/_controle/Broersma Generatief", "OUT/_controle/Broersma Zonlicht (AI)"]) {
      expect(mediaHernoemPaden(adres, sub, "DSC02537-HDR.jpg", "Dam 5, Amsterdam - Keuken 2.jpg")).toEqual({
        van: `${adres}/${sub}/DSC02537-HDR.jpg`,
        naar: `${adres}/${sub}/Dam 5, Amsterdam - Keuken 2.jpg`,
      });
    }
  });

  it("weigert elke andere map — ook de andere uitvoermappen en de invoer", () => {
    for (const sub of ["OUT/_controle/360", "OUT/360/review", "OUT/Video", "OUT/_controle/Video", "In/Raw/360", "In/Raw/Photo's"]) {
      expect(mediaHernoemPaden(adres, sub, "a.jpg", "b.jpg")).toBeNull();
    }
  });

  it("weigert een naam die na het opschonen iets anders zou worden, of geen beeld is", () => {
    expect(mediaHernoemPaden(adres, "OUT/Photo's", "a.jpg", "../b.jpg")).toBeNull();
    expect(mediaHernoemPaden(adres, "OUT/Photo's", "a.jpg", "b/c.jpg")).toBeNull();
    expect(mediaHernoemPaden(adres, "OUT/Photo's", "a.jpg", "keuken.pdf")).toBeNull();
    expect(mediaHernoemPaden("/Automatie Energielabels/Dam 5", "OUT/Photo's", "a.jpg", "b.jpg")).toBeNull();
  });
});

describe("isLeegmaakUitvoer", () => {
  it("laat alleen de uitvoer van de fotografie toe", () => {
    expect(isLeegmaakUitvoer("OUT/Photo's")).toBe(true);
    expect(isLeegmaakUitvoer("out/_controle/photo's")).toBe(true);
    for (const sub of ["OUT/360", "OUT/Video", "In/Raw/Photo's", "OUT", ""]) expect(isLeegmaakUitvoer(sub)).toBe(false);
  });
});
