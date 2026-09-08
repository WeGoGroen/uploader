import { cookies } from "next/headers";
import { SESSION_COOKIE, authConfig, leesSessie } from "@/lib/auth";
import { getClickUpAccounts } from "@/lib/clickup";

/**
 * Wie er op dit moment werkt.
 *
 * Stond hiervóór in een losse cookie ("clickup_account") die niet ondertekend
 * was en die je op de gebruikerspagina met één klik kon omzetten. Dat paste
 * bij één gedeelde inlog, maar het betekende ook dat het werk van een collega
 * op iemand anders naam kon komen te staan zonder dat er iets van klopte.
 *
 * Nu komt de naam uit de ondertekende sessie: wisselen is opnieuw inloggen.
 */
export async function getActiveAccountName(): Promise<string | null> {
  const store = await cookies();
  const { secret } = authConfig();
  const sessie = await leesSessie(secret, store.get(SESSION_COOKIE)?.value);
  return sessie?.naam ?? null;
}

/**
 * Zelfde als getActiveAccountName, maar valt terug op het eerste account.
 *
 * De terugval blijft bestaan voor werk dat zonder sessie draait — de cron die
 * herinneringen stuurt, de herstelwerker — want dat heeft wél een ClickUp-
 * token nodig maar heeft niemand die ingelogd is.
 */
export async function resolveActiveAccountName(): Promise<string | null> {
  const explicit = await getActiveAccountName();
  if (explicit) return explicit;
  const accounts = await getClickUpAccounts();
  return accounts[0]?.name ?? null;
}
