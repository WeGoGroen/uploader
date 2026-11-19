import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Stoppen tijdens het uploaden: de lopende verbinding moet echt dicht, de
 * regel moet weg, en er mag daarna niets opnieuw starten (geen herkansing,
 * geen terugvalweg).
 */
class NepXhr {
  static alle: NepXhr[] = [];
  upload: { onprogress: ((e: unknown) => void) | null; onloadend: (() => void) | null } = {
    onprogress: null,
    onloadend: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;
  status = 0;
  responseText = "";
  afgebroken = false;
  url = "";
  constructor() {
    NepXhr.alle.push(this);
  }
  open(_m: string, url: string) {
    this.url = url;
  }
  setRequestHeader() {}
  getResponseHeader() {
    return null;
  }
  send() {}
  abort() {
    this.afgebroken = true;
    this.onabort?.();
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  NepXhr.alle = [];
});

describe("stopUpload", () => {
  it("aborts the running request and starts nothing new", async () => {
    vi.stubGlobal("XMLHttpRequest", NepXhr);
    const fetchNep = vi.fn(async (url: string) => {
      if (url === "/api/dropbox/upload-link") {
        return new Response(JSON.stringify({ links: { "/p/In/Raw/Photo's/a.jpg": "https://upload.example/x" } }));
      }
      return new Response(JSON.stringify({ files: [] }));
    });
    vi.stubGlobal("fetch", fetchNep);

    const q = await import("./upload-queue");
    const file = new File([new Uint8Array(10)], "a.jpg", { type: "image/jpeg" });
    q.enqueue("/p", "In/Raw/Photo's", file);

    // Wachten tot de upload echt verstuurd wordt.
    await vi.waitFor(() => expect(NepXhr.alle.length).toBe(1));
    const id = q.getSnapshot()[0].id;

    q.stopUpload(id);
    expect(NepXhr.alle[0].afgebroken).toBe(true);
    expect(q.getSnapshot()).toHaveLength(0);

    // Even laten doorlopen: geen herkansing en geen terugval via de server.
    await new Promise((r) => setTimeout(r, 50));
    expect(NepXhr.alle).toHaveLength(1);
    expect(fetchNep.mock.calls.map((c) => c[0])).not.toContain("/api/dropbox/upload-file");
  });
});
