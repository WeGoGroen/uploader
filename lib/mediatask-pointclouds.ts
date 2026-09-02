import { createHash } from "node:crypto";
import { getSharedAccessToken, listFolderFiles, openFileStream } from "@/lib/dropbox";
import { attachPointclouds, listPointclouds, requestPointcloudUploads } from "@/lib/mediatask";
import { getOptionalRedis } from "@/lib/redis";

/**
 * Scans uit Dropbox als puntenwolk aan een Mediatask-order hangen.
 *
 * Dit hoort bewust op de server en niet in de pagina: er zijn twee plekken
 * waar een NEN-order ontstaat (rechtstreeks vanaf de orderpagina en via de
 * documentenpagina), en toen alleen die tweede de puntenwolk meestuurde,
 * kwam een order die op de eerste manier gemaakt was zonder scan aan.
 * Eén plek die het altijd doet is het enige wat dat voorkomt.
 *
 * De browser kan dit niet zelf: de S3-bucket van Mediatask geeft ons domein
 * geen CORS-toestemming, dus een upload vanaf de iPad wordt geweigerd nog
 * voordat hij begint. Onze server heeft die beperking niet.
 */

/**
 * Vertaalt een technische fout naar iets waar een opnemer wat mee kan.
 *
 * De rauwe tekst hoort in de logboeken, niet op het scherm: "Dropbox
 * files/download failed: 409 {path/not_found}" zegt niemand iets, terwijl het
 * antwoord ("het bestand staat er niet meer") wél tot een handeling leidt.
 */
export function leesbareFout(err: unknown): string {
  const t = err instanceof Error ? err.message : String(err);
  if (/not_found/i.test(t)) return "het bestand staat niet meer in Dropbox";
  if (/insufficient_space/i.test(t)) return "Dropbox zit vol";
  if (/expired_access_token|invalid_access_token/i.test(t)) return "de Dropbox-koppeling is verlopen";
  if (/\b(401|403)\b/.test(t)) return "Mediatask weigerde het verzoek (geen toegang)";
  if (/\b(429)\b/.test(t)) return "te veel verzoeken tegelijk — probeer het zo nog eens";
  if (/\b(50\d)\b/.test(t)) return "Mediatask of Dropbox gaf een serverfout";
  if (/Amazon weigerde/i.test(t)) return t;
  return t.slice(0, 120);
}

export interface ScanUitkomst {
  naam: string;
  ok: boolean;
  fout?: string;
  /** Hing al aan de order (op de achtergrond verstuurd tijdens het uploaden)
      en is dus niet opnieuw verstuurd. */
  alAanwezig?: boolean;
}

/**
 * De bestandsnamen die al als puntenwolk aan een order hangen.
 *
 * Nodig sinds scans al tijdens het uploaden (per bestand, op de achtergrond)
 * doorgestuurd worden: bij het afronden van de order zou alles anders een
 * tweede keer verstuurd worden en dubbel aan de order komen te hangen.
 */
export async function alAanwezigeNamen(orderId: number): Promise<Set<string>> {
  const aanwezig = await listPointclouds(orderId).catch(() => []);
  return new Set(
    aanwezig.map((p) => naamUitUrl(p.url)).filter((n): n is string => Boolean(n))
  );
}

/** MD5 die de iPad (of een eerdere doorgang) al berekend heeft. */
export interface Md5Hint {
  /** MD5 in base64, het formaat dat S3 in de uploadlink meetekent. */
  checksum: string;
  grootte: number;
}

/**
 * MD5-cache per Dropbox-pad. Gevuld door de iPad (die hasht het bestand
 * terwijl het nog in het geheugen zit) of door een eerdere serverdoorgang.
 * Scheelt bij elke volgende verzending van dezelfde scan de complete
 * hash-doorgang door Dropbox — de helft van het serververkeer.
 */
const MD5_PREFIX = "mediatask:md5:";
const MD5_TTL = 60 * 60 * 24 * 7;

export async function bewaarMd5(path: string, hint: Md5Hint): Promise<void> {
  const redis = getOptionalRedis();
  if (!redis) return;
  await redis.set(`${MD5_PREFIX}${path}`, JSON.stringify(hint), "EX", MD5_TTL).catch(() => {});
}

export async function leesMd5(path: string): Promise<Md5Hint | null> {
  const redis = getOptionalRedis();
  if (!redis) return null;
  const ruw = await redis.get(`${MD5_PREFIX}${path}`).catch(() => null);
  if (!ruw) return null;
  try {
    const hint = JSON.parse(ruw) as Md5Hint;
    return hint.checksum && hint.grootte > 0 ? hint : null;
  } catch {
    return null;
  }
}

