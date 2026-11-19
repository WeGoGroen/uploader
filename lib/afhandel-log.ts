import { isMaandMap } from "@/lib/archief-maand";

/**
 * De regels voor het afhandel-log van de Energielabel Afhandel-agent in het
 * control center. Puur, zodat elke grens in een test vastligt; de route in
 * app/api/intern/afhandel-log doet alleen het Dropbox-werk.
 *
 * Wat hier geldt, en waarom:
 *  1. Alleen een projectmap onder "Automatie Energielabels" (direct, of in het
 *     archief "Afgerond"). Dezelfde regel als bij bestand-plaatsen.
 *  2. Alleen een bestandsnaam van de vorm `_afhandel-log_2026-11-10_0905.md`.
 *     Geen vrije naam: deze route schrijft één soort bestand en niets anders.
 *  3. Klein en tekst: hooguit 100 kB. Een log is een tabel met controles,
 *     geen bijlage.
 */

export const HOOFDMAP = "Automatie Energielabels";
export const MAX_BYTES = 100_000;
const NAAM_RE = /^_afhandel-log_\d{4}-\d{2}-\d{2}_\d{4}\.md$/;

/** Is dit pad een energielabel-projectmap (en niet de hoofdmap, het archief of een maandmap)? */
export function isProjectmap(pad: string): boolean {
  if (!pad.startsWith(`/${HOOFDMAP}/`) || pad.includes("..") || pad.endsWith("/")) return false;
  const delen = pad.split("/").filter(Boolean);
  if (delen.length === 2) return delen[1] !== "Afgerond";
  if (delen.length === 3) return delen[1] === "Afgerond" && !isMaandMap(delen[2]);
  if (delen.length === 4) return delen[1] === "Afgerond" && isMaandMap(delen[2]);
  return false;
}

export type Invoer =
  | { ok: true; folderId: string; bestandsnaam: string; inhoud: string }
  | { ok: false; fout: string };

/** De aanvraag lezen en afkeuren wat niet past, vóór er iets met Dropbox gebeurt. */
export function leesInvoer(body: unknown): Invoer {
  const b = (body ?? {}) as { folder_id?: unknown; bestandsnaam?: unknown; inhoud?: unknown };
  const folderId = typeof b.folder_id === "string" ? b.folder_id.trim() : "";
  const bestandsnaam = typeof b.bestandsnaam === "string" ? b.bestandsnaam.trim() : "";
  const inhoud = typeof b.inhoud === "string" ? b.inhoud : "";
  if (!/^id:[A-Za-z0-9_-]+$/.test(folderId)) return { ok: false, fout: "folder_id moet de vorm id:... hebben" };
  if (!NAAM_RE.test(bestandsnaam)) {
    return { ok: false, fout: "alleen een bestandsnaam als _afhandel-log_JJJJ-MM-DD_UUMM.md" };
  }
  if (!inhoud.trim()) return { ok: false, fout: "het log is leeg" };
  if (Buffer.byteLength(inhoud, "utf8") > MAX_BYTES) return { ok: false, fout: `het log is groter dan ${MAX_BYTES} bytes` };
  return { ok: true, folderId, bestandsnaam, inhoud };
}
