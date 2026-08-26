import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Deze tests gaan over de vraag "komen de foto's compleet en niet dubbel in
 * ClickUp terecht". Twee fouten zaten hier eerder in:
 *
 *  1. Elke poging begon weer bij bestand één, terwijl het tijdsbudget steeds op
 *     dezelfde plek afkapte — de laatste foto's kwamen dus nooit aan de beurt.
 *  2. Het ClickUp-veld wordt aangevuld en niet overschreven, dus die
 *     opnieuw-geüploade kopfoto's kwamen er dubbel in te staan.
 */

const listFolderFiles = vi.fn();
const downloadFile = vi.fn();
const uploadCustomFieldAttachment = vi.fn();
const setAttachmentFieldValue = vi.fn();

vi.mock("./clickup", () => ({
  getTeams: async () => [{ id: "team1" }],
  getListCustomFields: async () => [{ id: "veld-d5", name: "D5 Algemene foto's" }],
  uploadCustomFieldAttachment: (...a: unknown[]) => uploadCustomFieldAttachment(...a),
  setAttachmentFieldValue: (...a: unknown[]) => setAttachmentFieldValue(...a),
}));

vi.mock("./dropbox", () => ({
  getSharedAccessToken: async () => "dbx",
  downloadFile: (...a: unknown[]) => downloadFile(...a),
  listFolderFiles: (...a: unknown[]) => listFolderFiles(...a),
}));

const { attachOneDocument } = await import("./attachments");

function fotos(n: number) {
  return Array.from({ length: n }, (_, i) => ({ name: `foto-${i + 1}.jpg`, size: 1000 }));
}

/** Namen van de bestanden die daadwerkelijk naar ClickUp geüpload zijn. */
function geuploadeNamen(): string[] {
  return uploadCustomFieldAttachment.mock.calls.map((c) => c[3] as string);
}

beforeEach(() => {
  vi.useFakeTimers();
  downloadFile.mockResolvedValue(new Blob(["x"]));
  let n = 0;
  uploadCustomFieldAttachment.mockImplementation(async () => ({ id: `att-${++n}` }));
  setAttachmentFieldValue.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("attachOneDocument", () => {
  it("attaches every photo and reports where it stopped", async () => {
    listFolderFiles.mockResolvedValue(fotos(3));

    const r = await attachOneDocument("t", "lijst", "taak", "/map", "D5");

    expect(r).toMatchObject({ fileCount: 3, gelukt: 3, mislukt: [], afgekapt: false, volgendeSkip: 3 });
    expect(geuploadeNamen()).toEqual(["foto-1.jpg", "foto-2.jpg", "foto-3.jpg"]);
  });

  it("resumes at skip instead of starting over", async () => {
    listFolderFiles.mockResolvedValue(fotos(5));

    const r = await attachOneDocument("t", "lijst", "taak", "/map", "D5", { skip: 3 });

    // Alleen de staart, en geen enkele foto voor de tweede keer.
    expect(geuploadeNamen()).toEqual(["foto-4.jpg", "foto-5.jpg"]);
    expect(r.volgendeSkip).toBe(5);
    expect(r.afgekapt).toBe(false);
  });

  // De kern van de oude fout: bij afkappen moest de vervolgpoging verder
  // kunnen, anders bleef dezelfde staart eeuwig liggen.
  it("covers all photos across truncated attempts, uploading each exactly once", async () => {
    listFolderFiles.mockResolvedValue(fotos(7));
    // Ruim genoeg per upload om het tijdsbudget hoe dan ook te raken, welk
    // budget de route ook heeft. Eerder stond hier 20s tegen een grens van
    // 45s; toen die grens naar 240s ging kapte er niets meer af en testte
    // deze zaak stilletjes niets meer.
    uploadCustomFieldAttachment.mockImplementation(async () => {
      vi.advanceTimersByTime(120_000);
      return { id: "att" };
    });

    let skip = 0;
    let rondes = 0;
    for (;;) {
      const r = await attachOneDocument("t", "lijst", "taak", "/map", "D5", { skip });
      skip = r.volgendeSkip;
      rondes++;
      if (!r.afgekapt) break;
      expect(rondes).toBeLessThan(10);
    }

    const namen = geuploadeNamen();
    expect(namen).toEqual(fotos(7).map((f) => f.name));
    expect(new Set(namen).size).toBe(7); // niets dubbel
    expect(rondes).toBeGreaterThan(1); // er is echt afgekapt en hervat
  });

  it("retries only the named files, leaving the rest untouched", async () => {
    listFolderFiles.mockResolvedValue(fotos(5));

    const r = await attachOneDocument("t", "lijst", "taak", "/map", "D5", {
      only: ["foto-2.jpg", "foto-4.jpg"],
    });

    expect(geuploadeNamen()).toEqual(["foto-2.jpg", "foto-4.jpg"]);
    expect(r.gelukt).toBe(2);
  });

  it("keeps the successful files when one photo fails", async () => {
    listFolderFiles.mockResolvedValue(fotos(3));
    uploadCustomFieldAttachment.mockImplementation(async (...a: unknown[]) => {
      if (a[3] === "foto-2.jpg") throw Object.assign(new Error("te groot"), { status: 400 });
      return { id: "att" };
    });

    const r = await attachOneDocument("t", "lijst", "taak", "/map", "D5");

    expect(r.mislukt).toEqual(["foto-2.jpg"]);
    expect(r.gelukt).toBe(2);
    // De twee geslaagde zijn wél vastgezet op het veld.
    expect(setAttachmentFieldValue).toHaveBeenCalledOnce();
  });

  it("does not touch the field when the folder is empty", async () => {
    listFolderFiles.mockResolvedValue([]);

    const r = await attachOneDocument("t", "lijst", "taak", "/map", "D5");

    expect(r).toMatchObject({ fileCount: 0, gelukt: 0, afgekapt: false });
    expect(setAttachmentFieldValue).not.toHaveBeenCalled();
  });

  it("does not run past the end of the list when skip is too high", async () => {
    listFolderFiles.mockResolvedValue(fotos(2));

    const r = await attachOneDocument("t", "lijst", "taak", "/map", "D5", { skip: 99 });

    expect(geuploadeNamen()).toEqual([]);
    expect(r.afgekapt).toBe(false);
    expect(r.volgendeSkip).toBe(2);
  });
});
