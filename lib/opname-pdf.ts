import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb, type RGB } from "pdf-lib";
import type { DossierGroep } from "@/lib/opname-velden";

/**
 * Het opnameformulier als PDF, in de opmaak van het Business Control Center.
 *
 * Waarom hier en niet met een HTML-naar-PDF-dienst: dit draait op Vercel achter
 * een agent, en een browser meestarten voor één A4 is een tweede systeem dat
 * kan omvallen op het moment dat er niemand kijkt. pdf-lib tekent rechtstreeks
 * en heeft geen browser, geen lettertypebestanden en geen netwerk nodig.
 *
 * De maten staan in punten (72 per inch), niet in pixels: dit is papier.
 */

const A4 = { breedte: 595.276, hoogte: 841.89 };

const MARGE = { links: 39, rechts: 39, boven: 34, onder: 30 };
const BREEDTE = A4.breedte - MARGE.links - MARGE.rechts;

const KOP_HOOGTE = 26;
const VOET_HOOGTE = 24;

/* Hetzelfde palet als het dashboard (app/globals.css). Groen is een
   statuskleur en geen versiering; op papier geldt dat net zo goed. */
const KLEUR = {
  tekst: rgb(0.067, 0.075, 0.071),
  zacht: rgb(0.42, 0.447, 0.502),
  rand: rgb(0.925, 0.925, 0.925),
  leeg: rgb(0.725, 0.749, 0.745),
  groen: rgb(0.659, 0.878, 0.373),
  groenDiep: rgb(0.302, 0.486, 0.059),
  groenZacht: rgb(0.941, 0.976, 0.91),
  blauw: rgb(0.012, 0.412, 0.631),
  blauwZacht: rgb(0.878, 0.949, 0.992),
  vlak: rgb(0.957, 0.961, 0.961),
};

const MAAT = {
  titel: 22,
  sectie: 15,
  kopKlein: 8.5,
  label: 8.5,
  waarde: 10.5,
  bijschrift: 8,
  voet: 7.5,
};

const REGEL = { waarde: 13, label: 10.5, bijschrift: 9.5 };

const PANEEL = { padding: 14, radius: 11, kolomGat: 16, rijGat: 10 };
const FOTO = { kolommen: 4, rijGat: 9, bijschriftGat: 3, rijenPerPagina: 4 };
/** Hoogte van de sectiekop boven een fotoraster; nodig om de tegels zo te maken
    dat er vier rijen op passen in plaats van drie met een lege onderkant. */
const SECTIE_HOOGTE = 40;

/** Eén foto zoals hij in het dossier komt: de bytes plus waar hij vandaan komt. */
export interface DossierFoto {
  code: string;
  label: string;
  naam: string;
  bytes: Uint8Array;
  /** "image/jpeg" of "image/png"; iets anders komt hier niet binnen. */
  mime: string;
}

export interface DossierInvoer {
  adres: string;
  postcodePlaats: string;
  taakId: string;
  taakNaam: string;
  status: string;
  adviseur: string | null;
  gebouwtype: string | null;
  bouwjaar: string | null;
  aangemaaktMs: number | null;
  streefdatumMs: number | null;
  groepen: DossierGroep[];
  fotos: DossierFoto[];
  /** Bijlagen die geen afbeelding zijn — video's, een LAZ-scan. Die kunnen niet
      afgedrukt worden, maar horen wel vermeld: anders lijkt het dossier
      completer dan de opname was. */
  andereBijlagen: { code: string; naam: string }[];
  opgehaaldOp: Date;
}

/*
  Helvetica kan alleen Latin-1. Een mapnaam met een bolletje erin (🟢) of een
  slim aanhalingsteken uit ClickUp laat pdf-lib anders midden in het genereren
  omvallen — en dan is er geen dossier in plaats van een dossier met een
  rechte apostrof.
*/
const VERVANG: Record<string, string> = {
  "‘": "'",
  "’": "'",
  "‚": "'",
  "“": '"',
  "”": '"',
  "–": "-",
  "—": "-",
  "−": "-",
  "…": "...",
  " ": " ",
  "•": "-",
  "→": "->",
  "€": "EUR",
};

export function veilig(tekst: string): string {
  // Regeleindes eerst naar een spatie: het adresveld in ClickUp is twee regels,
  // en zonder deze stap wordt "104 E" + "1012 MR" tot "104 E1012 MR".
  let t = tekst.replace(/\s+/g, " ");
  for (const [van, naar] of Object.entries(VERVANG)) t = t.split(van).join(naar);
  return Array.from(t)
    .map((ch) => {
      const c = ch.codePointAt(0) ?? 0;
      if (c === 32 || (c >= 33 && c <= 126)) return ch;
      if (c >= 0xa0 && c <= 0xff) return ch;
      return "";
    })
    .join("")
    .trim();
}

