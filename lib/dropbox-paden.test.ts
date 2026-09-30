import { describe, expect, it } from "vitest";
import { projectFolderPath, safeHeaderJson, sanitizePathSegment } from "@/lib/dropbox";

// Legt het huidige gedrag vast: bestaande projectmappen worden op deze namen
// teruggevonden, dus een wijziging hier zou stilletjes tweede mappen opleveren.

describe("sanitizePathSegment", () => {
  it("vervangt padtekens door een streepje", () => {
    expect(sanitizePathSegment('a/b\\c:d*e?f"g<h>i|j')).toBe("a-b-c-d-e-f-g-h-i-j");
  });

  it("trimt en voegt witruimte samen", () => {
    expect(sanitizePathSegment("  Kerkstraat   12 \t a ")).toBe("Kerkstraat 12 a");
  });

  it("laat letters met accenten staan", () => {
    expect(sanitizePathSegment("Café-Hôtel")).toBe("Café-Hôtel");
  });
});

describe("projectFolderPath", () => {
  it("kiest de hoofdmap per soort", () => {
    expect(projectFolderPath("energielabel", "Utrecht", "Kerkstraat 1")).toBe(
      "/Automatie Energielabels/Kerkstraat 1, Utrecht"
    );
    expect(projectFolderPath("nen", "Utrecht", "Kerkstraat 1")).toBe(
      "/Automatie NEN2580/Kerkstraat 1, Utrecht"
    );
    expect(projectFolderPath("media", "Utrecht", "Kerkstraat 1")).toBe(
      "/Automatie Media/Kerkstraat 1, Utrecht"
    );
  });

  it("schoont straat en plaats op", () => {
    expect(projectFolderPath("media", " 's-Hertogenbosch ", "Markt 1/A")).toBe(
      "/Automatie Media/Markt 1-A, 's-Hertogenbosch"
    );
  });
});

describe("safeHeaderJson", () => {
  it("laat ASCII ongemoeid", () => {
    expect(safeHeaderJson({ path: "/a b/c.jpg" })).toBe('{"path":"/a b/c.jpg"}');
  });

  it("escapet niet-ASCII en DEL als \\uXXXX", () => {
    const uit = safeHeaderJson({ path: "/Café…\u007f" });
    expect(uit).toBe('{"path":"/Caf\\u00e9\\u2026\\u007f"}');
    expect(/^[\x20-\x7e]*$/.test(uit)).toBe(true);
    expect(JSON.parse(uit)).toEqual({ path: "/Café…\u007f" });
  });
});
