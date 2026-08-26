// Koppeling tussen de ClickUp-documentvelden (D2 t/m D5, allemaal van het
// type "attachment") en de vaste Dropbox-submappen — gebruikt zowel om op de
// documentenpagina te tonen wat er al staat, als om die bestanden bij het
// aanmaken van de taak automatisch als bijlage in ClickUp te zetten.
export const DOCUMENT_FOLDER_MAP: { key: string; label: string; folder: string }[] = [
  { key: "D2", label: "D2 Foto's Buitengevels", folder: "Opname formulier" },
  { key: "D3", label: "D3 Plattegrond schets", folder: "Plattegronden" },
  { key: "D4", label: "D4 LAZ-bestanden", folder: "LAZ" },
  { key: "D5", label: "D5 Algemene foto's", folder: "Foto's" },
];