/**
 * De upload zelf: aanmelden bij Mediatask, één doorgang Dropbox → S3, en
 * koppelen. Vereist een vooraf bekende MD5 — S3 tekent die mee in de
 * uploadlink en controleert 'm bij aankomst, dus een verkeerde hash (of een
 * ondertussen vervangen bestand) wordt daar hard geweigerd.
 */
async function uploadNaarMediatask(
  orderId: number,
  path: string,
  token: string,
  hint: Md5Hint
): Promise<{ pointcloudId: number; bytes: number; aanwezig: number }> {
  const naam = path.split("/").pop() ?? "scan";
  const doelen = await requestPointcloudUploads(orderId, [
    {
      filename: naam,
      byte_size: String(hint.grootte),
      checksum: hint.checksum,
      content_type: "application/octet-stream",
    },
  ]);
  const doel = doelen.pointclouds?.[0];
  if (!doel?.url) throw new Error("Mediatask gaf geen uploadlink terug");

  const bron = await openFileStream(token, path);
  const put = await fetch(doel.url, {
    method: "PUT",
    headers: { ...doel.headers, "Content-Length": String(hint.grootte) },
    body: bron.stream,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  if (!put.ok) {
    const body = await put.text().catch(() => "");
    throw new Error(`Amazon weigerde de scan (${put.status}). ${body.slice(0, 200)}`);
  }

  await attachPointclouds(orderId, [
    { pointcloud_id: doel.pointcloud_id, signed_blob_id: doel.blob_id },
  ]);
  // Teruglezen is de enige harde bevestiging dat hij er ook echt aan hangt.
  const aanwezig = await listPointclouds(orderId).catch(() => []);
  return { pointcloudId: doel.pointcloud_id, bytes: hint.grootte, aanwezig: aanwezig.length };
}

/**
 * Eén scan doorsturen: aanmelden, uploaden, koppelen.
 *
 * Met een bekende MD5 (van de iPad of uit de cache) is één doorgang door
 * Dropbox genoeg. Zonder — of als S3 de bekende hash weigert omdat het
 * bestand ondertussen anders is — valt dit terug op het oude tweetraps­pad:
 * eerst streamen om te hashen, dan streamen om te versturen. Het resultaat is
 * in alle gevallen even betrouwbaar; alleen de snelheid verschilt.
 */
export async function stuurScanVanuitDropbox(
  orderId: number,
  path: string,
  accessToken?: string,
  hint?: Md5Hint | null
): Promise<{ pointcloudId: number; bytes: number; aanwezig: number }> {
  const token = accessToken ?? (await getSharedAccessToken());

  const bekend = hint ?? (await leesMd5(path));
  if (bekend) {
    try {
      const uitkomst = await uploadNaarMediatask(orderId, path, token, bekend);
      void bewaarMd5(path, bekend);
      return uitkomst;
    } catch (err) {
      // Kan van alles zijn (verkeerde hash, maar ook een Mediatask-storing);
      // de verse-hash-poging hieronder is in beide gevallen het juiste
      // antwoord en gedraagt zich als de retry die er vroeger ook al was.
      console.error(`Scan versturen met bekende MD5 mislukt (${path}), opnieuw met verse hash`, err);
    }
  }

  // Doorgang 1: meten en hashen. Streamen i.p.v. inlezen: een scan van
  // honderden MB's in het geheugen laat een serverless-functie omvallen.
  const eerste = await openFileStream(token, path);
  const hash = createHash("md5");
  let bytes = 0;
  for await (const blok of eerste.stream as unknown as AsyncIterable<Uint8Array>) {
    hash.update(blok);
    bytes += blok.byteLength;
  }
  const vers: Md5Hint = { checksum: hash.digest("base64"), grootte: bytes || eerste.size };
  void bewaarMd5(path, vers);

  // Doorgang 2: dezelfde bytes doorzetten naar S3.
  return uploadNaarMediatask(orderId, path, token, vers);
}

/**
 * Alle scans uit de Optimized-map van een project doorsturen.
 *
 * Eén voor één en nooit blokkerend: een scan die niet aankomt mag de order
 * niet laten sneuvelen — die bestaat op dat moment al, en een tweede poging
 * zou een dubbele order opleveren. Wat er misging komt per bestand terug.
 */
export async function stuurScansVanuitDropbox(
  orderId: number,
  projectPad: string
): Promise<ScanUitkomst[]> {
  const token = await getSharedAccessToken();
  const bestanden = await listFolderFiles(token, `${projectPad}/Optimized`).catch(() => []);
  const uitkomsten: ScanUitkomst[] = [];

  // Wat er al hangt niet nóg eens versturen: scans gaan tegenwoordig al
  // tijdens het uploaden op de achtergrond mee, en het afronden van de order
  // komt daar overheen.
  const alAanwezig = await alAanwezigeNamen(orderId);

  for (const bestand of bestanden) {
    if (alAanwezig.has(bestand.name)) {
      uitkomsten.push({ naam: bestand.name, ok: true, alAanwezig: true });
      continue;
    }
    try {
      await stuurScanVanuitDropbox(orderId, `${projectPad}/Optimized/${bestand.name}`, token);
      uitkomsten.push({ naam: bestand.name, ok: true });
    } catch (err) {
      uitkomsten.push({
        naam: bestand.name,
        ok: false,
        fout: leesbareFout(err),
      });
    }
  }
  return uitkomsten;
}


/**
 * Onthoudt bij welke Dropbox-map een order hoort.
 *
 * Nodig om een scan later opnieuw te kunnen versturen: Mediatask weet niets
 * van onze mappenstructuur, en zonder deze koppeling is een mislukte
 * puntenwolk alleen nog met de hand recht te zetten.
 */
const PAD_PREFIX = "mediatask:pad:";
const TIJD_PREFIX = "mediatask:aangemaakt:";

export async function bewaarOrderPad(orderId: number, projectPad: string): Promise<void> {
  const redis = getOptionalRedis();
  if (!redis) return;
  await redis.set(`${PAD_PREFIX}${orderId}`, projectPad, "EX", 60 * 60 * 24 * 30).catch(() => {});
  // Mediatask geeft zelf geen aanmaakmoment terug in de orderlijst, en zonder
  // dat kun je "nog aan het verwerken" niet onderscheiden van "hangt al een
  // dag". Daarom leggen we het hier vast.
  await redis
    .set(`${TIJD_PREFIX}${orderId}`, String(Date.now()), "EX", 60 * 60 * 24 * 30)
    .catch(() => {});
}

/** Wanneer wij deze order aanmaakten, in milliseconden. */
export async function leesOrderTijd(orderId: number): Promise<number | null> {
  const redis = getOptionalRedis();
  if (!redis) return null;
  const t = await redis.get(`${TIJD_PREFIX}${orderId}`).catch(() => null);
  return t ? Number(t) : null;
}

export async function leesOrderPad(orderId: number): Promise<string | null> {
  const redis = getOptionalRedis();
  if (!redis) return null;
  return redis.get(`${PAD_PREFIX}${orderId}`).catch(() => null);
}

/** De bestandsnaam zit in de downloadlink die Mediatask teruggeeft. */
function naamUitUrl(url: string): string | null {
  const m = /filename%3D%22([^%]+)%22/.exec(url) ?? /filename="([^"]+)"/.exec(url);
  return m ? decodeURIComponent(m[1]) : null;
}

