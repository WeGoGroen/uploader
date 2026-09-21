import { describe, expect, it } from "vitest";
import { rechtenNaWijziging, rechtenVan } from "@/lib/clickup";

describe("rechtenVan", () => {
  it("laat een account zonder rechten-sleutel alles doen", () => {
    expect(rechtenVan({})).toEqual({ energielabel: true, nen: true, media: true });
    expect(rechtenVan(null)).toEqual({ energielabel: true, nen: true, media: true });
  });

  it("neemt opgeslagen rechten letterlijk over", () => {
    expect(rechtenVan({ rechten: { energielabel: true, nen: false, media: false } })).toEqual({
      energielabel: true,
      nen: false,
      media: false,
    });
  });
});

describe("rechtenNaWijziging", () => {
  const metAlleDrie = { rechten: { energielabel: true, nen: true, media: true } };

  it("laat een recht staan dat niet in het verzoek zit", () => {
    // Dit is het geval waar de NEN-knop ongemerkt door verdween: het Business
    // Control Center stuurde alleen het vinkje dat het kende, en de rest werd
    // stilzwijgend op false gezet.
    expect(rechtenNaWijziging(metAlleDrie, { energielabel: true })).toEqual({
      energielabel: true,
      nen: true,
      media: true,
    });
  });

  it("neemt een recht wél af als het expliciet is uitgevinkt", () => {
    expect(rechtenNaWijziging(metAlleDrie, { nen: false })).toEqual({
      energielabel: true,
      nen: false,
      media: true,
    });
  });

  it("laat een leeg verzoek de bestaande rechten ongemoeid", () => {
    const bestaand = { rechten: { energielabel: false, nen: true, media: false } };
    expect(rechtenNaWijziging(bestaand, {})).toEqual({
      energielabel: false,
      nen: true,
      media: false,
    });
    expect(rechtenNaWijziging(bestaand, undefined)).toEqual({
      energielabel: false,
      nen: true,
      media: false,
    });
  });

  it("geeft een nieuw account alleen wat is aangevinkt", () => {
    // Niet terugvallen op rechtenVan(), want dat leest een onbekend account
    // als "mag alles" — dan zou één vinkje alle drie de rechten opleveren.
    expect(rechtenNaWijziging(null, { nen: true })).toEqual({
      energielabel: false,
      nen: true,
      media: false,
    });
  });

  it("vult bij een bestaand account zonder rechten-sleutel aan met alles", () => {
    expect(rechtenNaWijziging({}, { media: false })).toEqual({
      energielabel: true,
      nen: true,
      media: false,
    });
  });
});
