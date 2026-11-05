import { afterEach, describe, expect, it, vi } from "vitest";
import { vertaalOpmerking } from "@/lib/vertaal-opmerking";

describe("vertaalOpmerking", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("geeft een lege opmerking leeg terug", async () => {
    expect(await vertaalOpmerking("   ")).toBe("");
  });

  it("stuurt zonder API-sleutel de oorspronkelijke tekst mee", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    expect(await vertaalOpmerking(" Zolder niet toegankelijk. ")).toBe("Zolder niet toegankelijk.");
  });
});