function knip(tekst: string, font: PDFFont, grootte: number, breedte: number): string[] {
  const woorden = veilig(tekst).split(/\s+/).filter(Boolean);
  const regels: string[] = [];
  let huidig = "";

  for (const woord of woorden) {
    const kandidaat = huidig ? `${huidig} ${woord}` : woord;
    if (font.widthOfTextAtSize(kandidaat, grootte) <= breedte) {
      huidig = kandidaat;
      continue;
    }
    if (huidig) regels.push(huidig);

    // Een woord dat zelf niet past — een lange bestandsnaam — hard afbreken.
    let rest = woord;
    while (font.widthOfTextAtSize(rest, grootte) > breedte && rest.length > 1) {
      let n = rest.length;
      while (n > 1 && font.widthOfTextAtSize(rest.slice(0, n), grootte) > breedte) n--;
      regels.push(rest.slice(0, n));
      rest = rest.slice(n);
    }
    huidig = rest;
  }

  if (huidig) regels.push(huidig);
  return regels.length ? regels : [""];
}

function kort(tekst: string, font: PDFFont, grootte: number, breedte: number): string {
  const schoon = veilig(tekst);
  if (font.widthOfTextAtSize(schoon, grootte) <= breedte) return schoon;
  let n = schoon.length;
  while (n > 1 && font.widthOfTextAtSize(`${schoon.slice(0, n)}...`, grootte) > breedte) n--;
  return `${schoon.slice(0, n)}...`;
}

/** Afgeronde rechthoek als pad; pdf-lib tekent alleen rechte rechthoeken. */
function rondPad(breedte: number, hoogte: number, r: number): string {
  const k = r * 0.5523;
  return [
    `M ${r} 0`,
    `H ${breedte - r}`,
    `C ${breedte - r + k} 0 ${breedte} ${r - k} ${breedte} ${r}`,
    `V ${hoogte - r}`,
    `C ${breedte} ${hoogte - r + k} ${breedte - r + k} ${hoogte} ${breedte - r} ${hoogte}`,
    `H ${r}`,
    `C ${r - k} ${hoogte} 0 ${hoogte - r + k} 0 ${hoogte - r}`,
    `V ${r}`,
    `C 0 ${r - k} ${r - k} 0 ${r} 0`,
    "Z",
  ].join(" ");
}

const MAANDEN = [
  "januari", "februari", "maart", "april", "mei", "juni",
  "juli", "augustus", "september", "oktober", "november", "december",
];

function datum(d: Date): string {
  return `${d.getDate()} ${MAANDEN[d.getMonth()]} ${d.getFullYear()}`;
}

