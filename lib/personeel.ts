import { hashCode, nieuweSalt, STARTCODE } from "@/lib/auth";
import { getClickUpAccounts, patchClickUpAccount, type ClickUpAccount } from "@/lib/clickup";

/**
 * Wie er in deze app mag werken, en onder welke naam.
 *
 * De accounts stonden er al — met naam, mailadres, uploadrechten en een
 * eventueel ClickUp-token — maar zonder eigen inlog: de hele app zat achter
 * één gedeelde code, en daarna koos je op de gebruikerspagina zelf wie je was.
 * Dat maakte "wie heeft dit opgenomen" een kwestie van vertrouwen in plaats
 * van iets dat de app weet.
 *
 * Hier komt daar de inlogkant bij: een persoonlijke viercijferige code en een
 * rol. Bewust op hetzelfde record en niet in een tweede lijst — twee lijsten
 * met mensen erin lopen vroeg of laat uit de pas, en dan is het de vraag welke
 * de echte is.
 */

export interface Persoon {
  naam: string;
  email: string | null;
  avatar: string | null;
  rol: "medewerker" | "beheerder";
  /** Heeft deze persoon de startcode 0000 al vervangen? */
  codeGewijzigd: boolean;
}

/**
 * Er moet altijd iemand beheerder zijn.
 *
 * Staat er nergens een rol (het normale geval vlak na deze wijziging), dan zou
 * niemand accounts kunnen beheren en is de app op slot voor beheer. De eerste
 * account is die van de eigenaar — het env-token hoort bij Floris — dus die
 * krijgt de rol tot iemand het expliciet anders zet.
 */
function metRollen(accounts: ClickUpAccount[]): ClickUpAccount[] {
  if (accounts.some((a) => a.rol === "beheerder")) return accounts;
  return accounts.map((a, i) => (i === 0 ? { ...a, rol: "beheerder" as const } : a));
}

function naarPersoon(a: ClickUpAccount): Persoon {
  return {
    naam: a.name,
    email: a.email ?? null,
    avatar: a.avatar ?? null,
    rol: a.rol === "beheerder" ? "beheerder" : "medewerker",
    codeGewijzigd: Boolean(a.codeHash),
  };
}

export async function haalPersoneel(): Promise<Persoon[]> {
  const accounts = metRollen(await getClickUpAccounts());
  return accounts.map(naarPersoon);
}

export async function haalPersoon(naam: string): Promise<Persoon | null> {
  const gevonden = (await haalPersoneel()).find((p) => p.naam === naam);
  return gevonden ?? null;
}

/**
 * Klopt deze code bij deze naam?
 *
 * Een account zonder opgeslagen code zit nog op de startcode. Dat is geen gat
 * maar de overgang: iedereen kreeg 0000 en wisselt hem daarna zelf. De app
 * blijft daarop wijzen zolang codeGewijzigd false is.
 */
export async function controleerCode(
  naam: string,
  code: string
): Promise<{ ok: boolean; persoon: Persoon | null }> {
  const accounts = metRollen(await getClickUpAccounts());
  const account = accounts.find((a) => a.name === naam);
  if (!account) return { ok: false, persoon: null };

  if (!account.codeHash || !account.codeSalt) {
    return { ok: code === STARTCODE, persoon: naarPersoon(account) };
  }

  const berekend = await hashCode(code, account.codeSalt);
  // Constante tijd: anders is de responstijd een aanwijzing hoe ver je bent.
  if (berekend.length !== account.codeHash.length) return { ok: false, persoon: naarPersoon(account) };
  let verschil = 0;
  for (let i = 0; i < berekend.length; i++) {
    verschil |= berekend.charCodeAt(i) ^ account.codeHash.charCodeAt(i);
  }
  return { ok: verschil === 0, persoon: naarPersoon(account) };
}

/** Zet een nieuwe code. Vier cijfers, net als in het Business Control Center. */
export async function zetCode(naam: string, code: string): Promise<void> {
  if (!/^[0-9]{4}$/.test(code)) throw new Error("De code bestaat uit vier cijfers.");
  const salt = nieuweSalt();
  await patchClickUpAccount({ name: naam, codeSalt: salt, codeHash: await hashCode(code, salt) });
}

export async function zetRol(naam: string, rol: "medewerker" | "beheerder"): Promise<void> {
  await patchClickUpAccount({ name: naam, rol });
}