export interface HerstelUitkomst {
  orderId: number;
  gecontroleerd: number;
  mislukt: string[];
  opnieuwVerstuurd: string[];
  nietGelukt: string[];
  reden?: string;
}

/**
 * Controleert of Mediatask de puntenwolken van een order ook echt verwerkt
 * heeft, en verstuurt opnieuw wat er mis ging.
 *
 * Aankomen en verwerkt worden zijn twee verschillende dingen: het koppelen kan
 * melden dat alles goed ging terwijl hun verwerker het bestand daarna alsnog
 * afkeurt. Dat is aan de voorbeeldbeelden te zien — een verwerkte puntenwolk
 * heeft er een handvol, een mislukte geen enkele. Dat is het enige signaal dat
 * hun API hierover geeft.
 */
export async function controleerEnHerstel(
  orderId: number,
  opties: { alleenKijken?: boolean } = {}
): Promise<HerstelUitkomst> {
  const uit: HerstelUitkomst = {
    orderId,
    gecontroleerd: 0,
    mislukt: [],
    opnieuwVerstuurd: [],
    nietGelukt: [],
  };

  const puntenwolken = await listPointclouds(orderId).catch(() => null);
  if (!puntenwolken) {
    uit.reden = "order niet gevonden bij Mediatask";
    return uit;
  }
  uit.gecontroleerd = puntenwolken.length;

  const kapot = puntenwolken.filter((p) => (p.images?.length ?? 0) === 0);
  if (kapot.length === 0) return uit;
  uit.mislukt = kapot.map((p) => naamUitUrl(p.url) ?? `puntenwolk ${p.id}`);

  if (opties.alleenKijken) return uit;

  const pad = await leesOrderPad(orderId);
  if (!pad) {
    uit.reden = "Dropbox-map van deze order is niet bekend; opnieuw versturen kan alleen met de hand";
    return uit;
  }

  for (const p of kapot) {
    const naam = naamUitUrl(p.url);
    if (!naam) {
      uit.nietGelukt.push(`puntenwolk ${p.id} (bestandsnaam onbekend)`);
      continue;
    }
    try {
      await stuurScanVanuitDropbox(orderId, `${pad}/Optimized/${naam}`);
      uit.opnieuwVerstuurd.push(naam);
    } catch (err) {
      uit.nietGelukt.push(`${naam}: ${leesbareFout(err)}`);
    }
  }
  return uit;
}
