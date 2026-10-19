import { describe, expect, it } from "vitest";
import { DropboxApiError, isTeVeelSchrijven, retryAfterUit } from "./dropbox";

// De melding zoals Dropbox hem op 19 oktober gaf bij Pieter Postsingel 49.
const MELDING =
  'Dropbox save_url/check_job_status failed: 429 {"error_summary":"too_many_requests/..","error":{"reason":{".tag":"too_many_requests"},"retry_after":10}}';

describe("te druk bij Dropbox", () => {
  it("herkent too_many_requests van check_job_status", () => {
    expect(isTeVeelSchrijven(new DropboxApiError(429, MELDING))).toBe(true);
    expect(isTeVeelSchrijven(new Error(MELDING))).toBe(true);
  });

  it("haalt de retry_after eruit", () => {
    expect(retryAfterUit(MELDING)).toBe(10);
    expect(retryAfterUit("oplevering gaf 500")).toBeNull();
  });

  it("een gewone fout is niet te druk", () => {
    expect(isTeVeelSchrijven(new DropboxApiError(409, "path/conflict"))).toBe(false);
  });
});
