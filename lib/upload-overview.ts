import type { UploadTask } from "@/lib/upload-queue";
import { opnameLink } from "@/lib/opname-link";
import { normalizeForMatch, sameAddress, splitAddress } from "@/lib/address-format";
import type { DraftSamenvatting } from "@/lib/drafts";

export type Soort = "nen" | "energielabel" | "media";

export type OverzichtDraft = Pick<
  DraftSamenvatting,
  | "id"
  | "status"
  | "titel"
  | "straatnaam"
  | "accountName"
  | "incompleteDocs"
  | "updatedAt"
  | "soort"
  | "heeftMediatask"
  | "adviseur"
  | "ontbrekendeVelden"
>;

/**
 * Wat er met deze regel aan de hand is. Bepaalt de kleur en het label, zodat
 * je in één oogopslag ziet of iets loopt, vastloopt of alleen nog afgemaakt
 * moet worden — eerder moest je daarvoor de zin eronder lezen.
 */
export type Status = "bezig" | "mislukt" | "open";

/** Eén product waaraan op dit adres nog gewerkt wordt, met de weg erheen. */
export interface Product {
  soort: Soort;
  href: string;
}

/**
 * Eén regel in het dashboardpaneel: alles wat bij één adres nog open staat.
 * Bewust per ADRES en niet per Dropbox-map: een pand kan zowel een
 * energielabel als een NEN2580 hebben, en dat is één klus op één adres — twee
 * regels zou het laten lijken alsof je er twee keer heen moet.
 */
export interface Openstaand {
  sleutel: string;
  adres: string;
  /** Producten met openstaand werk; elk met een eigen bestemming. */
  producten: Product[];
  /** ClickUp-gebruiker van wie dit werk is, als dat bekend is. */
  gebruiker: string | null;
  /** null zodra er niets meer loopt: dan is een percentage geen voortgang. */
  pct: number | null;
  bezig: number;
  klaar: number;
  mislukt: UploadTask[];
  status: Status;
  /**
   * Waarom deze opname in de lijst staat, in gewone taal — als losse punten.
   * Eerder was dit één string waar de redenen met " · " aan elkaar geplakt
   * werden; bij twee of drie redenen werd dat een onleesbare regel.
   */
  redenen: string[];
  /** Wanneer er voor het laatst aan gewerkt is, of null als dat niet bekend is. */
  updatedAt: number | null;
  /**
   * Verplichte velden die nog leeg zijn (codes zoals "A7", "B2"). Alleen
   * gevuld als de veldenlijst bekend is; leeg betekent dus niet automatisch
   * "compleet", maar wel "hier valt niets over te zeggen".
   */
  ontbrekend: string[];
  /** Waar je verdergaat om die velden in te vullen. */
  invulHref: string | null;
}

/** "/Automatie NEN2580/Damrak 1, Amsterdam" → "Damrak 1, Amsterdam". */
export function adresUitPad(folderPath: string): string {
  const delen = folderPath.split("/").filter(Boolean);
  return delen[delen.length - 1] ?? folderPath;
}

export function soortUitPad(folderPath: string): Soort {
  if (/NEN/i.test(folderPath)) return "nen";
  if (/Automatie Media/i.test(folderPath)) return "media";
  return "energielabel";
}

/** Naam van een product zoals hij op het dashboard staat. */
export const PRODUCT_LABEL: Record<Soort, string> = {
  nen: "NEN2580",
  energielabel: "Energielabel",
  media: "Media",
};

const PRODUCT_BASIS: Record<Soort, string> = {
  nen: "/nen",
  energielabel: "/energielabel",
  media: "/media",
};

/**
 * Voortgang over meerdere bestanden. Bewust het gemiddelde van de percentages
 * en niet van de bytes: de wachtrij houdt geen bestandsgroottes bij, en een
 * gemiddelde dat soms te optimistisch is blijft beter te volgen dan een balk
 * die stilstaat. Afgeronde bestanden tellen als 100.
 *
 * Mislukte bestanden krijgen geen percentage. Ze houden hun laatst gemeten
 * stand vast — vaak 100, omdat het juist bij het afronden misging — en dan
 * zou er "100%" naast "1 bestand mislukt" staan. Loopt er niets meer, dan is
 * een percentage sowieso geen voortgang maar een stilstaande momentopname;
 * dan telt alleen nog de knop "Upload afmaken".
 */
export function gemiddeldPct(taken: UploadTask[]): number | null {
  const meetbaar = taken.filter((t) => t.dropbox !== "error");
  if (meetbaar.length === 0 || !taken.some((t) => t.dropbox === "uploading")) return null;
  const som = meetbaar.reduce((t, u) => t + (u.dropbox === "done" ? 100 : u.pct), 0);
  return Math.round(som / meetbaar.length);
}

function bestandenTekst(n: number): string {
  return `${n} bestand${n === 1 ? "" : "en"}`;
}

/** De straatregel zonder plaats, zodat map- en conceptnotatie samenvallen. */
function adresSleutel(adres: string): string {
  return normalizeForMatch(splitAddress(adres).street);
}

function voegProductToe(regel: Openstaand, soort: Soort, href: string) {
  const bestaand = regel.producten.find((p) => p.soort === soort);
  // Een bestemming met draft-id brengt je terug ín het formulier en wint dus
  // van een bestemming die alleen het adres meegeeft.
  if (bestaand) {
    if (href.includes("draft=")) bestaand.href = href;
    return;
  }
  regel.producten.push({ soort, href });
}

