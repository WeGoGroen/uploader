import { createHash } from "node:crypto";
import { getSharedAccessToken, listFolderFiles, openFileStream } from "@/lib/dropbox";
import {
  attachPhotos,
  GeenDirecteUpload,
  listPhotos,
  requestPhotoUploads,
  type MediaUploadTarget,
} from "@/lib/mediatask";
import { bewaarMd5, leesbareFout, leesMd5, type Md5Hint } from "@/lib/mediatask-pointclouds";

/**
 * Foto's en video's uit Dropbox meesturen naar Mediatask, als foto's aan de
 * order.
 *
 * Tot nu toe kregen de verwerkers alleen Dropbox-links in de opmerking bij de
 * order. Dat werkt zolang iemand die opmerking leest en de link nog geldig is;
 * het beeld zelf hing nergens aan. Vandaar deze route: dezelfde weg als de
 * puntenwolken (Dropbox → onze server → hun S3-opslag → koppelen), zodat de
 * foto's en video's op de order staan waar de verwerker ze verwacht.
 *
 * Video's gaan bewust óók als "photo" mee: Mediatask kent bij een order geen
 * apart videoveld, en een rondleiding die als foto aan de order hangt is
 * zichtbaar; eentje die nergens hangt niet.
 */

/** De Dropbox-submappen die als foto meegaan, in de volgorde van de opname. */
export const MEDIA_MAPPEN = ["Photo's", "Video", "360"] as const;

export interface MediaUitkomst {
  naam: string;
  map: string;
  ok: boolean;
  fout?: string;
  /** Hing er al aan (bv. een tweede poging), dus niet opnieuw verstuurd. */
  alAanwezig?: boolean;
  /** Als bijlage niet lukte en het bestand als link is meegegeven. */
  alsLink?: boolean;
}

const CONTENT_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  heic: "image/heic",
  webp: "image/webp",
  tif: "image/tiff",
  tiff: "image/tiff",
  mp4: "video/mp4",
  mov: "video/quicktime",
  m4v: "video/x-m4v",
  avi: "video/x-msvideo",
  insp: "image/jpeg",
  insv: "video/mp4",
};

export function contentType(naam: string): string {
  const ext = naam.split(".").pop()?.toLowerCase() ?? "";
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

/** De bestandsnaam uit de downloadlink die Mediatask teruggeeft. */
function naamUitUrl(url: string): string | null {
  const m = /filename%3D%22([^%]+)%22/.exec(url) ?? /filename="([^"]+)"/.exec(url);
  if (m) return decodeURIComponent(m[1]);
  const laatste = url.split("?")[0].split("/").pop();
  return laatste ? decodeURIComponent(laatste) : null;
}

/** Wat er al als foto aan de order hangt — om niets dubbel te versturen. */
export async function alAanwezigeFotoNamen(orderId: number): Promise<Set<string>> {
  const aanwezig = await listPhotos(orderId).catch(() => []);
  return new Set(aanwezig.map((p) => naamUitUrl(p.url)).filter((n): n is string => Boolean(n)));
}

