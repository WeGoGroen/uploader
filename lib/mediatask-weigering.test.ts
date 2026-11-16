import { describe, expect, it } from "vitest";
import { alIngediend, andereSleutels, orderVanSchrijfactie, weigeringUitleg } from "./mediatask-weigering";

describe("orderVanSchrijfactie", () => {
  it("herkent schrijfacties op een order", () => {
    expect(orderVanSchrijfactie("/api/orders/812", "PATCH")).toBe(812);
    expect(orderVanSchrijfactie("/api/orders/812/submit", "POST")).toBe(812);
    expect(orderVanSchrijfactie("/api/orders/812/pointclouds/attach", "post")).toBe(812);
  });

  it("laat lezen en het aanmaken van een order met rust", () => {
    expect(orderVanSchrijfactie("/api/orders/812", undefined)).toBeNull();
    expect(orderVanSchrijfactie("/api/orders/812/pointclouds", "GET")).toBeNull();
    expect(orderVanSchrijfactie("/api/orders", "POST")).toBeNull();
    expect(orderVanSchrijfactie("/api/report_variables/812", "POST")).toBeNull();
  });
});

describe("andereSleutels", () => {
  it("slaat de geweigerde sleutel, lege waarden en dubbelen over", () => {
    expect(andereSleutels("eigen", ["gedeeld", "eigen", null, undefined, "collega", "gedeeld"])).toEqual([
      "gedeeld",
      "collega",
    ]);
  });
});

describe("alIngediend", () => {
  it("telt alles voorbij het concept als ingediend", () => {
    expect(alIngediend("submitted")).toBe(true);
    expect(alIngediend("action required")).toBe(true);
    expect(alIngediend("draft")).toBe(false);
    expect(alIngediend(null)).toBe(false);
  });
});

describe("weigeringUitleg", () => {
  it("zegt bij een ingediende order dat er niets meer bij kan", () => {
    const tekst = weigeringUitleg({ orderId: 812, state: "submitted", eigenaar: "Sam" });
    expect(tekst).toContain("#812");
    expect(tekst).toContain('al op "submitted"');
  });

  it("noemt bij een concept de eigenaar", () => {
    const tekst = weigeringUitleg({ orderId: 812, state: "draft", eigenaar: "Sam" });
    expect(tekst).toContain("op naam van Sam");
  });
});
