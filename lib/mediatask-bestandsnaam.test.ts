import { describe, expect, it } from "vitest";
import { naamUitDisposition, naamUitUrl } from "./mediatask-bestandsnaam";

const S3 = "https://mediatask-bucket.s3.eu-west-1.amazonaws.com/orders/123/abcdef";

function link(disposition: string): string {
  return `${S3}?X-Amz-Expires=3600&response-content-disposition=${encodeURIComponent(disposition)}&X-Amz-Signature=xyz`;
}

/**
 * Een naam die hier niet herkend wordt, telt als "nog niet aanwezig" en gaat
 * dus opnieuw naar Mediatask. Vandaar vooral de namen met spaties en accenten.
 */
describe("naamUitUrl", () => {
  it("reads a plain file name", () => {
    expect(naamUitUrl(link('attachment; filename="IMG_0001.jpg"'))).toBe("IMG_0001.jpg");
  });

  it("reads a name with spaces", () => {
    expect(naamUitUrl(link('attachment; filename="Voorgevel links 2.jpg"'))).toBe("Voorgevel links 2.jpg");
  });

  it("reads a name with non-ASCII characters in the extended form", () => {
    expect(
      naamUitUrl(link("attachment; filename=\"Voorgevel o.jpg\"; filename*=UTF-8''Voorgevel%20%C3%B6.jpg"))
    ).toBe("Voorgevel ö.jpg");
  });

  it("reads an unquoted name", () => {
    expect(naamUitUrl(link("attachment; filename=scan_01.e57"))).toBe("scan_01.e57");
  });

  it("returns null without a name, unless asked to fall back on the path", () => {
    expect(naamUitUrl(`${S3}/Dam%205.jpg?X-Amz-Expires=3600`)).toBeNull();
    expect(naamUitUrl(`${S3}/Dam%205.jpg?X-Amz-Expires=3600`, { terugvalOpPad: true })).toBe("Dam 5.jpg");
  });

  it("does not throw on a malformed link", () => {
    expect(naamUitUrl("niet-een-url filename%3D%22a%20b.jpg%22")).toBe("a b.jpg");
    expect(naamUitUrl("%E0%A4%A", { terugvalOpPad: true })).toBe("%E0%A4%A");
  });
});

describe("naamUitDisposition", () => {
  it("falls back to the plain form when the extended form is broken", () => {
    expect(naamUitDisposition("attachment; filename=\"a.jpg\"; filename*=UTF-8''%E0%A4%A")).toBe("a.jpg");
  });
});
