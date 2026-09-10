import { cookies } from "next/headers";
import { SESSION_COOKIE, authConfig, leesSessie, type Sessie } from "@/lib/auth";

/** Wie er nu ingelogd is, server-side. Null als er geen geldige sessie is. */
export async function huidigeSessie(): Promise<Sessie | null> {
  const store = await cookies();
  return leesSessie(authConfig().secret, store.get(SESSION_COOKIE)?.value);
}

/**
 * Alleen beheerders mogen aan de inrichting komen.
 *
 * De middleware bewaakt of je binnen mag; dit bewaakt wat je binnen mag doen.
 * Op de iPad in het veld staat de app de hele dag open, en dan hoort een
 * verkeerde tik in de instellingen niet de koppelingen van iedereen om te
 * kunnen zetten.
 */
export async function isBeheerder(): Promise<boolean> {
  return (await huidigeSessie())?.rol === "beheerder";
}
