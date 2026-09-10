import { describe, expect, it } from "vitest";
import {
  matchesAddress,
  parseAddressLine,
  parseSharePointUrl,
  taskNameToAddress,
  taskToAddress,
  matchesPostcodeFolder,
  postcodeSleutel,
} from "@/lib/sharepoint-match";

function parse(line: string) {
  const parsed = parseAddressLine(line);
  if (!parsed) throw new Error(`kon "${line}" niet lezen`);
  return parsed;
}

describe("parseAddressLine", () => {
  it("leest straat en huisnummer", () => {
    expect(parse("Kerkstraat 12")).toEqual({ street: "kerkstraat", number: "12", suffix: "" });
  });

  it("houdt een cijfer in de straatnaam bij de straat", () => {
    expect(parse("1e Jan Steenstraat 5")).toEqual({
      street: "1e jan steenstraat",
      number: "5",
      suffix: "",
    });
  });

  it("leest de toevoeging apart", () => {
    expect(parse("Cruquiusweg 79C-4")).toEqual({
      street: "cruquiusweg",
      number: "79",
      suffix: "c4",
    });
  });

  it("geeft null bij een regel zonder huisnummer", () => {
    expect(parseAddressLine("Kerkstraat")).toBeNull();
  });
});

describe("matchesAddress", () => {
  const kerkstraat12 = parse("Kerkstraat 12");

  it("matcht een exacte mapnaam", () => {
    expect(matchesAddress("Kerkstraat 12", kerkstraat12)).toBe(true);
  });

  it("matcht met extra woorden eromheen", () => {
    expect(matchesAddress("Kerkstraat 12 Utrecht - definitief", kerkstraat12)).toBe(true);
    expect(matchesAddress("kerkstraat_12_energielabel.pdf", kerkstraat12)).toBe(true);
  });

  it("matcht niet op het adres van de buren", () => {
    // De kern: "Kerkstraat 1" zit als tekst in "Kerkstraat 12".
    expect(matchesAddress("Kerkstraat 12", parse("Kerkstraat 1"))).toBe(false);
    expect(matchesAddress("Kerkstraat 120", kerkstraat12)).toBe(false);
  });

  it("matcht niet op een andere straat", () => {
    expect(matchesAddress("Kerkweg 12", kerkstraat12)).toBe(false);
  });

  it("eist de toevoeging als het adres er een heeft", () => {
    const met = parse("Cruquiusweg 79C-4");
    expect(matchesAddress("Cruquiusweg 79C4 label", met)).toBe(true);
    expect(matchesAddress("Cruquiusweg 79 C 4", met)).toBe(true);
    expect(matchesAddress("Cruquiusweg 79", met)).toBe(false);
  });

  it("negeert hoofdletters en diakrieten", () => {
    expect(matchesAddress("SÚDERGOWEG 3", parse("Sudergoweg 3"))).toBe(true);
  });
});

describe("taskNameToAddress", () => {
  it("splitst een taaknaam in straatregel en woonplaats", () => {
    expect(taskNameToAddress("Kerkstraat 12, 1234 AB Utrecht")).toEqual({
      addressLine: "Kerkstraat 12",
      woonplaats: "Utrecht",
    });
  });

  it("werkt met een postcode zonder spatie en een plaats van twee woorden", () => {
    expect(taskNameToAddress("Hoofdstraat 5B, 2511AB Den Haag")).toEqual({
      addressLine: "Hoofdstraat 5B",
      woonplaats: "Den Haag",
    });
  });

  it("geeft null voor een taak die geen adres is", () => {
    expect(taskNameToAddress("Bellen met makelaar")).toBeNull();
    expect(taskNameToAddress("Facturatie januari")).toBeNull();
  });
});