/**
 * Zet de wachtrij en de concepten om in één lijst met openstaand werk,
 * gesorteerd op wat je aandacht nodig heeft: eerst wat loopt, dan wat mislukt
 * is, dan wat alleen nog afgemaakt moet worden.
 */
export function bouwOpenstaand(
  taken: UploadTask[],
  drafts: OverzichtDraft[] | null
): Openstaand[] {
  const perAdres = new Map<string, Openstaand>();

  function regelVoor(adres: string): Openstaand {
    const sleutel = adresSleutel(adres);
    let regel = perAdres.get(sleutel);
    if (!regel) {
      regel = {
        sleutel,
        adres,
        producten: [],
        gebruiker: null,
        pct: null,
        bezig: 0,
        klaar: 0,
        mislukt: [],
        status: "open",
        redenen: [],
        updatedAt: null,
        ontbrekend: [],
        invulHref: null,
      };
      perAdres.set(sleutel, regel);
    }
    return regel;
  }

  // 1. Wat er in de wachtrij staat.
  for (const taak of taken) {
    const adres = adresUitPad(taak.folderPath);
    const regel = regelVoor(adres);
    const soort = soortUitPad(taak.folderPath);
    voegProductToe(regel, soort, `${PRODUCT_BASIS[soort]}?addr=${encodeURIComponent(adres)}`);
    if (taak.account && !regel.gebruiker) regel.gebruiker = taak.account;
    if (taak.dropbox === "uploading") regel.bezig++;
    else if (taak.dropbox === "done") regel.klaar++;
    else regel.mislukt.push(taak);
  }

  for (const regel of perAdres.values()) {
    const eigen = taken.filter((t) => adresSleutel(adresUitPad(t.folderPath)) === regel.sleutel);
    regel.pct = gemiddeldPct(eigen);
    regel.status = regel.bezig > 0 ? "bezig" : "mislukt";
    regel.redenen.push(
      regel.bezig > 0
        ? `${regel.bezig} van ${bestandenTekst(eigen.length)} nog bezig`
        : `${bestandenTekst(regel.mislukt.length)} mislukt`
    );
  }

  // Afgeronde uploads horen niet in een lijst met openstaand werk.
  for (const [sleutel, regel] of [...perAdres]) {
    if (regel.bezig === 0 && regel.mislukt.length === 0) perAdres.delete(sleutel);
  }

  // 2. Opnames die nog afgemaakt moeten worden.
  for (const d of drafts ?? []) {
    const onvolledig = (d.incompleteDocs?.length ?? 0) > 0;
    if (d.status !== "concept" && !onvolledig) continue;

    const reden = onvolledig
      ? `bijlages ontbreken in ClickUp: ${d.incompleteDocs!.join(", ")}`
      : "opname niet afgemaakt";
    const adres = splitAddress(d.straatnaam || d.titel || "Onbekend adres").street;

    const bestaand = [...perAdres.values()].find((r) => sameAddress(r.adres, d.straatnaam));
    const regel = bestaand ?? regelVoor(adres);

    /*
      Wat je gestart hebt, blijft wat het is.

      Dit werd afgeleid uit "heeft deze opname een Mediatask-order?" - en zo
      lang die er nog niet was (upload nog bezig, of het aanmaken mislukt),
      gold een NEN-opname als energielabel. Terwijl de app allang weet waar je
      begonnen bent: wie via het menu op NEN2580 klikt, legt bij het opslaan
      soort "nen" vast. Die herkomst is het antwoord, niet wat er later
      toevallig wel of niet is aangemaakt. De Mediatask-order blijft de
      terugval voor opnames van vóór dat veld.
    */
    const soort: Soort = d.soort === "nen" || d.heeftMediatask ? "nen" : "energielabel";
    /*
      En dan hoort de link daar ook heen te wijzen.

      Dit stond vast op /energielabel, ook voor NEN-opnames. Klikte je op zo'n
      regel, dan kwam je op het energielabelformulier terecht - en wie dat
      recht niet heeft (Jelle doet alleen NEN2580 en media) werd meteen
      teruggestuurd naar het dashboard. Zo kon je niet meer terug naar je eigen
      onafgemaakte NEN-upload: de enige weg erheen liep langs een deur die voor
      jou dicht zat.
    */
    const href = opnameLink({ ...d, soort, straatnaam: d.straatnaam || d.titel || adres });
    voegProductToe(regel, soort, href);
    // De adviseur op de opname wint van de ingelogde gebruiker. Bij opslaan
    // vastgelegd, dus hier geen veldenlijst en geen rekenwerk meer nodig.
    if (d.adviseur) regel.gebruiker = d.adviseur;
    else if (d.accountName && !regel.gebruiker) regel.gebruiker = d.accountName;
    regel.redenen.push(reden);
    if (d.updatedAt && d.updatedAt > (regel.updatedAt ?? 0)) regel.updatedAt = d.updatedAt;

    // Welke verplichte velden nog leeg zijn — dezelfde regels als de blokkade
    // in het formulier zelf, zodat het dashboard niet iets anders "af" noemt.
    if (d.status === "concept" && d.ontbrekendeVelden?.length) {
      regel.ontbrekend = d.ontbrekendeVelden;
      regel.invulHref = href;
    }
  }

  return [...perAdres.values()].sort((a, b) => {
    const rang = (r: Openstaand) => (r.bezig > 0 ? 0 : r.mislukt.length > 0 ? 1 : 2);
    return rang(a) - rang(b) || a.adres.localeCompare(b.adres);
  });
}
