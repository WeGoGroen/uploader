/**
 * Het opnameformulier zoals het in ClickUp staat, klaargemaakt om af te
 * drukken.
 *
 * De velden heten daar "A1 Adres:", "B3 Isolatie gevel", "D8.2 Polycam link".
 * Die codes zijn geen rommel maar de indeling van het formulier zelf: A is het
 * pand, B de isolatie, C de aanbouw, D wat er is meegestuurd, E de opmerkingen.
 * Deze module leest die codes en zet ze om in groepen — in plaats van de
 * eenenvijftig veldnamen hier over te tikken.
 *
 * Dat onderscheid is de reden dat het zo werkt: wie in ClickUp een veld
 * toevoegt of hernoemt, wil dat terugzien in het dossier zonder dat hier iets
 * verandert. Alleen als er een héle nieuwe groepletter bijkomt hoort dat op te
 * vallen — en dat valt op, want dan staat de groep er zonder titel.
 */

export interface RuwVeld {
  name: string;
  type?: string;
  value?: unknown;
  type_config?: {
    options?: { id?: string; orderindex?: number; name?: string; label?: string }[];
  };
}

export interface DossierVeld {
  /** De code uit ClickUp: A1, B7, D8.2. Zonder die code is een regel in het
      dossier niet terug te vinden in de taak. */
  code: string;
  label: string;
  /** Null als het veld leeg is; leeg blijft staan in het dossier, want een
      niet-ingevuld veld is informatie. */
  waarde: string | null;
}

export interface DossierGroep {
  letter: string;
  titel: string;
  velden: DossierVeld[];
}

export interface DossierBijlage {
  code: string;
  label: string;
  naam: string;
  /** Kleine versie van ClickUp; het origineel is een foto van drie megabyte en
      die past niet vijftig keer in één PDF. */
  miniatuurUrl: string | null;
  url: string;
  mime: string;
}

/** De groepen van het formulier. Wat hier niet in staat, komt niet in het
    dossier: de Mo-velden zijn de controles van MO Consultancy en worden pas ná
    de aanvraag ingevuld. */
export const GROEP_TITELS: Record<string, string> = {
  A: "Algemeen",
  B: "Isolatie",
  C: "Aanbouw",
  D: "Wat er is meegestuurd",
  E: "Opmerkingen",
};

const CODE_RE = /^([A-E])(\d+(?:\.\d+)?)\s+(.*)$/;

/** Splitst "D8.2 Polycam link - 1e verdieping" in code en label. Geeft null bij
    alles wat niet bij het formulier hoort: "Created", "Mo-1 Check Vloer". */
export function splitsCode(naam: string): { letter: string; code: string; nummer: number; label: string } | null {
  const m = CODE_RE.exec(naam.trim());
  if (!m) return null;
  const [, letter, nummer, label] = m;
  return {
    letter,
    code: `${letter}${nummer}`,
    nummer: Number(nummer),
    label: label.replace(/:$/, "").trim(),
  };
}

function optieNaam(veld: RuwVeld, waarde: unknown): string {
  const opties = veld.type_config?.options ?? [];
  const treffer = opties.find((o) => o.id === waarde || o.orderindex === waarde);
  return treffer?.name ?? treffer?.label ?? String(waarde);
}

const MAANDEN = [
  "januari", "februari", "maart", "april", "mei", "juni",
  "juli", "augustus", "september", "oktober", "november", "december",
];

export function datumTekst(ms: number): string {
  const d = new Date(ms);
  return `${d.getDate()} ${MAANDEN[d.getMonth()]} ${d.getFullYear()}`;
}

