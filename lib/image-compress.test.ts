import { describe, expect, it } from "vitest";
import { mayCompressFolder } from "./image-compress";
import { MEDIA_STAPPEN } from "./media-folders";

describe("mayCompressFolder", () => {
  it("laat de media-aanlevering met rust, hoe de In-map ook geschreven is", () => {
    // Elke uploadstap van de media-flow, uit dezelfde bron als de flow zelf:
    // verandert daar een mapnaam, dan valt hier om wat er misgaat.
    for (const stap of MEDIA_STAPPEN) {
      expect(mayCompressFolder(stap.map)).toBe(false);
    }
    // Dropbox kijkt niet naar de schrijfwijze, dus deze functie ook niet: de
    // map heette eerder "in" en de bestanden eronder zijn dezelfde levering.
    expect(mayCompressFolder("in/Photo's")).toBe(false);
    expect(mayCompressFolder("IN/RAW/360")).toBe(false);
  });

  it("laat scan- en meetdata ongemoeid", () => {
    expect(mayCompressFolder("Optimized")).toBe(false);
    expect(mayCompressFolder("RAW")).toBe(false);
    expect(mayCompressFolder("LAZ")).toBe(false);
  });

  it("verkleint wel de dossierfoto's", () => {
    expect(mayCompressFolder("Foto's")).toBe(true);
    expect(mayCompressFolder("Photo's")).toBe(true);
    expect(mayCompressFolder("Plattegronden")).toBe(true);
  });
});
