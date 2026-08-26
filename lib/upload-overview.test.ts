import { describe, expect, it } from "vitest";
import { bouwOpenstaand, gemiddeldPct, soortUitPad, type OverzichtDraft } from "./upload-overview";
import type { UploadTask } from "./upload-queue";

function taak(p: Partial<UploadTask> & { id: string; folderPath: string }): UploadTask {
  return {
    folder: "Photo's",
    name: `${p.id}.jpg`,
    pct: 0,
    dropbox: "uploading",
    ...p,
  } as UploadTask;
}

function concept(p: Partial<OverzichtDraft> & { id: string; straatnaam: string }): OverzichtDraft {
  return {
    status: "concept",
    titel: "",
    accountName: null,
    ...p,
  } as OverzichtDraft;
}

const NEN = "/Automatie NEN2580/Damrak 1, Amsterdam";
const LABEL = "/Automatie Energielabels/Dam 5, Amsterdam";

function soorten(r: { producten: { soort: string }[] }): string[] {
  return r.producten.map((p) => p.soort).sort();
}

describe("gemiddeldPct", () => {
  it("averages running and finished files", () => {
    expect(
      gemiddeldPct([
        taak({ id: "a", folderPath: NEN, pct: 40 }),
        taak({ id: "b", folderPath: NEN, dropbox: "done", pct: 100 }),
      ])
    ).toBe(70);
  });

  // Een mislukt bestand blijft vaak op 100 staan omdat het juist bij het
  // afronden misging; dat mag niet als voortgang gelezen worden.
  it("gives no percentage once nothing is running any more", () => {
    expect(gemiddeldPct([taak({ id: "a", folderPath: NEN, dropbox: "error", pct: 100 })])).toBeNull();
  });

  it("leaves failed files out of a running average", () => {
    expect(
      gemiddeldPct([
        taak({ id: "a", folderPath: NEN, pct: 50 }),
        taak({ id: "b", folderPath: NEN, dropbox: "error", pct: 100 }),
      ])
    ).toBe(50);
  });
});

describe("bouwOpenstaand", () => {
  it("groups files per address and tags the product", () => {
    const r = bouwOpenstaand(
      [
        taak({ id: "a", folderPath: NEN, pct: 20 }),
        taak({ id: "b", folderPath: NEN, pct: 60 }),
        taak({ id: "c", folderPath: LABEL, pct: 10 }),
      ],
      null
    );

    expect(r).toHaveLength(2);
    const nen = r.find((x) => x.adres.startsWith("Damrak"))!;
    expect(soorten(nen)).toEqual(["nen"]);
    expect(nen.pct).toBe(40);
    expect(nen.redenen).toEqual(["2 van 2 bestanden nog bezig"]);
    expect(nen.status).toBe("bezig");
    expect(nen.producten[0].href).toContain("/nen?addr=");
  });

  // Eén pand kan beide producten hebben; dat is één klus op één adres.
  it("puts both products on one row for the same address", () => {
    const r = bouwOpenstaand(
      [
        taak({ id: "a", folderPath: "/Automatie NEN2580/Dam 5, Amsterdam", pct: 20 }),
        taak({ id: "b", folderPath: LABEL, pct: 60 }),
      ],
      null
    );

    expect(r).toHaveLength(1);
    expect(soorten(r[0])).toEqual(["energielabel", "nen"]);
    expect(r[0].pct).toBe(40);
  });

  it("shows the user who started the upload", () => {
    const r = bouwOpenstaand([taak({ id: "a", folderPath: NEN, account: "Floris de Laat" })], null);
    expect(r[0].gebruiker).toBe("Floris de Laat");
  });

  it("falls back to the user on the draft when the queue has no name", () => {
    const r = bouwOpenstaand([], [concept({ id: "d0", straatnaam: "Dam 5", accountName: "Y. Bakker" })]);
    expect(r[0].gebruiker).toBe("Y. Bakker");
  });

  it("leaves out uploads that finished cleanly", () => {
    const r = bouwOpenstaand([taak({ id: "a", folderPath: NEN, dropbox: "done", pct: 100 })], null);
    expect(r).toEqual([]);
  });

  it("keeps failed uploads with a retry handle and no percentage", () => {
    const r = bouwOpenstaand([taak({ id: "a", folderPath: NEN, dropbox: "error", pct: 100 })], null);
    expect(r).toHaveLength(1);
    expect(r[0].pct).toBeNull();
    expect(r[0].mislukt.map((t) => t.id)).toEqual(["a"]);
    expect(r[0].redenen).toEqual(["1 bestand mislukt"]);
    expect(r[0].status).toBe("mislukt");
  });

  it("lists an unfinished draft even when nothing is uploading", () => {
    const r = bouwOpenstaand([], [concept({ id: "d1", straatnaam: "Dam 5" })]);
    expect(r).toHaveLength(1);
    expect(r[0].producten[0].href).toBe("/energielabel?draft=d1");
    expect(r[0].redenen).toEqual(["opname niet afgemaakt"]);
    expect(r[0].status).toBe("open");
    expect(r[0].pct).toBeNull();
  });

  it("flags an upload whose attachments never reached ClickUp", () => {
    const r = bouwOpenstaand(
      [],
      [
        concept({
          id: "d2",
          status: "uploaded",
          straatnaam: "Dam 5",
          incompleteDocs: ["D5 Algemene foto's"],
        }),
      ]
    );
    expect(r[0].redenen.join(" ")).toContain("bijlages ontbreken");
  });

  // Zonder samenvoegen zou hetzelfde adres twee regels krijgen: één voor de
  // lopende bestanden en één voor het halve formulier.
  it("merges a draft into the upload row for the same address", () => {
    const r = bouwOpenstaand(
      [taak({ id: "a", folderPath: LABEL, pct: 30 })],
      [concept({ id: "d3", straatnaam: "Dam 5" })]
    );

    expect(r).toHaveLength(1);
    expect(r[0].pct).toBe(30);
    // Het draft-id wint als bestemming: dat brengt je terug in het formulier.
    expect(r[0].producten[0].href).toBe("/energielabel?draft=d3");
    // Twee redenen blijven twee losse punten i.p.v. één geplakte regel.
    expect(r[0].redenen).toEqual(["1 van 1 bestand nog bezig", "opname niet afgemaakt"]);
  });

  it("does not merge addresses that only look alike", () => {
    const r = bouwOpenstaand(
      [taak({ id: "a", folderPath: LABEL, pct: 30 })],
      [concept({ id: "d4", straatnaam: "Dam 50" })]
    );
    expect(r).toHaveLength(2);
  });

  it("puts running uploads first, then failures, then drafts", () => {
    const r = bouwOpenstaand(
      [
        taak({ id: "a", folderPath: "/Automatie NEN2580/Bakstraat 2, Utrecht", dropbox: "error" }),
        taak({ id: "b", folderPath: LABEL, pct: 15 }),
      ],
      [concept({ id: "d5", straatnaam: "Zandpad 9" })]
    );
    expect(r.map((x) => x.adres)).toEqual(["Dam 5, Amsterdam", "Bakstraat 2, Utrecht", "Zandpad 9"]);
  });

  it("treats a draft with a Mediatask order as NEN work", () => {
    const r = bouwOpenstaand([], [concept({ id: "d6", straatnaam: "Dam 5", heeftMediatask: true })]);
    expect(soorten(r[0])).toEqual(["nen"]);
  });
});

