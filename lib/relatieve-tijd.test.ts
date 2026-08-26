import { describe, expect, it } from "vitest";
import { relatieveTijd } from "./relatieve-tijd";

const NU = Date.UTC(2026, 7, 18, 12, 0, 0);
const min = 60_000;
const uur = 60 * min;
const dag = 24 * uur;

describe("relatieveTijd", () => {
  it("calls anything under a minute just now", () => {
    expect(relatieveTijd(NU - 30_000, NU)).toBe("zojuist");
  });

  it("counts minutes and hours", () => {
    expect(relatieveTijd(NU - 5 * min, NU)).toBe("5 min geleden");
    expect(relatieveTijd(NU - 3 * uur, NU)).toBe("3 uur geleden");
  });

  it("switches to days, with a word for one day", () => {
    expect(relatieveTijd(NU - 1 * dag, NU)).toBe("gisteren");
    expect(relatieveTijd(NU - 5 * dag, NU)).toBe("5 dagen geleden");
  });

  it("switches to weeks and months", () => {
    expect(relatieveTijd(NU - 7 * dag, NU)).toBe("vorige week");
    expect(relatieveTijd(NU - 21 * dag, NU)).toBe("3 weken geleden");
    expect(relatieveTijd(NU - 60 * dag, NU)).toBe("2 maanden geleden");
  });

  // Klokken lopen niet gelijk; een tijdstip "in de toekomst" mag geen
  // onzinnige tekst als "-3 min geleden" opleveren.
  it("does not produce negative times when the clock is off", () => {
    expect(relatieveTijd(NU + 5 * min, NU)).toBe("zojuist");
  });
});
