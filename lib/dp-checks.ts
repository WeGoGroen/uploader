/**
 * De checklist waarmee een RAW-scan wordt beoordeeld voordat de opdracht naar
 * Mediatask gaat.
 *
 * De punten komen uit "Mastering Mobile 3D Scanning" (Dot3D-gids van Mediatask,
 * versie 03.2025) — de partij die de plattegrond uiteindelijk tekent. Elk punt
 * verwijst naar de plek in die gids waar de eis staat, zodat bij twijfel na te
 * lezen is waar hij vandaan komt en de lijst niet stilletjes eigen leven gaat
 * leiden.
 *
 * Elk punt heeft een bron:
 *   "meting" — uit de scandata zelf te bepalen; deterministisch, altijd gelijk.
 *   "beeld"  — vraagt om kijken naar de top-downrender en de scanfoto's; die
 *              gaan naar het beoordelingsmodel. De gids schrijft deze visuele
 *              controle zelf voor ("Review your scan", p18).
 *
 * Vier statussen: "ok", "twijfel" (mens kijkt ernaar), "afkeuren" (niet
 * doorsturen zonder actie) en "onbekend" — dat laatste voor punten waar we geen
 * gegevens over hebben. Dat eerlijk tonen is beter dan een groen vinkje dat
 * niets betekent.
 */

import type { DpMetrics } from "@/lib/dp-metrics";
import type { DpReferenceDistance } from "@/lib/dp-scan";

/**
 * Uitkomst van één checklistpunt.
 *
 * "afwijking" staat er los van "afkeuren" omdat niet elke rode vlag even hard
 * is. Vergelijkingen met de BAG en 3DBAG horen in die categorie: die gegevens
 * kloppen regelmatig niet — een pand is verbouwd, de vlieghoogtemeting zat er
 * naast, of het verblijfsobject is anders ingedeeld dan de registratie denkt.
 * Zo'n verschil moet opvallen, maar mag de opname niet tegenhouden. Vandaar:
 * rood in beeld, geen blokkade.
 */
export type CheckStatus = "ok" | "twijfel" | "afwijking" | "afkeuren" | "onbekend";

export interface CheckContext {
  /** Bestandsnaam zoals geüpload, bijvoorbeeld "Kerkstraat 31_raw.dp". */
  fileName: string;
  /** Adres van de opname, voor de naamcontrole. */
  address?: string;
  /** Verwacht aantal bouwlagen (uit BAG/afspraak), als bekend. */
  expectedFloors?: number;
  /** Gebruiksoppervlakte volgens BAG in m², als bekend. */
  bagAreaM2?: number;
  /** Referentiematen die in Dot3D zijn ingevoerd. */
  referenceDistances: DpReferenceDistance[];
}

export interface CheckResult {
  id: string;
  status: CheckStatus;
  toelichting: string;
}

export interface ChecklistItem {
  id: string;
  categorie: "Volledigheid" | "Nauwkeurigheid" | "Maatvoering" | "Administratief";
  titel: string;
  /** Waar de eis staat in de Mediatask-gids. */
  bron_gids: string;
  bron: "meting" | "beeld";
  /** Wat het beoordelingsmodel moet nagaan (alleen bij bron "beeld"). */
  vraag?: string;
  /** Deterministische toets (alleen bij bron "meting"). */
  evaluate?: (m: DpMetrics, c: CheckContext) => CheckResult;
  /**
   * Toets die genoeg heeft aan de context. Dit zijn de punten over de
   * ingevoerde maatvoering: die staat in het .dp-bestand en in géén enkele
   * export, dus die controleren we los van de puntenwolk.
   */
  evaluateRef?: (c: CheckContext) => CheckResult;
}

const ok = (id: string, toelichting: string): CheckResult => ({ id, status: "ok", toelichting });
const twijfel = (id: string, toelichting: string): CheckResult => ({ id, status: "twijfel", toelichting });
const afkeuren = (id: string, toelichting: string): CheckResult => ({ id, status: "afkeuren", toelichting });
const onbekend = (id: string, toelichting: string): CheckResult => ({ id, status: "onbekend", toelichting });

const m2 = (v: number) => `${v.toFixed(0)} m²`;
const meters = (v: number) => `${v.toFixed(1)} m`;
const pct = (v: number) => `${(v * 100).toFixed(0)}%`;

