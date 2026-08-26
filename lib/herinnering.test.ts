import { describe, expect, it } from "vitest";
import { binnenWerkuren, stilTekst, teHerinneren } from "./herinnering";
import type { DraftSamenvatting } from "./drafts";

const NU = Date.UTC(2026, 7, 19, 10, 0, 0); // 12:00 in Amsterdam
const min = 60_000;

function opname(p: Partial<DraftSamenvatting> & { id: string }): DraftSamenvatting {
  return {
    status: "concept",
    titel: "",
    straatnaam: "Damrak 1",
    postcode: "1012LG",
    woonplaats: "Amsterdam",
    accountName: "Floris de Laat",
    clickupTaskUrl: null,
    updatedAt: NU - 60 * min,
    createdAt: NU - 90 * min,
    ...p,
  } as DraftSamenvatting;
}

const GEEN = new Set<string>();
const URL = "https://app.test";

describe("teHerinneren", () => {
  it("picks an opname that has been quiet past the threshold", () => {
    const r = teHerinneren([opname({ id: "a" })], NU, GEEN, URL);
    expect(r.map((x) => x.draft.id)).toEqual(["a"]);
    expect(r[0].stilMinuten).toBe(60);
  });

  // De grens bestaat juist om rijden en fotograferen niet als "gestopt" te
  // lezen; net binnen de tijd hoort dus niets te melden.
  it("leaves an opname alone while it is still within the grace period", () => {
    const r = teHerinneren([opname({ id: "a", updatedAt: NU - 30 * min })], NU, GEEN, URL);
    expect(r).toEqual([]);
  });

  it("ignores opnames that are already finished", () => {
    const r = teHerinneren([opname({ id: "a", status: "uploaded" })], NU, GEEN, URL);
    expect(r).toEqual([]);
  });

  it("does not send the same reminder twice", () => {
    const r = teHerinneren([opname({ id: "a" })], NU, new Set(["a"]), URL);
    expect(r).toEqual([]);
  });

  // Zonder naam is er niemand om aan te schrijven.
  it("skips opnames without a known user", () => {
    const r = teHerinneren([opname({ id: "a", accountName: null })], NU, GEEN, URL);
    expect(r).toEqual([]);
  });

  it("links an energielabel back into its own draft", () => {
    const r = teHerinneren([opname({ id: "a", soort: "energielabel" })], NU, GEEN, URL);
    expect(r[0].href).toBe("https://app.test/energielabel?draft=a");
  });

  it("links NEN and media back to their flow by address", () => {
    const r = teHerinneren(
      [opname({ id: "n", soort: "nen" }), opname({ id: "m", soort: "media" })],
      NU,
      GEEN,
      URL
    );
    expect(r.find((x) => x.draft.id === "n")!.href).toBe("https://app.test/nen?addr=Damrak%201");
    expect(r.find((x) => x.draft.id === "m")!.href).toBe("https://app.test/media?addr=Damrak%201");
  });

  // Oude records hebben geen soort; die zijn altijd energielabel geweest.
  it("treats a record without a kind as an energielabel", () => {
    const r = teHerinneren([opname({ id: "a" })], NU, GEEN, URL);
    expect(r[0].soort).toBe("energielabel");
  });

  it("puts the longest-abandoned opname first", () => {
    const r = teHerinneren(
      [
        opname({ id: "kort", updatedAt: NU - 50 * min }),
        opname({ id: "lang", updatedAt: NU - 200 * min }),
      ],
      NU,
      GEEN,
      URL
    );
    expect(r.map((x) => x.draft.id)).toEqual(["lang", "kort"]);
  });
});

describe("binnenWerkuren", () => {
  it("is true during the working day in Amsterdam", () => {
    expect(binnenWerkuren(new Date(Date.UTC(2026, 7, 19, 10, 0)))).toBe(true); // 12:00
  });

  it("is false in the evening and at night", () => {
    expect(binnenWerkuren(new Date(Date.UTC(2026, 7, 19, 19, 0)))).toBe(false); // 21:00
    expect(binnenWerkuren(new Date(Date.UTC(2026, 7, 19, 2, 0)))).toBe(false); // 04:00
  });

  // De serverklok staat op UTC; zonder tijdzone zou de werkdag twee uur
  // verschoven zijn.
  it("uses Dutch time, not the server clock", () => {
    expect(binnenWerkuren(new Date(Date.UTC(2026, 7, 19, 5, 30)))).toBe(true); // 07:30
    expect(binnenWerkuren(new Date(Date.UTC(2026, 7, 19, 4, 30)))).toBe(false); // 06:30
  });
});

describe("stilTekst", () => {
  it("reads as minutes, then hours", () => {
    expect(stilTekst(45)).toBe("45 min");
    expect(stilTekst(60)).toBe("1 uur");
    expect(stilTekst(125)).toBe("2 uur 5 min");
  });
});
