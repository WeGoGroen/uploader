import { describe, expect, it } from "vitest";
import { telOverdrachten } from "./health";

/**
 * De ochtendcontrole moet de overdrachtsstatus uit Redis lezen. Na de
 * bolletjes-opruiming staat hij niet meer in de mapnaam, en dan meldde de
 * controle elke ochtend "nog geen overdrachten" terwijl er mappen op rood
 * stonden.
 */
describe("telOverdrachten", () => {
  const root = "/Automatie Energielabels";

  it("reads the status from Redis for folders without a marker", () => {
    const uit = telOverdrachten(
      root,
      [{ name: "Dam 5, Amsterdam" }, { name: "Kade 2, Utrecht" }, { name: "Laan 9, Delft" }],
      {
        "/automatie energielabels/dam 5, amsterdam": "compleet",
        "/automatie energielabels/kade 2, utrecht": "ontbreekt",
      }
    );
    expect(uit.compleet).toEqual(["Dam 5, Amsterdam"]);
    expect(uit.ontbreekt).toEqual(["Kade 2, Utrecht"]);
    expect(uit.bezig).toEqual([]);
  });

  it("still counts a legacy marker in the folder name", () => {
    const uit = telOverdrachten(root, [{ name: "🟠 Dam 5, Amsterdam" }], {});
    expect(uit.bezig).toEqual(["Dam 5, Amsterdam"]);
  });

  it("lets Redis win over a stale marker, and ignores unknown values", () => {
    const uit = telOverdrachten(root, [{ name: "🔴 Dam 5, Amsterdam" }, { name: "Kade 2, Utrecht" }], {
      "/automatie energielabels/dam 5, amsterdam": "compleet",
      "/automatie energielabels/kade 2, utrecht": "iets-anders",
    });
    expect(uit.compleet).toEqual(["Dam 5, Amsterdam"]);
    expect(uit.ontbreekt).toEqual([]);
  });
});