describe("producten en gebruikers", () => {
  it("recognises the media folder as its own product", () => {
    expect(soortUitPad("/Automatie Media/Dam 5, Amsterdam")).toBe("media");
    expect(soortUitPad("/Automatie NEN2580/Dam 5, Amsterdam")).toBe("nen");
    expect(soortUitPad("/Automatie Energielabels/Dam 5, Amsterdam")).toBe("energielabel");
  });

  it("routes a media upload to the media page", () => {
    const r = bouwOpenstaand([taak({ id: "m", folderPath: "/Automatie Media/Dam 5, Amsterdam" })], null);
    expect(r[0].producten[0].href).toContain("/media?addr=");
  });
});

describe("ontbrekende verplichte velden", () => {
  // Deze codes worden bij het opslaan van de opname vastgelegd; de lijst
  // rekent ze niet meer zelf uit en heeft de formulierstaat dus niet nodig.
  it("names the fields that still need filling in", () => {
    const r = bouwOpenstaand(
      [],
      [concept({ id: "d1", straatnaam: "Dam 5", ontbrekendeVelden: ["A7", "B2"] })]
    );
    expect(r[0].ontbrekend).toEqual(["A7", "B2"]);
    expect(r[0].invulHref).toBe("/energielabel?draft=d1");
  });

  it("says nothing when every required field is filled in", () => {
    const r = bouwOpenstaand([], [concept({ id: "d2", straatnaam: "Dam 5", ontbrekendeVelden: [] })]);
    expect(r[0].ontbrekend).toEqual([]);
    expect(r[0].invulHref).toBeNull();
  });

  it("stays silent when nothing was recorded", () => {
    const r = bouwOpenstaand([], [concept({ id: "d3", straatnaam: "Dam 5" })]);
    expect(r[0].ontbrekend).toEqual([]);
    expect(r[0].invulHref).toBeNull();
  });

  // Een afgeronde opname hoort geen "nog invullen" te tonen, ook niet als er
  // ooit iets is vastgelegd.
  it("does not claim missing fields for an already uploaded opname", () => {
    const r = bouwOpenstaand(
      [],
      [
        concept({
          id: "d4",
          status: "uploaded",
          straatnaam: "Dam 5",
          incompleteDocs: ["D5"],
          ontbrekendeVelden: ["A7"],
        }),
      ]
    );
    expect(r[0].ontbrekend).toEqual([]);
  });
});

describe("adviseur op de tag", () => {
  // Het scenario dat het misging: ingelogd als de een, opname op naam van de
  // ander. De tag noemde dan de verkeerde persoon.
  it("names the adviseur from the opname, not the logged-in user", () => {
    const r = bouwOpenstaand(
      [],
      [concept({ id: "d1", straatnaam: "Dam 5", accountName: "Floris de Laat", adviseur: "Y. Bakker" })]
    );
    expect(r[0].gebruiker).toBe("Y. Bakker");
  });

  it("falls back to the logged-in user when no adviseur was recorded", () => {
    const r = bouwOpenstaand(
      [],
      [concept({ id: "d2", straatnaam: "Dam 5", accountName: "Floris de Laat" })]
    );
    expect(r[0].gebruiker).toBe("Floris de Laat");
  });

  it("overrides the name carried by the upload queue", () => {
    const r = bouwOpenstaand(
      [taak({ id: "a", folderPath: LABEL, account: "Floris de Laat" })],
      [concept({ id: "d4", straatnaam: "Dam 5", accountName: "Floris de Laat", adviseur: "Y. Bakker" })]
    );
    expect(r[0].gebruiker).toBe("Y. Bakker");
  });
});
