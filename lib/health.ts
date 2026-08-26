import {
  getSharedAccessToken,
  createTemporaryUploadLink,
  listFolderFiles,
  statusFromName,
  stripStatusMarker,
  summarizeProjectFolders,
} from "@/lib/dropbox";
import {
  getDefaultDriveId,
  getSharedAccessToken as getGraphToken,
  listPathChildren,
  requireSharePointConfig,
  resolveSiteId,
} from "@/lib/microsoft";
import { listDrafts } from "@/lib/drafts";
import { getTeams, requireClickUpConfig, getListCustomFields, getClickUpAccounts } from "@/lib/clickup";
import { getAgencies, listOrders, listPointclouds } from "@/lib/mediatask";
import { suggestAddresses } from "@/lib/pdok";
import { calendarLocationToBagQuery } from "@/lib/address-format";
import { getAccessTokenForAccount, getTodayEvents } from "@/lib/google-calendar";
import { resolveActiveAccountName } from "@/lib/active-account";
import { authConfig } from "@/lib/auth";
import { getOptionalRedis } from "@/lib/redis";
import { checkStreetView } from "@/lib/streetview";

export interface Controle {
  naam: string;
  /** false = echte storing. Zie ook `niveau` voor het verschil tussen een
      storing en iets dat alleen aandacht vraagt. */
  ok: boolean;
  /** "let op" = geen storing, maar wel het bekijken waard (bv. een afspraak
      zonder adres). Zou de hele controle niet rood moeten maken, anders leert
      iedereen de melding wegkijken. */
  niveau: "ok" | "let op" | "fout";
  detail: string;
  ms: number;
  /** Aantal pogingen dat nodig was. Meer dan 1 betekent: het ging even mis en
      is vanzelf hersteld — dat wil je wel weten, maar er hoeft niemand voor uit
      bed. */
  pogingen: number;
}

export interface Gezondheidsrapport {
  tijdstip: string;
  allesGoed: boolean;
  controles: Controle[];
}

const LAATSTE_KEY = "health:laatste";

/** Een controle mag "let op" teruggeven door LET_OP vóór de tekst te zetten. */
const LET_OP = "\u26a0";

/**
 * Onderscheidt een hapering van een echte kapotte koppeling.
 *
 * Dit is precies de grens van wat de app zélf kan oplossen: een 502 van
 * Mediatask of een time-out bij PDOK trekt vanzelf bij, dus daar heeft het zin
 * om opnieuw te proberen. Een ingetrokken token of een ontbrekende instelling
 * blijft bij poging tien net zo stuk als bij poging één — daar meteen mee
 * stoppen scheelt tijd én voorkomt de illusie dat er iets geprobeerd wordt.
 */
function isTijdelijk(err: unknown): boolean {
  const t = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (/\b(401|403|invalid_grant|unauthorized|ontbreekt|niet gekoppeld|geen token)\b/.test(t)) {
    return false;
  }
  return /\b(429|500|502|503|504)\b|timeout|timed out|etimedout|econnreset|network|fetch failed|socket/.test(t);
}

const wacht = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function meet(naam: string, fn: () => Promise<string>): Promise<Controle> {
  const t0 = Date.now();
  const maxPogingen = 3;

  for (let poging = 1; ; poging++) {
    try {
      const detail = await fn();
      const letOp = detail.startsWith(LET_OP);
      const zelfHersteld = poging > 1;
      const schoon = letOp ? detail.slice(1).trim() : detail;
      return {
        naam,
        ok: true,
        // Vanzelf herstelde haperingen zijn geen storing, maar wel het
        // vermelden waard: drie ochtenden op rij "pas na de derde poging" is
        // een dienst die aan het wegzakken is.
        niveau: zelfHersteld ? "let op" : letOp ? "let op" : "ok",
        detail: zelfHersteld ? `${schoon} — hapering vanzelf hersteld na ${poging} pogingen` : schoon,
        ms: Date.now() - t0,
        pogingen: poging,
      };
    } catch (err) {
      if (poging < maxPogingen && isTijdelijk(err)) {
        await wacht(poging * 1500);
        continue;
      }
      return {
        naam,
        ok: false,
        niveau: "fout",
        detail: err instanceof Error ? err.message.slice(0, 200) : "onbekende fout",
        ms: Date.now() - t0,
        pogingen: poging,
      };
    }
  }
}

