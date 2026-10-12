import { describe, expect, it } from "vitest";
import {
  energielabelStatus,
  nenStatus,
  orderTeltMee,
  recenteClickUpTaak,
  recenteMediataskOrder,
} from "./afspraak-status";

const NU = Date.UTC(2026, 9, 12, 10);
const DAG = 24 * 60 * 60 * 1000;

describe("recenteClickUpTaak", () => {
  it("negeert een taak van vorig jaar op hetzelfde adres", () => {
    const taken = [{ name: "Prinsengracht 12, Amsterdam", created: NU - 400 * DAG }];
    expect(recenteClickUpTaak(taken, "Prinsengracht 12", NU)).toBeNull();
  });

  it("vindt een taak van vandaag", () => {
    const taken = [{ name: "Prinsengracht 12, Amsterdam", created: NU - 2 * 60 * 60 * 1000 }];
    expect(recenteClickUpTaak(taken, "Prinsengracht 12", NU)).not.toBeNull();
  });

  it("telt een taak zonder aanmaakmoment niet mee", () => {
    expect(recenteClickUpTaak([{ name: "Prinsengracht 12", created: null }], "Prinsengracht 12", NU)).toBeNull();
  });
});

describe("orderTeltMee", () => {
  it("afgeronde order zonder ons tijdstempel is van vroeger", () => {
    expect(orderTeltMee({ state: "finished" }, NU)).toBe(false);
  });
  it("lopende order buiten de uploader telt", () => {
    expect(orderTeltMee({ state: "submitted" }, NU)).toBe(true);
  });
  it("order via de uploader telt zolang hij recent is", () => {
    expect(orderTeltMee({ state: "finished", viaUploaderOp: NU - DAG }, NU)).toBe(true);
    expect(orderTeltMee({ state: "draft", viaUploaderOp: NU - 20 * DAG }, NU)).toBe(false);
  });
});

describe("recenteMediataskOrder", () => {
  it("geeft de order via de uploader voorrang", () => {
    const orders = [
      { id: 1, address: "Singel 200, Amsterdam", state: "submitted" },
      { id: 2, address: "Singel 200, Amsterdam", state: "draft", viaUploaderOp: NU - 1000 },
    ];
    expect(recenteMediataskOrder(orders, "Singel 200", NU)?.id).toBe(2);
  });
});

describe("nenStatus", () => {
  it("ingediend via de uploader is geüpload", () => {
    expect(nenStatus({ order: { state: "submitted", viaUploaderOp: NU }, conceptMetOrder: false, handmatig: false })).toBe("geupload");
  });
  it("concept via de uploader is nog niet af", () => {
    expect(nenStatus({ order: { state: "draft", viaUploaderOp: NU }, conceptMetOrder: false, handmatig: false })).toBe("onaf");
  });
  it("order buiten de uploader is elders", () => {
    expect(nenStatus({ order: { state: "submitted" }, conceptMetOrder: false, handmatig: false })).toBe("elders");
  });
  it("handmatig als er niets is", () => {
    expect(nenStatus({ order: null, conceptMetOrder: false, handmatig: true })).toBe("handmatig");
    expect(nenStatus({ order: null, conceptMetOrder: false, handmatig: false })).toBeNull();
  });
});

describe("energielabelStatus", () => {
  const leeg = { taak: null, conceptGeupload: false, bijlagesOntbreken: false, handmatig: false };
  it("via de uploader en compleet", () => {
    expect(energielabelStatus({ ...leeg, conceptGeupload: true })).toBe("geupload");
  });
  it("bijlages ontbreken is nog niet af, tenzij met de hand gemarkeerd", () => {
    expect(energielabelStatus({ ...leeg, conceptGeupload: true, bijlagesOntbreken: true })).toBe("onaf");
    expect(energielabelStatus({ ...leeg, conceptGeupload: true, bijlagesOntbreken: true, handmatig: true })).toBe("handmatig");
  });
  it("alleen een recente ClickUp-taak is elders", () => {
    expect(energielabelStatus({ ...leeg, taak: { name: "x", created: NU } })).toBe("elders");
  });
});
