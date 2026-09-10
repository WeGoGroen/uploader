import { describe, expect, it } from "vitest";
import { hashCode, nieuweSalt, STARTCODE } from "@/lib/auth";

/**
 * De inlogcode is het enige dat tussen een willekeurige bezoeker en het werk
 * van het hele team in staat, dus de twee eigenschappen die dat dragen horen
 * vastgelegd: dezelfde code geeft dezelfde hash (anders kan niemand meer
 * inloggen na een herstart), en een andere code geeft een andere (anders is
 * het slot geen slot).
 */
describe("inlogcode", () => {
  it("geeft dezelfde hash voor dezelfde code en salt", async () => {
    const salt = nieuweSalt();
    expect(await hashCode("1234", salt)).toBe(await hashCode("1234", salt));
  });

  it("geeft een andere hash voor een andere code", async () => {
    const salt = nieuweSalt();
    expect(await hashCode("1234", salt)).not.toBe(await hashCode("1235", salt));
  });

  it("geeft een andere hash voor dezelfde code onder een andere salt", async () => {
    // Anders zou één gekraakte code meteen alle accounts met diezelfde code
    // verraden — en na de overgang staat iedereen op 0000.
    expect(await hashCode(STARTCODE, nieuweSalt())).not.toBe(await hashCode(STARTCODE, nieuweSalt()));
  });

  it("levert een salt die elke keer anders is", () => {
    expect(nieuweSalt()).not.toBe(nieuweSalt());
  });
});
