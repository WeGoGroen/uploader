import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Wat hier getoetst wordt is de reactie op een weigering, niet het uploaden
 * zelf — en juist dáár ging het mis bij Balboastraat 12-3.
 *
 * Mediatask antwoordde met 403 op het aanmelden van de puntenwolk (dat doet
 * een order die geen concept meer is). De code las dat als "misschien klopte
 * de hash niet", haalde de hele scan opnieuw door Dropbox om te hashen, kreeg
 * exact dezelfde 403 terug, en deed dat voor elk bestand opnieuw. Eén oorzaak,
 * minutenlang wachten, en een scherm vol foutmeldingen.
 *
 * De Mediatask-kant loopt hier bewust door de échte client heen — alleen het
 * netwerk is nagebootst. Zo toetst dit ook of de statuscode goed vertaald
 * wordt en of de uitleg uit de toestand van de order gehaald wordt, en niet
 * alleen of er ergens een vlag omgaat.
 */

const dropbox = vi.hoisted(() => ({
  getSharedAccessToken: vi.fn(),
  listFolderFiles: vi.fn(),
  openFileStream: vi.fn(),
}));

vi.mock("@/lib/dropbox", () => dropbox);
vi.mock("@/lib/redis", () => ({ getOptionalRedis: () => null, requireRedis: () => null }));

const { stuurScanVanuitDropbox, stuurScansVanuitDropbox } = await import("@/lib/mediatask-pointclouds");

const BASIS = "https://mediatask.test";

/** Een leesbare stroom van een paar bytes, zoals openFileStream teruggeeft. */
function nepBestand(bytes = 8) {
  return {
    size: bytes,
    stream: new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(bytes));
        c.close();
      },
    }),
  };
}

function antwoord(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    json: async () => body,
  };
}

/**
 * Nagebootste Mediatask + S3. `orderState` bepaalt wat een order-GET zegt;
 * `aanmelden` wat het aanmelden van een puntenwolk (PATCH) antwoordt.
 */
function nepNetwerk(opties: { orderState?: string; aanmelden?: () => unknown } = {}) {
  const aanroepen: string[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const methode = init?.method ?? "GET";
    aanroepen.push(`${methode} ${url}`);
    if (!url.startsWith(BASIS)) return antwoord(200, {}); // de S3-PUT
    const pad = url.slice(BASIS.length);
    if (methode === "PATCH" && /^\/api\/orders\/\d+$/.test(pad)) {
      const uit = opties.aanmelden?.() ?? antwoord(403, {});
      return uit;
    }
    if (methode === "POST" && pad.endsWith("/pointclouds/attach")) return antwoord(200, { message: "ok" });
    if (methode === "GET" && pad.endsWith("/pointclouds")) return antwoord(200, []);
    if (methode === "GET" && /^\/api\/orders\/\d+$/.test(pad)) {
      return antwoord(200, { id: 7, state: opties.orderState ?? "submitted" });
    }
    return antwoord(404, {});
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, aanroepen };
}

const AANMELDEN = (id = 42) =>
  antwoord(200, {
    pointclouds: [
      { url: "https://s3.test/put", headers: {}, blob_id: "b1", filename: "12 3.dp", pointcloud_id: id },
    ],
  });

