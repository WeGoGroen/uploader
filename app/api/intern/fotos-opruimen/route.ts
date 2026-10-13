import { NextResponse } from "next/server";
import { isInternRequest } from "@/lib/intern-auth";
import {
  createFolder,
  folderExists,
  getSharedAccessToken,
  leesProjectmap,
  verplaats,
} from "@/lib/dropbox";
import {
  FOTOMAP,
  HOOFDMAP,
  SCANMAP,
  isProjectmap,
  kiesLosseFotos,
  kiesOpnameFotos,
  kiesScans,
} from "@/lib/fotos-opruimen";

export const maxDuration = 300;

/**
 * De losse foto's uit een projectmap in de submap "foto's" zetten — en sinds
 * 13 oktober ook de gevelfoto's uit "Opname formulier" en de LAS/LAZ-scans
 * die buiten "LAZ" staan (zie lib/fotos-opruimen.ts).
 *
 * Waarvoor: wie foto's aanlevert sleept ze in de projectmap en niet in de
 * submap. Voor de controle in het control center zijn ze dan onvindbaar — die
 * kijkt in "foto's" — en het dossier blijft op "foto's ontbreken" staan terwijl
 * ze er wel degelijk zijn. Dat is de enige situatie die deze route oplost: de
 * foto's zijn er, ze staan op de verkeerde plek.
 *
 * Vier grenzen, en ze zijn het punt van deze route:
 *
 *  1. Alleen een projectmap onder "Automatie Energielabels" — direct, of in het
 *     archief "Afgerond".
 *  2. Foto's alleen als ze **los in de projectmap** of direct in "Opname
 *     formulier" liggen. Wat in een andere submap staat blijft staan, ook als
 *     het een foto is: de oplevermap van MO Consultancy en "onderbouwing" zijn
 *     andermans werk. Scans (.las/.laz) wel van overal, want die horen
 *     nergens anders dan in "LAZ".
 *  3. Alleen afbeeldingen, op extensie. Nooit een PDF, nooit een scan, nooit
 *     iets waarvan de soort niet vaststaat — een verdwaald bestand verplaatsen
 *     is erger dan het laten liggen, want in "foto's" kijkt niemand ernaar.
 *  4. Nooit overschrijven. Staat er in "foto's" al iets met die naam, dan
 *     blijft het origineel liggen en komt het terug als "overgeslagen". Twee
 *     bestanden met dezelfde naam kunnen twee verschillende foto's zijn.
 *
 * Met `droog: true` verplaatst hij niets en zegt hij alleen wat hij zou doen.
 */

