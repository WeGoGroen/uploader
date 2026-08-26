import { NextResponse } from "next/server";
import { ensureProjectFolder, getSharedAccessToken, listFolderFiles, uploadFile } from "@/lib/dropbox";
import { generate3dBagPdf, generateBagPdf } from "@/lib/bag-pdf";

export const maxDuration = 300;

/**
 * Maakt (of hergebruikt) de projectmap voor een adres, en geeft de deelbare
 * link terug. Wordt aangeroepen zodra de opnemer bij de Dropbox-stap komt —
 * dus vóórdat de ClickUp-taak bestaat, zodat er al bestanden geüpload kunnen
 * worden terwijl de rest van het formulier nog wordt ingevuld.
 *
 * Voor de energielabel-flow worden hier ook automatisch twee officiële
 * rapporten in de map "BAG" gezet — het reguliere Kadaster BAG-PDF-rapport
 * (bagviewer.kadaster.nl) én een los 3D BAG-rapport met de 3DBAG-
 * hoogtegegevens (nok-/dakhoogte, bouwlagen). Elk maar één keer per adres:
 * bij een volgende opname op hetzelfde adres wordt een al aanwezig rapport
 * niet opnieuw gemaakt.
 */
async function ensureBagPdfs(
  folderPath: string,
  postcode: string,
  huisnummer: number,
  huisletter: string | null | undefined,
  huisnummertoevoeging: string | null | undefined,
  straatEnNummer: string
) {
  const bagFolder = `${folderPath}/BAG`;
  let accessToken: string;
  try {
    accessToken = await getSharedAccessToken();
  } catch (err) {
    console.error("[BAG-PDF-ALERT] Kon geen Dropbox-token krijgen voor BAG-rapporten", {
      adres: straatEnNummer,
      error: err instanceof Error ? { name: err.name, message: err.message } : err,
    });
    return;
  }

  const existing = await listFolderFiles(accessToken, bagFolder).catch(() => []);
  const hasMainReport = existing.some((f) => f.name.toLowerCase().includes("bag-rapport"));
  const has3dReport = existing.some((f) => f.name.toLowerCase().includes("3d bag"));

  await Promise.all([
    hasMainReport
      ? null
      : generateBagPdf(postcode, huisnummer, huisletter, huisnummertoevoeging)
          .then((pdf) => uploadFile(accessToken, `${bagFolder}/${straatEnNummer} - BAG-rapport.pdf`, pdf))
          .catch((err) => {
            // Best-effort: het BAG-rapport mag het aanmaken van de projectmap
            // nooit blokkeren. Wél duidelijk en doorzoekbaar loggen (prefix
            // "[BAG-PDF-ALERT]") zodat een terugkerende storing (bv. de
            // Kadaster print-key die ooit roteert, of KADASTER_BAG_API_KEY die
            // ontbreekt) opvalt in de Vercel-logs i.p.v. stilzwijgend te
            // verdwijnen — er is bewust geen actieve meldingdienst
            // (Slack/e-mail) gekoppeld, dus dit is de plek om op te controleren.
            console.error("[BAG-PDF-ALERT] Genereren/uploaden van het BAG-rapport is mislukt", {
              adres: straatEnNummer,
              postcode,
              huisnummer,
              error: err instanceof Error ? { name: err.name, message: err.message } : err,
            });
          }),
    has3dReport
      ? null
      : generate3dBagPdf(postcode, huisnummer, huisletter, huisnummertoevoeging)
          .then((pdf) => {
            if (!pdf) return; // geen 3D-reconstructie beschikbaar voor dit pand
            return uploadFile(accessToken, `${bagFolder}/${straatEnNummer} - 3D BAG.pdf`, pdf);
          })
          .catch((err) => {
            console.error("[BAG-PDF-ALERT] Genereren/uploaden van het 3D BAG-rapport is mislukt", {
              adres: straatEnNummer,
              postcode,
              huisnummer,
              error: err instanceof Error ? { name: err.name, message: err.message } : err,
            });
          }),
  ]);
}

export async function POST(request: Request) {
  const body = (await request.json()) as {
    woonplaats?: string;
    straatEnNummer?: string;
    kind?: "energielabel" | "nen" | "media";
    postcode?: string;
    huisnummer?: number;
    huisletter?: string | null;
    huisnummertoevoeging?: string | null;
  };

  if (!body.woonplaats || !body.straatEnNummer) {
    return NextResponse.json({ error: "missing_address" }, { status: 400 });
  }

  const kind = body.kind ?? "energielabel";
  const folder = await ensureProjectFolder(kind, body.woonplaats, body.straatEnNummer);
  if (!folder) {
    return NextResponse.json(
      { error: "Dropbox is nog niet gekoppeld. Zie Verbindingen." },
      { status: 409 }
    );
  }

  if (kind === "energielabel" && body.postcode && body.huisnummer) {
    await ensureBagPdfs(
      folder.path,
      body.postcode,
      body.huisnummer,
      body.huisletter,
      body.huisnummertoevoeging,
      body.straatEnNummer
    );
  }

  return NextResponse.json(folder);
}