beforeEach(() => {
  vi.clearAllMocks();
  process.env.MEDIATASK_API_TOKEN = "test-token";
  process.env.MEDIATASK_API_BASE = BASIS;
  dropbox.getSharedAccessToken.mockResolvedValue("dbx-token");
  dropbox.openFileStream.mockImplementation(async () => nepBestand());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("stuurScanVanuitDropbox", () => {
  it("haalt de scan niet nóg een keer door Dropbox als Mediatask hem weigert", async () => {
    const { aanroepen } = nepNetwerk();

    await expect(
      stuurScanVanuitDropbox(7, "/map/Optimized/12 3.dp", "dbx-token", { checksum: "abc", grootte: 8 })
    ).rejects.toThrow(/403/);

    // Eén aanmeldpoging, en geen enkele doorgang door Dropbox: opnieuw hashen
    // levert alleen dezelfde weigering op, en kost bij een scan van honderden
    // MB's minuten.
    expect(aanroepen.filter((a) => a.startsWith("PATCH"))).toHaveLength(1);
    expect(dropbox.openFileStream).not.toHaveBeenCalled();
  });

  it("noemt het endpoint dat weigerde, zodat een 403 na te lopen is", async () => {
    nepNetwerk();
    await expect(
      stuurScanVanuitDropbox(7, "/map/Optimized/12 3.dp", "dbx-token", { checksum: "abc", grootte: 8 })
    ).rejects.toThrow("PATCH /api/orders/7");
  });

  it("probeert het bij een storing wél opnieuw met een verse hash", async () => {
    let poging = 0;
    const { aanroepen } = nepNetwerk({
      aanmelden: () => (++poging === 1 ? antwoord(503, "") : AANMELDEN()),
    });

    const uitkomst = await stuurScanVanuitDropbox(7, "/map/Optimized/12 3.dp", "dbx-token", {
      checksum: "abc",
      grootte: 8,
    });

    expect(uitkomst.pointcloudId).toBe(42);
    expect(aanroepen.filter((a) => a.startsWith("PATCH"))).toHaveLength(2);
    // Doorgang 1 om te hashen, doorgang 2 om te versturen.
    expect(dropbox.openFileStream).toHaveBeenCalledTimes(2);
  });
});

describe("stuurScansVanuitDropbox", () => {
  it("meldt één oorzaak in plaats van per scan opnieuw te proberen", async () => {
    dropbox.listFolderFiles.mockResolvedValue([
      { name: "12 3.dp" },
      { name: "12 3 zolder.dp" },
      { name: "12 3 kelder.dp" },
    ]);
    const { aanroepen } = nepNetwerk({ orderState: "submitted" });

    const uitkomsten = await stuurScansVanuitDropbox(7, "/map");

    expect(uitkomsten).toHaveLength(3);
    expect(uitkomsten.every((u) => !u.ok && u.definitief)).toBe(true);
    // De reden komt uit de toestand van de order, niet uit de kale statuscode.
    expect(uitkomsten[0].fout).toContain('staat bij Mediatask op "submitted"');
    // Alle drie krijgen dezelfde tekst, zodat het scherm er één regel van kan
    // maken in plaats van drie identieke.
    expect(new Set(uitkomsten.map((u) => u.fout)).size).toBe(1);
    // En alleen de eerste scan is echt geprobeerd. Die ene doorgang door
    // Dropbox is niet te vermijden: Mediatask wil de checksum hebben vóór hij
    // zegt of hij het bestand aanneemt, en die checksum komt uit het bestand.
    // Het gaat erom dat het bij die ene blijft — vroeger deed elke scan het
    // hele rondje nog eens over.
    expect(aanroepen.filter((a) => a.startsWith("PATCH"))).toHaveLength(1);
    expect(dropbox.openFileStream).toHaveBeenCalledTimes(1);
  });

  it("valt terug op de korte melding als de order gewoon een concept is", async () => {
    dropbox.listFolderFiles.mockResolvedValue([{ name: "12 3.dp" }]);
    nepNetwerk({ orderState: "draft" });

    const [uitkomst] = await stuurScansVanuitDropbox(7, "/map");

    expect(uitkomst.ok).toBe(false);
    expect(uitkomst.fout).toContain("403");
  });

  it("laat een fout aan één bestand de rest niet tegenhouden", async () => {
    dropbox.listFolderFiles.mockResolvedValue([{ name: "weg.dp" }, { name: "goed.dp" }]);
    dropbox.openFileStream.mockImplementation(async (_t: string, pad: string) => {
      if (pad.endsWith("weg.dp")) throw new Error("Dropbox files/download failed: 409 {path/not_found}");
      return nepBestand();
    });
    nepNetwerk({ aanmelden: () => AANMELDEN() });

    const uitkomsten = await stuurScansVanuitDropbox(7, "/map");

    expect(uitkomsten[0]).toMatchObject({ naam: "weg.dp", ok: false });
    expect(uitkomsten[0].fout).toBe("het bestand staat niet meer in Dropbox");
    expect(uitkomsten[0].definitief).toBeFalsy();
    expect(uitkomsten[1]).toMatchObject({ naam: "goed.dp", ok: true });
  });
});
