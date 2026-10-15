import { afterEach, describe, expect, it, vi } from "vitest";
import { verplaatsBatch } from "./dropbox";

/**
 * Dropbox weigert een verplaatsing per regel met too_many_write_operations
 * zodra er in hetzelfde account iets anders tegelijk schrijft. Op 15 oktober
 * bleven zo zeven 360's onder een tijdelijke naam staan. verplaatsBatch
 * probeert die regels opnieuw, en alleen die.
 */

const weigering = { ".tag": "failure", failure: { ".tag": "too_many_write_operations" } };
const gelukt = { ".tag": "success", metadata: {} };

function antwoorden(reeks: unknown[][]) {
  const verzoeken: unknown[] = [];
  let i = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: { body: string }) => {
      verzoeken.push(JSON.parse(init.body));
      const entries = reeks[i++];
      return { ok: true, status: 200, json: async () => ({ ".tag": "complete", entries }) };
    })
  );
  return verzoeken;
}

afterEach(() => vi.unstubAllGlobals());

describe("verplaatsBatch", () => {
  it("probeert een regel die Dropbox even weigert opnieuw, en alleen die", async () => {
    const verzoeken = antwoorden([[gelukt, weigering], [gelukt]]);
    const uit = await verplaatsBatch("t", [
      { van: "/a/1.jpg", naar: "/a/x.jpg" },
      { van: "/a/2.jpg", naar: "/a/y.jpg" },
    ]);
    expect(uit).toEqual(["verplaatst", "verplaatst"]);
    expect(verzoeken).toHaveLength(2);
    expect((verzoeken[1] as { entries: { from_path: string }[] }).entries.map((e) => e.from_path)).toEqual([
      "/a/2.jpg",
    ]);
  }, 20_000);

  it("geeft een andere fout meteen terug, zonder herhaling", async () => {
    const verzoeken = antwoorden([[{ ".tag": "failure", failure: { ".tag": "from_lookup" } }]]);
    const uit = await verplaatsBatch("t", [{ van: "/a/1.jpg", naar: "/a/x.jpg" }]);
    expect(typeof uit[0]).toBe("object");
    expect(verzoeken).toHaveLength(1);
  });
});