describe("parseSharePointUrl", () => {
  it("haalt site en map uit een geplakte adresbalk-URL", () => {
    expect(
      parseSharePointUrl(
        "https://moconsultancyltd168.sharepoint.com/sites/WeGoGroen/Shared%20Documents/Forms/AllItems.aspx?id=%2Fsites%2FWeGoGroen%2FShared%20Documents%2FGereed&viewid=d4abe468"
      )
    ).toEqual({
      siteUrl: "https://moconsultancyltd168.sharepoint.com/sites/WeGoGroen",
      rootPath: "Gereed",
    });
  });

  it("houdt geneste mappen heel", () => {
    expect(
      parseSharePointUrl(
        "https://x.sharepoint.com/sites/WeGoGroen/Shared%20Documents/Forms/AllItems.aspx?id=%2Fsites%2FWeGoGroen%2FShared%20Documents%2FGereed%2F2026"
      )?.rootPath
    ).toBe("Gereed/2026");
  });

  it("accepteert een kale site-URL", () => {
    expect(parseSharePointUrl("https://x.sharepoint.com/sites/WeGoGroen")).toEqual({
      siteUrl: "https://x.sharepoint.com/sites/WeGoGroen",
      rootPath: "",
    });
  });

  it("geeft null bij iets dat geen URL is", () => {
    expect(parseSharePointUrl("Gereed")).toBeNull();
  });
});

describe("taskToAddress", () => {
  // Zoals de opnames er in ClickUp echt in staan: de naam is géén adres, het
  // adres zit in het custom field.
  const echteTaak = {
    name: "58-3 1055 BW WG",
    customFields: [
      { name: "A1 Adres:", value: "Sanderijnstraat 58-3\n1055 BW  AMSTERDAM\n" },
      { name: "A3 Bouwjaar", value: 95 },
    ],
  };

  it("leest het adres uit A1 Adres, niet uit de taaknaam", () => {
    expect(taskToAddress(echteTaak)).toEqual({
      addressLine: "Sanderijnstraat 58-3",
      woonplaats: "Amsterdam",
      postcodeRegel: "1055 BW  AMSTERDAM",
    });
  });

  it("leest ook het adres dat op één regel met een komma staat", () => {
    /*
      Een deel van de taken heeft A1 zo ingevuld, en de taaknaam is daar geen
      betrouwbare terugval: bij Balboastraat 12-3, 12-4 en Marco Polostraat
      188-1 staat er "Amsterdam1" in de naam. Dan zoekt de overdracht een
      projectmap die niet bestaat terwijl de map er gewoon staat.
    */
    expect(
      taskToAddress({
        name: "Balboastraat 12-3 1057VV Amsterdam1",
        customFields: [{ name: "A1 Adres:", value: "Balboastraat 12-3, 1057VV Amsterdam" }],
      })
    ).toEqual({
      addressLine: "Balboastraat 12-3",
      woonplaats: "Amsterdam",
      postcodeRegel: "1057VV Amsterdam",
    });
  });

  it("valt terug op de taaknaam als het veld ontbreekt", () => {
    expect(taskToAddress({ name: "Kerkstraat 12, 1234 AB Utrecht", customFields: [] })).toEqual({
      addressLine: "Kerkstraat 12",
      woonplaats: "Utrecht",
      postcodeRegel: null,
    });
  });

  it("geeft null voor een taak zonder adres", () => {
    expect(taskToAddress({ name: "Bellen met makelaar", customFields: [] })).toBeNull();
    expect(
      taskToAddress({ name: "Factuur 1050", customFields: [{ name: "A1 Adres:", value: "" }] })
    ).toBeNull();
  });

  it("maakt van een plaats in kapitalen weer normale schrijfwijze", () => {
    expect(
      taskToAddress({
        name: "x",
        customFields: [{ name: "A1 Adres:", value: "Hoofdstraat 5\n2511 AB  DEN HAAG" }],
      })
    ).toEqual({
      addressLine: "Hoofdstraat 5",
      woonplaats: "Den Haag",
      postcodeRegel: "2511 AB  DEN HAAG",
    });
  });
});

