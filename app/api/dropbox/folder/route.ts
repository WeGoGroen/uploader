import { NextResponse } from "next/server";
import { ensureProjectFolder, getSharedAccessToken } from "@/lib/dropbox";
import { zorgVoorBagRapporten } from "@/lib/bag-rapporten";

export const maxDuration = 300;

/**
 * Maakt (of hergebruikt) de projectmap voor een adres, en geeft de deelbare
 * link terug. Wordt aangeroepen zodra de opnemer bij de Dropbox-stap komt —
 * dus vóórdat de ClickUp-taak bestaat, zodat er al bestanden geüpload kunnen
 * worden terwijl de rest van het formulier nog wordt ingevuld.
 *
 * Voor de energielabel-flow worden hier ook automatisch het BAG-rapport en het
 * 3D BAG-rapport in de map "BAG" gezet (lib/bag-rapporten.ts). Best-effort: een
 * mislukt rapport blokkeert het aanmaken van de projectmap nooit.
 */
async function ensureBagPdfs(
  folderPath: string,
  postcode: string,
  huisnummer: number,
  huisletter: string | null | undefined,
  huisnummertoevoeging: string | null | undefined,
  straatEnNummer: string
) {
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
  await zorgVoorBagRapporten(
    accessToken,
    folderPath,
    { postcode, huisnummer, huisletter, huisnummertoevoeging },
    straatEnNummer
  );
}

export async function POST(request: Request) {
  const body = ((await request.json().catch(() => ({}))) ?? {}) as {
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
  let folder: Awaited<ReturnType<typeof ensureProjectFolder>>;
  try {
    folder = await ensureProjectFolder(kind, body.woonplaats, body.straatEnNummer);
  } catch (err) {
    // Zoeken of aanmaken liep stuk (Dropbox druk of onbereikbaar). Liever een
    // nette fout waarop de app opnieuw kan proberen dan een tweede map.
    console.error("[DROPBOX-MAP] projectmap klaarzetten mislukt", {
      adres: `${body.straatEnNummer}, ${body.woonplaats}`,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: "Dropbox reageerde niet. Probeer het zo nog eens." },
      { status: 502 }
    );
  }
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
