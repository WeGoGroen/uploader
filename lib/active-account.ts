import { cookies } from "next/headers";
import { getClickUpAccounts } from "@/lib/clickup";

export const ACCOUNT_COOKIE = "clickup_account";

/** Welke geconfigureerde ClickUp-account dit apparaat momenteel gebruikt. */
export async function getActiveAccountName(): Promise<string | null> {
  const store = await cookies();
  return store.get(ACCOUNT_COOKIE)?.value ?? null;
}

/**
 * Zelfde als getActiveAccountName, maar valt terug op het eerste
 * geconfigureerde account als er nog nooit expliciet gewisseld is —
 * anders zou een apparaat dat nog nooit "Wissel van gebruiker" heeft
 * gebruikt (het normale geval bij één teamlid) geen actief account hebben,
 * en dus geen per-persoon koppelingen (zoals Google Agenda) kunnen matchen.
 */
export async function resolveActiveAccountName(): Promise<string | null> {
  const explicit = await getActiveAccountName();
  if (explicit) return explicit;
  const accounts = await getClickUpAccounts();
  return accounts[0]?.name ?? null;
}
