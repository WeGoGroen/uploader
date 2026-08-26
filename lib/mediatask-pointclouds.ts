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
}

/** Eén scan doorsturen: aanmelden, uploaden, koppelen. */
export async function stuurScanVanuitDropbox(
  orderId: number,
  path: string,
  accessToken?: string
): Promise<{ pointcloudId: number; bytes: number; aanwezig: number }> {
  const naam = path.split("/").pop() ?? "scan";
  const token = accessToken ?? (await getSharedAccessToken());

  // Doorgang 1: meten en hashen. S3 tekent de MD5 mee in de uploadlink, dus
  // die moet vooraf bekend zijn. Streamen i.p.v. inlezen: een scan van
  // honderden MB's in het geheugen laat een serverless-functie omvallen.
  const eerste = await openFileStream(token, path);
  const hash = createHash("md5");
  let bytes = 0;
  for await (const blok of eerste.stream as unknown as AsyncIterable<Uint8Array>) {
    hash.update(blok);
    bytes += blok.byteLength;
  }
  const checksum = hash.digest("base64");
  const grootte = bytes || eerste.size;

  const doelen = await requestPointcloudUploads(orderId, [
    { filename: naam, byte_size: String(grootte), checksum, content_type: "application/octet-stream" },
  ]);
  const doel = doelen.pointclouds?.[0];
  if (!doel?.url) throw new Error("Mediatask gaf geen uploadlink terug");

  // Doorgang 2: dezelfde bytes doorzetten naar S3.
  const tweede = await openFileStream(token, path);
  const put = await fetch(doel.url, {
    method: "PUT",
    headers: { ...doel.headers, "Content-Length": String(grootte) },
    body: tweede.stream,
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
  return { pointcloudId: doel.pointcloud_id, bytes: grootte, aanwezig: aanwezig.length };
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

  for (const bestand of bestanden) {
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
