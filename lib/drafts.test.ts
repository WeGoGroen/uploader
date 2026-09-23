import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Nagebootste Redis met precies de commando's die deze module gebruikt. Dit
 * is de laag waar een fout geen foutmelding geeft maar data: een opname die
 * in twee indexen staat, of eentje die uit beeld verdwijnt.
 */
function nepRedis() {
  const strings = new Map<string, string>();
  const zsets = new Map<string, Map<string, number>>();
  const sets = new Map<string, Set<string>>();
  const z = (k: string) => zsets.get(k) ?? (zsets.set(k, new Map()), zsets.get(k)!);

  const api = {
    async get(k: string) {
      return strings.get(k) ?? null;
    },
    async set(k: string, v: string) {
      strings.set(k, v);
      return "OK";
    },
    async del(k: string) {
      strings.delete(k);
      return 1;
    },
    async mget(keys: string[]) {
      return keys.map((k) => strings.get(k) ?? null);
    },
    async smembers(k: string) {
      return [...(sets.get(k) ?? [])];
    },
    async zadd(k: string, score: number, lid: string) {
      z(k).set(lid, score);
      return 1;
    },
    async zrem(k: string, ...leden: string[]) {
      for (const l of leden) z(k).delete(l);
      return leden.length;
    },
    async zrevrange(k: string, van: number, tot: number) {
      const alle = [...z(k).entries()].sort((a, b) => b[1] - a[1]).map(([lid]) => lid);
      return alle.slice(van, tot === -1 ? undefined : tot + 1);
    },
    async zrangebyscore(k: string, min: number, max: number) {
      return [...z(k).entries()]
        .filter(([, s]) => s >= min && s <= max)
        .sort((a, b) => a[1] - b[1])
        .map(([lid]) => lid);
    },
    async zremrangebyscore(k: string, min: number, max: number) {
      for (const [lid, s] of [...z(k).entries()]) if (s >= min && s <= max) z(k).delete(lid);
      return 1;
    },
    async zcard(k: string) {
      return z(k).size;
    },
    pipeline() {
      const acties: (() => Promise<unknown>)[] = [];
      const p: Record<string, unknown> = {
        exec: async () => {
          for (const a of acties) await a();
          return [];
        },
      };
      for (const naam of ["set", "del", "zadd", "zrem", "zremrangebyscore"]) {
        p[naam] = (...args: unknown[]) => {
          acties.push(() => (api as never as Record<string, (...a: unknown[]) => Promise<unknown>>)[naam](...args));
          return p;
        };
      }
      return p;
    },
    _strings: strings,
    _zsets: zsets,
    _sets: sets,
  };
  return api;
}

let redis = nepRedis();
vi.mock("@/lib/redis", () => ({ requireRedis: () => redis }));

const {
  archiveerOudeOpnames,
  deleteDraft,
  draftIdUitPad,
  getDraft,
  isVerwijderd,
  listDrafts,
  listDraftsByStatus,
  saveDraft,
  telOpnames,
} = await import("./drafts");
type Record_ = Awaited<ReturnType<typeof getDraft>>;

const dag = 24 * 60 * 60 * 1000;

function opname(id: string, p: Partial<NonNullable<Record_>> = {}) {
  return {
    id,
    status: "concept" as const,
    titel: `Straat ${id}`,
    straatnaam: `Straat ${id}`,
    postcode: "1012LG",
    woonplaats: "Amsterdam",
    accountName: "Floris de Laat",
    clickupTaskUrl: null,
    updatedAt: Date.now(),
    createdAt: Date.now(),
    // Zwaar veld: dit hoort juist NIET in een lijst terecht te komen.
    state: { fieldValues: Object.fromEntries([...Array(44)].map((_, i) => [`f${i}`, "x"])) },
    ...p,
  };
}

beforeEach(() => {
  redis = nepRedis();
});

