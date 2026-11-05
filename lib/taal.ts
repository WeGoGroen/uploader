/**
 * De taal van de uploader: alleen de schermteksten, niet de workflow.
 *
 * Mapnamen in Dropbox, ClickUp-velden, Mediatask-orders en alles wat naar
 * buiten gaat blijft Nederlands — dat zijn afspraken met andere systemen, geen
 * tekst voor de gebruiker. Hier staat alleen wat iemand op het scherm leest.
 *
 * Nederlands is de bron. Ontbreekt een Engelse vertaling, dan valt t() terug
 * op het Nederlands in plaats van een sleutel of een lege knop te tonen.
 */

export type Taal = "nl" | "en";

export const TALEN: Taal[] = ["nl", "en"];
export const STANDAARD_TAAL: Taal = "nl";
export const TAAL_COOKIE = "taal";

export function isTaal(v: unknown): v is Taal {
  return v === "nl" || v === "en";
}

const nl = {
  // zijbalk
  "zijbalk.ondertitel": "Upload portaal",
  "zijbalk.hoofdmenu": "Hoofdmenu",
  "zijbalk.dashboard": "Dashboard",
  "zijbalk.uploaden": "Uploaden",
  "zijbalk.binnenkort": "binnenkort",
  "zijbalk.status": "Status",
  "zijbalk.gebruikers": "Gebruikers",
  "zijbalk.instellingen": "Instellingen",
  "zijbalk.inloggen": "INLOGGEN",
  "zijbalk.herstellen": "HERSTELLEN",
  "zijbalk.uploadenBezig.een": "{n} project aan het uploaden",
  "zijbalk.uploadenBezig.meer": "{n} projecten aan het uploaden",
  "zijbalk.laden": "Laden…",
  "zijbalk.ingelogd": "ingelogd",
  "zijbalk.mijnGegevens": "Mijn gegevens en code",
  "zijbalk.bezig": "Bezig…",
  "zijbalk.uitloggen": "Uitloggen",
  // taalknop
  "taal.label": "Taal",
  "taal.nl": "Nederlands",
  "taal.en": "Engels",
  // dashboard
  "dashboard.titel": "Dashboard",
  "dashboard.verversen": "Afspraken verversen",
  "dashboard.verversenBezig": "Bezig met verversen…",
} as const;

export type TaalSleutel = keyof typeof nl;

const en: Partial<Record<TaalSleutel, string>> = {
  "zijbalk.ondertitel": "Upload portal",
  "zijbalk.hoofdmenu": "Main menu",
  "zijbalk.dashboard": "Dashboard",
  "zijbalk.uploaden": "Upload",
  "zijbalk.binnenkort": "coming soon",
  "zijbalk.status": "Status",
  "zijbalk.gebruikers": "Users",
  "zijbalk.instellingen": "Settings",
  "zijbalk.inloggen": "SIGN IN",
  "zijbalk.herstellen": "FIX",
  "zijbalk.uploadenBezig.een": "{n} project uploading",
  "zijbalk.uploadenBezig.meer": "{n} projects uploading",
  "zijbalk.laden": "Loading…",
  "zijbalk.ingelogd": "signed in",
  "zijbalk.mijnGegevens": "My details and code",
  "zijbalk.bezig": "Working…",
  "zijbalk.uitloggen": "Sign out",
  "taal.label": "Language",
  "taal.nl": "Dutch",
  "taal.en": "English",
  "dashboard.titel": "Dashboard",
  "dashboard.verversen": "Refresh appointments",
  "dashboard.verversenBezig": "Refreshing…",
};

const WOORDENBOEK: Record<Taal, Partial<Record<TaalSleutel, string>>> = { nl, en };

/** Vertaal een sleutel; {naam}-plekken worden ingevuld vanuit `waarden`. */
export function vertaal(taal: Taal, sleutel: TaalSleutel, waarden?: Record<string, string | number>): string {
  const tekst = WOORDENBOEK[taal][sleutel] ?? nl[sleutel];
  if (!waarden) return tekst;
  return tekst.replace(/\{(\w+)\}/g, (_, k: string) => String(waarden[k] ?? `{${k}}`));
}
