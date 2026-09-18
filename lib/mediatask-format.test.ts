import { describe, expect, it } from "vitest";
import { bundelFoutmeldingen, matchGrossFloorAreaBracket } from "./mediatask-format";

const VALUES = ["≤110m2", "111-230m2", "231-390m2", "391-600m2", ">600m2"];

describe("matchGrossFloorAreaBracket", () => {
  it("matches the lower bound bracket", () => {
    expect(matchGrossFloorAreaBracket(90, VALUES)).toBe("≤110m2");
    expect(matchGrossFloorAreaBracket(110, VALUES)).toBe("≤110m2");
  });

  it("matches a middle range bracket", () => {
    expect(matchGrossFloorAreaBracket(150, VALUES)).toBe("111-230m2");
    expect(matchGrossFloorAreaBracket(390, VALUES)).toBe("231-390m2");
  });

  it("matches the open-ended upper bracket", () => {
    expect(matchGrossFloorAreaBracket(700, VALUES)).toBe(">600m2");
  });

  it("returns null when nothing matches or values are missing", () => {
    expect(matchGrossFloorAreaBracket(90, undefined)).toBeNull();
    expect(matchGrossFloorAreaBracket(90, [])).toBeNull();
  });
});

describe("bundelFoutmeldingen", () => {
  it("laat één mislukt bestand ongewijzigd", () => {
    expect(bundelFoutmeldingen([{ naam: "12 3.dp", fout: "order is al ingediend" }])).toBe(
      "12 3.dp: order is al ingediend"
    );
  });

  it("vat dezelfde oorzaak samen in plaats van hem per bestand te herhalen", () => {
    const fouten = Array.from({ length: 30 }, (_, i) => ({
      naam: `IMG_${i}.jpg`,
      fout: "Mediatask neemt niets meer aan bij deze order (403)",
    }));
    expect(bundelFoutmeldingen(fouten)).toBe(
      "30 bestanden (IMG_0.jpg, IMG_1.jpg, IMG_2.jpg, IMG_3.jpg en nog 26): " +
        "Mediatask neemt niets meer aan bij deze order (403)"
    );
  });

  it("houdt verschillende oorzaken uit elkaar", () => {
    const regel = bundelFoutmeldingen([
      { naam: "a.dp", fout: "order is al ingediend" },
      { naam: "b.jpg", fout: "het bestand staat niet meer in Dropbox" },
      { naam: "c.jpg", fout: "het bestand staat niet meer in Dropbox" },
    ]);
    expect(regel).toBe(
      "a.dp: order is al ingediend · 2 bestanden (b.jpg, c.jpg): het bestand staat niet meer in Dropbox"
    );
  });

  it("valt terug op een algemene tekst als er geen reden meekwam", () => {
    expect(bundelFoutmeldingen([{ naam: "a.dp" }])).toBe("a.dp: versturen mislukt");
  });
});
