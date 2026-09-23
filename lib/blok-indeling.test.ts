import { describe, expect, it } from "vitest";
import { afsluitBlok, blokFoutHerstelbaar, blokIndeling } from "./upload-queue";

const MB = 1024 * 1024;
const BLOK = 16 * MB;

/**
 * Deze indeling bepaalt op wélke positie elk blok bij Dropbox terechtkomt.
 * Een fout valt niet op als foutmelding maar als een stil beschadigd bestand,
 * dus de randgevallen staan hier vast.
 */
describe("blokIndeling", () => {
  it("splits a file into blocks, with a smaller last one", () => {
    const { alle } = blokIndeling(40 * MB, BLOK, []);
    expect(alle).toEqual([
      [0, 16 * MB],
      [16 * MB, 32 * MB],
      [32 * MB, 40 * MB],
    ]);
  });

  it("asks for everything when nothing was uploaded yet", () => {
    const { resterend, alGedaan } = blokIndeling(40 * MB, BLOK, []);
    expect(resterend).toHaveLength(3);
    expect(alGedaan).toBe(0);
  });

  // De kern van hervatten: alleen de rest, en de balk begint op de juiste stand.
  it("only asks for the blocks Dropbox does not have yet", () => {
    const { resterend, alGedaan } = blokIndeling(40 * MB, BLOK, [0, 16 * MB]);
    expect(resterend).toEqual([[32 * MB, 40 * MB]]);
    expect(alGedaan).toBe(32 * MB);
  });

  it("handles blocks finished out of order", () => {
    // Parallelle werkers kunnen blok 3 vóór blok 2 afronden.
    const { resterend, alGedaan } = blokIndeling(40 * MB, BLOK, [32 * MB, 0]);
    expect(resterend).toEqual([[16 * MB, 32 * MB]]);
    expect(alGedaan).toBe(24 * MB);
  });

  it("asks for nothing when every block is already there", () => {
    const { resterend, alGedaan } = blokIndeling(40 * MB, BLOK, [0, 16 * MB, 32 * MB]);
    expect(resterend).toEqual([]);
    expect(alGedaan).toBe(40 * MB);
  });

  // Een bewaarde stand uit een andere blokgrootte wijst naar posities die nu
  // niet bestaan; die overslaan zou gaten in het bestand achterlaten.
  it("ignores saved positions that do not line up with the current blocks", () => {
    const { resterend, alGedaan } = blokIndeling(40 * MB, BLOK, [8 * MB, 24 * MB]);
    expect(resterend).toHaveLength(3);
    expect(alGedaan).toBe(0);
  });

  it("handles a file smaller than one block", () => {
    const { alle, resterend } = blokIndeling(3 * MB, BLOK, []);
    expect(alle).toEqual([[0, 3 * MB]]);
    expect(resterend).toEqual([[0, 3 * MB]]);
  });

  it("handles a file that is an exact multiple of the block size", () => {
    const { alle } = blokIndeling(32 * MB, BLOK, []);
    expect(alle).toEqual([
      [0, 16 * MB],
      [16 * MB, 32 * MB],
    ]);
  });

  it("covers every byte exactly once", () => {
    const { alle } = blokIndeling(100 * MB, BLOK, []);
    expect(alle[0][0]).toBe(0);
    expect(alle[alle.length - 1][1]).toBe(100 * MB);
    for (let i = 1; i < alle.length; i++) expect(alle[i][0]).toBe(alle[i - 1][1]);
  });
});

/**
 * Het blok dat de sessie sluit mag nooit naast andere blokken lopen: zodra
 * Dropbox 'm binnen heeft, weigert hij elke append die nog onderweg was met
 * een 409 "closed". Daar sneuvelde het uploaden van video's op — die zijn als
 * enige groot genoeg om in blokken te gaan.
 */
describe("afsluitBlok", () => {
  it("houdt het laatste blok apart van wat parallel mag", () => {
    const { resterend } = blokIndeling(100 * MB, BLOK, []);
    const { parallel, sluit } = afsluitBlok(100 * MB, resterend);
    expect(sluit).toEqual([96 * MB, 100 * MB]);
    expect(parallel).toHaveLength(resterend.length - 1);
    expect(parallel.every(([, to]) => to !== 100 * MB)).toBe(true);
  });

  it("laat samen nog steeds elk blok één keer over", () => {
    const { resterend } = blokIndeling(100 * MB, BLOK, []);
    const { parallel, sluit } = afsluitBlok(100 * MB, resterend);
    expect([...parallel, sluit!].sort((a, b) => a[0] - b[0])).toEqual(resterend);
  });

  it("geeft een bestand van één blok alleen als sluitend blok terug", () => {
    const { resterend } = blokIndeling(10 * MB, BLOK, []);
    const { parallel, sluit } = afsluitBlok(10 * MB, resterend);
    expect(parallel).toEqual([]);
    expect(sluit).toEqual([0, 10 * MB]);
  });

  it("heeft niets te sluiten als dat blok er bij het hervatten al door was", () => {
    // Kan alleen als alles al gelukt was: het sluitende blok gaat als laatste.
    const { resterend } = blokIndeling(40 * MB, BLOK, [32 * MB]);
    const { parallel, sluit } = afsluitBlok(40 * MB, resterend);
    expect(sluit).toBeNull();
    expect(parallel).toEqual([
      [0, 16 * MB],
      [16 * MB, 32 * MB],
    ]);
  });

  it("valt niet over een bestand dat exact op de blokgrens eindigt", () => {
    const { resterend } = blokIndeling(32 * MB, BLOK, []);
    const { parallel, sluit } = afsluitBlok(32 * MB, resterend);
    expect(sluit).toEqual([16 * MB, 32 * MB]);
    expect(parallel).toEqual([[0, 16 * MB]]);
  });
});

describe("blokFoutHerstelbaar", () => {
  it("probeert opnieuw bij netwerk, 429 en serverfouten", () => {
    expect(blokFoutHerstelbaar(new Error("Netwerkfout bij uploaden"))).toBe(true);
    expect(blokFoutHerstelbaar(new Error("Dropbox append gaf 429"))).toBe(true);
    expect(blokFoutHerstelbaar(new Error("Dropbox append gaf 503"))).toBe(true);
  });

  it("geeft het op bij een fout die niet vanzelf overgaat", () => {
    expect(blokFoutHerstelbaar(new Error("Dropbox append gaf 401"))).toBe(false);
    expect(blokFoutHerstelbaar(new Error("Dropbox append gaf 409"))).toBe(false);
  });

  // Onze route maakt van elke Dropbox-fout een 502; dan telt de code die
  // Dropbox zelf gaf, anders herhalen we een 409 drie keer voor niets.
  it("kijkt door de 502 van onze eigen route heen", () => {
    const closed = new Error(
      'Dropbox upload_session/append_v2 failed: 409 {"error_summary":"closed/.."} (gaf 502)'
    );
    expect(blokFoutHerstelbaar(closed)).toBe(false);

    const druk = new Error(
      'Dropbox upload_session/append_v2 failed: 429 {"error_summary":"too_many_requests/.."} (gaf 502)'
    );
    expect(blokFoutHerstelbaar(druk)).toBe(true);
  });
});
