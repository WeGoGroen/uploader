import { describe, expect, it } from "vitest";
import { calendarLocationToBagQuery, relaxedBagQueries, sameAddress, splitAddress } from "./address-format";

describe("relaxedBagQueries", () => {
  it("drops the house-letter suffix first, then the number", () => {
    expect(relaxedBagQueries("Kalverstraat 220 DP, 1012 XJ Amsterdam")).toEqual([
      "Kalverstraat 220, Amsterdam",
      "Kalverstraat, Amsterdam",
    ]);
  });

  it("falls back to the street when only the number is wrong", () => {
    expect(relaxedBagQueries("Damrak 9999, 1012LG Amsterdam")).toEqual([
      "Damrak 9999, Amsterdam",
      "Damrak, Amsterdam",
    ]);
  });

  it("does not mistake a digit inside the street name for the house number", () => {
    expect(relaxedBagQueries("1e Jan Steenstraat 5A, 1072 NA Amsterdam")).toEqual([
      "1e Jan Steenstraat 5, Amsterdam",
      "1e Jan Steenstraat, Amsterdam",
    ]);
  });

  it("never returns the original query", () => {
    expect(relaxedBagQueries("Damrak, Amsterdam")).not.toContain("Damrak, Amsterdam");
  });

  it("keeps the search local when the city sits in the street line", () => {
    // Zonder plaats zou "Kerkstraat 12" landelijk zoeken en adressen uit een
    // andere gemeente voorstellen.
    expect(relaxedBagQueries("Kerkstraat 12 Utrecht")).toEqual(["Kerkstraat 12, Utrecht", "Kerkstraat, Utrecht"]);
    expect(relaxedBagQueries("Laan van Meerdervoort 100-A Den Haag")).toEqual([
      "Laan van Meerdervoort 100, Den Haag",
      "Laan van Meerdervoort, Den Haag",
    ]);
  });

  it("falls back to the postcode when there is no city name", () => {
    expect(relaxedBagQueries("Kalverstraat 220 DP, 1012 XJ")).toEqual([
      "Kalverstraat 220, 1012 XJ",
      "Kalverstraat, 1012 XJ",
    ]);
  });

  it("suggests nothing when neither a city nor a postcode is known", () => {
    // Landelijk zoeken zou adressen uit willekeurige gemeenten opleveren.
    expect(relaxedBagQueries("Kalverstraat 220 DP")).toEqual([]);
    expect(relaxedBagQueries("Damrak 1")).toEqual([]);
  });
});

describe("calendarLocationToBagQuery", () => {
  it("strips the trailing country that Google Maps appends", () => {
    expect(calendarLocationToBagQuery("Dam 1, 1012 JS Amsterdam, Nederland")).toBe("Dam 1, 1012 JS Amsterdam");
    expect(calendarLocationToBagQuery("Dam 1, 1012 JS Amsterdam, The Netherlands")).toBe("Dam 1, 1012 JS Amsterdam");
  });

  it("drops a venue-name prefix without digits", () => {
    expect(calendarLocationToBagQuery("Café De Zwart, Kalverstraat 1, 1012NX Amsterdam, Nederland")).toBe(
      "Kalverstraat 1, 1012NX Amsterdam"
    );
  });

  it("leaves a plain address untouched", () => {
    expect(calendarLocationToBagQuery("Huidekoperstraat 25 B, 1017ZL Amsterdam")).toBe(
      "Huidekoperstraat 25 B, 1017ZL Amsterdam"
    );
    expect(calendarLocationToBagQuery("Damrak 1 Amsterdam")).toBe("Damrak 1 Amsterdam");
  });

  it("never drops the last remaining part, even without digits", () => {
    expect(calendarLocationToBagQuery("Hoofdkantoor WeGoGroen")).toBe("Hoofdkantoor WeGoGroen");
  });
});

describe("splitAddress", () => {
  it("splits on the postcode when a comma separates street and postcode/city", () => {
    expect(splitAddress("Damrak 1, 1012LG Amsterdam")).toEqual({
      street: "Damrak 1",
      cityLine: "1012LG Amsterdam",
    });
  });

  it("splits on the postcode without a comma", () => {
    expect(splitAddress("Kalverstraat 10 3512PA Utrecht")).toEqual({
      street: "Kalverstraat 10",
      cityLine: "3512PA Utrecht",
    });
  });

  it("falls back to the last comma when there is no postcode", () => {
    expect(splitAddress("Hoofdstraat 5, Rotterdam")).toEqual({
      street: "Hoofdstraat 5",
      cityLine: "Rotterdam",
    });
  });

  it("keeps everything on one line when there is neither a postcode nor a comma", () => {
    expect(splitAddress("Damrak 1 Amsterdam")).toEqual({
      street: "Damrak 1 Amsterdam",
      cityLine: null,
    });
  });

  it("handles a postcode without a space", () => {
    expect(splitAddress("Damrak 1, 1012LG Amsterdam")).toEqual({
      street: "Damrak 1",
      cityLine: "1012LG Amsterdam",
    });
  });
});

describe("sameAddress", () => {
  it("matches the same address written with a different postcode notation", () => {
    expect(sameAddress("Dam 1, 1012JS Amsterdam", "Dam 1, 1012 JS Amsterdam")).toBe(true);
  });

  it("matches an agenda street line against a full ClickUp task name", () => {
    expect(sameAddress("Dam 1, 1012JS Amsterdam", "Dam 1")).toBe(true);
  });

  it("matches house-letter notations that differ only in punctuation", () => {
    expect(sameAddress("Cruquiusweg 79C-4, Amsterdam", "Cruquiusweg 79 C4")).toBe(true);
  });

  // Dit is de regressie waar het om begon: met prefix-matching gold "Dam 1"
  // als hetzelfde adres als "Dam 10", waardoor het dashboard een vals
  // "geüpload" liet zien en de startknop verborg.
  it("does not treat a longer house number as the same address", () => {
    expect(sameAddress("Dam 1", "Dam 10, 1012NP Amsterdam")).toBe(false);
    expect(sameAddress("Dam 1", "Dam 11, 1012JS Amsterdam")).toBe(false);
  });

  it("does not treat a house letter as the same address", () => {
    expect(sameAddress("Dam 1", "Dam 1A, 1012JS Amsterdam")).toBe(false);
  });

  it("does not match different streets that share a prefix", () => {
    expect(sameAddress("Damstraat 1", "Damstraatje 1")).toBe(false);
  });

  it("never matches on an empty address", () => {
    expect(sameAddress("", "Dam 1")).toBe(false);
    expect(sameAddress("   ", "")).toBe(false);
  });
});
