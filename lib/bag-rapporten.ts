import { listFolderFiles, uploadFile } from "@/lib/dropbox";
import { generate3dBagPdf, generateBagPdf } from "@/lib/bag-pdf";

export interface BagAdres {
  postcode: string;
  huisnummer: number;
  huisletter?: string | null;
  huisnummertoevoeging?: string | null;
}

export interface BagUitkomst {
  gemaakt: string[];
  bestondAl: string[];
  /** Er is geen 3D-reconstructie voor dit pand; dan valt er niets te maken. */
  geen3d: boolean;
  fouten: string[];
}

/**
 * Het BAG-rapport en het 3D BAG-rapport in de map "BAG" van een projectmap,
 * elk alleen als het er nog niet staat.
 *
 * Wordt gebruikt bij het aanmaken van de projectmap (app/api/dropbox/folder)
 * en achteraf door de finalisatie (app/api/intern/bag-rapporten), voor de
 * projecten waar het destijds misging of die van vóór deze rapporten zijn.
 * Gooit niet: een mislukt rapport komt terug in `fouten`, met de prefix
 * "[BAG-PDF-ALERT]" ook in de Vercel-logs.
 */
export async function zorgVoorBagRapporten(
  accessToken: string,
  projectmap: string,
  adres: BagAdres,
  straatEnNummer: string
): Promise<BagUitkomst> {
  const bagFolder = `${projectmap}/BAG`;
  const uit: BagUitkomst = { gemaakt: [], bestondAl: [], geen3d: false, fouten: [] };

  const existing = await listFolderFiles(accessToken, bagFolder).catch(() => []);
  const hasMainReport = existing.some((f) => f.name.toLowerCase().includes("bag-rapport"));
  const has3dReport = existing.some((f) => f.name.toLowerCase().includes("3d bag"));
  if (hasMainReport) uit.bestondAl.push("BAG-rapport");
  if (has3dReport) uit.bestondAl.push("3D BAG");

  const { postcode, huisnummer, huisletter, huisnummertoevoeging } = adres;
  const meld = (welk: string, err: unknown) => {
    console.error(`[BAG-PDF-ALERT] Genereren/uploaden van het ${welk} is mislukt`, {
      adres: straatEnNummer,
      postcode,
      huisnummer,
      error: err instanceof Error ? { name: err.name, message: err.message } : err,
    });
    uit.fouten.push(`${welk}: ${err instanceof Error ? err.message.slice(0, 160) : "onbekende fout"}`);
  };

  await Promise.all([
    hasMainReport
      ? null
      : generateBagPdf(postcode, huisnummer, huisletter, huisnummertoevoeging)
          .then((pdf) => uploadFile(accessToken, `${bagFolder}/${straatEnNummer} - BAG-rapport.pdf`, pdf))
          .then(() => void uit.gemaakt.push("BAG-rapport"))
          .catch((err) => meld("BAG-rapport", err)),
    has3dReport
      ? null
      : generate3dBagPdf(postcode, huisnummer, huisletter, huisnummertoevoeging)
          .then(async (pdf) => {
            if (!pdf) {
              uit.geen3d = true; // geen 3D-reconstructie beschikbaar voor dit pand
              return;
            }
            await uploadFile(accessToken, `${bagFolder}/${straatEnNummer} - 3D BAG.pdf`, pdf);
            uit.gemaakt.push("3D BAG");
          })
          .catch((err) => meld("3D BAG-rapport", err)),
  ]);
  return uit;
}
