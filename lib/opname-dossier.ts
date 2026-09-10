import { getTaakVolledig, requireClickUpConfig } from "@/lib/clickup";
import {
  findProjectFolder,
  getSharedAccessToken,
  listFolderFiles,
  sanitizePathSegment,
  uploadFile,
} from "@/lib/dropbox";
import { taskToAddress } from "@/lib/sharepoint-match";
import { bijlagenUitVelden, bouwGroepen, splitsCode, veldTekst, type RuwVeld } from "@/lib/opname-velden";
import { bouwOpnameDossier, type DossierFoto } from "@/lib/opname-pdf";

/**
 * Het opnameformulier uit ClickUp als PDF in de projectmap.
 *
 * Waarom dit bestaat: de aanvraag staat volledig in ClickUp en nergens anders.
 * Wie later in Dropbox kijkt — de adviseur, een collega, de klant — ziet foto's
 * en een LAZ-scan, maar niet wat de opnemer heeft ingevuld. Dat is precies de
 * informatie die je nodig hebt om te begrijpen wat je ziet, en ze zit vast in
 * een taak waar niet iedereen bij kan.
 *
 * Eén handeling, twee aanleidingen, net als bij de SharePoint-overdracht: de
 * Energielabel AI Agent roept dit aan zodra een opdracht nog geen dossier heeft,
 * en dezelfde functie doet het werk bij een inhaalslag. Geen webhook — een
 * webhook is een gebeurtenis, en een ontbrekend dossier is een toestand.
 */

export const DOSSIER_MAP = "Opname formulier";

/** Meer dan dit aan foto's is geen dossier meer maar een fotoboek, en het duwt
    de PDF over de tijdslimiet van de agent heen. */
const MAX_FOTOS = 120;
/** Tegelijk ophalen bij ClickUp. Zes is ruim binnen hun limiet en scheelt bij
    vijftig foto's een minuut. */
const TEGELIJK = 6;

export interface DossierUitkomst {
  ok: boolean;
  /** Waaróm het niet kon. Bepaalt of opnieuw proberen zin heeft: een taak
      zonder adres wordt vanzelf nooit beter, een 500 van Dropbox wel. */
  code: "geen_adres" | "geen_projectmap" | "geen_velden" | "clickup" | "dropbox" | null;
  reden: string | null;
  adres: string | null;
  /** Volledig pad van de PDF in Dropbox. */
  pad: string | null;
  bestand: string | null;
  velden: number;
  ingevuld: number;
  fotos: number;
  /** Bijlagen die geen afbeelding zijn; die staan als regel in de PDF. */
  overgeslagen: number;
  /** Waar als er al een dossier stond en er niets opnieuw gemaakt is. */
  bestondAl: boolean;
}

function mislukt(code: DossierUitkomst["code"], reden: string, adres: string | null = null): DossierUitkomst {
  return {
    ok: false,
    code,
    reden,
    adres,
    pad: null,
    bestand: null,
    velden: 0,
    ingevuld: 0,
    fotos: 0,
    overgeslagen: 0,
    bestondAl: false,
  };
}

/** Zoekt één veld op zijn code op; voor de paar dingen die in de kop komen. */
function waardeVanCode(velden: RuwVeld[], code: string): string | null {
  for (const veld of velden) {
    const gesplitst = splitsCode(veld.name);
    if (gesplitst?.code === code) return veldTekst(veld);
  }
  return null;
}

async function haalAfbeeldingen(
  bijlagen: ReturnType<typeof bijlagenUitVelden>
): Promise<{ fotos: DossierFoto[]; mislukt: number }> {
  const fotos: DossierFoto[] = [];
  let misluktAantal = 0;

  for (let i = 0; i < bijlagen.length; i += TEGELIJK) {
    const groepje = bijlagen.slice(i, i + TEGELIJK);
    const opgehaald = await Promise.all(
      groepje.map(async (b) => {
        // De miniatuur en niet het origineel: een opnamefoto is drie megabyte
        // en op een tegel van vier centimeter ziet niemand het verschil. Vijftig
        // originelen zouden de PDF onverstuurbaar maken.
        const url = b.miniatuurUrl ?? b.url;
        try {
          const res = await fetch(url, { cache: "no-store" });
          if (!res.ok) return null;
          const bytes = new Uint8Array(await res.arrayBuffer());
          if (bytes.byteLength === 0) return null;
          return {
            code: b.code,
            label: b.label,
            naam: b.naam,
            bytes,
            // ClickUp levert miniaturen altijd als JPEG, ook van een PNG.
            mime: b.miniatuurUrl ? "image/jpeg" : b.mime,
          } satisfies DossierFoto;
        } catch {
          return null;
        }
      })
    );
    for (const foto of opgehaald) {
      if (foto) fotos.push(foto);
      else misluktAantal++;
    }
  }

  return { fotos, mislukt: misluktAantal };
}

/**
 * Maakt het dossier voor één ClickUp-taak en zet het in de projectmap.
 *
 * Standaard idempotent: staat het bestand er al, dan gebeurt er niets en komt
 * `bestondAl` terug. Dat is wat een agent die elke tien minuten draait nodig
 * heeft — anders staat er elke ronde een nieuwe versie in Dropbox en ziet de
 * klant een map die "steeds verandert" zonder dat er iets verandert.
 */
