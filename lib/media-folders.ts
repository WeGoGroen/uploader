/**
 * De drie stappen van een media-opname, in de volgorde waarin ze in het veld
 * gedaan worden: eerst foto's, dan video, dan 360. Eén bron voor de stappen,
 * de knoppen en de Dropbox-submap, zodat een naam die hier verandert niet
 * stilletjes een tweede map naast de bestaande oplevert.
 */
export interface MediaStap {
  /** Interne sleutel van de stap. */
  key: "photos" | "video" | "360";
  naam: string;
  uitleg: string;
  /**
   * Submap onder de projectmap. Alles wat de opnemer aanlevert gaat onder
   * "In/Raw"; "OUT" is voor wat de bewerker teruglevert en wordt hier nooit
   * beschreven.
   */
  map: string;
  /** Wat de bestandskiezer aanbiedt; leeg = alles toestaan. */
  accept?: string;
}

export const MEDIA_STAPPEN: MediaStap[] = [
  {
    key: "photos",
    naam: "Foto's",
    uitleg: "Interieur- en gevelfoto's",
    map: "In/Raw/Photo's",
    accept: "image/*",
  },
  {
    key: "video",
    naam: "Video",
    uitleg: "Rondleidingen en drone-beelden",
    map: "In/Raw/Video",
    accept: "video/*",
  },
  {
    key: "360",
    naam: "360 graden",
    uitleg: "Panorama's en 360-opnames",
    map: "In/Raw/360",
    // Geen filter: 360-camera's leveren naast JPG ook eigen formaten (INSP,
    // INSV) die de browser niet als afbeelding of video herkent en die anders
    // niet te kiezen zouden zijn.
    accept: undefined,
  },
];