describe("matchesPostcodeFolder", () => {
  // Echte mapnamen uit de SharePoint-map "Gereed".
  const sanderijnstraat = postcodeSleutel("Sanderijnstraat 58-3", "1055 BW  AMSTERDAM");

  it("matcht de map van hetzelfde adres", () => {
    expect(sanderijnstraat).toEqual({ postcode: "1055BW", huisnummer: "583" });
    expect(matchesPostcodeFolder("58-3 1055 BW WG", sanderijnstraat!)).toBe(true);
  });

  it("matcht ongeacht extra spaties of initialen", () => {
    expect(matchesPostcodeFolder("58-3 1055BW  WGG1", sanderijnstraat!)).toBe(true);
  });

  it("matcht niet op een ander huisnummer met dezelfde postcode", () => {
    expect(matchesPostcodeFolder("58-2 1055 BW WG", sanderijnstraat!)).toBe(false);
    expect(matchesPostcodeFolder("1 1055 BW WG", sanderijnstraat!)).toBe(false);
  });

  it("matcht niet op dezelfde nummers in een andere postcode", () => {
    expect(matchesPostcodeFolder("58-3 1055 BX WG", sanderijnstraat!)).toBe(false);
  });

  it("werkt met een losse huisletter", () => {
    const sleutel = postcodeSleutel("Warmoesstraat 1 H", "1012 AL AMSTERDAM");
    expect(matchesPostcodeFolder("1 H 1012 AL WGG1", sleutel!)).toBe(true);
    expect(matchesPostcodeFolder("1 F 1012 AL WGG1", sleutel!)).toBe(false);
  });

  it("geeft null als postcode of huisnummer ontbreekt", () => {
    expect(postcodeSleutel("Sanderijnstraat", "1055 BW AMSTERDAM")).toBeNull();
    expect(postcodeSleutel("Sanderijnstraat 58-3", "AMSTERDAM")).toBeNull();
  });
});

describe("matchesPostcodeFolder — vormen uit het archief", () => {
  // Echte mapnamen uit Gereed die eerder allemaal afvielen.
  const sleutel = (adres: string, pc: string) => postcodeSleutel(adres, pc)!;

  it("herkent de postcode vóór het huisnummer", () => {
    expect(matchesPostcodeFolder("1053 BT 1-3 WGG", sleutel("Kerkstraat 1-3", "1053 BT AMSTERDAM"))).toBe(true);
    expect(matchesPostcodeFolder("1077 AW 191-2 WGG", sleutel("Straat 191-2", "1077 AW AMSTERDAM"))).toBe(true);
  });

  it("herkent een mapnaam met de straatnaam erin", () => {
    expect(
      matchesPostcodeFolder(
        "Anna van den Vondelstraat 5-1 1054GX Amsterdam",
        sleutel("Anna van den Vondelstraat 5-1", "1054 GX AMSTERDAM")
      )
    ).toBe(true);
    expect(
      matchesPostcodeFolder(
        "Ceintuurbaan 206-3 1072GC Amsterdam",
        sleutel("Ceintuurbaan 206-3", "1072 GC AMSTERDAM")
      )
    ).toBe(true);
  });

  it("herkent een huisletter aan weerskanten", () => {
    expect(matchesPostcodeFolder("27H 1055PB Amsterdam", sleutel("Straat 27 H", "1055 PB AMSTERDAM"))).toBe(true);
    expect(matchesPostcodeFolder("18 F 3532 GG  UTRECHT", sleutel("Straat 18 F", "3532 GG UTRECHT"))).toBe(true);
  });

  it("houdt buren nog steeds uit elkaar", () => {
    const s = sleutel("Ceintuurbaan 206-3", "1072 GC AMSTERDAM");
    expect(matchesPostcodeFolder("Ceintuurbaan 206-2 1072GC Amsterdam", s)).toBe(false);
    expect(matchesPostcodeFolder("Ceintuurbaan 206 1072GC Amsterdam", s)).toBe(false);
    // Zelfde nummers, andere postcode.
    expect(matchesPostcodeFolder("Ceintuurbaan 206-3 1072GD Amsterdam", s)).toBe(false);
  });

  it("matcht niet als de straat wel klopt maar het nummer niet meekomt", () => {
    expect(
      matchesPostcodeFolder("Anna van den Vondelstraat 1054GX Amsterdam", sleutel("Anna van den Vondelstraat 5-1", "1054 GX AMSTERDAM"))
    ).toBe(false);
  });
});
