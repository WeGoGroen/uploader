/**
 * MD5 van een bestand berekenen in de browser, op het moment dat het gekozen
 * wordt en dus nog in het geheugen zit.
 *
 * Waarom hier en niet op de server: Mediatask's S3-uploadlink tekent de MD5
 * mee, dus die moet bekend zijn vóórdat de upload begint. De server kende 'm
 * niet en moest de scan daarom twee keer uit Dropbox streamen — één keer om
 * te hashen, één keer om te versturen. Met de hash van de iPad erbij is één
 * doorgang genoeg en halveert de Mediatask-stap. S3 controleert de checksum
 * nog steeds bij aankomst, dus aan de betrouwbaarheid verandert er niets:
 * klopt de hash niet (bestand ondertussen vervangen), dan weigert S3 en valt
 * de server terug op zelf hashen.
 */

import SparkMD5 from "spark-md5";

/** Blokgrootte voor het inlezen. Groot genoeg om snel te zijn, klein genoeg
    om tussen de blokken door de UI niet te bevriezen (elke await geeft de
    hoofdthread terug). */
const LEES_BLOK = 8 * 1024 * 1024;

export interface Md5Uitkomst {
  /** MD5 in base64 — hetzelfde formaat als de Content-MD5-header die S3 wil. */
  checksum: string;
  grootte: number;
}

export async function berekenMd5(file: File): Promise<Md5Uitkomst> {
  const spark = new SparkMD5.ArrayBuffer();
  for (let offset = 0; offset < file.size; offset += LEES_BLOK) {
    const blok = await file.slice(offset, Math.min(offset + LEES_BLOK, file.size)).arrayBuffer();
    spark.append(blok);
  }
  // spark-md5 geeft hex terug; S3 wil base64 van de rauwe bytes.
  const hex = spark.end();
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return { checksum: btoa(String.fromCharCode(...bytes)), grootte: file.size };
}
