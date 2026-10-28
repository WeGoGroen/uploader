import { describe, expect, it } from "vitest";
import { GestoptFout, magOpnieuw, staatErAl, zoekBestand } from "./upload-queue";
import { isMediaAanlevering, schrijfwijze } from "./media-folders";

/**
 * Na een mislukte upload kijken we of het bestand er tóch staat. Een ander
 * bestand met dezelfde naam mag dan niet als "geslaagd" tellen: dan werd de
 * eigen upload opgeruimd en was het beeld weg.
 */
describe("staatErAl", () => {
  it("finds the same file by name and size", () => {
    expect(staatErAl([{ name: "DSC00001.ARW", size: 100 }], "DSC00001.ARW", 100)).toBe(true);
  });

  it("does not count another file with the same name", () => {
    expect(staatErAl([{ name: "DSC00001.ARW", size: 999 }], "DSC00001.ARW", 100)).toBe(false);
  });

  it("finds the copy Dropbox renamed next to an existing file", () => {
    const lijst = [
      { name: "DSC00001.ARW", size: 999 },
      { name: "DSC00001 (1).ARW", size: 100 },
    ];
    expect(staatErAl(lijst, "DSC00001.ARW", 100)).toBe(true);
  });

  it("does not treat an unrelated name as a renamed copy", () => {
    expect(staatErAl([{ name: "DSC00001 (kopie).ARW", size: 100 }], "DSC00001.ARW", 100)).toBe(false);
  });
});

describe("schrijfwijze", () => {
  it("never overwrites in the media delivery folders", () => {
    const pad = "/Automatie Media/Damrak 1, Amsterdam/In/Raw/360/IMG_0001.insp";
    expect(isMediaAanlevering(pad)).toBe(true);
    expect(schrijfwijze(pad)).toEqual({ mode: "add", autorename: true });
  });

  it("keeps overwriting elsewhere", () => {
    expect(schrijfwijze("/Automatie NEN2580/Damrak 1, Amsterdam/Photo's/a.jpg")).toEqual({
      mode: "overwrite",
      autorename: false,
    });
  });
});

/**
 * Verwijderen moet het eigen bestand raken. Staat er een ander bestand met
 * dezelfde naam en heeft Dropbox het eigen bestand hernoemd, dan zou weghalen
 * op de oorspronkelijke naam juist het verkeerde beeld wissen.
 */
describe("zoekBestand", () => {
  it("picks the renamed copy when the plain name is a different file", () => {
    const lijst = [
      { name: "DSC00001.ARW", size: 999 },
      { name: "DSC00001 (1).ARW", size: 100 },
    ];
    expect(zoekBestand(lijst, "DSC00001.ARW", 100)).toBe("DSC00001 (1).ARW");
  });

  it("prefers the plain name when both match", () => {
    const lijst = [
      { name: "DSC00001 (1).ARW", size: 100 },
      { name: "DSC00001.ARW", size: 100 },
    ];
    expect(zoekBestand(lijst, "DSC00001.ARW", 100)).toBe("DSC00001.ARW");
  });

  it("returns null when nothing matches", () => {
    expect(zoekBestand([{ name: "DSC00001.ARW", size: 999 }], "DSC00001.ARW", 100)).toBeNull();
  });
});

describe("a stopped upload", () => {
  it("is never retried", () => {
    expect(magOpnieuw(new GestoptFout())).toBe(false);
  });
});