/**
 * Controleert 's ochtends of de hele keten nog werkt. Bewust niet alleen
 * "is het bereikbaar" maar ook "mogen we nog schrijven": een verlopen token
 * of ingetrokken rechten geeft bij lezen vaak nog gewoon antwoord, en valt
 * pas op als een opnemer in het veld staat.
 *
 * Alle controles zijn niet-destructief: er wordt niets aangemaakt of
 * verwijderd, ook geen testorder bij Mediatask.
 */
/**
 * Eén controle per gekoppeld account. Elk teamlid heeft een eigen
 * Google-koppeling; alleen de eerste testen zou betekenen dat een verlopen
 * koppeling van een collega pas opvalt als die 's ochtends voor een dichte
 * deur staat.
 *
 * Kijkt meteen naar de bruikbaarheid van de afspraken van vandaag: een
 * afspraak zonder adres of met een adres dat niet in de BAG staat, wil je om
 * half acht weten en niet op de stoep.
 */
async function agendaControles(): Promise<Controle[]> {
  let accounts: string[] = [];
  try {
    accounts = (await getClickUpAccounts()).map((a) => a.name);
  } catch {
    accounts = [];
  }
  if (accounts.length === 0) {
    const enige = await resolveActiveAccountName();
    accounts = enige ? [enige] : [];
  }
  if (accounts.length === 0) {
    return [await meet("Google Agenda", async () => {
      throw new Error("geen accounts ingesteld");
    })];
  }

  return Promise.all(
    accounts.map((naam) =>
      meet(`Google Agenda — ${naam}`, async () => {
        const token = await getAccessTokenForAccount(naam);
        const events = await getTodayEvents(token);
        if (events.length === 0) return `${LET_OP} geen afspraken vandaag`;

        const zonderAdres = events.filter((e) => !e.location?.trim()).length;
        const metAdres = events.filter((e) => e.location?.trim());

        // Adressen die de BAG niet kent leveren straks een opname op die niet
        // te starten is; dat is nu al te zien.
        const onbekend: string[] = [];
        for (const e of metAdres) {
          const query = calendarLocationToBagQuery(e.location!.trim());
          try {
            if ((await suggestAddresses(query)).length === 0) onbekend.push(query);
          } catch {
            // Hapert PDOK, dan geen vals alarm over dit adres.
          }
        }

        const problemen: string[] = [];
        if (zonderAdres > 0) problemen.push(`${zonderAdres} zonder adres`);
        if (onbekend.length > 0) problemen.push(`niet in BAG: ${onbekend.join("; ")}`);

        const basis = `${events.length} afspraken vandaag`;
        return problemen.length > 0 ? `${LET_OP} ${basis} — ${problemen.join(", ")}` : basis;
      })
    )
  );
}

const DAG_MS = 24 * 60 * 60 * 1000;
/** Ouder dan dit en nog niet afgemaakt: dan blijft er werk liggen. */
const CONCEPT_OUD_DAGEN = 7;

/**
 * Controles op het wérk, niet op de koppelingen. Dit is de categorie die
 * ontbrak: alle diensten konden groen staan terwijl een opname stilletjes
 * halverwege was blijven hangen. Precies dat viel eerder niemand op tot een
 * opnemer erover struikelde.
 */
