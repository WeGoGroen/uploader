import { describe, expect, it } from "vitest";
import { statusFromName, stripStatusMarker } from "@/lib/dropbox";

/**
 * Het bolletje voor de mapnaam is de drager van de overdrachtsstatus — in
 * Dropbox, in de ochtendcontrole én in het Business Control Center. Gaat het
 * lezen of strippen ervan stuk, dan liegt op alle drie die plekken tegelijk
 * de status.
 */
describe("statusbolletje op een projectmap", () => {
  it("leest de status uit de mapnaam", () => {
    expect(statusFromName("🟢 Kerkstraat 12, Utrecht")).toBe("compleet");
    expect(statusFromName("🟠 Kerkstraat 12, Utrecht")).toBe("bezig");
    expect(statusFromName("🔴 Kerkstraat 12, Utrecht")).toBe("ontbreekt");
  });

  it("geeft null voor een map zonder bolletje", () => {
    expect(statusFromName("Kerkstraat 12, Utrecht")).toBeNull();
  });

  it("haalt het bolletje eraf zonder het adres te raken", () => {
    expect(stripStatusMarker("🟢 Kerkstraat 12, Utrecht")).toBe("Kerkstraat 12, Utrecht");
    expect(stripStatusMarker("Kerkstraat 12, Utrecht")).toBe("Kerkstraat 12, Utrecht");
  });

  it("laat een adres dat zelf met een cijfer begint heel", () => {
    expect(stripStatusMarker("🔴 1e Jan Steenstraat 5, Amsterdam")).toBe(
      "1e Jan Steenstraat 5, Amsterdam"
    );
  });
});
