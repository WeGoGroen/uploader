import { describe, expect, it } from "vitest";
import { pdfBijlagen, type Onderdeel } from "@/lib/postbus";

/**
 * De opbouw van een mail is waar dit stil kan misgaan: de bijlage zit bij RVO
 * een laag dieper dan je zou denken, en alleen op het eerste niveau kijken
 * levert geen foutmelding op maar een mail die overgeslagen wordt.
 */
describe("pdfBijlagen", () => {
  it("vindt de bijlage die naast de tekst hangt", () => {
    const mail: Onderdeel = {
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "text/plain" },
        { filename: "459616729_1072PA_8_H.pdf", body: { attachmentId: "att-1" } },
      ],
    };
    expect(pdfBijlagen(mail)).toEqual([{ id: "att-1", filename: "459616729_1072PA_8_H.pdf" }]);
  });

  it("vindt de bijlage ook een laag dieper", () => {
    const mail: Onderdeel = {
      mimeType: "multipart/mixed",
      parts: [
        {
          mimeType: "multipart/alternative",
          parts: [
            { mimeType: "text/plain" },
            { mimeType: "text/html" },
            { filename: "afschrift.pdf", body: { attachmentId: "att-2" } },
          ],
        },
      ],
    };
    expect(pdfBijlagen(mail)).toEqual([{ id: "att-2", filename: "afschrift.pdf" }]);
  });

  it("laat het logo uit de handtekening liggen", () => {
    const mail: Onderdeel = {
      parts: [
        { filename: "logo.png", body: { attachmentId: "att-3" } },
        { filename: "handtekening.jpg", body: { attachmentId: "att-4" } },
      ],
    };
    expect(pdfBijlagen(mail)).toEqual([]);
  });

  it("slaat een bijlage zonder id over in plaats van te gokken", () => {
    expect(pdfBijlagen({ filename: "afschrift.pdf" })).toEqual([]);
    expect(pdfBijlagen(undefined)).toEqual([]);
  });
});
