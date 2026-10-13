/**
 * De bestandsnaam uit een downloadlink die Mediatask teruggeeft.
 *
 * Mediatask geeft S3-links met de naam in de query, als
 * `response-content-disposition=attachment%3B%20filename%3D%22IMG_1.jpg%22`.
 * Hiermee kijken de koppelingen welke scans en foto's er al aan een order
 * hangen, zodat er niets dubbel verstuurd wordt.
 *
 * Dit stond twee keer in de code, met een reguliere expressie op de rauwe
 * URL: `filename%3D%22([^%]+)%22`. Die stopt bij het eerste procentteken, en
 * een spatie is in een URL `%20`. Een bestand als "IMG 1.jpg" of "Voorgevel
 * ö.jpg" werd dus niet herkend, gold als "nog niet aanwezig", en ging bij elke
 * afrond-klik en elke herstelronde opnieuw naar Mediatask.
 *
 * Nu wordt de query eerst netjes ontleed (de browser-URL decodeert zelf), en
 * daarna de Content-Disposition gelezen zoals die bedoeld is, inclusief de
 * `filename*=UTF-8''…`-vorm voor namen met bijzondere tekens.
 */
export function naamUitDisposition(disposition: string): string | null {
  // filename*=UTF-8''Voorgevel%20%C3%B6.jpg  (RFC 5987) gaat voor.
  const uitgebreid = /filename\*\s*=\s*(?:[\w-]+)?'[^']*'([^;]+)/i.exec(disposition);
  if (uitgebreid) {
    try {
      return decodeURIComponent(uitgebreid[1].trim().replace(/^"|"$/g, ""));
    } catch {
      // Kapotte codering: dan de gewone vorm hieronder proberen.
    }
  }
  const tussenAanhalingstekens = /filename\s*=\s*"([^"]*)"/i.exec(disposition);
  if (tussenAanhalingstekens) return tussenAanhalingstekens[1] || null;
  const kaal = /filename\s*=\s*([^;]+)/i.exec(disposition);
  return kaal ? kaal[1].trim() || null : null;
}

export function naamUitUrl(url: string, opties: { terugvalOpPad?: boolean } = {}): string | null {
  let ontleed: URL | null = null;
  try {
    ontleed = new URL(url);
  } catch {
    ontleed = null;
  }

  if (ontleed) {
    for (const [, waarde] of ontleed.searchParams) {
      if (/filename/i.test(waarde)) {
        const naam = naamUitDisposition(waarde);
        if (naam) return naam;
      }
    }
  } else if (/filename/i.test(url)) {
    // Geen geldige URL, maar wel een disposition erin: eenmaal decoderen.
    let tekst = url;
    try {
      tekst = decodeURIComponent(url);
    } catch {
      // laten zoals het is
    }
    const naam = naamUitDisposition(tekst);
    if (naam) return naam;
  }

  if (!opties.terugvalOpPad) return null;
  const pad = ontleed ? ontleed.pathname : url.split("?")[0];
  const laatste = pad.split("/").pop();
  if (!laatste) return null;
  try {
    return decodeURIComponent(laatste);
  } catch {
    return laatste;
  }
}
