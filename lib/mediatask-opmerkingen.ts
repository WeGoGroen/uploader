import { createHash } from "node:crypto";
import type { ClickUpAccount } from "@/lib/clickup";

/**
 * Het gesprek bij een Mediatask-order: lezen en schrijven, voor de chatkolom
 * op de NEN2580-pagina van het Control Center.
 *
 * Mediatask documenteert het leesantwoord van /api/orders/{id}/comments niet.
 * Daarom leest dit bestand ruim: een lijst of {comments|data: [...]}, en per
 * opmerking de gangbare veldnamen. Wat er niet in staat (geen id, geen tijd)
 * vullen we zo in dat dezelfde opmerking bij elke ophaalronde dezelfde sleutel
 * houdt — het Control Center legt ze vast en mag ze niet dubbel tellen.
 */

export interface OpmerkingVol {
  /** Het id van Mediatask, of een vingerafdruk als die er niet is. */
  id: string;
  tekst: string;
  /** Naam van de schrijver zoals Mediatask hem geeft. */
  door: string | null;
  /** Gebruikersnummer bij Mediatask; daarmee ziet het Control Center wie "ik" is. */
  doorId: number | null;
  op: string | null;
}

export function lijstUit(ruw: unknown): unknown[] {
  if (Array.isArray(ruw)) return ruw;
  if (ruw && typeof ruw === "object") {
    const r = ruw as Record<string, unknown>;
    for (const k of ["comments", "data", "items", "results"]) {
      if (Array.isArray(r[k])) return r[k] as unknown[];
    }
  }
  return [];
}

function tekstUit(r: Record<string, unknown>): string | null {
  const v = [r.comment, r.body, r.text, r.content, r.message].find(
    (x): x is string => typeof x === "string" && x.trim().length > 0
  );
  return v ? v.trim() : null;
}

function schrijverUit(r: Record<string, unknown>): { door: string | null; doorId: number | null } {
  const g = r.user ?? r.author ?? r.created_by ?? r.owner;
  let door: string | null = null;
  let doorId: number | null = null;
  if (typeof g === "string") door = g;
  if (g && typeof g === "object") {
    const o = g as Record<string, unknown>;
    door = String(o.full_name ?? o.name ?? o.username ?? "").trim() || null;
    const id = Number(o.id);
    if (Number.isFinite(id) && id > 0) doorId = id;
  }
  if (doorId === null) {
    const los = Number(r.user_id ?? r.author_id ?? r.created_by_id);
    if (Number.isFinite(los) && los > 0) doorId = los;
  }
  if (!door) {
    const naam = r.user_name ?? r.author_name ?? r.username;
    if (typeof naam === "string" && naam.trim()) door = naam.trim();
  }
  return { door, doorId };
}

export function leesOpmerkingVol(ruw: unknown, orderId: number): OpmerkingVol | null {
  if (!ruw || typeof ruw !== "object") return null;
  const r = ruw as Record<string, unknown>;
  const tekst = tekstUit(r);
  if (!tekst) return null;
  const { door, doorId } = schrijverUit(r);
  const op = [r.created_at, r.createdAt, r.date, r.created].find((v): v is string => typeof v === "string") ?? null;
  const eigenId = r.id ?? r.uuid;
  const id =
    eigenId !== undefined && eigenId !== null && String(eigenId).trim()
      ? String(eigenId)
      : "h" +
        createHash("sha1")
          .update(`${orderId}|${op ?? ""}|${doorId ?? door ?? ""}|${tekst}`)
          .digest("hex")
          .slice(0, 20);
  return { id, tekst, door, doorId, op };
}

/** Alle opmerkingen, oudste eerst — zoals een gesprek leest. */
export function opmerkingenUit(ruw: unknown, orderId: number): OpmerkingVol[] {
  return lijstUit(ruw)
    .map((x) => leesOpmerkingVol(x, orderId))
    .filter((o): o is OpmerkingVol => o !== null)
    .sort((a, b) => (a.op ?? "").localeCompare(b.op ?? ""));
}

/**
 * Het account in deze app dat bij een Control Center-gebruiker hoort.
 *
 * Eerst op e-mail, want die is in beide apps hetzelfde. Dan op de volledige
 * naam, en pas daarna op de voornaam — en alleen als die voornaam maar bij één
 * account hoort. Liever geen account dan het verkeerde: een opmerking onder
 * andermans naam is precies wat dit moet voorkomen.
 */
export function vindAccount(
  accounts: ClickUpAccount[],
  wie: { email?: string | null; naam?: string | null }
): ClickUpAccount | null {
  const email = (wie.email ?? "").trim().toLowerCase();
  if (email) {
    const hit = accounts.find((a) => (a.email ?? "").trim().toLowerCase() === email);
    if (hit) return hit;
  }
  const naam = (wie.naam ?? "").trim().toLowerCase();
  if (!naam) return null;
  const vol = accounts.find((a) => a.name.trim().toLowerCase() === naam);
  if (vol) return vol;
  const voornaam = naam.split(/\s+/)[0];
  const opVoornaam = accounts.filter((a) => a.name.trim().toLowerCase().split(/\s+/)[0] === voornaam);
  return opVoornaam.length === 1 ? opVoornaam[0] : null;
}

/** Een Mediatask-aanroep met een bepaalde sleutel, niet die van de sessie. */
export async function mediataskMetSleutel(
  baseUrl: string,
  token: string,
  pad: string,
  init: RequestInit = {}
): Promise<Response> {
  return fetch(`${baseUrl.replace(/\/+$/, "")}${pad}`, {
    ...init,
    headers: {
      // Mediatask gebruikt X-Api-Token (zie mediataskFetch). De Bearer-kop
      // stond in de oudere leesroutes; meesturen kan geen kwaad.
      "X-Api-Token": token,
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
}
