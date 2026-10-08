import { afterEach, describe, expect, it, vi } from "vitest";
import { serverFetch, wachtNa429 } from "./server-fetch";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function antwoord(status: number, headers: Record<string, string> = {}) {
  return new Response(status === 204 ? null : "{}", { status, headers });
}

describe("serverFetch", () => {
  it("retries a 429 and returns the later answer", async () => {
    const nep = vi.fn().mockResolvedValueOnce(antwoord(429, { "retry-after": "0" })).mockResolvedValueOnce(antwoord(200));
    vi.stubGlobal("fetch", nep);
    const res = await serverFetch("https://api.dropboxapi.com/2/files/list_folder", {
      method: "POST",
      body: JSON.stringify({ path: "/x" }),
    });
    expect(res.status).toBe(200);
    expect(nep).toHaveBeenCalledTimes(2);
  });

  it("gives up after two retries and returns the 429", async () => {
    const nep = vi.fn().mockImplementation(async () => antwoord(429, { "retry-after": "0" }));
    vi.stubGlobal("fetch", nep);
    const res = await serverFetch("https://api.clickup.com/api/v2/task", { method: "POST", body: "{}" });
    expect(res.status).toBe(429);
    expect(nep).toHaveBeenCalledTimes(3);
  });

  it("does not repeat a 5xx: it may have been carried out", async () => {
    const nep = vi.fn().mockResolvedValue(antwoord(503));
    vi.stubGlobal("fetch", nep);
    const res = await serverFetch("https://api.clickup.com/api/v2/task", { method: "POST", body: "{}" });
    expect(res.status).toBe(503);
    expect(nep).toHaveBeenCalledTimes(1);
  });

  it("does not repeat when the body is a stream", async () => {
    const nep = vi.fn().mockResolvedValue(antwoord(429, { "retry-after": "0" }));
    vi.stubGlobal("fetch", nep);
    const stream = new ReadableStream({ start: (c) => c.close() });
    await serverFetch("https://api.dropboxapi.com/x", { method: "POST", body: stream });
    expect(nep).toHaveBeenCalledTimes(1);
  });

  it("adds a time limit to API calls but not to file traffic", async () => {
    const nep = vi.fn().mockResolvedValue(antwoord(200));
    vi.stubGlobal("fetch", nep);
    await serverFetch("https://api.dropboxapi.com/2/files/list_folder", { method: "POST" });
    await serverFetch("https://content.dropboxapi.com/2/files/download", { method: "POST" });
    expect(nep.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    expect(nep.mock.calls[1][1].signal).toBeUndefined();
  });

  it("keeps a signal the caller passed", async () => {
    const nep = vi.fn().mockResolvedValue(antwoord(200));
    vi.stubGlobal("fetch", nep);
    const eigen = new AbortController().signal;
    await serverFetch("https://api.dropboxapi.com/x", { signal: eigen });
    expect(nep.mock.calls[0][1].signal).toBe(eigen);
  });
});

describe("wachtNa429", () => {
  it("follows Retry-After in seconds, capped", () => {
    expect(wachtNa429("3", 0)).toBe(3000);
    expect(wachtNa429("600", 0)).toBe(10_000);
  });

  it("backs off without a header", () => {
    expect(wachtNa429(null, 0)).toBe(1000);
    expect(wachtNa429(null, 1)).toBe(2000);
  });
});
