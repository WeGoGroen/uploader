/**
 * "3 min geleden", "gisteren", "5 dagen geleden". Bedoeld om in één blik te
 * kunnen zien of iets van vanochtend is of al weken ligt — een datum en tijd
 * dwingt je daar zelf toe te rekenen.
 *
 * `nu` is een parameter en geen Date.now() binnenin, zodat dit te testen is
 * zonder de klok te manipuleren.
 *
 * `taal` volgt de taalknop; zonder opgave Nederlands, zoals het altijd was.
 */
export function relatieveTijd(ts: number, nu: number = Date.now(), taal: "nl" | "en" = "nl"): string {
  const en = taal === "en";
  const seconden = Math.round((nu - ts) / 1000);
  if (seconden < 0) return en ? "just now" : "zojuist";
  if (seconden < 60) return en ? "just now" : "zojuist";

  const minuten = Math.floor(seconden / 60);
  if (minuten < 60) return en ? `${minuten} min ago` : `${minuten} min geleden`;

  const uren = Math.floor(minuten / 60);
  if (uren < 24) return en ? `${uren} ${uren === 1 ? "hour" : "hours"} ago` : `${uren} uur geleden`;

  const dagen = Math.floor(uren / 24);
  if (dagen === 1) return en ? "yesterday" : "gisteren";
  if (dagen < 7) return en ? `${dagen} days ago` : `${dagen} dagen geleden`;

  const weken = Math.floor(dagen / 7);
  if (weken === 1) return en ? "last week" : "vorige week";
  if (dagen < 31) return en ? `${weken} weeks ago` : `${weken} weken geleden`;

  const maanden = Math.floor(dagen / 30);
  if (en) return maanden === 1 ? "last month" : `${maanden} months ago`;
  return maanden === 1 ? "vorige maand" : `${maanden} maanden geleden`;
}
