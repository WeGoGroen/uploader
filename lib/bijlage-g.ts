import { getTaakVolledig, requireClickUpConfig } from "@/lib/clickup";
import { findProjectFolder, getSharedAccessToken, voegBijlageGToe } from "@/lib/dropbox";
import { taskToAddress } from "@/lib/sharepoint-match";

/**
 * Bijlage G in de projectmap van één ClickUp-taak.
 *
 * Nieuwe projectmappen krijgen de bijlage al bij het aanmaken (zie
 * ensureProjectFolder). Deze weg is voor alles wat daarvoor bestond én voor
 * mappen waar hij om wat voor reden ook niet is geland: de agent in het
 * control center roept hem aan zodra een opdracht de bijlage mist. Geen
 * webhook — een ontbrekende bijlage is een toestand, geen gebeurtenis.
 */

export interface BijlageGUitkomst {
  ok: boolean;
  /** Waaróm het niet kon. Bepaalt of opnieuw proberen zin heeft: een taak
      zonder adres wordt vanzelf nooit beter, een 500 van Dropbox wel. */
  code: "geen_adres" | "geen_projectmap" | "clickup" | "dropbox" | null;
  reden: string | null;
  adres: string | null;
  pad: string | null;
  /** Waar als de bijlage er al stond en er niets is geüpload. */
  bestondAl: boolean;
}

export async function bijlageGVoorTaak(taskId: string): Promise<BijlageGUitkomst> {
  const leeg: BijlageGUitkomst = {
    ok: false,
    code: null,
    reden: null,
    adres: null,
    pad: null,
    bestondAl: false,
  };

  let taak;
  try {
    const { token } = await requireClickUpConfig();
    taak = await getTaakVolledig(token, taskId);
  } catch (err) {
    return { ...leeg, code: "clickup", reden: err instanceof Error ? err.message.slice(0, 200) : "onbekend" };
  }

  // getTaakVolledig geeft de custom fields met optionele waarde terug;
  // taskToAddress wil ze stellig. Hier eenmalig gelijktrekken.
  const adres = taskToAddress({
    name: taak.name,
    customFields: taak.customFields.map((f) => ({ name: f.name, value: f.value })),
  });
  if (!adres) {
    return { ...leeg, code: "geen_adres", reden: "geen adres in de taak (veld A1 Adres) of de taaknaam" };
  }
  const adresTekst = `${adres.addressLine}, ${adres.woonplaats}`;

  let token: string;
  try {
    token = await getSharedAccessToken();
  } catch (err) {
    return { ...leeg, adres: adresTekst, code: "dropbox", reden: err instanceof Error ? err.message.slice(0, 200) : "onbekend" };
  }

  // Geen projectmap aanmaken: net als bij de SharePoint-overdracht betekent een
  // ontbrekende map dat er iets niet klopt, en een losse map vol met alleen een
  // bijlage helpt niemand.
  const map = await findProjectFolder(token, "energielabel", adres.woonplaats, adres.addressLine).catch(
    () => null
  );
  if (!map) {
    return {
      ...leeg,
      adres: adresTekst,
      code: "geen_projectmap",
      reden: `Geen projectmap gevonden onder Automatie Energielabels voor ${adresTekst}.`,
    };
  }

  const uitkomst = await voegBijlageGToe(token, map.path);
  if (!uitkomst.geplaatst && uitkomst.reden !== "stond er al") {
    return { ...leeg, adres: adresTekst, pad: map.path, code: "dropbox", reden: uitkomst.reden };
  }

  return {
    ok: true,
    code: null,
    reden: null,
    adres: adresTekst,
    pad: map.path,
    bestondAl: uitkomst.reden === "stond er al",
  };
}