export const CHECKLIST: ChecklistItem[] = [
  // ---------- Maatvoering: de referentiematen ----------
  {
    id: "referentiematen",
    categorie: "Maatvoering",
    titel: "Minimaal twee referentiematen ingevoerd per bouwlaag",
    bron_gids: "p8 'Place tags' — minimaal 4 targets per verdieping, goed voor twee maten",
    bron: "meting",
    evaluateRef: (c) => {
      const n = c.referenceDistances.length;
      if (n === 0) {
        return afkeuren(
          "referentiematen",
          "Geen referentiematen ingevoerd — zonder laseraten kan Dot3D de scan niet op ware maat trekken"
        );
      }
      const maten = c.referenceDistances
        .map((d) => `${d.fromTag}↔${d.toTag}: ${d.distanceM.toFixed(2)} m`)
        .join(", ");
      if (n === 1) return twijfel("referentiematen", `Maar één referentiemaat (${maten}); de gids vraagt er twee in loodrechte richtingen`);
      return ok("referentiematen", `${n} referentiematen: ${maten}`);
    },
  },
  {
    id: "tags-aantal",
    categorie: "Maatvoering",
    titel: "Minimaal vier AprilTags gebruikt",
    bron_gids: "p8 — 'make sure to place at least 4 targets on each floor'",
    bron: "meting",
    evaluateRef: (c) => {
      const tags = new Set(c.referenceDistances.flatMap((d) => [d.fromTag, d.toTag]));
      if (tags.size === 0) return afkeuren("tags-aantal", "Geen tags in de maatvoering gebruikt");
      if (tags.size < 4) {
        return twijfel(
          "tags-aantal",
          `${tags.size} tag(s) gebruikt voor de maten (${[...tags].join(", ")}) — de gids vraagt er minimaal 4 per bouwlaag`
        );
      }
      return ok("tags-aantal", `${tags.size} tags gebruikt: ${[...tags].join(", ")}`);
    },
  },
  {
    id: "maten-lengte",
    categorie: "Maatvoering",
    titel: "Referentiematen overspannen een flinke afstand",
    bron_gids: "p8 — kies bij voorkeur de twee langste maten; tags nooit dichter dan 2 m op elkaar",
    bron: "meting",
    evaluateRef: (c) => {
      if (c.referenceDistances.length === 0) return onbekend("maten-lengte", "Geen referentiematen om te beoordelen");
      const kort = c.referenceDistances.filter((d) => d.distanceM < 2);
      if (kort.length > 0) {
        return afkeuren(
          "maten-lengte",
          `Maat van ${kort[0].distanceM.toFixed(2)} m tussen tags ${kort[0].fromTag} en ${kort[0].toTag} — tags horen minimaal 2 m uit elkaar`
        );
      }
      const langste = Math.max(...c.referenceDistances.map((d) => d.distanceM));
      if (langste < 4) return twijfel("maten-lengte", `Langste referentiemaat is ${langste.toFixed(2)} m — korte maten corrigeren de scan minder goed`);
      return ok("maten-lengte", `Langste referentiemaat ${langste.toFixed(2)} m`);
    },
  },

  // ---------- Nauwkeurigheid: wat de scanroute verraadt ----------
  {
    id: "rondje-gesloten",
    categorie: "Nauwkeurigheid",
    titel: "Scan eindigt waar hij begon (loop closure)",
    bron_gids: "p7 en p9 — 'finish your scan in the place you started', nodig voor loop closure",
    bron: "meting",
    evaluate: (m) => {
      // De gids maakt hier geen vrijblijvende aanbeveling van: zonder gesloten
      // lus kan Dot3D de opgebouwde fout niet wegwerken en loopt de maatvoering
      // scheef. Wel met marge: de opnemer staat zelden op exact dezelfde tegel.
      if (m.loopClosureM <= 3) return ok("rondje-gesloten", `Eindpunt ${meters(m.loopClosureM)} van het startpunt`);
      if (m.loopClosureM <= 8) {
        return twijfel("rondje-gesloten", `Eindpunt ${meters(m.loopClosureM)} van het startpunt — controleer of de lus echt gesloten is`);
      }
      return afkeuren("rondje-gesloten", `Eindpunt ${meters(m.loopClosureM)} van het startpunt — lus niet gesloten`);
    },
  },
  {
    id: "sprongen",
    categorie: "Nauwkeurigheid",
    titel: "Geen breuken in de scanroute",
    bron_gids: "p13 — vloeiende beweging, geen onderbrekingen in de continuïteit",
    bron: "meting",
    evaluate: (m) => {
      if (m.largeSteps.length === 0) return ok("sprongen", "Aaneengesloten route, geen sprongen boven 3 m");
      if (m.maxStepM > 5) {
        return twijfel(
          "sprongen",
          `${m.largeSteps.length} sprong(en), grootste ${meters(m.maxStepM)} — stuk gelopen zonder te scannen, of tracking kwijtgeraakt`
        );
      }
      return twijfel("sprongen", `${m.largeSteps.length} sprong(en) boven 3 m, grootste ${meters(m.maxStepM)}`);
    },
  },
  {
    id: "beweging",
    categorie: "Nauwkeurigheid",
    titel: "Rustige beweging zonder plotselinge draaien",
    bron_gids: "p13 — 'keep your movement steady, and avoid sudden changes of direction or rotation'",
    bron: "meting",
    evaluate: (m) => {
      if (m.keyframes < 10) return onbekend("beweging", "Te weinig keyframes om de beweging te beoordelen");
      const deel = m.abruptTurns / m.keyframes;
      if (deel > 0.25) return twijfel("beweging", `${m.abruptTurns} scherpe draaien op ${m.keyframes} keyframes (${pct(deel)}) — onrustig gescand`);
      return ok("beweging", `${m.abruptTurns} scherpe draaien op ${m.keyframes} keyframes (${pct(deel)})`);
    },
  },
  {
    id: "vloer-in-beeld",
    categorie: "Nauwkeurigheid",
    titel: "Vloeroppervlak meegenomen in de scan",
    bron_gids: "p10 en p12 — vloer meescannen; in gangen onder ~45° naar de vloer richten",
    bron: "meting",
    evaluate: (m) => {
      if (m.heightConfidence < 0.5) {
        return onbekend("vloer-in-beeld", `Hoogte-as te onzeker (${pct(m.heightConfidence)}) om de kijkrichting te beoordelen`);
      }
      if (m.floorAimShare < 0.15) {
        return twijfel("vloer-in-beeld", `Maar ${pct(m.floorAimShare)} van de keyframes wees omlaag — mogelijk te weinig vloer in beeld`);
      }
      return ok("vloer-in-beeld", `${pct(m.floorAimShare)} van de keyframes wees omlaag`);
    },
  },
  {
    id: "plafond",
    categorie: "Nauwkeurigheid",
    titel: "Niet onnodig plafonds gescand",
    bron_gids: "p14 — 'avoid scanning ceilings unless you really need them'",
    bron: "meting",
    evaluate: (m) => {
      if (m.heightConfidence < 0.5) return onbekend("plafond", `Hoogte-as te onzeker (${pct(m.heightConfidence)})`);
      if (m.ceilingAimShare > 0.3) return twijfel("plafond", `${pct(m.ceilingAimShare)} van de keyframes wees omhoog — veel plafond in beeld`);
      return ok("plafond", `${pct(m.ceilingAimShare)} van de keyframes wees omhoog`);
    },
  },

  // ---------- Volledigheid ----------
  {
    id: "dekking",
    categorie: "Volledigheid",
    titel: "Gescand grondvlak komt overeen met het pand",
    bron_gids: "p10 — 'try to capture the entire room', laat geen gaten achter",
    bron: "meting",
    evaluate: (m, c) => {
      if (c.bagAreaM2 === undefined) {
        return onbekend("dekking", `${m2(m.sweptAreaM2)} gescand; geen BAG-oppervlakte om tegen te leggen`);
      }
      // Het gescande vlak telt gangen, trapgaten en meegenomen buitenruimte mee
      // en valt daardoor hoger uit dan de BAG-gebruiksoppervlakte. Ruim eronder
      // betekent dat er delen ontbreken.
      const ratio = m.sweptAreaM2 / c.bagAreaM2;
      if (ratio < 0.7) return afkeuren("dekking", `${m2(m.sweptAreaM2)} gescand tegen ${m2(c.bagAreaM2)} volgens BAG — er ontbreekt een deel`);
      if (ratio < 0.9) return twijfel("dekking", `${m2(m.sweptAreaM2)} gescand tegen ${m2(c.bagAreaM2)} volgens BAG`);
      return ok("dekking", `${m2(m.sweptAreaM2)} gescand tegen ${m2(c.bagAreaM2)} volgens BAG`);
    },
  },
  {
    id: "scanduur",
    categorie: "Volledigheid",
    titel: "Scanduur past bij de omvang van het pand",
    bron: "meting",
    bron_gids: "afgeleid: te snel gescand betekent overgeslagen ruimtes (p10)",
    evaluate: (m) => {
      if (m.durationSeconds === null) return onbekend("scanduur", "Geen IMU-log in het bestand, duur onbekend");
      const min = m.durationSeconds / 60;
      const secPerM2 = m.durationSeconds / Math.max(m.sweptAreaM2, 1);
      if (min < 1.5) return afkeuren("scanduur", `Scan duurde maar ${min.toFixed(1)} min — te kort voor een volledige opname`);
      if (secPerM2 < 0.35) return twijfel("scanduur", `${min.toFixed(1)} min voor ${m2(m.sweptAreaM2)} — snel doorgelopen`);
      return ok("scanduur", `${min.toFixed(1)} min voor ${m2(m.sweptAreaM2)}`);
    },
  },
  {
    id: "bouwlagen",
    categorie: "Volledigheid",
    titel: "Alle bouwlagen zitten in de scan",
    bron_gids: "p7 — verdieping voor verdieping scannen, telkens terug naar het trapgat",
    bron: "meting",
    evaluate: (m, c) => {
      if (m.heightConfidence < 0.7) {
        return onbekend(
          "bouwlagen",
          `Hoogte-as te onzeker (${pct(m.heightConfidence)}) om bouwlagen te tellen; hoogteverschil in de scan is ${meters(m.bboxM.height)}`
        );
      }
      const found = m.levels.length;
      if (c.expectedFloors === undefined) return onbekend("bouwlagen", `${found} hoogteniveau(s) herkend; geen verwacht aantal bekend`);
      if (found < c.expectedFloors) return afkeuren("bouwlagen", `${found} van de ${c.expectedFloors} bouwlagen herkend`);
      return ok("bouwlagen", `${found} hoogteniveau(s), verwacht ${c.expectedFloors}`);
    },
  },
  {
    id: "fotos",
    categorie: "Volledigheid",
    titel: "Automatische fotoverzameling stond aan",
    bron_gids: "p15 — 'Enable NeRF/PG Capture' met Frame Spacing 100",
    bron: "meting",
    evaluate: (m) => {
      if (m.photos === 0) {
        return afkeuren(
          "fotos",
          "Geen foto's in de scan — zet in Dot3D onder Settings > Scene Capture > NeRF Settings de automatische fotoverzameling aan"
        );
      }
      const perM2 = m.photos / Math.max(m.sweptAreaM2, 1);
      if (perM2 < 0.1) return twijfel("fotos", `${m.photos} foto's voor ${m2(m.sweptAreaM2)} — weinig beeld om onduidelijke plekken op te helderen`);
      return ok("fotos", `${m.photos} foto's voor ${m2(m.sweptAreaM2)}`);
    },
  },

  // ---------- Administratief ----------
  {
    id: "bestandsnaam",
    categorie: "Administratief",
    titel: "Bestandsnaam volgt de conventie en hoort bij het adres",
    bron_gids: "eigen afspraak: RAW-scans heten _raw.dp",
    bron: "meting",
    evaluate: (_m, c) => {
      if (!/_raw\.dp$/i.test(c.fileName)) return afkeuren("bestandsnaam", `"${c.fileName}" eindigt niet op _raw.dp`);
      if (!c.address) return onbekend("bestandsnaam", `"${c.fileName}"; geen adres om tegen te leggen`);
      const huisnummer = /(\d+)/.exec(c.address)?.[1];
      if (huisnummer && !c.fileName.includes(huisnummer)) {
        return twijfel("bestandsnaam", `Huisnummer ${huisnummer} komt niet terug in "${c.fileName}"`);
      }
      return ok("bestandsnaam", c.fileName);
    },
  },

  // ---------- Wat alleen met beeld te beoordelen is ----------
  // De gids schrijft deze controle zelf voor: bekijk de scan in top-down,
  // orthografisch — "the scan should look like a floor plan" (p18).
  {
    id: "gebied-doorlopen",
    categorie: "Volledigheid",
    titel: "Scanpad dekt het hele pand",
    bron_gids: "p18 'Review your scan' — beoordeel de scan in top-down",
    bron: "beeld",
    vraag:
      "Bestrijkt het scanpad een aaneengesloten gebied, of zit er een hele hoek of vleugel waar de opnemer niet is geweest? Let op uitstulpingen die er los bij hangen en op grote lege plekken midden in het gebied.",
  },
  {
    id: "samenhang",
    categorie: "Nauwkeurigheid",
    titel: "Geen breuken of losse stukken in het scanpad",
    bron_gids: "p18 — 'there should not be any major breaks or misalignments'",
    bron: "beeld",
    vraag:
      "Zie je onderbrekingen in de route, of stukken pad die er los van de rest bij liggen? Let op: dit is een RAW-scan, dus lussen die niet precies sluiten en een pad dat geleidelijk wegdraait zijn normaal — die worden bij de optimalisatie rechtgetrokken. Alleen echte breuken en losse eilanden zijn een probleem.",
  },
  {
    id: "ruimtes-compleet",
    categorie: "Volledigheid",
    titel: "Alle ruimtes gescand, ook berging, zolder, kelder en garage",
    bron_gids: "p8 — buitenruimtes en bijgebouwen horen bij de begane grond",
    bron: "beeld",
    vraag:
      "Welke soorten ruimtes zie je op de foto's terug — woonkamer, keuken, slaapkamers, badkamer, zolder, kelder, berging, garage, buitenruimte? Ontbreekt er een type ruimte dat je bij deze woning zou verwachten?",
  },
  {
    id: "deuren",
    categorie: "Nauwkeurigheid",
    titel: "Deuren stonden open en zijn niet bewogen tijdens de scan",
    bron_gids: "p11 — bewegende deuren zijn de belangrijkste foutbron in mobiele 3D-scans",
    bron: "beeld",
    vraag:
      "Zie je op de foto's dichte binnendeuren op plekken waar de scan doorheen had moeten lopen, of dezelfde deur in verschillende standen? Sluit dit aan bij ontbrekende ruimtes op de render?",
  },
  {
    id: "spiegels-glas",
    categorie: "Nauwkeurigheid",
    titel: "Geen verstoring door spiegels, glas of mensen",
    bron_gids: "p13 — 'avoid scanning mirrors - just scan around them'",
    bron: "beeld",
    vraag:
      "Kom je op de foto's grote spiegels, glazen wanden, fel tegenlicht of mensen tegen die de scan verstoord kunnen hebben?",
  },
  {
    id: "muurafstand",
    categorie: "Nauwkeurigheid",
    titel: "Voldoende afstand tot muren gehouden",
    bron_gids: "p12 — 2 tot 3 m van muren blijven, 3 tot 4 m bij blanke witte muren",
    bron: "beeld",
    vraag:
      "Zie je op de foto's veel kale witte muren van dichtbij in beeld? De gids waarschuwt daarvoor: dichtbij een blanke muur verliest de camera zijn houvast en loopt de scan uit de pas.",
  },
];