describe("opslag van opnames", () => {
  it("keeps the full form only in the record, never in the list", async () => {
    await saveDraft(opname("a"));

    const lijst = await listDraftsByStatus("concept");
    expect(lijst).toHaveLength(1);
    expect("state" in lijst[0]).toBe(false);

    const volledig = await getDraft("a");
    expect(volledig?.state).toBeDefined();
  });

  it("returns newest first", async () => {
    await saveDraft(opname("oud", { updatedAt: 1000 }));
    await saveDraft(opname("nieuw", { updatedAt: 5000 }));
    const lijst = await listDraftsByStatus("concept");
    expect(lijst.map((d) => d.id)).toEqual(["nieuw", "oud"]);
  });

  it("honours the limit instead of reading everything", async () => {
    for (let i = 0; i < 50; i++) await saveDraft(opname(`x${i}`, { updatedAt: i }));
    const lijst = await listDraftsByStatus("concept", 10);
    expect(lijst).toHaveLength(10);
    expect(lijst[0].id).toBe("x49");
  });

  // Zonder verwijderen uit de andere index zou dezelfde opname zowel bij
  // "open" als bij "afgerond" staan, en dus dubbel geteld worden.
  it("moves an opname out of the old index when its status changes", async () => {
    await saveDraft(opname("a"));
    expect(await telOpnames()).toEqual({ concept: 1, uploaded: 0 });

    await saveDraft(opname("a", { status: "uploaded" }));
    expect(await telOpnames()).toEqual({ concept: 0, uploaded: 1 });
    expect((await listDraftsByStatus("concept")).map((d) => d.id)).toEqual([]);
  });

  it("removes an opname everywhere when it is deleted", async () => {
    await saveDraft(opname("a"));
    await deleteDraft("a");
    expect(await getDraft("a")).toBeNull();
    expect(await listDrafts()).toEqual([]);
    expect(await telOpnames()).toEqual({ concept: 0, uploaded: 0 });
  });

  it("combines both statuses, newest first", async () => {
    await saveDraft(opname("c", { updatedAt: 100 }));
    await saveDraft(opname("u", { status: "uploaded", updatedAt: 200 }));
    expect((await listDrafts()).map((d) => d.id)).toEqual(["u", "c"]);
  });

  it("drops index entries whose summary is gone", async () => {
    await saveDraft(opname("a"));
    redis._strings.delete("draft:kort:a");
    expect(await listDraftsByStatus("concept")).toEqual([]);
    expect(await telOpnames()).toEqual({ concept: 0, uploaded: 0 });
  });
});

describe("archiveren", () => {
  it("removes finished opnames older than the limit", async () => {
    const nu = Date.now();
    await saveDraft(opname("oud", { status: "uploaded", updatedAt: nu - 100 * dag }));
    await saveDraft(opname("vers", { status: "uploaded", updatedAt: nu - 10 * dag }));

    expect(await archiveerOudeOpnames(90)).toBe(1);
    expect((await listDraftsByStatus("uploaded")).map((d) => d.id)).toEqual(["vers"]);
    expect(await getDraft("oud")).toBeNull();
  });

  // Een concept dat lang stilligt is werk dat nog moet gebeuren; dat mag nooit
  // stilletjes verdampen.
  it("never touches unfinished opnames, however old", async () => {
    await saveDraft(opname("oudConcept", { updatedAt: Date.now() - 500 * dag }));
    expect(await archiveerOudeOpnames(90)).toBe(0);
    expect((await listDraftsByStatus("concept")).map((d) => d.id)).toEqual(["oudConcept"]);
  });
});

describe("migratie van de oude indeling", () => {
  it("brings existing opnames across so they do not disappear", async () => {
    // Zoals het er vóór deze wijziging in Redis stond.
    const oud = opname("bestaand", { status: "uploaded", updatedAt: 4242 });
    redis._strings.set("draft:bestaand", JSON.stringify(oud));
    redis._sets.set("drafts:index", new Set(["bestaand"]));

    const lijst = await listDraftsByStatus("uploaded");
    expect(lijst.map((d) => d.id)).toEqual(["bestaand"]);
    expect("state" in lijst[0]).toBe(false);
  });

  it("runs only once", async () => {
    redis._sets.set("drafts:index", new Set([]));
    await listDraftsByStatus("concept");
    const vlag = await redis.get("drafts:gemigreerd");
    expect(vlag).toBeTruthy();

    // Tweede keer mag de oude index niet opnieuw ingelezen worden.
    redis._sets.set("drafts:index", new Set(["mag-niet-terugkomen"]));
    redis._strings.set("draft:mag-niet-terugkomen", JSON.stringify(opname("mag-niet-terugkomen")));
    expect(await listDraftsByStatus("concept")).toEqual([]);
  });
});