/** Eén bestand: aanmelden, doorzetten naar S3, koppelen. */
async function uploadNaarMediatask(
  orderId: number,
  path: string,
  token: string,
  hint: Md5Hint
): Promise<void> {
  const naam = path.split("/").pop() ?? "foto";
  const doelen: MediaUploadTarget[] = await requestPhotoUploads(orderId, [
    {
      filename: naam,
      byte_size: String(hint.grootte),
      checksum: hint.checksum,
      content_type: contentType(naam),
    },
  ]);
  const doel = doelen[0];

  const bron = await openFileStream(token, path);
  const put = await fetch(doel.url, {
    method: "PUT",
    headers: { ...doel.headers, "Content-Length": String(hint.grootte) },
    body: bron.stream,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  if (!put.ok) {
    const body = await put.text().catch(() => "");
    throw new Error(`Amazon weigerde het bestand (${put.status}). ${body.slice(0, 200)}`);
  }

  await attachPhotos(orderId, [{ photo_id: doel.photo_id, signed_blob_id: doel.blob_id }]);
}

/**
 * Eén foto of video doorsturen.
 *
 * Met een bekende MD5 (uit de cache, gevuld tijdens het uploaden naar Dropbox)
 * is één doorgang door Dropbox genoeg; zonder wordt er eerst gehasht en dan
 * verstuurd. Even betrouwbaar, alleen trager — dezelfde afweging als bij de
 * puntenwolken.
 */
export async function stuurMediaVanuitDropbox(
  orderId: number,
  path: string,
  accessToken?: string,
  hint?: Md5Hint | null
): Promise<void> {
  const token = accessToken ?? (await getSharedAccessToken());

  const bekend = hint ?? (await leesMd5(path));
  if (bekend) {
    try {
      await uploadNaarMediatask(orderId, path, token, bekend);
      void bewaarMd5(path, bekend);
      return;
    } catch (err) {
      // Een verkeerde hash is de meest waarschijnlijke oorzaak (het bestand
      // kan ondertussen vervangen zijn); bij een storing is opnieuw proberen
      // met een verse hash net zo goed het juiste antwoord.
      if (err instanceof GeenDirecteUpload) throw err;
      console.error(`Foto versturen met bekende MD5 mislukt (${path}), opnieuw met verse hash`, err);
    }
  }

  // Doorgang 1: meten en hashen, streamend — een video van honderden MB's in
  // het geheugen laat een serverless-functie omvallen.
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
  await uploadNaarMediatask(orderId, path, token, vers);
}

/**
 * Alle foto's, video's en 360-opnames van een project als foto's aan de order
 * hangen.
 *
 * Eén voor één en nooit blokkerend: net als bij de scans mag een bestand dat
 * niet aankomt de order niet laten sneuvelen — die bestaat op dat moment al.
 * Wat er misging komt per bestand terug, zodat het scherm het kan tonen.
 *
 * Weigert Mediatask de directe-uploadflow voor foto's, dan valt dit terug op
 * het veld vullen met directe Dropbox-links. Dat is zwakker (de verwerker moet
 * er zelf heen), maar het is zichtbaar op de order en het is eerlijk over wat
 * er gebeurd is: die bestanden komen terug met `alsLink`.
 */
export async function stuurMediaVanuitDropboxMap(
  orderId: number,
  projectPad: string
): Promise<MediaUitkomst[]> {
  const token = await getSharedAccessToken();
  const alAanwezig = await alAanwezigeFotoNamen(orderId);
  const uitkomsten: MediaUitkomst[] = [];

  for (const map of MEDIA_MAPPEN) {
    const mapPad = `${projectPad}/${map}`;
    const bestanden = await listFolderFiles(token, mapPad).catch(() => []);
    for (const bestand of bestanden) {
      if (alAanwezig.has(bestand.name)) {
        uitkomsten.push({ naam: bestand.name, map, ok: true, alAanwezig: true });
        continue;
      }
      try {
        await stuurMediaVanuitDropbox(orderId, `${mapPad}/${bestand.name}`, token);
        uitkomsten.push({ naam: bestand.name, map, ok: true });
      } catch (err) {
        if (err instanceof GeenDirecteUpload) {
          // Geen enkel bestand komt er dan als bijlage in; verder proberen
          // kost alleen tijd. Ineens de hele lijst als link markeren.
          return await alsLinks(projectPad, token, uitkomsten);
        }
        uitkomsten.push({ naam: bestand.name, map, ok: false, fout: leesbareFout(err) });
      }
    }
  }
  return uitkomsten;
}

/**
 * Terugvalweg: de media telt als geleverd via de Dropbox-links in de opmerking
 * bij de order (die plaatst de orders-route al, per map).
 *
 * Er wordt bewust níét meer geprobeerd het fotoveld met link-URL's te vullen:
 * live vastgesteld (01-09) dat Mediatask ook dát met 422 weigert — elke
 * schrijfactie op het photos-veld wordt afgewezen. De opmerking is de enige
 * route die aantoonbaar bij de verwerker aankomt, dus dáár wijzen we eerlijk
 * naar in plaats van een tweede kapotte weg te proberen.
 */
async function alsLinks(
  projectPad: string,
  token: string,
  tot_nu_toe: MediaUitkomst[]
): Promise<MediaUitkomst[]> {
  const uitkomsten = tot_nu_toe.filter((u) => !u.ok);
  for (const map of MEDIA_MAPPEN) {
    const bestanden = await listFolderFiles(token, `${projectPad}/${map}`).catch(() => []);
    for (const b of bestanden) {
      uitkomsten.push({ naam: b.name, map, ok: true, alsLink: true });
    }
  }
  return uitkomsten;
}
