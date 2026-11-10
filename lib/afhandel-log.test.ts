import { describe, expect, it } from "vitest";
import { isProjectmap, leesInvoer, MAX_BYTES } from "@/lib/afhandel-log";

describe("afhandel-log: projectmap", () => {
  it("een projectmap direct onder de hoofdmap, of in het archief", () => {
    expect(isProjectmap("/Automatie Energielabels/Sluisstraat 25-H, Amsterdam")).toBe(true);
    expect(isProjectmap("/Automatie Energielabels/Afgerond/Sluisstraat 25-H, Amsterdam")).toBe(true);
    expect(isProjectmap("/Automatie Energielabels/Afgerond/2026-10 Oktober/Sluisstraat 25-H, Amsterdam")).toBe(true);
  });
  it("niet de hoofdmap, het archief, een maandmap, een submap of iets daarbuiten", () => {
    expect(isProjectmap("/Automatie Energielabels/Afgerond")).toBe(false);
    expect(isProjectmap("/Automatie Energielabels/Afgerond/2026-10 Oktober")).toBe(false);
    expect(isProjectmap("/Automatie Energielabels/Sluisstraat 25-H, Amsterdam/Foto's")).toBe(false);
    expect(isProjectmap("/Automatie NEN2580/Sluisstraat 25-H")).toBe(false);
    expect(isProjectmap("/Automatie Energielabels/../Privé")).toBe(false);
  });
});

describe("afhandel-log: invoer", () => {
  const goed = { folder_id: "id:GMPyUgOlkxAAAAAAAAqwVg", bestandsnaam: "_afhandel-log_2026-11-10_0905.md", inhoud: "# log" };
  it("een geldige aanvraag", () => {
    expect(leesInvoer(goed)).toEqual({ ok: true, folderId: goed.folder_id, bestandsnaam: goed.bestandsnaam, inhoud: "# log" });
  });
  it("alleen een folder-ID, geen pad", () => {
    expect(leesInvoer({ ...goed, folder_id: "/Automatie Energielabels/x" }).ok).toBe(false);
  });
  it("alleen de vaste lognaam", () => {
    expect(leesInvoer({ ...goed, bestandsnaam: "Opnameformulier.pdf" }).ok).toBe(false);
    expect(leesInvoer({ ...goed, bestandsnaam: "../_afhandel-log_2026-11-10_0905.md" }).ok).toBe(false);
    expect(leesInvoer({ ...goed, bestandsnaam: "_afhandel-log.md" }).ok).toBe(false);
  });
  it("niet leeg en niet te groot", () => {
    expect(leesInvoer({ ...goed, inhoud: "  " }).ok).toBe(false);
    expect(leesInvoer({ ...goed, inhoud: "x".repeat(MAX_BYTES + 1) }).ok).toBe(false);
  });
});
