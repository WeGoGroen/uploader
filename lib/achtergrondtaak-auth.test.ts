import { afterEach, describe, expect, it } from "vitest";
import { gelijkInConstanteTijd, maakSessie, magAchtergrondtaakDraaien } from "@/lib/auth";

/**
 * Wie de ochtendcontrole, herinneringen en de herstelwerker mag starten.
 *
 * Hier zat een stille fout: de sessiecontrole kende alleen het oude
 * sessieformaat, dus een echte, geldige sessie werd altijd geweigerd. Deze
 * tests leggen vast dat een sessie van nu weer telt, en dat een vervalste of
 * ontbrekende niet telt.
 */
const OUD_GEHEIM = process.env.CRON_SECRET;
const OUDE_SLEUTEL = process.env.SESSION_SECRET;

function aanvraag(auth?: string): Request {
  return new Request("https://example.test/api/health", {
    headers: auth ? { authorization: auth } : {},
  });
}

afterEach(() => {
  process.env.CRON_SECRET = OUD_GEHEIM;
  process.env.SESSION_SECRET = OUDE_SLEUTEL;
});

describe("magAchtergrondtaakDraaien", () => {
  it("accepts a current session", async () => {
    process.env.SESSION_SECRET = "test-sleutel-die-lang-genoeg-is-0123456789";
    const sessie = await maakSessie(process.env.SESSION_SECRET, {
      naam: "Floris",
      rol: "beheerder",
      codeGewijzigd: true,
    });
    const uit = await magAchtergrondtaakDraaien(aanvraag(), sessie);
    expect(uit.viaSessie).toBe(true);
    expect(uit.viaCron).toBe(false);
  });

  it("rejects a session signed with another key", async () => {
    process.env.SESSION_SECRET = "test-sleutel-die-lang-genoeg-is-0123456789";
    const vervalst = await maakSessie("een-andere-sleutel", {
      naam: "Floris",
      rol: "beheerder",
      codeGewijzigd: true,
    });
    expect((await magAchtergrondtaakDraaien(aanvraag(), vervalst)).viaSessie).toBe(false);
    expect((await magAchtergrondtaakDraaien(aanvraag(), undefined)).viaSessie).toBe(false);
  });

  it("accepts only the exact cron secret", async () => {
    process.env.CRON_SECRET = "cron-geheim";
    expect((await magAchtergrondtaakDraaien(aanvraag("Bearer cron-geheim"), null)).viaCron).toBe(true);
    expect((await magAchtergrondtaakDraaien(aanvraag("Bearer cron-geheiM"), null)).viaCron).toBe(false);
    expect((await magAchtergrondtaakDraaien(aanvraag(), null)).viaCron).toBe(false);
  });

  it("never accepts cron access when no secret is set", async () => {
    delete process.env.CRON_SECRET;
    expect((await magAchtergrondtaakDraaien(aanvraag("Bearer "), null)).viaCron).toBe(false);
    expect((await magAchtergrondtaakDraaien(aanvraag("Bearer undefined"), null)).viaCron).toBe(false);
  });
});

describe("gelijkInConstanteTijd", () => {
  it("compares whole strings", () => {
    expect(gelijkInConstanteTijd("abc", "abc")).toBe(true);
    expect(gelijkInConstanteTijd("abc", "abd")).toBe(false);
    expect(gelijkInConstanteTijd("abc", "abcd")).toBe(false);
  });
});
