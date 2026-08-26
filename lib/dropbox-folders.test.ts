import { afterEach, describe, expect, it, vi } from "vitest";
import { summarizeProjectFolders } from "./dropbox";

/**
 * De ochtendcontrole gebruikt dit om verweesde (lege) projectmappen te vinden.
 * Een fout in het uitsplitsen van paden zou stille valse meldingen geven, dus
 * die logica staat hier vast met een nagebootste Dropbox-respons.
 */

const ROOT = "/Automatie NEN2580";

function entry(tag: "file" | "folder", path: string, name?: string) {
  return { ".tag": tag, name: name ?? path.split("/").pop()!, path_lower: path.toLowerCase() };
}

function stubFetch(pages: { entries: unknown[]; has_more: boolean; cursor: string }[]) {
  let i = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => pages[i++],
    }))
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("summarizeProjectFolders", () => {
  it("counts files per project folder, including files in subfolders", async () => {
    stubFetch([
      {
        entries: [
          entry("folder", `${ROOT}/Damrak 1, Amsterdam`),
          entry("folder", `${ROOT}/Damrak 1, Amsterdam/Optimized`),
          entry("file", `${ROOT}/Damrak 1, Amsterdam/Optimized/scan.laz`),
          entry("file", `${ROOT}/Damrak 1, Amsterdam/Photo's/voor.jpg`),
        ],
        has_more: false,
        cursor: "",
      },
    ]);

    const { folders, volledig } = await summarizeProjectFolders("t", ROOT);
    expect(volledig).toBe(true);
    expect(folders).toEqual([{ name: "Damrak 1, Amsterdam", files: 2 }]);
  });

  // Dit is het geval waar de controle voor bestaat: een map die is aangemaakt
  // onder een adres dat daarna nog gecorrigeerd werd, blijft leeg achter.
  it("reports a folder with only empty subfolders as having no files", async () => {
    stubFetch([
      {
        entries: [
          entry("folder", `${ROOT}/Dam 1, Amsterdam`),
          entry("folder", `${ROOT}/Dam 1, Amsterdam/Optimized`),
          entry("folder", `${ROOT}/Dam 1, Amsterdam/RAW`),
          entry("folder", `${ROOT}/Dam 1A, Amsterdam`),
          entry("file", `${ROOT}/Dam 1A, Amsterdam/RAW/scan.laz`),
        ],
        has_more: false,
        cursor: "",
      },
    ]);

    const { folders } = await summarizeProjectFolders("t", ROOT);
    expect(folders.find((f) => f.name === "Dam 1, Amsterdam")!.files).toBe(0);
    expect(folders.find((f) => f.name === "Dam 1A, Amsterdam")!.files).toBe(1);
  });

  it("keeps counting across pagination", async () => {
    stubFetch([
      {
        entries: [
          entry("folder", `${ROOT}/Damrak 1, Amsterdam`),
          entry("file", `${ROOT}/Damrak 1, Amsterdam/RAW/a.laz`),
        ],
        has_more: true,
        cursor: "c1",
      },
      {
        entries: [entry("file", `${ROOT}/Damrak 1, Amsterdam/RAW/b.laz`)],
        has_more: false,
        cursor: "",
      },
    ]);

    const { folders, volledig } = await summarizeProjectFolders("t", ROOT);
    expect(volledig).toBe(true);
    expect(folders).toEqual([{ name: "Damrak 1, Amsterdam", files: 2 }]);
  });

  it("ignores loose files sitting directly in the root", async () => {
    stubFetch([
      {
        entries: [
          entry("file", `${ROOT}/losse-notitie.txt`),
          entry("folder", `${ROOT}/Damrak 1, Amsterdam`),
        ],
        has_more: false,
        cursor: "",
      },
    ]);

    const { folders } = await summarizeProjectFolders("t", ROOT);
    expect(folders).toEqual([{ name: "Damrak 1, Amsterdam", files: 0 }]);
  });

  it("reports an incomplete listing instead of looping forever", async () => {
    // Altijd has_more: true — de noodrem moet ingrijpen.
    const pages = Array.from({ length: 40 }, () => ({
      entries: [entry("folder", `${ROOT}/Damrak 1, Amsterdam`)],
      has_more: true,
      cursor: "c",
    }));
    stubFetch(pages);

    const { volledig } = await summarizeProjectFolders("t", ROOT);
    expect(volledig).toBe(false);
  });

  it("treats a missing root folder as empty rather than an error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 409,
        text: async () => '{"error_summary":"path/not_found/..."}',
      }))
    );

    const { folders, volledig } = await summarizeProjectFolders("t", ROOT);
    expect(folders).toEqual([]);
    expect(volledig).toBe(true);
  });
});
