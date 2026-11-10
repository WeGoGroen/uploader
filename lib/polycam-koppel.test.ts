import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dropbox = vi.hoisted(() => ({
  getSharedAccessToken: vi.fn(async () => "dbx-token"),
  getMetadata: vi.fn(async (): Promise<object | null> => null),
  saveUrl: vi.fn(async () => ({ done: false, jobId: "job-1" })),
  checkSaveUrlJob: vi.fn(async () => ({ status: "in_progress", error: null as string | null })),
}));
vi.mock("@/lib/dropbox", () => dropbox);

import { POST } from "@/app/api/polycam/koppel/route";

let capture: Record<string, unknown>;
let artefacten: unknown;
const polycamAanroepen: string[] = [];

function verzoek(body: object) {
  return new Request("http://x/api/polycam/koppel", { method: "POST", body: JSON.stringify(body) });
}

const basis = { captureId: "cap1", dropboxPad: "/Automatie Energielabels/Dorpsstraat 12 Zwolle", verdieping: "Begane grond" };

beforeEach(() => {
  process.env.POLYCAM_API_TOKEN = "pc-token";
  capture = { id: "cap1", name: "Scan 10 nov", status: "completed", visibility: "public" };
  artefacten = { artifacts: [] };
  polycamAanroepen.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      polycamAanroepen.push(`${init?.method ?? "GET"} ${url}`);
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer pc-token");
      if (url.endsWith("/captures/cap1")) return Response.json(capture);
      if (url.endsWith("/captures/cap1/export") && (init?.method ?? "GET") === "GET") return Response.json(artefacten);
      if (url.endsWith("/captures/cap1/export")) return Response.json({ jobId: "exp-1" });
      return new Response("nee", { status: 404 });
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("POST /api/polycam/koppel", () => {
  it("wacht zolang de scan nog uploadt, zonder deellink", async () => {
    capture.status = "uploading";
    const res = await (await POST(verzoek(basis))).json();
    expect(res).toMatchObject({ fase: "wacht-upload", deellink: null });
    expect(dropbox.saveUrl).not.toHaveBeenCalled();
  });

  it("start de LAS-export als er nog geen puntenwolk is, en geeft de deellink al", async () => {
    const res = await (await POST(verzoek(basis))).json();
    expect(res).toMatchObject({ fase: "exporteren", exportGestart: true, deellink: "https://poly.cam/capture/cap1" });
    expect(polycamAanroepen.filter((a) => a.startsWith("POST"))).toHaveLength(1);

    // Tweede ronde: niet nog eens exporteren.
    const res2 = await (await POST(verzoek({ ...basis, exportGestart: true }))).json();
    expect(res2.fase).toBe("exporteren");
    expect(polycamAanroepen.filter((a) => a.startsWith("POST"))).toHaveLength(1);
  });

  it("laat Dropbox de LAS ophalen in de map LAZ", async () => {
    artefacten = { artifacts: [{ format: "las", url: "https://cdn.poly.cam/x.las?sig=1" }] };
    const res = await (await POST(verzoek({ ...basis, exportGestart: true }))).json();
    expect(dropbox.saveUrl).toHaveBeenCalledWith(
      "dbx-token",
      "/Automatie Energielabels/Dorpsstraat 12 Zwolle/LAZ/Begane grond - Scan 10 nov.las",
      "https://cdn.poly.cam/x.las?sig=1"
    );
    expect(res).toMatchObject({ fase: "opslaan", saveJobId: "job-1" });
  });

  it("meldt klaar zodra de Dropbox-opdracht af is", async () => {
    dropbox.checkSaveUrlJob.mockResolvedValueOnce({ status: "complete", error: null });
    const res = await (await POST(verzoek({ ...basis, saveJobId: "job-1" }))).json();
    expect(res.fase).toBe("klaar");
  });

  it("slaat niet dubbel op als het bestand er al staat", async () => {
    artefacten = { artifacts: [{ format: "las", url: "https://cdn.poly.cam/x.las" }] };
    dropbox.getMetadata.mockResolvedValueOnce({ name: "x.las" });
    const res = await (await POST(verzoek(basis))).json();
    expect(res.fase).toBe("klaar");
    expect(dropbox.saveUrl).not.toHaveBeenCalled();
  });

  it("zegt dat Polycam niet gekoppeld is zonder token", async () => {
    delete process.env.POLYCAM_API_TOKEN;
    const res = await POST(verzoek(basis));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("niet_ingesteld");
  });
});
