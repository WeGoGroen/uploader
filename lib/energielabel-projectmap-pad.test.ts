import { describe, expect, it } from "vitest";
import { INTERN_MAP, isEnergielabelProjectmap } from "@/lib/energielabel-projectmap-pad";

describe("isEnergielabelProjectmap", () => {
  it.each([
    "/Automatie Energielabels/Lutmastraat 3-3, Amsterdam",
    "/Automatie Energielabels/Afgerond/Lutmastraat 3-3, Amsterdam",
    `${INTERN_MAP}/2026-08/Balboastraat 12-4, Amsterdam`,
  ])("accepteert %s", (pad) => {
    expect(isEnergielabelProjectmap(pad)).toBe(true);
  });

  it.each([
    "/Automatie Energielabels",
    "/Automatie Energielabels/Afgerond",
    "/Automatie Energielabels/Lutmastraat 3-3, Amsterdam/EP-Online",
    INTERN_MAP,
    `${INTERN_MAP}/2026-08`,
    `${INTERN_MAP}/2026-08/Balboastraat 12-4, Amsterdam/Foto's`,
    `${INTERN_MAP}/../Archief projectdossiers/2026-08/X`,
    "/Automatie Media/Lutmastraat 3-3, Amsterdam",
    "/Certificering NL-EPBD/WeGoGroen/Energielabels/Archief projectdossiers/2024-01/X",
  ])("weigert %s", (pad) => {
    expect(isEnergielabelProjectmap(pad)).toBe(false);
  });
});
