import { describe, expect, it } from "vitest";
import { bouwOrderOpmerking, verdiepingLabel } from "@/lib/mediatask-opmerking";

describe("verdiepingLabel", () => {
  it("noemt de bouwlagen zoals een verwerker ze leest", () => {
    expect(verdiepingLabel(0)).toBe("ground floor");
    expect(verdiepingLabel(1)).toBe("1st floor");
    expect(verdiepingLabel(2)).toBe("2nd floor");
    expect(verdiepingLabel(3)).toBe("3rd floor");
    expect(verdiepingLabel(4)).toBe("4th floor");
    expect(verdiepingLabel(-1)).toBe("basement level 1");
    expect(verdiepingLabel(-2)).toBe("basement level 2");
  });

  it("houdt de uitzonderingen op 11, 12 en 13 aan", () => {
    expect(verdiepingLabel(11)).toBe("11th floor");
    expect(verdiepingLabel(12)).toBe("12th floor");
    expect(verdiepingLabel(13)).toBe("13th floor");
    expect(verdiepingLabel(21)).toBe("21st floor");
    expect(verdiepingLabel(22)).toBe("22nd floor");
  });
});

describe("bouwOrderOpmerking", () => {
  const optimized = {
    kop: "Point clouds",
    aantal: 1,
    url: "https://www.dropbox.com/scl/fo/opt",
    toelichting: "These are also uploaded directly to this order; this link is a fallback.",
  };

  it("zet per map één maplink, kaal op een eigen regel", () => {
    const tekst = bouwOrderOpmerking({
      verdiepingenPerBestand: {},
      mappen: [
        { kop: "Photos", aantal: 4, url: "https://www.dropbox.com/scl/fo/foto" },
        { kop: "Video", aantal: 6, url: "https://www.dropbox.com/scl/fo/video" },
      ],
    });

    expect(tekst).toContain("Photos (4 files)\nhttps://www.dropbox.com/scl/fo/foto");
    expect(tekst).toContain("Video (6 files)\nhttps://www.dropbox.com/scl/fo/video");
    // Mediatask maakt van een kale URL zelf een link; tekst of leestekens
    // eromheen kunnen die herkenning breken.
    for (const regel of tekst.split("\n").filter((r) => r.includes("https://"))) {
      expect(regel).toMatch(/^https:\/\/\S+$/);
    }
  });

  it("schrijft één bestand enkelvoud", () => {
    const tekst = bouwOrderOpmerking({
      verdiepingenPerBestand: {},
      mappen: [{ kop: "RAW scans", aantal: 1, url: "https://www.dropbox.com/scl/fo/raw" }],
    });
    expect(tekst).toContain("RAW scans (1 file)");
    expect(tekst).not.toContain("1 files");
  });

  it("laat lege mappen helemaal weg", () => {
    const tekst = bouwOrderOpmerking({
      verdiepingenPerBestand: {},
      mappen: [
        { kop: "Photos", aantal: 2, url: "https://www.dropbox.com/scl/fo/foto" },
        { kop: "360 captures", aantal: 0, url: "https://www.dropbox.com/scl/fo/leeg" },
      ],
    });
    expect(tekst).toContain("Photos");
    expect(tekst).not.toContain("360 captures");
    expect(tekst).not.toContain("/leeg");
  });

  it("zet de toelichting tussen de kop en de link", () => {
    const tekst = bouwOrderOpmerking({ verdiepingenPerBestand: {}, mappen: [optimized] });
    expect(tekst).toContain(
      "Point clouds (1 file)\nThese are also uploaded directly to this order; this link is a fallback.\nhttps://www.dropbox.com/scl/fo/opt"
    );
  });

  it("noemt de bouwlagen per scanbestand, op volgorde", () => {
    const tekst = bouwOrderOpmerking({
      verdiepingenPerBestand: { "74.dp": [1, -1, 0] },
      mappen: [],
    });
    expect(tekst).toContain("Scanned floors per file:\n• 74.dp — basement level 1, ground floor, 1st floor");
  });

  it("slaat scanbestanden zonder bouwlagen over", () => {
    const tekst = bouwOrderOpmerking({
      verdiepingenPerBestand: { "74.dp": [0], "74_raw.dp": [] },
      mappen: [],
    });
    expect(tekst).toContain("74.dp");
    expect(tekst).not.toContain("74_raw.dp");
  });

  it("geeft lege tekst als er niets te melden valt", () => {
    // De route plaatst dan geen opmerking; een lege opmerking bij een order is
    // erger dan geen.
    expect(bouwOrderOpmerking({ verdiepingenPerBestand: {}, mappen: [] })).toBe("");
  });

  it("legt de mappen uit zodra er een link bij staat, en anders niet", () => {
    const metLink = bouwOrderOpmerking({
      verdiepingenPerBestand: { "74.dp": [0] },
      mappen: [optimized],
    });
    expect(metLink).toContain("Each link below opens a folder");

    const zonderLink = bouwOrderOpmerking({
      verdiepingenPerBestand: { "74.dp": [0] },
      mappen: [],
    });
    expect(zonderLink).not.toContain("Each link below opens a folder");
  });
});
