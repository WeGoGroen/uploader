import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Safari op de iPad laat IndexedDB soms hangen: open() geeft nooit onsuccess
 * en nooit onerror. De upload wachtte daarop en bleef voor altijd op "bezig"
 * staan bij Dropbox. De opslag moet dan na een paar seconden opgeven.
 */
describe("upload-store bij een hangende IndexedDB", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("geeft op in plaats van de upload te laten wachten", async () => {
    vi.useFakeTimers();
    // Een open() die nooit iets terugmeldt.
    vi.stubGlobal("indexedDB", { open: () => ({}) });
    const { bewaarUploadSessie, leesUploadSessie } = await import("./upload-store");

    const bewaren = bewaarUploadSessie({ id: "x", sessionId: "s", chunkSize: 4, klaar: [] });
    const lezen = leesUploadSessie("x");
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(bewaren).resolves.toBeUndefined();
    await expect(lezen).resolves.toBeNull();
  });
});
