import { describe, expect, it } from "vitest";
import {
  NetwerkFout,
  UploadFout,
  blokGrootte,
  magOpnieuw,
  sessieOnbruikbaar,
  wachttijd,
} from "./upload-queue";

const MB = 1024 * 1024;

/**
 * Hoe groot de blokken worden. Te groot betekent dat één hapering veel werk
 * weggooit, te klein betekent onnodig veel rondjes — en beneden een bepaalde
 * grootte staan er werkers te wachten op blokken die er niet zijn.
 */
describe("blokGrootte", () => {
  it("always stays a multiple of the 4MB Dropbox requires", () => {
    for (const grootte of [1 * MB, 12 * MB, 20 * MB, 37 * MB, 140 * MB, 2048 * MB]) {
      expect(blokGrootte(grootte) % (4 * MB)).toBe(0);
    }
  });

  it("gives every worker something to do on a medium file", () => {
    // 20MB met blokken van 16MB was: één blok van 16 en één van 4, dus twee
    // werkers aan het werk en twee die niets te doen hebben.
    expect(blokGrootte(20 * MB)).toBe(4 * MB);
    expect(Math.ceil((20 * MB) / blokGrootte(20 * MB))).toBe(5);
  });

  it("never goes below one 4MB block", () => {
    expect(blokGrootte(5 * MB)).toBe(4 * MB);
    expect(blokGrootte(1)).toBe(4 * MB);
  });

  it("caps the block size so one hiccup does not cost a lot of work", () => {
    expect(blokGrootte(2048 * MB)).toBe(16 * MB);
    expect(blokGrootte(100 * MB)).toBe(16 * MB);
  });
});

/**
 * Welke fouten een herkansing verdienen. Dit ging eerder op de tékst van de
 * melding ("gaf 429"), dus wie een melding herschreef zette ongemerkt alle
 * herkansingen uit.
 */
describe("magOpnieuw", () => {
  it("retries anything that smells like the network", () => {
    expect(magOpnieuw(new NetwerkFout())).toBe(true);
    expect(magOpnieuw(new NetwerkFout("Netwerkfout: de upload stond stil"))).toBe(true);
  });

  it("retries rate limits and server errors", () => {
    expect(magOpnieuw(new UploadFout(429, "too_many_write_operations"))).toBe(true);
    expect(magOpnieuw(new UploadFout(500, ""))).toBe(true);
    expect(magOpnieuw(new UploadFout(503, ""))).toBe(true);
  });

  it("gives up on errors that waiting does not fix", () => {
    expect(magOpnieuw(new UploadFout(401, "expired_access_token"))).toBe(false);
    expect(magOpnieuw(new UploadFout(409, "path/conflict"))).toBe(false);
    expect(magOpnieuw(new UploadFout(400, ""))).toBe(false);
    expect(magOpnieuw(new Error("iets anders"))).toBe(false);
  });
});

/**
 * Wanneer een halve upload weggegooid moet worden. Dit is de duurste
 * beslissing in de keten: "opnieuw beginnen" betekent bij een video van 800MB
 * een half uur werk weg.
 */
describe("sessieOnbruikbaar", () => {
  it("starts over when Dropbox no longer knows the session", () => {
    expect(sessieOnbruikbaar(new UploadFout(409, "not_found/..."))).toBe(true);
    expect(sessieOnbruikbaar(new UploadFout(409, "incorrect_offset/..."))).toBe(true);
  });

  it("keeps the session on a network hiccup or a rate limit", () => {
    expect(sessieOnbruikbaar(new NetwerkFout())).toBe(false);
    expect(sessieOnbruikbaar(new UploadFout(429, "too_many_write_operations"))).toBe(false);
    expect(sessieOnbruikbaar(new UploadFout(503, ""))).toBe(false);
  });

  // Een verlopen token zegt niets over de sessie, en de blokken die er al
  // staan blijven geldig. Alleen op de tekst letten ("expired") zou een video
  // van 800MB weggooien om een token van vier uur oud.
  it("keeps the session when only the token expired", () => {
    expect(sessieOnbruikbaar(new UploadFout(401, "expired_access_token/..."))).toBe(false);
  });
});

/** Hoe lang er gewacht wordt voor de volgende poging. */
describe("wachttijd", () => {
  it("does what Retry-After says", () => {
    expect(wachttijd(1, 15)).toBe(15_000);
    expect(wachttijd(4, 2)).toBe(2_000);
  });

  it("never waits longer than a minute, whatever the server asks", () => {
    expect(wachttijd(1, 600)).toBe(60_000);
  });

  it("backs off further with every attempt", () => {
    // Met jitter erbij is de exacte waarde niet vast; de banden mogen elkaar
    // niet overlappen, anders is "verder teruglopen" een lege belofte.
    expect(wachttijd(1, null)).toBeGreaterThanOrEqual(1_000);
    expect(wachttijd(1, null)).toBeLessThan(2_000);
    expect(wachttijd(4, null)).toBeGreaterThanOrEqual(8_000);
    expect(wachttijd(4, null)).toBeLessThan(13_000);
  });

  it("stays bounded on a long series of attempts", () => {
    for (let poging = 1; poging <= 12; poging++) {
      expect(wachttijd(poging, null)).toBeLessThanOrEqual(30_000);
    }
  });
});
