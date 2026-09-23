import { describe, expect, it } from "vitest";
import { dropboxWebUrl, leesbareOmvang, oudeMap, telPerStap } from "./media-inhoud";

const MB = 1024 * 1024;

/**
 * Wat de uploader per stap laat zien, uit Dropbox zelf. Deze telling is de
 * enige die klopt als er via de Dropbox-app is aangeleverd; een fout hier zegt
 * de opnemer dat zijn map leeg is terwijl hij vol staat — of andersom.
 */
describe("telPerStap", () => {
  it("counts each step's own files and nothing else", () => {
    const telling = telPerStap([
      { pad: "In/Raw/Photo's/DSC01.ARW", grootte: 34 * MB },
      { pad: "In/Raw/Photo's/DSC02.ARW", grootte: 36 * MB },
      { pad: "In/Raw/Video/rondgang.mp4", grootte: 800 * MB },
      { pad: "OUT/Photo's/bewerkt.jpg", grootte: 5 * MB },
    ]);
    expect(telling.photos).toMatchObject({ aantal: 2, bytes: 70 * MB });
    expect(telling.video).toMatchObject({ aantal: 1, bytes: 800 * MB });
    expect(telling["360"]).toMatchObject({ aantal: 0, bytes: 0, laatste: null });
  });

  // Dropbox kijkt niet naar hoofdletters, dus deze telling ook niet.
  it("ignores the case of the folder names", () => {
    const telling = telPerStap([{ pad: "in/raw/PHOTO'S/a.jpg", grootte: 1 }]);
    expect(telling.photos.aantal).toBe(1);
  });

  // Opnames van vóór de wissel naar In/Raw hebben hun bestanden nog direct
  // onder "in/". Zonder deze regel zou Gillis van Ledenberchstraat 44-1 nul
  // foto's tonen terwijl er 136 staan.
  it("still counts files from the layout before In/Raw", () => {
    const telling = telPerStap([
      { pad: "in/Photo's/DSC00960.ARW", grootte: 35 * MB },
      { pad: "in/Video/drone.mp4", grootte: 400 * MB },
    ]);
    expect(telling.photos.aantal).toBe(1);
    expect(telling.video.aantal).toBe(1);
  });

  it("does not count a file twice when both layouts are present", () => {
    const telling = telPerStap([
      { pad: "in/Photo's/oud.ARW", grootte: 1 },
      { pad: "in/Raw/Photo's/nieuw.ARW", grootte: 1 },
    ]);
    expect(telling.photos.aantal).toBe(2);
  });

  it("counts files in a subfolder of a step", () => {
    const telling = telPerStap([{ pad: "In/Raw/Photo's/zolder/1.ARW", grootte: 1 }]);
    expect(telling.photos.aantal).toBe(1);
  });

  it("does not mistake a sibling folder with a longer name for the step", () => {
    const telling = telPerStap([{ pad: "In/Raw/Photo's extra/1.jpg", grootte: 1 }]);
    expect(telling.photos.aantal).toBe(0);
  });

  it("remembers when the latest file came in", () => {
    const telling = telPerStap([
      { pad: "In/Raw/Photo's/a", grootte: 1, gewijzigd: "2026-09-23T14:16:44Z" },
      { pad: "In/Raw/Photo's/b", grootte: 1, gewijzigd: "2026-09-23T15:26:11Z" },
      { pad: "In/Raw/Photo's/c", grootte: 1, gewijzigd: "2026-09-23T14:58:16Z" },
    ]);
    expect(telling.photos.laatste).toBe("2026-09-23T15:26:11Z");
  });
});

describe("oudeMap", () => {
  it("maps the In/Raw layout back to where it used to be", () => {
    expect(oudeMap("In/Raw/Photo's")).toBe("in/Photo's");
    expect(oudeMap("In/Raw/360")).toBe("in/360");
  });

  it("has nothing to map for a folder outside In/Raw", () => {
    expect(oudeMap("OUT/Photo's")).toBeNull();
  });
});

/**
 * De link die de Dropbox-app opent. Klopt het voorvoegsel of de codering niet,
 * dan landt de opnemer op "niet gevonden" in plaats van in zijn map.
 */
describe("dropboxWebUrl", () => {
  it("puts the account's own folder in front for a team account", () => {
    expect(
      dropboxWebUrl(
        "/Info GoGroen",
        "/Automatie Media/Gillis van Ledenberchstraat 44-1, Amsterdam/In/Raw/Photo's"
      )
    ).toBe(
      "https://www.dropbox.com/home/Info%20GoGroen/Automatie%20Media/Gillis%20van%20Ledenberchstraat%2044-1%2C%20Amsterdam/In/Raw/Photo's"
    );
  });

  it("uses the path as-is without a team folder", () => {
    expect(dropboxWebUrl("", "/Automatie Media/Damrak 1, Amsterdam")).toBe(
      "https://www.dropbox.com/home/Automatie%20Media/Damrak%201%2C%20Amsterdam"
    );
  });

  it("keeps the slashes but encodes what is inside a segment", () => {
    expect(dropboxWebUrl("", "/a/b#c/d?e")).toBe("https://www.dropbox.com/home/a/b%23c/d%3Fe");
  });
});

describe("leesbareOmvang", () => {
  it("writes sizes the Dutch way", () => {
    expect(leesbareOmvang(4.55 * 1024 * MB)).toBe("4,55 GB");
    expect(leesbareOmvang(34.3 * MB)).toBe("34,3 MB");
    expect(leesbareOmvang(812 * MB)).toBe("812 MB");
    expect(leesbareOmvang(500)).toBe("500 B");
  });
});