async function werkControles(): Promise<Controle[]> {
  // Beide conceptcontroles lezen dezelfde lijst; die één keer ophalen i.p.v.
  // twee keer. De belofte wordt pas bij de eerste aanroep uitgevoerd, dus een
  // storing komt nog steeds in de controle zelf terecht en niet hierbuiten.
  let geladen: Promise<Awaited<ReturnType<typeof listDrafts>>> | null = null;
  const alleOpnames = () => (geladen ??= listDrafts());

  return Promise.all([
    meet("Opnames afgerond", async () => {
      const geupload = (await alleOpnames()).filter((d) => d.status === "uploaded");

      // Bijlages die niet in ClickUp gekomen zijn: de taak bestaat, dus alles
      // ziet er afgerond uit, maar de documenten ontbreken.
      const incompleet = geupload.filter((d) => (d.incompleteDocs?.length ?? 0) > 0);
      // Op "uploaded" gezet zonder taak-URL: dan is er iets misgegaan tussen
      // het aanmaken van de taak en het opslaan van het concept.
      const zonderTaak = geupload.filter((d) => !d.clickupTaskUrl);

      if (incompleet.length === 0 && zonderTaak.length === 0) {
        return `${geupload.length} afgeronde opnames, allemaal compleet`;
      }

      const stukken: string[] = [];
      if (incompleet.length > 0) {
        stukken.push(
          `${incompleet.length} met ontbrekende bijlages (${incompleet
            .slice(0, 3)
            .map((d) => `${d.straatnaam || d.titel}: ${d.incompleteDocs!.join(", ")}`)
            .join("; ")}${incompleet.length > 3 ? "; …" : ""})`
        );
      }
      if (zonderTaak.length > 0) {
        stukken.push(
          `${zonderTaak.length} zonder ClickUp-taak (${zonderTaak
            .slice(0, 3)
            .map((d) => d.straatnaam || d.titel)
            .join("; ")})`
        );
      }
      throw new Error(stukken.join(" — "));
    }),

    meet("Openstaande concepten", async () => {
      const alle = await alleOpnames();
      const concepten = alle.filter((d) => d.status === "concept");
      const grens = Date.now() - CONCEPT_OUD_DAGEN * DAG_MS;
      const oud = concepten.filter((d) => d.updatedAt < grens);
      const basis = `${concepten.length} openstaand, ${alle.length} opnames in de opslag`;
      if (oud.length === 0) return basis;
      const oudste = [...oud].sort((a, b) => a.updatedAt - b.updatedAt)[0];
      const dagen = Math.floor((Date.now() - oudste.updatedAt) / DAG_MS);
      return `${LET_OP} ${basis} — ${oud.length} langer dan ${CONCEPT_OUD_DAGEN} dagen niet aangeraakt (oudste: ${
        oudste.straatnaam || oudste.titel || "onbekend adres"
      }, ${dagen} dagen)`;
    }),

    /**
     * De koppeling met de SharePoint van MO Consultancy. Die draait app-only
     * met een client secret dat een houdbaarheidsdatum heeft — en als dat
     * verloopt stopt de hele overdracht zonder dat iemand iets merkt. Dit is
     * de controle die dat een ochtend later aan het licht brengt in plaats van
     * pas als een klant om zijn bestanden vraagt.
     */
    meet("SharePoint-koppeling", async () => {
      const config = await requireSharePointConfig();
      const token = await getGraphToken();
      const siteId = await resolveSiteId(token, config.siteUrl);
      const driveId = await getDefaultDriveId(token, siteId);
      const inhoud = await listPathChildren(token, driveId, config.rootPath);
      const mappen = inhoud.filter((i) => i.isFolder).length;
      // Een lege bronmap is geen storing (misschien is alles al opgehaald),
      // maar wel opvallend genoeg om te noemen.
      if (inhoud.length === 0) {
        return `${LET_OP} verbonden, maar "${config.rootPath}" is leeg`;
      }
      return `verbonden, ${mappen} opgeleverde mappen in "${config.rootPath}"`;
    }),

    /**
     * De uitkomst van de overdrachten zelf, af te lezen aan het bolletje voor
     * elke projectmap. Rood betekent: er is iets misgegaan en het blijft
     * liggen tot iemand kijkt. Oranje om half zes 's ochtends betekent
     * hetzelfde — een overdracht duurt seconden, geen uren.
     */
    meet("SharePoint-overdracht", async () => {
      const t = await getSharedAccessToken();
      const { folders, volledig } = await summarizeProjectFolders(t, "/Automatie Energielabels");

      const perStatus = { compleet: [] as string[], bezig: [] as string[], ontbreekt: [] as string[] };
      for (const f of folders) {
        const status = statusFromName(f.name);
        if (status) perStatus[status].push(stripStatusMarker(f.name));
      }

      const gemarkeerd =
        perStatus.compleet.length + perStatus.bezig.length + perStatus.ontbreekt.length;
      const afgekapt = volledig ? "" : " (lijst afgekapt)";

      if (gemarkeerd === 0) {
        return `nog geen overdrachten gedaan${afgekapt}`;
      }

      const samenvatting = `${perStatus.compleet.length} compleet, ${perStatus.bezig.length} bezig, ${perStatus.ontbreekt.length} met een probleem${afgekapt}`;

      // Rood is een echte storing: die map blijft liggen tot iemand kijkt.
      if (perStatus.ontbreekt.length > 0) {
        throw new Error(
          `${samenvatting} — ${perStatus.ontbreekt.slice(0, 5).join("; ")}${
            perStatus.ontbreekt.length > 5 ? "; …" : ""
          }`
        );
      }

      // Oranje op dit tijdstip is blijven hangen, geen werk in uitvoering.
      if (perStatus.bezig.length > 0) {
        return `${LET_OP} ${samenvatting} — blijven hangen: ${perStatus.bezig
          .slice(0, 5)
          .join("; ")}${perStatus.bezig.length > 5 ? "; …" : ""}`;
      }

      return samenvatting;
    }),

    meet("Verweesde projectmappen", async () => {
      const t = await getSharedAccessToken();
      const [label, nen] = await Promise.all([
        summarizeProjectFolders(t, "/Automatie Energielabels"),
        summarizeProjectFolders(t, "/Automatie NEN2580"),
      ]);
      const leeg = [
        ...label.folders.filter((f) => f.files === 0).map((f) => `Energielabels/${f.name}`),
        ...nen.folders.filter((f) => f.files === 0).map((f) => `NEN2580/${f.name}`),
      ];
      const totaal = label.folders.length + nen.folders.length;
      const onvolledig = !label.volledig || !nen.volledig ? " (lijst afgekapt)" : "";
      if (leeg.length === 0) return `${totaal} projectmappen, geen lege${onvolledig}`;
      // Een map die 's ochtends om half zes nog helemaal leeg is, is niet
      // "nog bezig" — dat is een map die is aangemaakt en daarna verlaten,
      // meestal omdat het adres erna nog gecorrigeerd werd.
      return `${LET_OP} ${leeg.length} van ${totaal} projectmappen zijn leeg${onvolledig}: ${leeg
        .slice(0, 5)
        .join("; ")}${leeg.length > 5 ? "; …" : ""}`;
    }),
  ]);
}

