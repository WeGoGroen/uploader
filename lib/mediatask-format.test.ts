import { describe, expect, it } from "vitest";
import { matchGrossFloorAreaBracket } from "./mediatask-format";

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
