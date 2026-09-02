import { getListCustomFields, getTaskTeamId, getTeams, setAttachmentFieldValue, uploadCustomFieldAttachment } from "@/lib/clickup";
import { downloadFile, getSharedAccessToken, listFolderFiles } from "@/lib/dropbox";
import { DOCUMENT_FOLDER_MAP } from "@/lib/documents";

/**
 * Downloaden+uploaden gebeurde eerst allemaal tegelijk (alle bestanden van
 * alle 4 categorieën in één keer) — bij echte foto's (i.p.v. kleine
 * testbestandjes) gaf dat "500 Internal Server Error" en "context deadline
 * exceeded" terug van ClickUp: te veel gelijktijdige grote uploads vanuit
 * hetzelfde account. Bestanden binnen één categorie gaan nu één voor één,
 * met een paar hernieuwde pogingen bij een tijdelijke serverfout.
 */
async function withRetry<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = (err as { status?: number })?.status;
      // Opnieuw proberen bij alles wat kán overwaaien: serverfouten (5xx),
      // "te veel verzoeken" (429) en netwerkfouten zonder status. Een echte
      // 4xx (bv. bestand te groot) heeft geen zin om te herhalen.
      const retryable = status == null || status >= 500 || status === 429;
      if (!retryable || i === attempts - 1) throw err;
      // Ruimer wachten dan voorheen: ClickUp geeft juist bij een reeks
      // uploads achter elkaar 500's, en die trekken pas na seconden bij.
      await new Promise((r) => setTimeout(r, Math.min(8000, 1000 * 2 ** i)));
    }
  }
  throw lastErr;
}

/**
 * Zet de bestanden uit één Dropbox-documentcategorie (D2 t/m D5) als bijlage
 * in het bijbehorende ClickUp-attachment-veld. Losstaand per categorie
 * aanroepbaar (i.p.v. alles in één keer) zodat de app per onderdeel
 * voortgang kan tonen in plaats van één lange, stille wachttijd.
 */
export async function attachOneDocument(
  clickupToken: string,
  listId: string,
  taskId: string,
  dropboxFolderPath: string,
  docKey: string,
  /**
   * Waar deze poging moet beginnen en eindigen. Zonder dit begon elke poging
   * weer bij het eerste bestand, en dat liep op twee manieren fout bij een
   * categorie met veel of grote foto's:
   *
   *  1. De tijdslimiet kapte steeds op dezelfde plek af, dus de laatste foto's
   *     kwamen bij géén enkele poging aan de beurt — hoe vaak je ook opnieuw
   *     probeerde.
   *  2. ClickUp's veld-API vult aan (`{ add: [...] }`) en overschrijft niet,
   *     dus de foto's die wél pasten werden bij elke poging opnieuw geüpload
   *     en kwamen er dubbel in te staan.
   *
   * `skip` laat een volgende poging doorgaan waar de vorige stopte; `only`
   * pakt gericht de bestanden die eerder mislukten, zonder de rest aan te
   * raken.
   */
  opties: { skip?: number; only?: string[] } = {}
): Promise<{
  fileCount: number;
  gelukt: number;
  mislukt: string[];
  afgekapt: boolean;
  /** Index in de mappenlijst waar een volgende poging moet beginnen. */
  volgendeSkip: number;
}> {
  const doc = DOCUMENT_FOLDER_MAP.find((d) => d.key === docKey);
  if (!doc) throw new Error(`Onbekende documentcategorie: ${docKey}`);

  const [teamId, dropboxToken, allFields] = await Promise.all([
    /*
      De workspace komt van de taak, niet van het token.

      Hiervoor stond hier teams[0]: de eerste workspace waar het token lid van
      is. Dat werkt zolang iemand maar één workspace heeft, en breekt stil zodra
      dat er twee zijn — dan gaat het bestand naar de verkeerde workspace en
      antwoordt ClickUp "404 Not Found or Authorized". De taak zelf werd wél
      aangemaakt (dat gaat via de lijst), dus het zag eruit als een probleem met
      de bijlages terwijl het een probleem met de workspace was.
    */
    getTaskTeamId(clickupToken, taskId)
      .catch(() => null)
      .then(async (viaTaak) => {
        if (viaTaak) return viaTaak;
        const teams = await getTeams(clickupToken);
        if (!teams[0]) throw new Error("Geen ClickUp-workspace gevonden");
        return teams[0].id;
      }),
    getSharedAccessToken(),
    getListCustomFields(clickupToken, listId),
  ]);

  const field = allFields.find((f) => f.name.startsWith(doc.key));
  if (!field) return { fileCount: 0, gelukt: 0, mislukt: [], afgekapt: false, volgendeSkip: 0 };

  const files = await listFolderFiles(dropboxToken, `${dropboxFolderPath}/${doc.folder}`);
  if (files.length === 0) {
    return { fileCount: 0, gelukt: 0, mislukt: [], afgekapt: false, volgendeSkip: 0 };
  }

  // Gerichte herkansing gaat vóór doorgaan-waar-je-was: bij `only` staat al
  // vast welke bestanden nog moeten, en die kunnen overal in de lijst zitten.
  const skip = opties.only?.length ? 0 : Math.min(opties.skip ?? 0, files.length);
  const teDoen = opties.only?.length
    ? files.filter((f) => opties.only!.includes(f.name))
    : files.slice(skip);

  // Tijdsbudget, ruim binnen de 300s die de route krijgt. Er blijft marge
  // over zodat het vastzetten van de bijlages op het veld nog past — afgekapt
  // worden ná het uploaden maar vóór dat zetten zou het werk weggooien.
  // De hervatlogica (skip) blijft bestaan: bij een uitzonderlijk grote serie
  // pakt de volgende aanroep gewoon de rest.
  const deadline = Date.now() + 240_000;

  const attachmentIds: string[] = [];
  const mislukt: string[] = [];
  let afgekapt = false;
  let gedaan = 0;

  for (const file of teDoen) {
    if (Date.now() > deadline) {
      afgekapt = true;
      break;
    }
    gedaan++;
    const path = `${dropboxFolderPath}/${doc.folder}/${file.name}`;
    try {
      const attachment = await withRetry(async () => {
        const blob = await downloadFile(dropboxToken, path);
        return uploadCustomFieldAttachment(clickupToken, teamId, field.id, file.name, blob);
      });
      attachmentIds.push(attachment.id);
    } catch (err) {
      // Eén weerbarstig bestand mag de rest niet meeslepen: doorgaan en aan
      // het eind melden wat er niet lukte. Voorheen ging bij een fout op
      // bestand 8 óók het werk van de eerste zeven verloren.
      console.error(`Bijlage mislukt: ${file.name}`, err);
      mislukt.push(file.name);
    }
  }

  // Vastzetten wat gelukt is. Let op: dit vult het veld aan, het vervangt de
  // inhoud niet — daarom mag hetzelfde bestand nooit twee keer langskomen.
  if (attachmentIds.length > 0) {
    await withRetry(() => setAttachmentFieldValue(clickupToken, taskId, field.id, attachmentIds));
  }

  return {
    fileCount: files.length,
    gelukt: attachmentIds.length,
    mislukt,
    afgekapt,
    // Bij `only` blijft de positie in de lijst waar hij was: die poging gaat
    // niet over doorlopen maar over een handvol specifieke bestanden.
    volgendeSkip: opties.only?.length ? (opties.skip ?? 0) : skip + gedaan,
  };
}