export async function dossierVoorTaak(
  taskId: string,
  opties: { opnieuw?: boolean } = {}
): Promise<DossierUitkomst> {
  let token: string;
  try {
    ({ token } = await requireClickUpConfig());
  } catch (err) {
    return mislukt("clickup", err instanceof Error ? err.message : "geen ClickUp-token");
  }

  const taak = await getTaakVolledig(token, taskId);

  const adresGegevens = taskToAddress({
    name: taak.name,
    customFields: taak.customFields.map((f) => ({ name: f.name, value: f.value })),
  });
  if (!adresGegevens) {
    return mislukt("geen_adres", `Taak "${taak.name}" bevat geen leesbaar adres; dit lijkt geen opname.`);
  }
  const adres = `${adresGegevens.addressLine}, ${adresGegevens.woonplaats}`;

  const groepen = bouwGroepen(taak.customFields);
  const velden = groepen.reduce((som, g) => som + g.velden.length, 0);
  if (velden === 0) {
    /*
      Geen enkel A- tot en met E-veld. Dat is geen opname maar bijvoorbeeld een
      handmatig aangemaakte taak in dezelfde lijst; daar een leeg formulier van
      afdrukken helpt niemand, en opnieuw proberen verandert er niets aan.
    */
    return mislukt("geen_velden", `Taak "${taak.name}" heeft geen opnameformulier-velden ingevuld.`, adres);
  }

  let dropboxToken: string;
  try {
    dropboxToken = await getSharedAccessToken();
  } catch (err) {
    return mislukt("dropbox", err instanceof Error ? err.message : "geen Dropbox-koppeling", adres);
  }

  /*
    De bestaande map opzoeken en er nooit zelf een maken.

    Dezelfde afspraak als bij de SharePoint-overdracht: is er geen projectmap,
    dan klopt er iets anders niet — een afwijkend gespeld adres, een opname die
    nooit via de app liep. Een tweede map ernaast zetten maakt dat probleem
    stiller in plaats van kleiner.
  */
  const map = await findProjectFolder(
    dropboxToken,
    "energielabel",
    adresGegevens.woonplaats,
    adresGegevens.addressLine
  ).catch(() => null);
  if (!map) {
    return mislukt(
      "geen_projectmap",
      `Geen projectmap gevonden onder Automatie Energielabels voor ${adres}.`,
      adres
    );
  }

  const doelmap = `${map.path}/${DOSSIER_MAP}`;
  const bestand = `Opnameformulier ${sanitizePathSegment(adresGegevens.addressLine)}.pdf`;
  const pad = `${doelmap}/${bestand}`;

  if (!opties.opnieuw) {
    const bestaand = await listFolderFiles(dropboxToken, doelmap).catch(() => []);
    if (bestaand.some((b) => b.name.toLowerCase() === bestand.toLowerCase())) {
      return {
        ok: true,
        code: null,
        reden: null,
        adres,
        pad,
        bestand,
        velden,
        ingevuld: groepen.reduce((s, g) => s + g.velden.filter((v) => v.waarde !== null).length, 0),
        fotos: 0,
        overgeslagen: 0,
        bestondAl: true,
      };
    }
  }

  const bijlagen = bijlagenUitVelden(taak.customFields);
  const afbeeldingen = bijlagen
    .filter((b) => b.mime.startsWith("image/") || Boolean(b.miniatuurUrl))
    .slice(0, MAX_FOTOS);
  const anders = bijlagen.filter((b) => !afbeeldingen.includes(b));

  const { fotos, mislukt: nietOpgehaald } = await haalAfbeeldingen(afbeeldingen);

  const pdf = await bouwOpnameDossier({
    adres: adresGegevens.addressLine,
    postcodePlaats: adresGegevens.postcodeRegel ?? adresGegevens.woonplaats,
    taakId: taak.id,
    taakNaam: taak.name,
    status: taak.status,
    adviseur: waardeVanCode(taak.customFields, "A2"),
    gebouwtype: waardeVanCode(taak.customFields, "A4"),
    bouwjaar: waardeVanCode(taak.customFields, "A3"),
    aangemaaktMs: taak.dateCreated,
    streefdatumMs: taak.dueDate,
    groepen,
    fotos,
    andereBijlagen: anders.map((b) => ({ code: b.code, naam: b.naam })),
    opgehaaldOp: new Date(),
  });

  try {
    await uploadFile(dropboxToken, pad, Buffer.from(pdf));
  } catch (err) {
    return mislukt("dropbox", err instanceof Error ? err.message.slice(0, 240) : "upload mislukt", adres);
  }

  return {
    ok: true,
    code: null,
    reden: null,
    adres,
    pad,
    bestand,
    velden,
    ingevuld: groepen.reduce((s, g) => s + g.velden.filter((v) => v.waarde !== null).length, 0),
    fotos: fotos.length,
    overgeslagen: anders.length + nietOpgehaald,
    bestondAl: false,
  };
}
