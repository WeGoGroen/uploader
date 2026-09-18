/**
 * De opmerking die bij een Mediatask-order wordt geplaatst.
 *
 * Dit is het enige stuk tekst dat hun verwerker bij de order te zien krijgt, en
 * in de praktijk de weg waarlangs hij bij de foto's en video's komt — aan de
 * order zelf kunnen die niet hangen, want elke schrijfactie op het photos-veld
 * geeft 422. Vandaar Engels: hun verwerkers lezen geen Nederlands.
 *
 * Los van de route gehouden zodat de vorm te testen is zonder Mediatask of
 * Dropbox erbij te halen. De route zoekt de mappen en links op; hier staat
 * alleen hoe dat tot tekst wordt.
 */

/** Eén Dropbox-map zoals hij in de opmerking terechtkomt. */
export interface OpmerkingMap {
  /** Engelse kop, bv. "Photos". */
  kop: string;
  /** Aantal bestanden in de map. Staat achter de kop, zodat de verwerker ziet
      of hij alles binnen heeft voordat hij de map opent. */
  aantal: number;
  /** Gedeelde link naar de map zélf, niet naar de losse bestanden. */
  url: string;
  /** Eventuele extra regel onder de kop, bv. dat de scans ook al aan de order
      hangen en deze link een terugvalweg is. */
  toelichting?: string;
}

function ordinal(n: number): string {
  const rest10 = n % 10;
  const rest100 = n % 100;
  if (rest10 === 1 && rest100 !== 11) return `${n}st`;
  if (rest10 === 2 && rest100 !== 12) return `${n}nd`;
  if (rest10 === 3 && rest100 !== 13) return `${n}rd`;
  return `${n}th`;
}

/** Een bouwlaag zoals de verwerker hem leest: "ground floor", "1st floor",
    "basement level 2". */
export function verdiepingLabel(n: number): string {
  if (n === 0) return "ground floor";
  if (n < 0) return `basement level ${-n}`;
  return `${ordinal(n)} floor`;
}

export function bouwOrderOpmerking({
  verdiepingenPerBestand,
  mappen,
}: {
  /** Per scanbestand de bouwlagen die erin zitten. */
  verdiepingenPerBestand: Record<string, number[]>;
  /** De mappen met bestanden, in de volgorde waarin ze moeten staan. */
  mappen: OpmerkingMap[];
}): string {
  const blokken: string[] = [];

  // Per scanbestand de bouwlagen, zodat de verwerker ziet wélke scan welke
  // verdiepingen bevat — bij meerdere scans op één adres is dat het verschil
  // tussen bruikbaar en giswerk.
  const verdiepingen = Object.entries(verdiepingenPerBestand)
    .filter(([, lagen]) => lagen.length > 0)
    .map(
      ([naam, lagen]) =>
        `• ${naam} — ${lagen
          .slice()
          .sort((a, b) => a - b)
          .map(verdiepingLabel)
          .join(", ")}`
    );
  if (verdiepingen.length > 0) {
    blokken.push(`Scanned floors per file:\n${verdiepingen.join("\n")}`);
  }

  /*
    Eén link per map, niet één per bestand.

    Een opname met dertig foto's leverde dertig regels URL op, waar de rest van
    de opmerking onder wegviel — terwijl de verwerker toch de hele map nodig
    heeft. Nu staat er per map één link naar de map zelf.

    De URL staat kaal op een eigen regel: Mediatask toont de opmerking als
    platte tekst en maakt daar zelf een klikbare link van. Tekst eromheen, of
    een punt erachter, kan die herkenning breken.
  */
  const gevuld = mappen.filter((m) => m.aantal > 0);
  if (gevuld.length > 0) {
    blokken.push(
      "The survey files are in Dropbox. Each link below opens a folder — you can view the files there or download the whole folder at once."
    );
    for (const map of gevuld) {
      const kop = `${map.kop} (${map.aantal} ${map.aantal === 1 ? "file" : "files"})`;
      blokken.push([kop, map.toelichting, map.url].filter(Boolean).join("\n"));
    }
  }

  return blokken.join("\n\n");
}