export async function POST(request: Request) {
  if (!isInternRequest(request)) {
    return NextResponse.json({ error: "niet_toegestaan" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as
    | { projectmap?: string; folder_id?: string; droog?: boolean }
    | null;

  const droog = body?.droog === true;
  const sleutel = (body?.folder_id || body?.projectmap || "").trim();
  if (!sleutel) {
    return NextResponse.json({ error: "geef projectmap of folder_id mee" }, { status: 400 });
  }

  let token: string;
  try {
    token = await getSharedAccessToken();
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message.slice(0, 200) : "Dropbox niet gekoppeld" },
      { status: 503 }
    );
  }

  /*
    Op id of op pad, net als /api/intern/projectmap: een id blijft kloppen nadat
    de map naar "Afgerond" is verhuisd. Het pad dat Dropbox teruggeeft is wat we
    daarna controleren — niet het pad dat de aanroeper dacht te hebben.
  */
  let inhoud;
  try {
    inhoud = await leesProjectmap(token, sleutel);
  } catch (err) {
    const status = err instanceof Error && err.message.includes("404") ? 404 : 502;
    return NextResponse.json(
      { error: err instanceof Error ? err.message.slice(0, 200) : "map niet te lezen" },
      { status }
    );
  }

  if (!isProjectmap(inhoud.pad)) {
    return NextResponse.json(
      { error: `alleen een projectmap onder /${HOOFDMAP} — kreeg "${inhoud.pad}"` },
      { status: 400 }
    );
  }

  /*
    Drie stromen, elk met dezelfde vier grenzen hierboven:
     - losse foto's in de projectmap        → "foto's"
     - gevelfoto's in "Opname formulier"    → "foto's"
     - LAS/LAZ buiten "LAZ"                 → "LAZ"
  */
  const fotos = [...kiesLosseFotos(inhoud.bestanden), ...kiesOpnameFotos(inhoud.bestanden)];
  const scans = kiesScans(inhoud.bestanden);

  const fotoUit = await verhuis(token, inhoud, fotos, FOTOMAP, droog);
  if ("fout" in fotoUit) return NextResponse.json({ error: fotoUit.fout }, { status: 502 });
  const scanUit = await verhuis(token, inhoud, scans, SCANMAP, droog, "LAZ");
  if ("fout" in scanUit) return NextResponse.json({ error: scanUit.fout }, { status: 502 });

  const { verplaatst, overgeslagen, mislukt } = fotoUit;
  const totaal = verplaatst.length + scanUit.verplaatst.length;
  return NextResponse.json({
    ok: mislukt.length === 0 && scanUit.mislukt.length === 0,
    pad: inhoud.pad,
    droog,
    fotomapBestond: fotoUit.mapBestond,
    verplaatst,
    overgeslagen,
    mislukt,
    scans: { verplaatst: scanUit.verplaatst, overgeslagen: scanUit.overgeslagen, mislukt: scanUit.mislukt },
    reden:
      totaal > 0
        ? [
            verplaatst.length > 0 ? `${verplaatst.length} foto('s) ${droog ? "te verplaatsen" : "verplaatst"} naar ${FOTOMAP}` : null,
            scanUit.verplaatst.length > 0
              ? `${scanUit.verplaatst.length} scan(s) ${droog ? "te verplaatsen" : "verplaatst"} naar LAZ`
              : null,
          ]
            .filter(Boolean)
            .join("; ")
        : "niets te verplaatsen",
  });
}

/**
 * Een lijst bestanden in één submap van de projectmap zetten, zonder ooit te
 * overschrijven. De submap wordt alleen aangemaakt als er ook iets in moet.
 */
async function verhuis(
  token: string,
  inhoud: { pad: string; mappen: string[]; bestanden: { pad: string; naam: string }[] },
  bestanden: { pad: string; naam: string }[],
  submap: string,
  droog: boolean,
  nieuweNaam: string = submap
): Promise<
  | {
      mapBestond: boolean;
      verplaatst: string[];
      overgeslagen: { naam: string; reden: string }[];
      mislukt: { naam: string; reden: string }[];
    }
  | { fout: string }
> {
  // Wat er al in de submap staat, op kleine letters: Dropbox is niet
  // kapitaalgevoelig, dus "IMG_1.JPG" en "img_1.jpg" zijn hetzelfde bestand.
  const bestaand = inhoud.mappen.find((m) => m.toLowerCase() === submap);
  const alAanwezig = new Set(
    inhoud.bestanden
      .filter((b) => b.pad.toLowerCase().startsWith(`${submap}/`))
      .map((b) => b.naam.toLowerCase())
  );
  const uit = {
    mapBestond: Boolean(bestaand),
    verplaatst: [] as string[],
    overgeslagen: [] as { naam: string; reden: string }[],
    mislukt: [] as { naam: string; reden: string }[],
  };
  if (bestanden.length === 0) return uit;

  const doelmap = bestaand ?? nieuweNaam;
  if (!bestaand && !droog) {
    try {
      await createFolder(token, `${inhoud.pad}/${doelmap}`);
    } catch (err) {
      // Bestaat hij inmiddels toch (andere ronde, andere sessie), dan is dat geen fout.
      const bestaat = await folderExists(token, `${inhoud.pad}/${doelmap}`).catch(() => false);
      if (!bestaat) {
        return {
          fout: `kon de submap ${doelmap} niet aanmaken: ${
            err instanceof Error ? err.message.slice(0, 160) : "onbekende fout"
          }`,
        };
      }
    }
  }

  for (const bestand of bestanden) {
    if (alAanwezig.has(bestand.naam.toLowerCase())) {
      uit.overgeslagen.push({ naam: bestand.naam, reden: `er staat al een ${bestand.naam} in ${doelmap}` });
      continue;
    }
    // Ook in een droge ronde bijhouden, zodat twee gelijknamige bestanden niet
    // allebei als verplaatsbaar worden gemeld.
    alAanwezig.add(bestand.naam.toLowerCase());
    if (droog) {
      uit.verplaatst.push(bestand.pad);
      continue;
    }
    try {
      await verplaats(token, `${inhoud.pad}/${bestand.pad}`, `${inhoud.pad}/${doelmap}/${bestand.naam}`);
      uit.verplaatst.push(bestand.pad);
    } catch (err) {
      alAanwezig.delete(bestand.naam.toLowerCase());
      uit.mislukt.push({
        naam: bestand.pad,
        reden: err instanceof Error ? err.message.slice(0, 160) : "onbekende fout",
      });
    }
  }
  return uit;
}
