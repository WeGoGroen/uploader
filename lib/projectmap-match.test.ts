import { describe, expect, it } from "vitest";
import {
  isZelfdeAdres,
  mapnaamPastBijAdres,
  parseProjectFolderName,
} from "@/lib/projectmap-match";

function parse(naam: string) {
  const a = parseProjectFolderName(naam);
  if (!a) throw new Error(`kon "${naam}" niet lezen`);
  return a;
}

describe("parseProjectFolderName", () => {
  it("splitst straat, huisnummer en woonplaats", () => {
    expect(parse("Sanderijnstraat 58-3, Amsterdam")).toEqual({
      straat: "sanderijnstraat",
      huisnummer: "583",
      woonplaats: "amsterdam",
    });
  });

  it("houdt een cijfer in de straatnaam bij de straat", () => {
    expect(parse("1e Jan Steenstraat 5B, Amsterdam").straat).toBe("1e jan steenstraat");
  });

  it("geeft null zonder komma of huisnummer", () => {
    expect(parseProjectFolderName("Sanderijnstraat 58-3")).toBeNull();
    expect(parseProjectFolderName("Sanderijnstraat, Amsterdam")).toBeNull();
  });
});

describe("isZelfdeAdres", () => {
  const basis = parse("Sanderijnstraat 58-3, Amsterdam");

  it("herkent verschillen in leestekens en hoofdletters", () => {
    expect(mapnaamPastBijAdres("SANDERIJNSTRAAT 58 3, AMSTERDAM", basis)).toBe(true);
    expect(mapnaamPastBijAdres("Sanderijnstraat  58--3 ,  Amsterdam", basis)).toBe(true);
  });

  it("herkent een afgekorte straatnaam", () => {
    expect(mapnaamPastBijAdres("Sanderijnstr. 58-3, Amsterdam", basis)).toBe(true);
  });

  it("laat buren met rust", () => {
    expect(mapnaamPastBijAdres("Sanderijnstraat 58-2, Amsterdam", basis)).toBe(false);
    expect(mapnaamPastBijAdres("Sanderijnstraat 58, Amsterdam", basis)).toBe(false);
  });

  it("laat een andere plaats met rust", () => {
    expect(mapnaamPastBijAdres("Sanderijnstraat 58-3, Utrecht", basis)).toBe(false);
  });

  it("gokt niet bij een te korte overeenkomst", () => {
    // "kerk" is te weinig om "Kerkstraat" mee te durven matchen.
    expect(mapnaamPastBijAdres("Kerk 1, Utrecht", parse("Kerkstraat 1, Utrecht"))).toBe(false);
  });

  it("negeert diakrieten", () => {
    expect(mapnaamPastBijAdres("Sudergoweg 3, Sneek", parse("Súdergoweg 3, Sneek"))).toBe(true);
  });
});
