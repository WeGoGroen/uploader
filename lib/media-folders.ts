import type { MediaSoort } from "@/lib/media-herkennen";

/**
 * De drie soorten van een media-opname: foto's, video en 360. Eén bron voor
 * de kolommen en de Dropbox-submap, zodat een naam die hier verandert niet
 * stilletjes een tweede map naast de bestaande oplevert.
 *
 * Ooit drie stappen na elkaar, met per stap een eigen knop; nu kiest de
 * opnemer alles in één keer en verdeelt lib/media-herkennen.ts de bestanden.
 * De sleutel heet daarom nog "stap".
 */
export interface MediaStap {
  /** Interne sleutel van de stap. */
  key: "photos" | "video" | "360";
  /** Wat de herkenning teruggeeft voor een bestand dat hier hoort. */
  soort: MediaSoort;
  naam: string;
  uitleg: string;
  /**
   * Submap onder de projectmap. Alles wat de opnemer aanlevert gaat onder
   * "In/Raw"; "OUT" is voor wat de bewerker teruglevert en wordt hier nooit
   * beschreven.
   */
  map: string;
}

/*
  Geen bestandsfilter meer per soort. Er is één kiezer voor alles, en die
  filtert bewust niet: een iPad zet een bestand grijs zodra hij de extensie niet
  aan een type kan koppelen, en dat gebeurde met RAW (.ARW, .CR3), drone-clips
  en Insta360 (.insp, .insv). Wat er niet hoort, laat de herkenning liggen —
  met de reden erbij, in plaats van een grijs bestand zonder uitleg.
*/
export const MEDIA_STAPPEN: MediaStap[] = [
  {
    key: "photos",
    soort: "foto",
    naam: "Foto's",
    uitleg: "RAW en JPEG van de camera",
    map: "In/Raw/Photo's",
  },
  {
    key: "video",
    soort: "video",
    naam: "Video",
    uitleg: "Clips, MP4 of MOV",
    map: "In/Raw/Video",
  },
  {
    key: "360",
    soort: "360",
    naam: "360 graden",
    uitleg: "Panorama's en 360-opnames",
    map: "In/Raw/360",
  },
];

/**
 * Gaat dit pad naar de aanlevering van een media-opname ("…/In/Raw/…")?
 *
 * Daar mag een upload nooit een ander bestand overschrijven. Twee camera's die
 * allebei bij DSC00001 beginnen, of een drone en een 360-camera met dezelfde
 * teller, leverden met "overwrite" stil verlies van beeld op: het tweede
 * bestand verving het eerste. Bij deze paden laat Dropbox een bestand met een
 * andere inhoud naast het bestaande landen ("DSC00001 (1).ARW"); exact
 * dezelfde inhoud nog eens versturen (een herkansing) is geen conflict en
 * levert dus ook geen dubbel op.
 *
 * Alleen de media-aanlevering: bij een energielabel of NEN2580 is dezelfde
 * naam opnieuw uploaden juist een nieuwe versie die de oude moet vervangen.
 */
export function isMediaAanlevering(pad: string): boolean {
  return /\/In\/Raw\//i.test(pad);
}

/** De commit-instelling voor Dropbox bij dit pad; zie isMediaAanlevering. */
export function schrijfwijze(pad: string): { mode: "add" | "overwrite"; autorename: boolean } {
  return isMediaAanlevering(pad) ? { mode: "add", autorename: true } : { mode: "overwrite", autorename: false };
}