export async function draaiControles(): Promise<Gezondheidsrapport> {
  const controles = await Promise.all([
    /**
     * De AI-agents van het Business Control Center.
     *
     * Die draaien daar en niet hier, maar horen wél in deze mail: een agent die
     * 's nachts stilvalt hoort in het bericht te staan dat iemand 's ochtends
     * toch al leest, niet in een apart kanaal dat niemand opent. Zonder
     * gekoppeld control center is dit geen fout maar een lege mededeling.
     */
    meet("AI-agents", async () => {
      const basis = (process.env.CONTROL_CENTER_URL ?? "").replace(/\/+$/, "");
      const token = process.env.CONTROL_CENTER_TOKEN;
      if (!basis || !token) return `${LET_OP} geen control center gekoppeld — niets te controleren`;

      const res = await fetch(`${basis}/api/agent-status`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`control center gaf ${res.status}`);

      const data = (await res.json()) as {
        agents?: { naam: string; niveau: string; detail: string; runs_ok: number }[];
      };
      const agents = data.agents ?? [];
      if (agents.length === 0) return `${LET_OP} er draaien nog geen agents`;

      const stil = agents.filter((a) => a.niveau === "fout");
      if (stil.length > 0) {
        throw new Error(stil.map((a) => `${a.naam}: ${a.detail}`).join(" · "));
      }
      const hapert = agents.filter((a) => a.niveau === "let op");
      const samen = `${agents.length} agent(s) draaien, ${agents.reduce((n, a) => n + a.runs_ok, 0)} klussen afgehandeld`;
      return hapert.length > 0
        ? `${LET_OP} ${samen} — ${hapert.map((a) => a.naam).join(", ")} hapert`
        : samen;
    }),
    meet("Inlog actief", async () => {
      const { password } = authConfig();
      if (!password) throw new Error("APP_PASSWORD ontbreekt — de app staat open voor iedereen");
      return "toegangscode ingesteld";
    }),

    meet("BAG (adressen)", async () => {
      const res = await suggestAddresses("Damrak 1, Amsterdam");
      if (res.length === 0) throw new Error("geen resultaten voor een bekend adres");
      return `${res.length} resultaten`;
    }),

    meet("ClickUp", async () => {
      const { token, listId } = await requireClickUpConfig(null);
      const [teams, velden] = await Promise.all([getTeams(token), getListCustomFields(token, listId)]);
      if (!teams[0]) throw new Error("geen workspace gevonden");
      if (velden.length === 0) throw new Error("lijst zonder velden — verkeerde CLICKUP_LIST_ID?");
      return `${velden.length} velden in de lijst`;
    }),

    meet("Dropbox (lezen)", async () => {
      const t = await getSharedAccessToken();
      const files = await listFolderFiles(t, "/Automatie Energielabels");
      return `hoofdmap leesbaar (${files.length} losse bestanden)`;
    }),

    meet("Dropbox (schrijfrecht)", async () => {
      // Vraagt een uploadlink aan zonder iets te schrijven: dit faalt zodra
      // het token zijn schrijfrechten kwijt is.
      const t = await getSharedAccessToken();
      const link = await createTemporaryUploadLink(t, "/Automatie Energielabels/.controle-schrijfrecht");
      if (!link.startsWith("http")) throw new Error("geen geldige uploadlink");
      return "schrijven toegestaan";
    }),

    meet("Google Street View", async () => {
      // Draait op het gratis metadata-endpoint, dus deze controle kost niets
      // en kan elke ochtend mee. Een geweigerde key merk je anders pas
      // doordat projectmappen stilletjes zonder gevelfoto blijven.
      const sv = await checkStreetView();
      if (!sv.connected) return `${LET_OP} ${sv.error}`;
      if (!sv.ok) throw new Error(sv.error ?? "onbekende fout");
      return "straatbeelden en luchtfoto worden geplaatst";
    }),

    ...(await agendaControles()),

    meet("Mediatask — puntenwolken", async () => {
      // Aankomen en verwerkt worden zijn twee dingen. Een puntenwolk die hun
      // verwerker afkeurt heeft geen voorbeeldbeelden; dat is het enige
      // signaal dat de API erover geeft, en zonder deze controle merk je het
      // pas als de verwerker erover belt.
      const orders = (await listOrders()).slice(0, 12);
      const stuk: string[] = [];
      for (const o of orders) {
        const pcs = await listPointclouds(o.id).catch(() => []);
        const kapot = pcs.filter((p) => (p.images?.length ?? 0) === 0).length;
        if (kapot > 0) stuk.push(`#${o.id} (${kapot})`);
      }
      if (stuk.length > 0) {
        return `${LET_OP} afgekeurde scans bij ${stuk.join(", ")} — opnieuw versturen via /api/mediatask/pointclouds/controle`;
      }
      return `${orders.length} orders gecontroleerd, alle scans verwerkt`;
    }),

    meet("Mediatask", async () => {
      const bureaus = await getAgencies();
      if (bureaus.length === 0) throw new Error("geen makelaars teruggekregen");
      return `${bureaus.length} makelaars`;
    }),

    ...(await werkControles()),
  ]);

  const rapport: Gezondheidsrapport = {
    tijdstip: new Date().toISOString(),
    // "let op" telt niet als storing: anders staat de cron elke zondag rood
    // omdat er geen afspraken zijn, en kijkt niemand er meer naar.
    allesGoed: controles.every((c) => c.niveau !== "fout"),
    controles,
  };

  // Bewaren zodat de app 'm kan tonen; zonder Redis werkt de controle nog
  // steeds, alleen zonder geschiedenis.
  const redis = getOptionalRedis();
  if (redis) await redis.set(LAATSTE_KEY, JSON.stringify(rapport)).catch(() => {});

  return rapport;
}

export async function laatsteRapport(): Promise<Gezondheidsrapport | null> {
  const redis = getOptionalRedis();
  if (!redis) return null;
  const raw = await redis.get(LAATSTE_KEY).catch(() => null);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Gezondheidsrapport;
  } catch {
    return null;
  }
}
