import { describe, expect, it } from "vitest";
import { herken, herkenOpNaam, is360, isPanorama, leesKop } from "@/lib/media-herkennen";

/** Een minimale JPEG: SOI, optioneel een APP1 met XMP, een SOF0 met de maat. */
function jpeg(breedte: number, hoogte: number, xmp?: string, opvulling = 0): Uint8Array {
  const delen: number[] = [0xff, 0xd8];
  if (opvulling > 0) {
    // Een APP0 vol nullen, zoals een dikke EXIF-voorvertoning.
    const lengte = opvulling + 2;
    delen.push(0xff, 0xe0, lengte >> 8, lengte & 0xff, ...new Array(opvulling).fill(0));
  }
  if (xmp) {
    const kop = "http://ns.adobe.com/xap/1.0/\0";
    const inhoud = [...kop, ...xmp].map((c) => c.charCodeAt(0));
    const lengte = inhoud.length + 2;
    delen.push(0xff, 0xe1, lengte >> 8, lengte & 0xff, ...inhoud);
  }
  delen.push(0xff, 0xc0, 0x00, 0x11, 0x08, hoogte >> 8, hoogte & 0xff, breedte >> 8, breedte & 0xff, 0x03);
  delen.push(...new Array(9).fill(0));
  delen.push(0xff, 0xda, 0x00, 0x02);
  return new Uint8Array(delen);
}

describe("herkenOpNaam", () => {
  it("kent clips, RAW en Insta360 aan de naam", () => {
    expect(herkenOpNaam("C0001.MP4")).toMatchObject({ soort: "video" });
    expect(herkenOpNaam("IMG_1234.MOV")).toMatchObject({ soort: "video" });
    expect(herkenOpNaam("DSC01234.ARW")).toMatchObject({ soort: "foto" });
    expect(herkenOpNaam("IMG_0001.CR3")).toMatchObject({ soort: "foto" });
    expect(herkenOpNaam("IMG_20261011_101010_00_001.insp")).toMatchObject({ soort: "360" });
    expect(herkenOpNaam("VID_20261011_101010_00_001.insv")).toMatchObject({ soort: "360" });
  });

  it("laat een JPEG over aan de kop", () => {
    expect(herkenOpNaam("woonkamer.jpg")).toBe("kijken");
    expect(herkenOpNaam("pano.HEIC")).toBe("kijken");
  });

  it("houdt rommel, sidecars en proxy's tegen", () => {
    expect(herkenOpNaam(".DS_Store")).toMatchObject({ soort: null });
    expect(herkenOpNaam("._DSC01234.ARW")).toMatchObject({ soort: null });
    expect(herkenOpNaam("DSC01234.xmp")).toMatchObject({ soort: null });
    expect(herkenOpNaam("LRV_20261011.lrv")).toMatchObject({ soort: null });
    expect(herkenOpNaam("clip.avi")).toMatchObject({ soort: null });
    expect(herkenOpNaam("plattegrond.pdf")).toMatchObject({ soort: null });
  });
});

describe("leesKop", () => {
  it("leest de maat uit een JPEG, ook achter een dikke voorvertoning", () => {
    expect(leesKop(jpeg(6000, 4000))).toMatchObject({ breedte: 6000, hoogte: 4000, equirect: false });
    expect(leesKop(jpeg(5376, 2688, undefined, 60_000))).toMatchObject({ breedte: 5376, hoogte: 2688 });
  });

  it("ziet een equirectangulaire projectie in de XMP, als attribuut en als element", () => {
    expect(leesKop(jpeg(100, 50, '<rdf:Description GPano:ProjectionType="equirectangular"/>')).equirect).toBe(true);
    expect(leesKop(jpeg(100, 50, "<GPano:ProjectionType>equirectangular</GPano:ProjectionType>")).equirect).toBe(true);
    expect(leesKop(jpeg(100, 50, '<rdf:Description GPano:ProjectionType="cylindrical"/>')).equirect).toBe(false);
  });

  it("geeft geen maat als het frame buiten de gelezen bytes valt", () => {
    const heel = jpeg(8000, 4000, undefined, 60_000);
    expect(leesKop(heel.subarray(0, 30_000))).toMatchObject({ breedte: null, hoogte: null });
  });
});

describe("herken", () => {
  it("een 2:1-JPEG is een panorama, een 3:2-JPEG een foto", () => {
    expect(herken("R0010001.JPG", jpeg(5376, 2688))).toMatchObject({ soort: "360" });
    expect(herken("DSC01234.JPG", jpeg(6000, 4000))).toMatchObject({ soort: "foto" });
  });

  it("een smalle 2:1 (een uitsnede van een telefoon) is geen panorama", () => {
    expect(is360(1600, 800)).toBe(false);
    expect(herken("strook.jpg", jpeg(1600, 800))).toMatchObject({ soort: "foto" });
  });

  it("GPano telt alleen bij een verhouding die bij een rondgang past", () => {
    const xmp = '<rdf:Description GPano:ProjectionType="equirectangular"/>';
    expect(herken("pano.jpg", jpeg(1920, 960, xmp))).toMatchObject({ soort: "360" });
    expect(herken("uitsnede.jpg", jpeg(3000, 2000, xmp))).toMatchObject({ soort: "foto" });
  });

  it("een HEIC zonder panorama-XMP is een foto die Imagen niet neemt", () => {
    expect(herken("IMG_0001.HEIC", new Uint8Array(64))).toMatchObject({ soort: null });
  });

  it("zonder kop wordt een JPEG een foto, nooit een betaalde 360-bewerking", () => {
    expect(herken("woonkamer.jpg", null)).toMatchObject({ soort: "foto" });
  });
});

describe("isPanorama", () => {
  it("een .insv is 360 maar geen panorama voor de nadir-agent", () => {
    expect(herkenOpNaam("VID_1.insv")).toMatchObject({ soort: "360" });
    expect(isPanorama("VID_1.insv")).toBe(false);
    expect(isPanorama("IMG_1.insp")).toBe(true);
    expect(isPanorama("R0010001.JPG")).toBe(true);
  });
});