export function datumTijdTekst(ms: number): string {
  const d = new Date(ms);
  const uu = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${datumTekst(ms)}, ${uu}:${mm}`;
}

/**
 * De waarde van één veld als leesbare tekst, of null als het leeg is.
 *
 * ClickUp geeft per veldtype iets anders terug: een optie-id bij een dropdown,
 * een lijst id's bij labels, een object bij geld. Eén functie die daar tekst
 * van maakt, zodat de opmaak verderop geen veldtypes hoeft te kennen.
 */
export function veldTekst(veld: RuwVeld): string | null {
  const v = veld.value;
  if (v === null || v === undefined || v === "") return null;
  if (Array.isArray(v) && v.length === 0) return null;

  switch (veld.type) {
    case "drop_down":
      return optieNaam(veld, v);
    case "labels":
      return Array.isArray(v)
        ? v.map((id) => optieNaam(veld, id)).filter(Boolean).join(", ") || null
        : String(v);
    case "checkbox":
      // "false" telt als niet ingevuld: een uitgevinkt vakje en een vakje waar
      // niemand naar gekeken heeft zijn in dit formulier hetzelfde.
      return v === true || v === "true" ? "Ja" : null;
    case "date": {
      const ms = Number(v);
      return Number.isFinite(ms) ? datumTekst(ms) : null;
    }
    case "attachment": {
      if (!Array.isArray(v)) return null;
      return v.length === 1 ? "1 bestand" : `${v.length} bestanden`;
    }
    case "users":
      return Array.isArray(v)
        ? v.map((u) => (u as { username?: string })?.username ?? "").filter(Boolean).join(", ") || null
        : String(v);
    default: {
      if (typeof v === "object") {
        const o = v as { value?: unknown; formatted?: unknown };
        const tekst = String(o.formatted ?? o.value ?? "");
        return tekst.trim() || null;
      }
      const tekst = String(v).trim();
      return tekst || null;
    }
  }
}

/**
 * Alle formuliervelden, gegroepeerd en op volgorde van hun code.
 *
 * ClickUp geeft de velden in willekeurige volgorde terug — die van de laatste
 * wijziging, niet die van het formulier. Sorteren op de code herstelt de
 * volgorde waarin de opnemer ze op zijn iPad heeft ingevuld, en dat is de enige
 * volgorde waarin het formulier te lezen is.
 */
export function bouwGroepen(velden: RuwVeld[]): DossierGroep[] {
  const perLetter = new Map<string, (DossierVeld & { nummer: number })[]>();

  for (const veld of velden) {
    const gesplitst = splitsCode(veld.name);
    if (!gesplitst) continue;
    const rij = {
      code: gesplitst.code,
      label: gesplitst.label,
      nummer: gesplitst.nummer,
      waarde: veldTekst(veld),
    };
    perLetter.set(gesplitst.letter, [...(perLetter.get(gesplitst.letter) ?? []), rij]);
  }

  return [...perLetter.keys()]
    .sort()
    .map((letter) => ({
      letter,
      titel: GROEP_TITELS[letter] ?? letter,
      velden: perLetter
        .get(letter)!
        .sort((a, b) => a.nummer - b.nummer || a.label.localeCompare(b.label))
        .map(({ code, label, waarde }) => ({ code, label, waarde })),
    }));
}

/**
 * De bijlagen die aan de formuliervelden hangen, met het veld erbij waar ze
 * onder zijn gezet. Dat veld is het bijschrift in het dossier: een foto onder
 * "D2 Foto's Buitengevels" betekent iets anders dan dezelfde foto onder "D5".
 */
export function bijlagenUitVelden(velden: RuwVeld[]): DossierBijlage[] {
  const uit: DossierBijlage[] = [];

  for (const veld of velden) {
    if (veld.type !== "attachment" || !Array.isArray(veld.value)) continue;
    const gesplitst = splitsCode(veld.name);
    if (!gesplitst) continue;

    for (const b of veld.value as Record<string, unknown>[]) {
      const url = typeof b.url === "string" ? b.url : "";
      if (!url) continue;
      uit.push({
        code: gesplitst.code,
        label: gesplitst.label,
        naam: typeof b.title === "string" ? b.title : url.split("/").pop() || "bijlage",
        /*
          De grote miniatuur (900x1200), niet de middelste (225x300).

          Op de tegel van vier centimeter lijkt dat verspilling, maar een PDF
          wordt gelezen op een scherm en daar wordt ingezoomd. Op 900 pixels is
          het typeplaatje onderop een cv-ketel leesbaar — merk, type, bouwjaar,
          vermogens — en op 225 is het een grijze vlek. Dat verschil is precies
          waar dit dossier voor bedoeld is.

          Het origineel (3088 pixels, ~2,4 MB per foto) zou 120 MB per dossier
          worden; de grote miniatuur kost 130 KB en is genoeg gebleken.
        */
        miniatuurUrl:
          (typeof b.thumbnail_large === "string" ? b.thumbnail_large : null) ??
          (typeof b.thumbnail_medium === "string" ? b.thumbnail_medium : null),
        url,
        mime: typeof b.mimetype === "string" ? b.mimetype : "",
      });
    }
  }

  return uit;
}
