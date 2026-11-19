import { describe, expect, it } from "vitest";
import { leesOpmerkingVol, lijstUit, opmerkingenUit, tijdUit, vindAccount, zonderHtml } from "@/lib/mediatask-opmerkingen";
import type { ClickUpAccount } from "@/lib/clickup";

describe("opmerkingenUit", () => {
  it("leest een lijst en een ingepakte lijst", () => {
    expect(lijstUit([1])).toEqual([1]);
    expect(lijstUit({ comments: [1] })).toEqual([1]);
    expect(lijstUit({ data: [2] })).toEqual([2]);
    expect(lijstUit(null)).toEqual([]);
  });

  it("haalt tekst, schrijver en tijd uit de gangbare velden, oudste eerst", () => {
    const uit = opmerkingenUit(
      [
        { id: 2, comment: "tweede", user: { id: 7, full_name: "Kasia W." }, created_at: "2026-11-02T09:43:00Z" },
        { id: 1, body: "eerste", author: "Tomasz", created_at: "2026-11-01T10:00:00Z" },
        { id: 3, comment: "   " },
      ],
      100
    );
    expect(uit.map((o) => o.tekst)).toEqual(["eerste", "tweede"]);
    expect(uit[1]).toMatchObject({ id: "2", door: "Kasia W.", doorId: 7 });
    expect(uit[0]).toMatchObject({ door: "Tomasz", doorId: null });
  });

  it("geeft een vaste vingerafdruk als Mediatask geen id stuurt", () => {
    const a = leesOpmerkingVol({ comment: "x", created_at: "t" }, 5);
    const b = leesOpmerkingVol({ comment: "x", created_at: "t" }, 5);
    const c = leesOpmerkingVol({ comment: "x", created_at: "t" }, 6);
    expect(a?.id).toBe(b?.id);
    expect(a?.id).not.toBe(c?.id);
  });
});

describe("vindAccount", () => {
  const accounts = [
    { name: "Floris de Laat", token: "a", email: "floris@wegogroen.nl" },
    { name: "Jelle Jansen", token: "b" },
    { name: "Jelle Pieters", token: "c" },
    { name: "Nicette Bos", token: "d" },
  ] as ClickUpAccount[];

  it("zoekt eerst op e-mail", () => {
    expect(vindAccount(accounts, { email: "FLORIS@wegogroen.nl", naam: "iets anders" })?.name).toBe("Floris de Laat");
  });
  it("dan op volledige naam, dan op een unieke voornaam", () => {
    expect(vindAccount(accounts, { naam: "jelle pieters" })?.name).toBe("Jelle Pieters");
    expect(vindAccount(accounts, { naam: "Nicette" })?.name).toBe("Nicette Bos");
  });
  it("kiest niet bij een dubbele voornaam", () => {
    expect(vindAccount(accounts, { naam: "Jelle" })).toBeNull();
  });
});

describe("zoals Mediatask het live stuurt", () => {
  it("maakt platte tekst van hun HTML", () => {
    expect(zonderHtml("<div>Hi,<br>Please check &amp; confirm</div><div>Thanks</div>")).toBe("Hi,\nPlease check & confirm\nThanks");
    expect(zonderHtml("gewoon")).toBe("gewoon");
  });
  it("leest de tijd uit timestamps, in elke vorm", () => {
    expect(tijdUit({ timestamps: { created_at: "2026-11-02T09:41:00Z" } })).toBe("2026-11-02T09:41:00.000Z");
    expect(tijdUit({ timestamps: "2026-11-02 09:41:00+00" })).toBe("2026-11-02T09:41:00.000Z");
    expect(tijdUit({ timestamps: 1793612460 })).toBe(new Date(1793612460000).toISOString());
    expect(tijdUit({ timestamps: ["2026-11-02T09:41:00Z", "2026-11-02T10:00:00Z"] })).toBe("2026-11-02T09:41:00.000Z");
    expect(tijdUit({ timestamps: null })).toBeNull();
  });
  it("sorteert zonder tijd op het oplopende Mediatask-id", () => {
    const uit = opmerkingenUit(
      [
        { id: 884300, comment: "b", author: "Floris de Laat", username: "floris" },
        { id: 883529, comment: "a", author: "Floris de Laat", username: "floris" },
      ],
      1
    );
    expect(uit.map((o) => o.tekst)).toEqual(["a", "b"]);
    expect(uit[0].door).toBe("Floris de Laat");
  });
});
