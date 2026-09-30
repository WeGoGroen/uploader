import { describe, expect, it } from "vitest";
import { bibliotheekPad, uploadPad } from "@/lib/bibliotheek-pad";

describe("bibliotheekPad", () => {
  it("geeft het volledige pad van een bestaande foto", () => {
    expect(bibliotheekPad("Amsterdam Oost/Oud-Oost/Indische Buurt/Javastraat/Javastraat 02.jpg")).toBe(
      "/Master B-roll Library/Amsterdam Oost/Oud-Oost/Indische Buurt/Javastraat/Javastraat 02.jpg"
    );
    expect(bibliotheekPad("Haarlem/Vondelweg/Vondelweg 144, Haarlem PHOTO 37.jpg")).toBe(
      "/Master B-roll Library/Haarlem/Vondelweg/Vondelweg 144, Haarlem PHOTO 37.jpg"
    );
  });

  it("weigert een map, iets anders dan beeld, of een pad dat omhoog loopt", () => {
    expect(bibliotheekPad("Amsterdam Oost")).toBeNull();
    expect(bibliotheekPad("Amsterdam Oost/IJburg")).toBeNull();
    expect(bibliotheekPad("Amsterdam Oost/plan.pdf")).toBeNull();
    expect(bibliotheekPad("../Automatie Media/x.jpg")).toBeNull();
    expect(bibliotheekPad("a/../../b/x.jpg")).toBeNull();
    expect(bibliotheekPad("a:b/x.jpg")).toBeNull();
  });
});

describe("uploadPad", () => {
  it("laat alleen Uploads/ toe", () => {
    expect(uploadPad("Uploads/Amsterdam/Javastraat/2026-09-30 IMG_1234.jpg")).toBe(
      "/Master B-roll Library/Uploads/Amsterdam/Javastraat/2026-09-30 IMG_1234.jpg"
    );
    expect(uploadPad("Amsterdam Oost/Javastraat/x.jpg")).toBeNull();
  });
});
