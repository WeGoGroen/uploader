import { getClickUpAccounts, rechtenVan, type UploadRechten } from "@/lib/clickup";
import { resolveActiveAccountName } from "@/lib/active-account";

/**
 * De uploadrechten van wie er op dit apparaat actief is.
 *
 * Dit is bewust een zachte grens en geen beveiliging: iedereen in de app deelt
 * één inlog en kan van gebruiker wisselen. Het doel is dat een opnemer die
 * alleen media doet geen energielabelformulier van 44 velden voor zich krijgt —
 * minder vergissingen, niet minder vertrouwen. Wie het echt wil omzeilen, kan
 * dat; dat is hier geen probleem, want ze zitten toch al binnen.
 */
export async function huidigeRechten(): Promise<{ naam: string | null; rechten: UploadRechten }> {
  const naam = await resolveActiveAccountName();
  const accounts = await getClickUpAccounts();
  const account = accounts.find((a) => a.name === naam) ?? null;
  return { naam, rechten: rechtenVan(account) };
}
