import { sameAddress } from "@/lib/address-format";

/**
 * Wat er voor een adres van vandaag al gedaan is — gedeeld door het dashboard
 * en de afspraakkaartjes op de opnamepagina's.
 *
 * De kern: alleen RECENT werk telt. Een pand waar vorig jaar al een
 * energielabel of NEN2580 is gemaakt, staat nog gewoon in ClickUp of bij
 * Mediatask. Zonder datumgrens kleurde een nieuwe afspraak op dat adres
 * meteen groen, terwijl er vandaag nog niets gebeurd was.
 */
export const RECENT_MS = 14 * 24 * 60 * 60 * 1000;

export function isRecent(ms: number | null | undefined, nu = Date.now()): boolean {
  return typeof ms === "number" && ms > 0 && nu - ms <= RECENT_MS;
}

export interface ClickUpTaakSamenvatting {
  name: string;
  /** Aanmaakmoment in ms; null als ClickUp het niet meegaf. */
  created: number | null;
}

export interface MediataskOrderSamenvatting {
  id?: number;
  address?: string;
  state?: string;
  /** Wanneer de uploader deze order aanmaakte; null = niet via de uploader
      (of langer geleden dan we dat bewaren). */
  viaUploaderOp?: number | null;
}

/** Mediatask-statussen waarin een order afgerond (of afgebroken) is. */
const AFGEROND = new Set(["finished", "delivered", "paid", "accepted", "cancelled", "canceled", "rejected"]);

/**
 * Telt deze Mediatask-order mee voor een afspraak van vandaag?
 *
 * Mediatask geeft in de orderlijst geen aanmaakdatum, dus de grens loopt
 * anders dan bij ClickUp: een order die de uploader recent maakte telt (dat
 * moment leggen we zelf vast), en verder alleen een order die nog loopt. Een
 * afgeronde order zonder ons tijdstempel is werk van vroeger.
 */
export function orderTeltMee(o: MediataskOrderSamenvatting, nu = Date.now()): boolean {
  if (o.viaUploaderOp) return isRecent(o.viaUploaderOp, nu);
  return !!o.state && !AFGEROND.has(o.state);
}

export function recenteClickUpTaak(
  taken: ClickUpTaakSamenvatting[],
  street: string,
  nu = Date.now()
): ClickUpTaakSamenvatting | null {
  return taken.find((t) => isRecent(t.created, nu) && sameAddress(t.name, street)) ?? null;
}

/** De meest relevante recente order: via de uploader gaat vóór, daarna ingediend boven concept. */
export function recenteMediataskOrder(
  orders: MediataskOrderSamenvatting[],
  street: string,
  nu = Date.now()
): MediataskOrderSamenvatting | null {
  const matches = orders.filter((o) => !!o.address && sameAddress(o.address, street) && orderTeltMee(o, nu));
  if (!matches.length) return null;
  const score = (o: MediataskOrderSamenvatting) => (o.viaUploaderOp ? 2 : 0) + (o.state !== "draft" ? 1 : 0);
  return [...matches].sort((a, b) => score(b) - score(a))[0];
}

/**
 * De status die een afspraak per dienst toont:
 *  - "geupload"  via de uploader en goed afgerond
 *  - "elders"    er staat recent een taak/order, maar niet via de uploader
 *  - "onaf"      via de uploader gestart, nog niet afgerond (concept, bijlages)
 *  - "handmatig" door de opnemer zelf als gedaan gemarkeerd
 *  - null        nog niets gedaan
 */
export type DienstStatus = "geupload" | "elders" | "onaf" | "handmatig" | null;

export function nenStatus(args: {
  order: MediataskOrderSamenvatting | null;
  /** Een recent concept in de uploader dat een Mediatask-order heeft. */
  conceptMetOrder: boolean;
  handmatig: boolean;
}): DienstStatus {
  const { order, conceptMetOrder, handmatig } = args;
  if (order) {
    const viaUploader = !!order.viaUploaderOp || conceptMetOrder;
    if (!viaUploader) return "elders";
    // Zelf als gedaan gemarkeerd wint van "nog niet af": de opnemer weet
    // dan iets wat de order (nog) niet laat zien.
    if (order.state === "draft") return handmatig ? "handmatig" : "onaf";
    return "geupload";
  }
  // Order (nog) niet in de lijst, maar ons concept zegt dat hij er is: de
  // lijst kan achterlopen of de order viel buiten de eerste pagina.
  if (conceptMetOrder) return "geupload";
  return handmatig ? "handmatig" : null;
}

export function energielabelStatus(args: {
  taak: ClickUpTaakSamenvatting | null;
  /** Een recent concept in de uploader dat geüpload is of een taak heeft. */
  conceptGeupload: boolean;
  bijlagesOntbreken: boolean;
  handmatig: boolean;
}): DienstStatus {
  const { taak, conceptGeupload, bijlagesOntbreken, handmatig } = args;
  if (conceptGeupload && !bijlagesOntbreken) return "geupload";
  if (handmatig) return "handmatig";
  if (conceptGeupload) return "onaf";
  return taak ? "elders" : null;
}
