import { describe, expect, it } from "vitest";
import { dayWindow } from "./google-calendar";

/**
 * Deze test bestaat omdat het venster eerder met de serverklok werd bepaald.
 * Op Vercel (UTC) begon "vandaag" daardoor om 02:00 Nederlandse tijd, en viel
 * een avondafspraak van 23:00 buiten de dag. De verwachte waarden hieronder
 * zijn UTC-instants van Nederlandse middernacht.
 */
describe("dayWindow", () => {
  it("uses the Dutch calendar day, not the UTC day (summer time)", () => {
    // 10:00 UTC = 12:00 in Amsterdam op 16 augustus.
    const { start, end } = dayWindow(new Date("2026-08-16T10:00:00Z"));
    expect(start.toISOString()).toBe("2026-08-15T22:00:00.000Z");
    expect(end.toISOString()).toBe("2026-08-16T22:00:00.000Z");
  });

  it("uses the Dutch calendar day in winter time", () => {
    const { start, end } = dayWindow(new Date("2026-01-15T10:00:00Z"));
    expect(start.toISOString()).toBe("2026-01-14T23:00:00.000Z");
    expect(end.toISOString()).toBe("2026-01-15T23:00:00.000Z");
  });

  // Vóór de fix het ergste geval: om 00:30 Nederlandse tijd stond de
  // serverklok (UTC) nog op de vorige dag, dus kreeg je de afspraken van
  // gisteren te zien.
  it("still returns today just after Dutch midnight", () => {
    // 22:30 UTC = 00:30 op 17 augustus in Amsterdam.
    const { start, end } = dayWindow(new Date("2026-08-16T22:30:00Z"));
    expect(start.toISOString()).toBe("2026-08-16T22:00:00.000Z");
    expect(end.toISOString()).toBe("2026-08-17T22:00:00.000Z");
  });

  it("covers a 23-hour day when summer time starts", () => {
    // 29 maart 2026: de klok gaat om 02:00 naar 03:00.
    const { start, end } = dayWindow(new Date("2026-03-29T10:00:00Z"));
    expect(start.toISOString()).toBe("2026-03-28T23:00:00.000Z");
    expect(end.toISOString()).toBe("2026-03-29T22:00:00.000Z");
    expect((end.getTime() - start.getTime()) / 3600_000).toBe(23);
  });

  it("covers a 25-hour day when summer time ends", () => {
    // 25 oktober 2026: de klok gaat om 03:00 terug naar 02:00.
    const { start, end } = dayWindow(new Date("2026-10-25T10:00:00Z"));
    expect(start.toISOString()).toBe("2026-10-24T22:00:00.000Z");
    expect(end.toISOString()).toBe("2026-10-25T23:00:00.000Z");
    expect((end.getTime() - start.getTime()) / 3600_000).toBe(25);
  });

  it("rolls over month and year boundaries", () => {
    const { start, end } = dayWindow(new Date("2026-12-31T12:00:00Z"));
    expect(start.toISOString()).toBe("2026-12-30T23:00:00.000Z");
    expect(end.toISOString()).toBe("2026-12-31T23:00:00.000Z");
  });
});
