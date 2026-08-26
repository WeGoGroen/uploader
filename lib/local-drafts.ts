"use client";

// Lokale back-up van het actieve concept, naast de opslag in Redis. Bij
// slecht bereik op locatie (bouwplaats, kelder) mag een opname nooit
// verloren gaan alleen omdat de netwerk-save faalde — dit schrijft synchroon
// naar localStorage, ongeacht of de server bereikbaar is.
const PREFIX = "energielabel:draft:";

export interface LocalDraft {
  id: string;
  updatedAt: number;
  pendingSync: boolean;
  straatnaam: string;
  payload: Record<string, unknown>;
}

export function saveDraftLocal(id: string, straatnaam: string, payload: Record<string, unknown>, pendingSync: boolean): void {
  if (typeof window === "undefined") return;
  try {
    const entry: LocalDraft = { id, updatedAt: Date.now(), pendingSync, straatnaam, payload };
    window.localStorage.setItem(`${PREFIX}${id}`, JSON.stringify(entry));
  } catch {
    // localStorage kan vol zijn of geblokkeerd (privénavigatie) — dan is er
    // gewoon geen lokale back-up, geen harde fout.
  }
}

export function markDraftSynced(id: string): void {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(`${PREFIX}${id}`);
    if (!raw) return;
    const entry = JSON.parse(raw) as LocalDraft;
    entry.pendingSync = false;
    window.localStorage.setItem(`${PREFIX}${id}`, JSON.stringify(entry));
  } catch {
    // negeren
  }
}

export function clearDraftLocal(id: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(`${PREFIX}${id}`);
  } catch {
    // negeren
  }
}

/** Alle lokale concepten die nog niet (bevestigd) naar de server zijn
    weggeschreven — gebruikt om na verbindingsverlies te herstellen. */
export function listPendingLocalDrafts(): LocalDraft[] {
  if (typeof window === "undefined") return [];
  const out: LocalDraft[] = [];
  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (!key?.startsWith(PREFIX)) continue;
      const raw = window.localStorage.getItem(key);
      if (!raw) continue;
      const entry = JSON.parse(raw) as LocalDraft;
      if (entry.pendingSync) out.push(entry);
    }
  } catch {
    // negeren
  }
  return out;
}