/** Draait alle deterministische controles op een volledige .dp-scan. */
export function runMeasurementChecks(m: DpMetrics, c: CheckContext): CheckResult[] {
  return CHECKLIST.filter((item) => item.bron === "meting")
    .map((item) => (item.evaluate ? item.evaluate(m, c) : item.evaluateRef?.(c)))
    .filter((r): r is CheckResult => r !== undefined);
}

/**
 * Alleen de controles over de ingevoerde maatvoering: hoeveel referentiematen
 * zijn er, tussen hoeveel tags, en overspannen ze genoeg afstand.
 *
 * Deze staan apart omdat ze naast een puntenwolk-export gedraaid worden. De
 * export bevat de punten maar weet niets van AprilTags of laseraten — die
 * gegevens zitten uitsluitend in het .dp-bestand, terwijl de gids ze wél als
 * harde eis stelt (p8).
 */
export function runReferenceChecks(c: CheckContext): CheckResult[] {
  return CHECKLIST.filter((item) => item.evaluateRef).map((item) => item.evaluateRef!(c));
}

/** De checklistpunten die uit het .dp-bestand komen, voor de weergave. */
export function referenceChecklist(): ChecklistItem[] {
  return CHECKLIST.filter((item) => item.evaluateRef);
}

/** De punten die het beoordelingsmodel moet beantwoorden. */
export function visualChecklist(): ChecklistItem[] {
  return CHECKLIST.filter((item) => item.bron === "beeld");
}

/** Zoekt de definitie bij een uitkomst op, voor de weergave. */
export function checklistItem(id: string): ChecklistItem | undefined {
  return CHECKLIST.find((item) => item.id === id);
}

/**
 * Eindoordeel over de scan. Eén afkeurpunt is genoeg om niet door te sturen;
 * een afwijking valt wel op maar houdt niets tegen, en "onbekend" telt niet
 * mee als fout maar ook niet als goedkeuring.
 */
export function overallVerdict(results: CheckResult[]): CheckStatus {
  if (results.some((r) => r.status === "afkeuren")) return "afkeuren";
  if (results.some((r) => r.status === "afwijking")) return "afwijking";
  if (results.some((r) => r.status === "twijfel")) return "twijfel";
  if (results.every((r) => r.status === "onbekend")) return "onbekend";
  return "ok";
}
