import { describe, expect, it } from "vitest";
import { doelVan, vrijeNaam } from "@/lib/clickup-bijlagen";

const b = (code: string, naam: string, mime = "") => ({ code, naam, mime });

describe("doelVan", () => {
  it("zet foto's uit elk veld in Foto's", () => {
    expect(doelVan(b("D2", "gevel-01.jpg", "image/jpeg"))).toBe("foto's");
    expect(doelVan(b("D5", "IMG_1825.HEIC"))).toBe("foto's");
    expect(doelVan(b("B3", "ketel.png", "image/png"))).toBe("foto's");
  });

  it("zet het LAZ-veld en elke .las/.laz in LAZ", () => {
    expect(doelVan(b("D4", "88.zip", "application/zip"))).toBe("laz");
    expect(doelVan(b("D5", "scan.LAS"))).toBe("laz");
  });

  it("laat de rest in ClickUp", () => {
    expect(doelVan(b("D3", "schets.pdf", "application/pdf"))).toBeNull();
    expect(doelVan(b("E1", "notitie.docx"))).toBeNull();
  });
});

describe("vrijeNaam", () => {
  it("houdt een vrije naam zoals hij is", () => {
    expect(vrijeNaam("gevel.jpg", new Set())).toBe("gevel.jpg");
  });

  it("nummert een naam die al bezet is, zonder te overschrijven", () => {
    const bezet = new Set(["image.jpg", "image (2).jpg"]);
    expect(vrijeNaam("image.jpg", bezet)).toBe("image (3).jpg");
    expect(vrijeNaam("IMAGE.JPG", new Set(["image.jpg"]))).toBe("IMAGE (2).JPG");
  });

  it("haalt tekens weg die Dropbox niet in een naam toelaat", () => {
    expect(vrijeNaam("a/b:c.jpg", new Set())).toBe("a_b_c.jpg");
  });
});
