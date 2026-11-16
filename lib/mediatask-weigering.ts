/**
 * Wat te doen als Mediatask een schrijfactie op een order weigert met 403.
 *
 * Mediatask stuurt bij zo'n weigering een leeg antwoord ("{}") terug: geen
 * woord over het waarom. In de praktijk zijn er twee oorzaken, en die vragen
 * elk iets anders:
 *
 *   1. De order staat op naam van een ander dan de sleutel waarmee we werken.
 *      De orderlijst is die van het hele bureau, dus een concept van een
 *      collega (of een dat nog met de gedeelde sleutel is aangemaakt) wordt
 *      gewoon gevonden en hergebruikt — lezen en een opmerking plaatsen mag
 *      dan, maar bestanden aanmelden en indienen niet. Dan helpt het om het
 *      met de sleutel van de eigenaar te doen.
 *   2. De order is geen concept meer. Aan een ingediende order valt niets toe
 *      te voegen; dat is geen storing maar een feit, en "indienen" is dan al
 *      gebeurd.
 *
 * Los van lib/mediatask.ts gehouden zodat het oordeel te testen is zonder
 * Redis, sessie of Mediatask erbij te halen.
 */

/** Het ordernummer uit een API-pad, alleen bij een schrijfactie op die order. */
export function orderVanSchrijfactie(path: string, method: string | undefined): number | null {
  if (!method || method.toUpperCase() === "GET") return null;
  const m = /^\/api\/orders\/(\d+)(?:[/?]|$)/.exec(path);
  return m ? Number(m[1]) : null;
}

/** De sleutels om het nog eens mee te proberen: zonder de geweigerde, zonder dubbelen. */
export function andereSleutels(geweigerd: string, kandidaten: (string | null | undefined)[]): string[] {
  const uit: string[] = [];
  for (const k of kandidaten) {
    if (!k || k === geweigerd || uit.includes(k)) continue;
    uit.push(k);
  }
  return uit;
}

/** Is deze order al voorbij het concept? Dan is indienen niet meer nodig. */
export function alIngediend(state: string | null | undefined): boolean {
  return Boolean(state) && state !== "draft";
}

/** De weigering in gewone taal, voor op het scherm van de opnemer. */
export function weigeringUitleg(invoer: {
  orderId: number;
  state: string | null;
  eigenaar: string | null;
}): string {
  if (alIngediend(invoer.state)) {
    return `Order #${invoer.orderId} staat bij Mediatask al op "${invoer.state}": daar kan via de uploader niets meer aan toegevoegd worden. Voeg het bestand toe in Mediatask zelf, of gebruik de Dropbox-link in de opmerking bij de order.`;
  }
  const wie = invoer.eigenaar ? ` De order staat op naam van ${invoer.eigenaar}.` : "";
  return `Mediatask staat niet toe dat order #${invoer.orderId} hiervandaan gewijzigd wordt.${wie} Geen van de Mediatask-sleutels in de uploader mag dat; laat de eigenaar zijn sleutel op zijn account zetten of pas de order aan in Mediatask zelf.`;
}
