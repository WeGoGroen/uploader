import { describe, expect, it } from "vitest";
import { eigenOrders } from "./mediatask-format";

const ORDERS = [
  { id: 1, address: "Haarlemmerdijk 164C", owner: { id: 1589 } },
  { id: 2, address: "Bos en Lommerplantsoen 77 D", owner: { id: 1726 } },
  { id: 3, address: "Talbotstraat 4", owner: { id: 1589 } },
  { id: 4, address: "Zonder eigenaar", owner: null },
  { id: 5, address: "Eigenaar ontbreekt" },
];

describe("eigenOrders", () => {
  it("houdt alleen de orders van deze gebruiker over", () => {
    expect(eigenOrders(ORDERS, 1589).map((o) => o.id)).toEqual([1, 3]);
    expect(eigenOrders(ORDERS, 1726).map((o) => o.id)).toEqual([2]);
  });

  it("laat een order zonder eigenaar vallen in plaats van hem aan iedereen te tonen", () => {
    expect(eigenOrders(ORDERS, 1589).some((o) => o.id === 4 || o.id === 5)).toBe(false);
  });

  it("geeft niets terug voor iemand zonder orders", () => {
    expect(eigenOrders(ORDERS, 9999)).toEqual([]);
  });
});
