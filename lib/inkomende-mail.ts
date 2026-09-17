import crypto from "node:crypto";

/**
 * Binnenkomende mail bij Resend: de handtekening controleren en de bijlagen
 * opvragen.
 *
 * Waarom hier en niet in het control center: deze app houdt de mailkoppeling,
 * net als de Dropbox- en ClickUp-tokens. Eén tokenhouder, één waarheid — zie
 * lib/mail.ts voor de uitgaande kant van dezelfde afspraak. Het control center
 * krijgt straks alleen te horen wát er binnenkwam en beslist waar het heen moet.
 *
 * Bewust zonder het pakket `svix`: het is een HMAC over drie stukjes tekst, en
 * een afhankelijkheid erbij voor twintig regels is duurder dan die regels.
 */

/** Ouder dan dit weigeren we: dan is het een herhaald verzoek van iemand anders. */
const MAX_LEEFTIJD_SECONDEN = 5 * 60;

export interface Handtekening {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
}

/**
 * Leest de drie kopregels waarmee Resend zijn webhooks ondertekent. Ze heten
 * `svix-*` (Resend gebruikt Svix) en in de nieuwere standaard `webhook-*`;
 * allebei komen voor, dus allebei accepteren.
 */
export function leesHandtekening(headers: Headers): Handtekening {
  const kies = (naam: string) => headers.get(`svix-${naam}`) ?? headers.get(`webhook-${naam}`);
  return { id: kies("id"), timestamp: kies("timestamp"), signature: kies("signature") };
}

/**
 * Klopt de handtekening over deze ruwe body?
 *
 * De body moet de tekst zijn zoals hij binnenkwam. Hem eerst als JSON lezen en
 * daarna weer uitschrijven levert een andere tekst op (spaties, volgorde) en
 * daarmee altijd een ongeldige handtekening — de klassieke val hier.
 */
export function handtekeningKlopt(
  geheim: string,
  ruweBody: string,
  kop: Handtekening,
  nuMs = Date.now()
): boolean {
  if (!geheim || !kop.id || !kop.timestamp || !kop.signature) return false;

  const moment = Number(kop.timestamp);
  if (!Number.isFinite(moment)) return false;
  if (Math.abs(nuMs / 1000 - moment) > MAX_LEEFTIJD_SECONDEN) return false;

  const sleutel = Buffer.from(geheim.replace(/^whsec_/, ""), "base64");
  if (sleutel.length === 0) return false;

  const verwacht = crypto
    .createHmac("sha256", sleutel)
    .update(`${kop.id}.${kop.timestamp}.${ruweBody}`)
    .digest("base64");

  // De kopregel kan meerdere handtekeningen bevatten ("v1,aaa v1,bbb"): tijdens
  // het wisselen van geheim ondertekent Resend met allebei.
  return kop.signature
    .split(" ")
    .map((deel) => deel.split(",").slice(1).join(","))
    .filter(Boolean)
    .some((aangeboden) => gelijk(verwacht, aangeboden));
}

function gelijk(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export interface Bijlage {
  id: string;
  filename: string;
  content_type: string | null;
  size: number | null;
  download_url: string;
  expires_at: string | null;
}

/**
 * De bijlagen van een binnengekomen mail.
 *
 * De webhook zelf draagt alleen namen en id's; het bestand haal je hiermee op.
 * De downloadlink is ongeveer een uur geldig, dus hij wordt opgehaald op het
 * moment dat er iets mee gebeurt en niet bewaard.
 */
export async function haalBijlagen(emailId: string): Promise<Bijlage[]> {
  const sleutel = process.env.RESEND_API_KEY;
  if (!sleutel) throw new Error("RESEND_API_KEY ontbreekt");

  const res = await fetch(
    `https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}/attachments`,
    { headers: { Authorization: `Bearer ${sleutel}` }, signal: AbortSignal.timeout(15_000) }
  );
  if (!res.ok) {
    throw new Error(`Resend gaf ${res.status} op de bijlagen van ${emailId}`);
  }
  const body = (await res.json()) as { data?: Bijlage[] };
  return body.data ?? [];
}

/**
 * Komt deze mail van de afzender waar we hem van verwachten?
 *
 * RVO mailt het afschrift vanaf noreply_eponline@rvo.nl. Alles daarbuiten laten
 * we met rust: een ontvangstadres dat bekend raakt, krijgt vanzelf ook post van
 * anderen, en die hoort niet in de projectmap van een klant terecht te komen.
 */
export function vanRvo(afzender: string | null | undefined): boolean {
  // Kan "RVO <noreply_eponline@rvo.nl>" zijn; het domein is waar het om gaat.
  const ruw = (afzender ?? "").toLowerCase().trim();
  const tussenHaken = /<([^>]+)>/.exec(ruw);
  const domein = (tussenHaken ? tussenHaken[1] : ruw).split("@").pop()?.trim() ?? "";
  return domein === "rvo.nl" || domein.endsWith(".rvo.nl");
}