function datumTijd(d: Date): string {
  return `${datum(d)}, ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * De tekenlaag: houdt bij op welke pagina en hoe hoog we zitten, en begint een
 * nieuwe pagina zodra het volgende blok er niet meer op past.
 */
class Vel {
  pagina!: PDFPage;
  y = 0;

  constructor(
    readonly doc: PDFDocument,
    readonly normaal: PDFFont,
    readonly vet: PDFFont,
    private readonly kopregel: string,
    private readonly kopRechts: string
  ) {}

  nieuwePagina(): void {
    this.pagina = this.doc.addPage([A4.breedte, A4.hoogte]);
    this.tekenKop();
    this.y = A4.hoogte - MARGE.boven - KOP_HOOGTE;
  }

  /** Zorgt dat er `hoogte` punten vrij zijn; anders een nieuwe pagina. */
  ruimte(hoogte: number): void {
    if (!this.pagina) this.nieuwePagina();
    else if (this.y - hoogte < MARGE.onder + VOET_HOOGTE) this.nieuwePagina();
  }

  schrijf(tekst: string, x: number, y: number, grootte: number, kleur: RGB, vet = false): void {
    this.pagina.drawText(veilig(tekst), {
      x,
      y,
      size: grootte,
      font: vet ? this.vet : this.normaal,
      color: kleur,
    });
  }

  private tekenKop(): void {
    const top = A4.hoogte - MARGE.boven;

    // Het merkteken: donker vlak met de groene wijzer erin. Klein gehouden —
    // dit is een dossier, geen briefpapier.
    const zijde = 13;
    this.pagina.drawSvgPath(rondPad(zijde, zijde, 3.4), {
      x: MARGE.links,
      y: top,
      color: KLEUR.tekst,
      borderWidth: 0,
    });
    this.pagina.drawCircle({
      x: MARGE.links + zijde / 2,
      y: top - zijde + 4.2,
      size: 1.1,
      color: KLEUR.groen,
    });
    this.pagina.drawLine({
      start: { x: MARGE.links + zijde / 2, y: top - zijde + 4.6 },
      end: { x: MARGE.links + zijde - 3.6, y: top - 3.4 },
      thickness: 1,
      color: KLEUR.groen,
    });

    const basis = top - zijde + 3.4;
    this.schrijf(this.kopregel.toUpperCase(), MARGE.links + zijde + 6, basis, MAAT.kopKlein, KLEUR.zacht, true);

    const rechts = veilig(this.kopRechts);
    const breedteRechts = this.normaal.widthOfTextAtSize(rechts, MAAT.kopKlein);
    this.schrijf(rechts, A4.breedte - MARGE.rechts - breedteRechts, basis, MAAT.kopKlein, KLEUR.zacht);

    this.pagina.drawLine({
      start: { x: MARGE.links, y: top - KOP_HOOGTE + 8 },
      end: { x: A4.breedte - MARGE.rechts, y: top - KOP_HOOGTE + 8 },
      thickness: 0.75,
      color: KLEUR.rand,
    });
  }
}

/** Chip zoals op het dashboard: rond vlak, bolletje, tekst. */
function tekenChip(
  vel: Vel,
  x: number,
  y: number,
  tekst: string,
  vulling: RGB,
  inkt: RGB
): number {
  const schoon = veilig(tekst);
  const tekstBreedte = vel.normaal.widthOfTextAtSize(schoon, MAAT.label);
  const breedte = tekstBreedte + 24;
  const hoogte = 15;

  vel.pagina.drawSvgPath(rondPad(breedte, hoogte, hoogte / 2), {
    x,
    y: y + hoogte,
    color: vulling,
    borderWidth: 0,
  });
  vel.pagina.drawCircle({ x: x + 9, y: y + hoogte / 2, size: 2, color: inkt });
  vel.schrijf(schoon, x + 15, y + 4.6, MAAT.label, inkt);
  return breedte;
}

interface Cel {
  /** Het label is al afgebroken: "D8.3 - Polycam link - 2e verdieping (indien
      aanwezig)" past niet op één regel en liep anders over de buurkolom heen. */
  labelRegels: string[];
  regels: string[];
  leeg: boolean;
}

/**
 * Een groep velden als paneel. Meten en tekenen zitten in één functie omdat de
 * hoogte pas bekend is als de waarden zijn afgebroken — en die hoogte bepaalt
 * of het paneel nog op deze pagina past.
 */
function tekenLegeGroep(vel: Vel, groep: DossierGroep): void {
  const hoogte = REGEL.label + 8 + REGEL.waarde + 2 * PANEEL.padding;
  vel.ruimte(hoogte + 8);
  const top = vel.y;

  vel.pagina.drawSvgPath(rondPad(BREEDTE, hoogte, PANEEL.radius), {
    x: MARGE.links,
    y: top,
    borderColor: KLEUR.rand,
    borderWidth: 0.75,
  });

  const y = top - PANEEL.padding - REGEL.label + 2;
  vel.schrijf(
    `${groep.letter} \u00b7 ${groep.titel}`.toUpperCase(),
    MARGE.links + PANEEL.padding,
    y,
    MAAT.kopKlein,
    KLEUR.zacht,
    true
  );
  vel.schrijf(
    `Niet ingevuld \u2014 alle ${groep.velden.length} velden (${groep.velden[0].code}-${groep.velden[groep.velden.length - 1].code}) zijn leeg.`,
    MARGE.links + PANEEL.padding,
    y - 8 - REGEL.waarde + 3,
    MAAT.waarde,
    KLEUR.leeg
  );

  vel.y = top - hoogte - 8;
}

function tekenGroep(vel: Vel, groep: DossierGroep, kolommen: number): void {
  /*
    Een groep waar niets van is ingevuld krijgt één regel in plaats van een
    raster met zes streepjes. Weglaten zou het dossier onvolledig maken — dat er
    geen aanbouw is opgegeven, is informatie — maar een half A4 aan lege vakjes
    zegt hetzelfde met meer papier.
  */
  if (groep.velden.length > 1 && groep.velden.every((v) => v.waarde === null)) {
    tekenLegeGroep(vel, groep);
    return;
  }

  const kolomBreedte =
    (BREEDTE - 2 * PANEEL.padding - (kolommen - 1) * PANEEL.kolomGat) / kolommen;

  const cellen: Cel[] = groep.velden.map((v) => ({
    labelRegels: knip(`${v.code} \u00b7 ${v.label}`, vel.normaal, MAAT.label, kolomBreedte),
    leeg: v.waarde === null,
    regels: v.waarde === null ? ["-"] : knip(v.waarde, vel.normaal, MAAT.waarde, kolomBreedte),
  }));

  const rijen: Cel[][] = [];
  for (let i = 0; i < cellen.length; i += kolommen) rijen.push(cellen.slice(i, i + kolommen));

  /* De hoogte van een rij is die van de langste cel erin: labels en waarden
     blijven zo over de kolommen heen op één lijn staan. */
  const rijHoogte = (rij: Cel[]) =>
    Math.max(...rij.map((c) => c.labelRegels.length)) * REGEL.label +
    2 +
    Math.max(...rij.map((c) => c.regels.length)) * REGEL.waarde;

  const kopHoogte = REGEL.label + 8;
  const inhoud =
    kopHoogte +
    rijen.reduce((som, rij) => som + rijHoogte(rij), 0) +
    Math.max(0, rijen.length - 1) * PANEEL.rijGat;
  const paneelHoogte = inhoud + 2 * PANEEL.padding;

  vel.ruimte(paneelHoogte + 8);

  const top = vel.y;
  vel.pagina.drawSvgPath(rondPad(BREEDTE, paneelHoogte, PANEEL.radius), {
    x: MARGE.links,
    y: top,
    borderColor: KLEUR.rand,
    borderWidth: 0.75,
  });

  let y = top - PANEEL.padding - REGEL.label + 2;
  vel.schrijf(
    `${groep.letter} \u00b7 ${groep.titel}`.toUpperCase(),
    MARGE.links + PANEEL.padding,
    y,
    MAAT.kopKlein,
    KLEUR.zacht,
    true
  );
  y -= 8;

  for (const rij of rijen) {
    const labelRegels = Math.max(...rij.map((c) => c.labelRegels.length));

    rij.forEach((cel, i) => {
      const x = MARGE.links + PANEEL.padding + i * (kolomBreedte + PANEEL.kolomGat);

      let ly = y - MAAT.label;
      for (const regel of cel.labelRegels) {
        vel.schrijf(regel, x, ly, MAAT.label, KLEUR.zacht);
        ly -= REGEL.label;
      }

      let wy = y - labelRegels * REGEL.label - 2 - MAAT.waarde;
      for (const regel of cel.regels) {
        vel.schrijf(regel, x, wy, MAAT.waarde, cel.leeg ? KLEUR.leeg : KLEUR.tekst);
        wy -= REGEL.waarde;
      }
    });

    y -= rijHoogte(rij) + PANEEL.rijGat;
  }

  vel.y = top - paneelHoogte - 8;
}

function tekenSectiekop(vel: Vel, titel: string, onder: string): void {
  vel.ruimte(REGEL.waarde * 3);
  vel.y -= MAAT.sectie;
  vel.schrijf(titel, MARGE.links, vel.y, MAAT.sectie, KLEUR.tekst, true);
  vel.y -= REGEL.label + 1;
  vel.schrijf(onder, MARGE.links, vel.y, MAAT.label, KLEUR.zacht);
  vel.y -= 12;
}

async function tekenFotos(
  vel: Vel,
  doc: PDFDocument,
  titel: string,
  fotos: DossierFoto[]
): Promise<number> {
  /*
    De tegel wordt afgeleid van de pagina en niet andersom.

    Met een vaste tegelmaat pasten er drie rijen op en bleef er een kwart
    pagina wit staan: net te weinig voor een vierde rij. Nu is de hoogte precies
    een vierde van wat er over is, en de breedte volgt daaruit — zo staat een
    staande opnamefoto strak in zijn vak.
  */
  const beschikbaar =
    A4.hoogte - MARGE.boven - KOP_HOOGTE - MARGE.onder - VOET_HOOGTE - SECTIE_HOOGTE;
  const tegelHoogte =
    (beschikbaar - (FOTO.rijenPerPagina - 1) * FOTO.rijGat) / FOTO.rijenPerPagina;
  const vakHoogte = tegelHoogte - FOTO.bijschriftGat - REGEL.bijschrift;
  const vakBreedte = Math.min(
    (BREEDTE - (FOTO.kolommen - 1) * 12) / FOTO.kolommen,
    (vakHoogte * 3) / 4
  );
  const gat = (BREEDTE - FOTO.kolommen * vakBreedte) / (FOTO.kolommen - 1);

  let geplaatst = 0;

  for (let i = 0; i < fotos.length; i += FOTO.kolommen) {
    const rij = fotos.slice(i, i + FOTO.kolommen);

    const vorigePagina = vel.pagina;
    vel.ruimte(tegelHoogte + FOTO.rijGat);
    if (vel.pagina !== vorigePagina) {
      // Op een vervolgpagina staat de sectiekop niet meer; zonder deze regel
      // weet je bij pagina vijf niet meer welk veld je aan het bekijken bent.
      vel.y -= MAAT.label;
      vel.schrijf(`${titel} (vervolg)`, MARGE.links, vel.y, MAAT.label, KLEUR.zacht);
      vel.y -= 10;
    }

    const top = vel.y;

    for (let k = 0; k < rij.length; k++) {
      const foto = rij[k];
      const x = MARGE.links + k * (vakBreedte + gat);

      vel.pagina.drawSvgPath(rondPad(vakBreedte, vakHoogte, 6), {
        x,
        y: top,
        color: KLEUR.vlak,
        borderColor: KLEUR.rand,
        borderWidth: 0.75,
      });

      try {
        const plaatje = foto.mime.includes("png")
          ? await doc.embedPng(foto.bytes)
          : await doc.embedJpg(foto.bytes);
        // Passend binnen het vak, niet bijgesneden: bij een opname wil je de
        // hele foto zien, ook als hij liggend is.
        const schaal = Math.min((vakBreedte - 2) / plaatje.width, (vakHoogte - 2) / plaatje.height);
        const b = plaatje.width * schaal;
        const h = plaatje.height * schaal;
        vel.pagina.drawImage(plaatje, {
          x: x + (vakBreedte - b) / 2,
          y: top - vakHoogte + (vakHoogte - h) / 2,
          width: b,
          height: h,
        });
        geplaatst++;
      } catch {
        // Een foto die ClickUp niet wil geven of die pdf-lib niet leest, mag
        // het dossier niet tegenhouden: leeg vak, naam eronder.
        vel.schrijf("(niet leesbaar)", x + 6, top - vakHoogte / 2, MAAT.bijschrift, KLEUR.leeg);
      }

      vel.schrijf(
        kort(foto.naam, vel.normaal, MAAT.bijschrift, vakBreedte),
        x,
        top - vakHoogte - FOTO.bijschriftGat - MAAT.bijschrift,
        MAAT.bijschrift,
        KLEUR.zacht
      );
    }

    vel.y = top - tegelHoogte - FOTO.rijGat;
  }

  return geplaatst;
}

/** Bouwt het dossier. Geeft de PDF terug; opslaan doet de aanroeper. */
export async function bouwOpnameDossier(invoer: DossierInvoer): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Opnameformulier ${veilig(invoer.adres)}`);
  doc.setSubject(`ClickUp-taak ${invoer.taakId}`);
  doc.setProducer("WeGoGroen");
  doc.setCreator("Energielabel AI Agent");

  const normaal = await doc.embedFont(StandardFonts.Helvetica);
  const vet = await doc.embedFont(StandardFonts.HelveticaBold);

  const vel = new Vel(
    doc,
    normaal,
    vet,
    `${invoer.adres} \u00b7 Opnameformulier`,
    invoer.aangemaaktMs
      ? `Aanvraag \u00b7 ${datum(new Date(invoer.aangemaaktMs))}`
      : "Aanvraag"
  );
  vel.nieuwePagina();

  /* --- De kop: adres, wie het opnam, en de datums ------------------------- */

  vel.y -= MAAT.titel;
  vel.schrijf(invoer.adres, MARGE.links, vel.y, MAAT.titel, KLEUR.tekst, true);

  const rechterKolom = A4.breedte - MARGE.rechts;
  const datums: [string, string][] = [
    ["Aangemaakt", invoer.aangemaaktMs ? datumTijd(new Date(invoer.aangemaaktMs)) : "-"],
    ["Streefdatum", invoer.streefdatumMs ? datum(new Date(invoer.streefdatumMs)) : "-"],
  ];
  let dy = vel.y + MAAT.titel - REGEL.label;
  for (const [label, waarde] of datums) {
    const lb = normaal.widthOfTextAtSize(veilig(label), MAAT.label);
    vel.schrijf(label, rechterKolom - lb, dy, MAAT.label, KLEUR.zacht);
    dy -= REGEL.waarde;
    const wb = normaal.widthOfTextAtSize(veilig(waarde), MAAT.waarde);
    vel.schrijf(waarde, rechterKolom - wb, dy, MAAT.waarde, KLEUR.tekst);
    dy -= REGEL.waarde + 2;
  }

  vel.y -= REGEL.waarde + 1;
  vel.schrijf(
    [invoer.postcodePlaats, invoer.adviseur ? `opgenomen door ${invoer.adviseur}` : null]
      .filter(Boolean)
      .join(" \u00b7 "),
    MARGE.links,
    vel.y,
    MAAT.waarde,
    KLEUR.zacht
  );

  vel.y -= 22;
  let chipX = MARGE.links;
  const chips: [string, RGB, RGB][] = [];
  if (invoer.gebouwtype) chips.push([invoer.gebouwtype, KLEUR.blauwZacht, KLEUR.blauw]);
  if (invoer.bouwjaar) chips.push([`Bouwjaar ${invoer.bouwjaar}`, KLEUR.vlak, KLEUR.zacht]);
  const bijlagen = invoer.fotos.length + invoer.andereBijlagen.length;
  chips.push([
    bijlagen === 1 ? "1 bijlage" : `${bijlagen} bijlagen`,
    bijlagen > 0 ? KLEUR.groenZacht : KLEUR.vlak,
    bijlagen > 0 ? KLEUR.groenDiep : KLEUR.zacht,
  ]);
  for (const [tekst, vulling, inkt] of chips) {
    chipX += tekenChip(vel, chipX, vel.y, tekst, vulling, inkt) + 6;
  }
  vel.y -= 16;

  /* --- De groepen van het formulier --------------------------------------- */

  for (const groep of invoer.groepen) {
    // Opmerkingen zijn lopende tekst; die gaan over de volle breedte staan in
    // plaats van in drie smalle kolommen waar niets in past.
    tekenGroep(vel, groep, groep.letter === "E" ? 1 : 3);
  }

  /* --- De bijlagen die geen foto zijn ------------------------------------- */

  if (invoer.andereBijlagen.length > 0) {
    tekenGroep(
      vel,
      {
        letter: "D",
        titel: "Bijlagen die niet af te drukken zijn",
        velden: invoer.andereBijlagen.map((b) => ({ code: b.code, label: "bestand", waarde: b.naam })),
      },
      2
    );
  }

  /* --- De foto's, per veld waar ze onder hangen --------------------------- */

  const perVeld = new Map<string, DossierFoto[]>();
  for (const foto of invoer.fotos) {
    const sleutel = `${foto.code} \u00b7 ${foto.label}`;
    perVeld.set(sleutel, [...(perVeld.get(sleutel) ?? []), foto]);
  }

  for (const [sleutel, fotos] of perVeld) {
    vel.nieuwePagina();
    tekenSectiekop(
      vel,
      sleutel,
      fotos.length === 1 ? "1 foto uit de opname" : `${fotos.length} foto's uit de opname`
    );
    await tekenFotos(vel, doc, sleutel, fotos);
  }

  /* --- Voetregels, als het aantal pagina's bekend is ---------------------- */

  const paginas = doc.getPages();
  paginas.forEach((pagina, i) => {
    pagina.drawLine({
      start: { x: MARGE.links, y: MARGE.onder + VOET_HOOGTE - 10 },
      end: { x: A4.breedte - MARGE.rechts, y: MARGE.onder + VOET_HOOGTE - 10 },
      thickness: 0.75,
      color: KLEUR.rand,
    });
    const links = veilig(
      `ClickUp-taak ${invoer.taakId} \u00b7 opgehaald op ${datumTijd(invoer.opgehaaldOp)}`
    );
    pagina.drawText(links, {
      x: MARGE.links,
      y: MARGE.onder,
      size: MAAT.voet,
      font: normaal,
      color: KLEUR.zacht,
    });
    const rechts = `Pagina ${i + 1} van ${paginas.length}`;
    pagina.drawText(rechts, {
      x: A4.breedte - MARGE.rechts - normaal.widthOfTextAtSize(rechts, MAAT.voet),
      y: MARGE.onder,
      size: MAAT.voet,
      font: normaal,
      color: KLEUR.zacht,
    });
  });

  return doc.save();
}
