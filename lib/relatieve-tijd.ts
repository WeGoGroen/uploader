/**
 * "3 min geleden", "gisteren", "5 dagen geleden". Bedoeld om in één blik te
 * kunnen zien of iets van vanochtend is of al weken ligt — een datum en tijd
 * dwingt je daar zelf toe te rekenen.
 *
 * `nu` is een parameter en geen Date.now() binnenin, zodat dit te testen is
 * zonder de klok te manipuleren.
 */
export function relatieveTijd(ts: number, nu: number = Date.now()): string {
  const seconden = Math.round((nu - ts) / 1000);
  if (seconden < 0) return "zojuist";
  if (seconden < 60) return "zojuist";

  const minuten = Math.floor(seconden / 60);
  if (minuten < 60) return `${minuten} min geleden`;

  const uren = Math.floor(minuten / 60);
  if (uren < 24) return `${uren} uur geleden`;

  const dagen = Math.floor(uren / 24);
  if (dagen === 1) return "gisteren";
  if (dagen < 7) return `${dagen} dagen geleden`;

  const weken = Math.floor(dagen / 7);
  if (weken === 1) return "vorige week";
  if (dagen < 31) return `${weken} weken geleden`;

  const maanden = Math.floor(dagen / 30);
  return maanden === 1 ? "vorige maand" : `${maanden} maanden geleden`;
}