/*
  Verwijderen was niet het laatste woord.

  Het energielabelformulier bewaart het concept in localStorage en duwt het
  terug zodra die pagina opent of het apparaat weer verbinding krijgt. De
  POST-route neemt een meegestuurde updatedAt over, dus de opname kwam terug
  met zijn oorspronkelijke datum — alsof het verwijderen nooit gebeurd was.
  Alleen het apparaat opruimen is niet genoeg: dezelfde opname kan op een
  tweede iPad of in een ander tabblad staan. Dus weigert de opslag hem.
*/
describe("een verwijderde opname blijft verwijderd", () => {
  it("refuses to take the same recording back", async () => {
    const d = opname("a");
    await saveDraft(d);
    await deleteDraft("a");

    // Precies wat een achtergebleven apparaat terugstuurt: dezelfde opname,
    // ongewijzigd, met de oude datum erbij.
    expect(await saveDraft(d)).toBe(false);
    expect(await getDraft("a")).toBeNull();
    expect(await listDrafts()).toHaveLength(0);
  });

  it("says so, so the device can stop trying", async () => {
    await saveDraft(opname("a"));
    expect(await isVerwijderd("a")).toBe(false);
    await deleteDraft("a");
    expect(await isVerwijderd("a")).toBe(true);
  });

  it("leaves every other recording alone", async () => {
    await saveDraft(opname("a"));
    await saveDraft(opname("b"));
    await deleteDraft("a");

    expect(await saveDraft(opname("b", { updatedAt: 9999 }))).toBe(true);
    const over = await listDrafts();
    expect(over.map((d) => d.id)).toEqual(["b"]);
  });

  // Een nieuwe opname op hetzelfde adres moet gewoon kunnen: de grafsteen
  // geldt het id, niet het pand.
  it("does not block a fresh recording at the same address", async () => {
    await saveDraft(opname("a", { straatnaam: "Rustenburgerstraat 356-I" }));
    await deleteDraft("a");
    expect(await saveDraft(opname("b", { straatnaam: "Rustenburgerstraat 356-I" }))).toBe(true);
    expect((await listDrafts()).map((d) => d.id)).toEqual(["b"]);
  });
});

/*
  Het id van een media-opname is een Dropbox-pad.

  components/MediaFlow.tsx legt het vast als `media-${folder.path}`, dus met
  schuine strepen erin. De route /api/drafts/<id> was één segment breed en kon
  zo'n verzoek niet matchen: DELETE gaf 502 en het concept bleef staan. Op het
  scherm zag dat eruit als "verwijderen doet niets" — de opname verdween uit de
  lijst en stond daarna onveranderd op het dashboard, met zijn oude datum, want
  er was nooit iets weggehaald.
*/
describe("een concept-id dat een pad is", () => {
  const MEDIA = "media-/Automatie Media/Rustenburgerstraat 356-1, Amsterdam";

  it("puts the path segments back together exactly", () => {
    expect(draftIdUitPad(["media-", "Automatie Media", "Rustenburgerstraat 356-1, Amsterdam"])).toBe(
      MEDIA
    );
  });

  // Codeert de client het id vooraf, dan komt het als één segment binnen en
  // mag de samenvoeging er niets meer aan veranderen.
  it("leaves an already-whole id alone", () => {
    expect(draftIdUitPad([MEDIA])).toBe(MEDIA);
    expect(draftIdUitPad("abc123")).toBe("abc123");
  });

  it("has nothing to say about an empty path", () => {
    expect(draftIdUitPad([])).toBe("");
    expect(draftIdUitPad(undefined)).toBe("");
  });

  it("stores and deletes such a recording like any other", async () => {
    await saveDraft(opname(MEDIA, { straatnaam: "Rustenburgerstraat 356-1" }));
    expect((await listDrafts()).map((d) => d.id)).toEqual([MEDIA]);

    await deleteDraft(MEDIA);
    expect(await getDraft(MEDIA)).toBeNull();
    expect(await listDrafts()).toHaveLength(0);
  });
});
