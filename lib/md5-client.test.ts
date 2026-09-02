import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { berekenMd5 } from "./md5-client";

// De uitkomst moet byte-voor-byte gelijk zijn aan wat de server (node:crypto)
// zou berekenen: S3 vergelijkt de twee indirect met elkaar, en een verschil
// betekent dat élke scanupload met client-hash geweigerd wordt.
describe("berekenMd5", () => {
  it("geeft dezelfde base64-MD5 als node:crypto", async () => {
    const inhoud = new Uint8Array(3 * 1024 * 1024);
    for (let i = 0; i < inhoud.length; i++) inhoud[i] = (i * 31 + 7) % 256;
    const file = new File([inhoud], "scan.ply");

    const uitkomst = await berekenMd5(file);
    const verwacht = createHash("md5").update(inhoud).digest("base64");

    expect(uitkomst.checksum).toBe(verwacht);
    expect(uitkomst.grootte).toBe(inhoud.length);
  });

  it("hasht ook over de blokgrens heen correct", async () => {
    // Groter dan één leesblok van 8MB, zodat het samenvoegen van blokken
    // aantoonbaar klopt — dáár zou een fout in de chunking zich verstoppen.
    const inhoud = new Uint8Array(9 * 1024 * 1024);
    for (let i = 0; i < inhoud.length; i++) inhoud[i] = (i * 13 + 5) % 256;
    const file = new File([inhoud], "groot.ply");

    const uitkomst = await berekenMd5(file);
    expect(uitkomst.checksum).toBe(createHash("md5").update(inhoud).digest("base64"));
  });
});
