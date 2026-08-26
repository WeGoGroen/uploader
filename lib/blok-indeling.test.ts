import { describe, expect, it } from "vitest";
import { blokIndeling } from "./upload-queue";

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
