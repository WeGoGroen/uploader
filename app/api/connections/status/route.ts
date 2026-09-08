import { NextResponse } from "next/server";
import { suggestAddresses } from "@/lib/pdok";
import { getAuthorizedUser, requireClickUpConfig } from "@/lib/clickup";
import { getActiveAccountName, resolveActiveAccountName } from "@/lib/active-account";
import { getCurrentAccount, getSharedAccessToken, requireDropboxConfig } from "@/lib/dropbox";
import { getAgencies, requireMediataskConfig } from "@/lib/mediatask";
import { getAccessTokenForAccount, getCurrentAccount as getGoogleAccount, requireGoogleConfig } from "@/lib/google-calendar";
import {
  getDefaultDriveId,
  getSharePointConfig,
  getSharedAccessToken as getMicrosoftAccessToken,
  getSiteName,
  requireMicrosoftConfig,
  resolveSiteId,
} from "@/lib/microsoft";
import { checkStreetView } from "@/lib/streetview";
import { haalUitgezet } from "@/lib/koppelingen";

interface ConnectionStatus {
  connected: boolean;
  ok: boolean;
  label: string | null;
  error: string | null;
  /** Bewust uitgezet: niet gemeten, en dus ook geen storing. */
  uit?: boolean;
}

function notConnected(): ConnectionStatus {
  return { connected: false, ok: false, label: null, error: null };
}

/** Een uitgezette koppeling: geen meting, geen foutmelding. */
function uitgezet(): ConnectionStatus {
  return { connected: false, ok: false, label: null, error: null, uit: true };
}

/** Springt uit een meetblok zonder er een fout van te maken. */
class SlaOver extends Error {}

export async function GET() {
  const uit = await haalUitgezet();

  // ClickUp en Dropbox gebruiken allebei hetzelfde patroon: één gedeeld
  // token in .env.local op de server, geen per-gebruiker sessie. "Verbonden"
  // betekent hier: het token staat er, en de dienst accepteert het nu.
  //
  // Staat een koppeling uit, dan wordt er niet gemeten: wie geen energielabels
  // doet heeft geen ClickUp-token, en dat is geen storing.
  const clickup = uit.includes("clickup") ? uitgezet() : notConnected();
  try {
    if (clickup.uit) throw new SlaOver();
    const activeAccount = await getActiveAccountName();
    const { token } = await requireClickUpConfig(activeAccount);
    clickup.connected = true;
    const user = await getAuthorizedUser(token);
    clickup.ok = true;
    clickup.label = user.username;
  } catch (err) {
    if (!(err instanceof SlaOver)) {
      clickup.error = clickup.connected
        ? "Token wordt geweigerd door ClickUp. Vernieuw het token."
        : err instanceof Error
          ? err.message
          : "Niet geconfigureerd.";
    }
  }

  // BAG heeft geen account — "verbonden" betekent hier dat de publieke PDOK-
  // dienst nu bereikbaar is.
  const bag = notConnected();
  bag.connected = true;
  try {
    // Dezelfde weg als het adres zoeken zelf (suggestAddresses), niet het
    // losse "free"-endpoint dat hier eerder stond. Dat endpoint doet er
    // regelmatig 3 tot 7 seconden over, terwijl de controle na 5 seconden
    // afbrak — dan stond er "BAG is niet bereikbaar" terwijl adres zoeken in
    // de app gewoon werkte. Een statusbalk die vals alarm slaat leert
    // iedereen om er niet meer naar te kijken.
    const res = await suggestAddresses("Damrak 1, Amsterdam");
    if (res.length === 0) throw new Error("geen resultaten");
    bag.ok = true;
  } catch {
    bag.error = "BAG (PDOK) is nu niet bereikbaar.";
  }

  const dropbox = notConnected();
  try {
    await requireDropboxConfig();
    dropbox.connected = true;
    const accessToken = await getSharedAccessToken();
    const account = await getCurrentAccount(accessToken);
    dropbox.ok = true;
    dropbox.label = account.email;
  } catch (err) {
    dropbox.error = dropbox.connected
      ? "Token wordt geweigerd door Dropbox. Koppel opnieuw."
      : err instanceof Error
        ? err.message
        : "Niet geconfigureerd.";
  }

  const mediatask = notConnected();
  try {
    await requireMediataskConfig();
    mediatask.connected = true;
    const agencies = await getAgencies();
    mediatask.ok = true;
    mediatask.label = `${agencies.length} bureau${agencies.length === 1 ? "" : "s"}`;
  } catch (err) {
    mediatask.error = mediatask.connected
      ? "Token wordt geweigerd door Mediatask."
      : err instanceof Error
        ? err.message
        : "Niet geconfigureerd.";
  }

  const google = notConnected();
  try {
    const activeAccount = await resolveActiveAccountName();
    await requireGoogleConfig(activeAccount);
    google.connected = true;
    const accessToken = await getAccessTokenForAccount(activeAccount);
    const account = await getGoogleAccount(accessToken);
    google.ok = true;
    google.label = account.email;
  } catch (err) {
    google.error = google.connected
      ? "Token wordt geweigerd door Google. Koppel opnieuw."
      : err instanceof Error
        ? err.message
        : "Niet geconfigureerd.";
  }

  // SharePoint draait app-only (Sites.Selected): er komt geen gebruiker aan te
  // pas, dus "verbonden" betekent hier dat de app-gegevens er staan en
  // Microsoft ze accepteert voor precies die ene site.
  const sharepoint = notConnected();
  try {
    await requireMicrosoftConfig();
    sharepoint.connected = true;
    const accessToken = await getMicrosoftAccessToken();
    const config = await getSharePointConfig();
    const siteId = await resolveSiteId(accessToken, config.siteUrl);
    await getDefaultDriveId(accessToken, siteId);
    const naam = await getSiteName(accessToken, siteId);
    sharepoint.ok = true;
    sharepoint.label = config.rootPath ? `${naam} / ${config.rootPath}` : naam;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    sharepoint.error = !sharepoint.connected
      ? detail
      : /\b403\b|accessDenied/i.test(detail)
        ? "Microsoft accepteert de app, maar geeft geen toegang tot deze site. Vraag MO Consultancy om de leestoegang (Sites.Selected) op /sites/WeGoGroen te controleren."
        : /\b401\b|invalid_client|AADSTS7000/i.test(detail)
          ? "Microsoft weigert de app-gegevens. Het client secret is waarschijnlijk verlopen of verkeerd overgenomen."
          : `Microsoft is nu niet bereikbaar of de ingestelde map bestaat niet. (${detail})`;
  }

  // Street View heeft geen account, alleen een API-key: "verbonden" betekent
  // hier dat de key er is, "in orde" dat Google 'm nu ook accepteert.
  const streetview = await checkStreetView();

  return NextResponse.json({ clickup, bag, dropbox, mediatask, google, sharepoint, streetview });
}
