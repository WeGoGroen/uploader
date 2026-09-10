import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * De conceptzoeker, en waarom hij een geheugen nodig heeft.
 *
 * `listOrders` geeft niet alleen onze eigen orders terug. Zolang iedereen
 * dezelfde Mediatask-sleutel had was dat onschuldig: elk concept met het
 * juiste adres was er ook eentje waar we bij konden. Sinds elke opnemer een
 * eigen sleutel heeft niet meer — en dan lijkt hergebruiken te lukken
 * (aanmaken en opmerkingen gaan gewoon door) tot de puntenwolk tegen een 403
 * loopt, op het moment dat de opnemer al klaar denkt te zijn.
 *
 * Dat is wat er bij Balboastraat 12-3 en 12-4 gebeurde: units in hetzelfde
 * pand, waar dus al concepten van een ander konden staan.
 */

const redis = vi.hoisted(() => {
  const strings = new Map<string, string>();
  return {
    store: strings,
    api: {
      async get(k: string) {
        return strings.get(k) ?? null;
      },
      async set(k: string, v: string) {
        strings.set(k, v);
        return "OK";
      },
    },
  };
});

vi.mock("@/lib/redis", () => ({
  getOptionalRedis: () => redis.api,
  requireRedis: () => redis.api,
}));

const {
  vindBestaandeDraft,
  onthoudGeweigerdeOrder,
  isGeweigerdeOrder,
  onthoudEigenOrder,
  isEigenOrder,
  weigeringUitleg,
  onthoudSleutelWeigering,
  isSleutelGeweigerd,
} = await import("@/lib/mediatask");

const BASIS = "https://mediatask.test";

function nepOrders(orders: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(orders),
      json: async () => orders,
    }))
  );
}

function nepOrder(order: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(order),
      json: async () => order,
    }))
  );
}

beforeEach(() => {
  redis.store.clear();
  process.env.MEDIATASK_API_TOKEN = "test-token";
  process.env.MEDIATASK_API_BASE = BASIS;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("vindBestaandeDraft", () => {
  it("hergebruikt een concept voor hetzelfde adres", async () => {
    nepOrders([
      { id: 1, state: "draft", address: "Balboastraat 12-3, Amsterdam" },
      { id: 2, state: "draft", address: "Balboastraat 12-4, Amsterdam" },
    ]);

    const gevonden = await vindBestaandeDraft("Balboastraat", "12-4", "Amsterdam");

    expect(gevonden?.id).toBe(2);
  });

  it("laat een order liggen waarvan bekend is dat hij ons weigert", async () => {
    await onthoudGeweigerdeOrder(2);
    nepOrders([{ id: 2, state: "draft", address: "Balboastraat 12-4, Amsterdam" }]);

    // Liever geen concept dan een concept waar de scan straks niet in kan: de
    // aanroeper maakt er dan zelf een aan, en die is wél van onze sleutel.
    expect(await vindBestaandeDraft("Balboastraat", "12-4", "Amsterdam")).toBeNull();
    expect(await isGeweigerdeOrder(2)).toBe(true);
    expect(await isGeweigerdeOrder(3)).toBe(false);
  });

  it("pakt het volgende bruikbare concept als het eerste ons weigert", async () => {
    await onthoudGeweigerdeOrder(2);
    nepOrders([
      { id: 2, state: "draft", address: "Balboastraat 12-4, Amsterdam" },
      { id: 5, state: "draft", address: "Balboastraat 12-4, Amsterdam" },
    ]);

    const gevonden = await vindBestaandeDraft("Balboastraat", "12-4", "Amsterdam");

    expect(gevonden?.id).toBe(5);
  });

  it("kijkt niet naar orders die geen concept meer zijn of een ander adres hebben", async () => {
    nepOrders([
      { id: 7, state: "submitted", address: "Balboastraat 12-4, Amsterdam" },
      { id: 8, state: "draft", address: "Balboastraat 12-40, Amsterdam" },
      { id: 9, state: "draft", address: "Balboastraat 12-4, Utrecht" },
    ]);

    expect(await vindBestaandeDraft("Balboastraat", "12-4", "Amsterdam")).toBeNull();
  });
});

describe("eigen orders", () => {
  it("onthoudt welke orders deze app zelf aanmaakte", async () => {
    expect(await isEigenOrder(378613)).toBe(false);
    await onthoudEigenOrder(378613);
    expect(await isEigenOrder(378613)).toBe(true);
    // Het onderscheid dat telt: een order die wij aanmaakten wordt niet
    // vervangen als hij ons weigert (dat zou alleen lege concepten opleveren),
    // eentje die we hergebruikten wél.
    expect(await isEigenOrder(378560)).toBe(false);
  });
});

describe("weigeringUitleg", () => {
  it("wijst bij een eigen, verse order naar de sleutel en niet naar de order", async () => {
    // Dit is Kea Boumanstraat 74 (10 sep): een gloednieuw adres, dus geen
    // concept van een ander om te hergebruiken — en tóch een 403. Dan gaat het
    // over wat de sleutel mag, en is een nieuwe order aanmaken zinloos.
    await onthoudEigenOrder(11);
    nepOrder({ id: 11, state: "draft" });

    const uitleg = await weigeringUitleg(11);

    expect(uitleg?.vanOns).toBe(true);
    expect(uitleg?.tekst).toContain("zelf hebben aangemaakt");
    expect(uitleg?.tekst).toContain("Een nieuwe order lost dit niet op");
  });

  it("wijst bij een hergebruikt concept juist wél naar het eigendom", async () => {
    nepOrder({ id: 12, state: "draft" });

    const uitleg = await weigeringUitleg(12);

    expect(uitleg?.vanOns).toBe(false);
    expect(uitleg?.tekst).toContain("hergebruikt");
  });

  it("noemt de toestand als de order geen concept meer is", async () => {
    nepOrder({ id: 13, state: "submitted" });

    const uitleg = await weigeringUitleg(13);

    expect(uitleg?.nogConcept).toBe(false);
    expect(uitleg?.tekst).toContain('"submitted"');
  });
});

describe("sleutelweigering", () => {
  it("onthoudt dat de sleutel zelf geweigerd wordt", async () => {
    expect(await isSleutelGeweigerd()).toBe(false);
    await onthoudSleutelWeigering();
    // Zolang deze rem staat maakt de orderroute geen vervangende order meer
    // aan: die zou net zo hard geweigerd worden en alleen een leeg concept
    // achterlaten bij Mediatask.
    expect(await isSleutelGeweigerd()).toBe(true);
  });
});
