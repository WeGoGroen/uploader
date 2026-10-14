/**
 * Waarom staat een Mediatask-order op "action required"?
 *
 * Mediatask zegt het zelf niet in de order: er is geen veld met de reden. Wat
 * er wél is: de puntenwolken (een afgekeurde heeft geen voorbeeldbeelden), de
 * opmerkingen van hun verwerker, en onze eigen Dropbox-map met wat er bij de
 * opname gemaakt is. Naast elkaar gelegd is de oorzaak meestal te zien —
 * en of wij hem zelf kunnen wegnemen.
 *
 * Los van de route gehouden zodat het oordeel te testen is zonder Mediatask of
 * Dropbox erbij te halen.
 */

export interface Opmerking {
  tekst: string;
  door: string | null;
  op: string | null;
}

export interface Diagnose {
  orderId: number;
  state: string | null;
  /** Dropbox-map van de opname, als we die nog kennen (bewaard 30 dagen). */
  pad: string | null;
  puntenwolken: number;
  /** Scans die Mediatask afkeurde (geen voorbeeldbeelden). */
  afgekeurd: string[];
  /** Scans die in Dropbox staan maar niet aan de order hangen. */
  ontbreekt: string[];
  scansInDropbox: number;
  /** Laatste opmerkingen van Mediatask zelf, nieuwste eerst. */
  opmerkingen: Opmerking[];
  /** Kunnen wij het zelf rechtzetten door scans (opnieuw) te sturen? */
  herstelbaar: boolean;
  /** In één zin, voor op de kaart in het Control Center. */
  samenvatting: string;
}

/** Ons eigen handtekeningetje onder een opmerking; zie afkeuren/route.ts. */
const VAN_ONS = /\(WeGoGroen\)\s*$/;

/**
 * Een opmerking uit het antwoord van Mediatask lezen, welke vorm hij ook heeft.
 *
 * Het endpoint is niet gedocumenteerd; we kennen alleen de schrijfkant
 * ({comment: "..."}). Daarom de gangbare veldnamen aflopen in plaats van op
 * één vorm te vertrouwen.
 */
export function leesOpmerking(ruw: unknown): Opmerking | null {
  if (typeof ruw === "string") return ruw.trim() ? { tekst: ruw.trim(), door: null, op: null } : null;
  if (!ruw || typeof ruw !== "object") return null;
  const r = ruw as Record<string, unknown>;
  const tekst = [r.comment, r.body, r.text, r.content, r.message].find(
    (v): v is string => typeof v === "string" && v.trim().length > 0
  );
  if (!tekst) return null;
  const gebruiker = (r.user ?? r.author ?? r.created_by) as Record<string, unknown> | string | null | undefined;
  const door =
    typeof gebruiker === "string"
      ? gebruiker
      : gebruiker && typeof gebruiker === "object"
        ? String(gebruiker.full_name ?? gebruiker.name ?? gebruiker.username ?? "") || null
        : null;
  const op = [r.created_at, r.createdAt, r.date].find((v): v is string => typeof v === "string") ?? null;
  return { tekst: tekst.trim(), door, op };
}

export function opmerkingenVanMediatask(ruw: unknown[]): Opmerking[] {
  return ruw
    .map(leesOpmerking)
    .filter((o): o is Opmerking => o !== null && !VAN_ONS.test(o.tekst))
    .sort((a, b) => (b.op ?? "").localeCompare(a.op ?? ""))
    .slice(0, 3);
}

export function stelDiagnose(invoer: {
  orderId: number;
  state: string | null;
  pad: string | null;
  puntenwolken: number;
  afgekeurd: string[];
  aanwezig: Set<string>;
  inDropbox: string[] | null;
  opmerkingen: Opmerking[];
}): Diagnose {
  const inDropbox = invoer.inDropbox ?? [];
  const ontbreekt = inDropbox.filter((n) => !invoer.aanwezig.has(n));
  // Een afgekeurde scan opnieuw sturen kan alleen als hij nog in Dropbox staat.
  const afgekeurdTeSturen = invoer.afgekeurd.filter((n) => inDropbox.includes(n));
  const herstelbaar = Boolean(invoer.pad) && (ontbreekt.length > 0 || afgekeurdTeSturen.length > 0);

  const delen: string[] = [];
  if (invoer.afgekeurd.length > 0) {
    delen.push(
      `Mediatask keurde ${invoer.afgekeurd.length === 1 ? "de scan" : `${invoer.afgekeurd.length} scans`} af (${invoer.afgekeurd.join(", ")})`
    );
  }
  if (ontbreekt.length > 0) {
    delen.push(
      `${ontbreekt.length === 1 ? "één scan staat" : `${ontbreekt.length} scans staan`} wel in Dropbox maar niet bij Mediatask (${ontbreekt.join(", ")})`
    );
  }
  if (invoer.puntenwolken === 0 && inDropbox.length === 0) {
    delen.push(invoer.pad ? "er is geen enkele scan, ook niet in Dropbox" : "er hangt geen scan aan de order");
  }
  if (invoer.opmerkingen[0]) delen.push(`Mediatask schreef: "${invoer.opmerkingen[0].tekst.slice(0, 200)}"`);
  if (!invoer.pad && (invoer.afgekeurd.length > 0 || invoer.puntenwolken === 0)) {
    delen.push("de Dropbox-map van deze order is niet meer bekend, dus opnieuw sturen kan alleen met de hand");
  }

  const samenvatting =
    delen.length > 0
      ? `${delen[0].charAt(0).toUpperCase()}${delen[0].slice(1)}${delen.length > 1 ? `; ${delen.slice(1).join("; ")}` : ""}.`
      : "Aan de scans is niets te zien; de reden staat alleen in Mediatask zelf.";

  return {
    orderId: invoer.orderId,
    state: invoer.state,
    pad: invoer.pad,
    puntenwolken: invoer.puntenwolken,
    afgekeurd: invoer.afgekeurd,
    ontbreekt,
    scansInDropbox: inDropbox.length,
    opmerkingen: invoer.opmerkingen,
    herstelbaar,
    samenvatting,
  };
}

/** De opmerking die we na het herstel bij de order zetten. Engels: hun
    verwerkers lezen geen Nederlands (zie mediatask-opmerking.ts). */
export function herstelOpmerking(verstuurd: string[], door: string | null): string {
  const lijst = verstuurd.join(", ");
  const tekst = `We have (re-)uploaded the point cloud${verstuurd.length === 1 ? "" : "s"}: ${lijst}. Please continue processing the order.`;
  return door ? `${tekst}\n\n— ${door} (WeGoGroen)` : `${tekst}\n\n— (WeGoGroen)`;
}
