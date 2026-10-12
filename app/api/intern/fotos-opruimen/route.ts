import { NextResponse } from "next/server";
import { isInternRequest } from "@/lib/intern-auth";
import {
  createFolder,
  folderExists,
  getSharedAccessToken,
  leesProjectmap,
  verplaats,
} from "@/lib/dropbox";
import { FOTOMAP, HOOFDMAP, isProjectmap, kiesLosseFotos } from "@/lib/fotos-opruimen";

export const maxDuration = 300;

/**
 * De losse foto's uit een projectmap in de submap "foto's" zetten.
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
 *  2. Alleen bestanden die **los in de projectmap** liggen. Wat in een submap
 *     staat blijft staan, ook als het een foto is: de oplevermap van MO
 *     Consultancy en "onderbouwing" zijn andermans werk, en daar foto's
 *     weghalen is een oplevering stukmaken.
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

  const los = kiesLosseFotos(inhoud.bestanden);

  // Wat er al in "foto's" staat, op kleine letters: Dropbox is niet
  // kapitaalgevoelig, dus "IMG_1.JPG" en "img_1.jpg" zijn hetzelfde bestand.
  const fotomap = inhoud.mappen.find((m) => m.toLowerCase() === FOTOMAP);
  const alAanwezig = new Set(
    inhoud.bestanden
      .filter((b) => b.pad.toLowerCase().startsWith(`${FOTOMAP}/`))
      .map((b) => b.naam.toLowerCase())
  );

  const verplaatst: string[] = [];
  const overgeslagen: { naam: string; reden: string }[] = [];
  const mislukt: { naam: string; reden: string }[] = [];

  if (los.length === 0) {
    return NextResponse.json({
      ok: true,
      pad: inhoud.pad,
      droog,
      fotomapBestond: Boolean(fotomap),
      verplaatst,
      overgeslagen,
      mislukt,
      reden: "er liggen geen losse foto's in de projectmap",
    });
  }

  // De submap kan ontbreken; dan maken we hem. Alleen als er ook werkelijk iets
  // in moet — een lege "foto's" aanmaken zet een vinkje dat niets dekt.
  const doelmap = fotomap ?? FOTOMAP;
  if (!fotomap && !droog) {
    try {
      await createFolder(token, `${inhoud.pad}/${doelmap}`);
    } catch (err) {
      // Bestaat hij inmiddels toch (andere ronde, andere sessie), dan is dat geen fout.
      const bestaat = await folderExists(token, `${inhoud.pad}/${doelmap}`).catch(() => false);
      if (!bestaat) {
        return NextResponse.json(
          {
            error: `kon de submap ${doelmap} niet aanmaken: ${
              err instanceof Error ? err.message.slice(0, 160) : "onbekende fout"
            }`,
          },
          { status: 502 }
        );
      }
    }
  }

  for (const foto of los) {
    if (alAanwezig.has(foto.naam.toLowerCase())) {
      overgeslagen.push({ naam: foto.naam, reden: `er staat al een ${foto.naam} in ${doelmap}` });
      continue;
    }
    if (droog) {
      verplaatst.push(foto.naam);
      // Ook in een droge ronde bijhouden, zodat twee gelijknamige losse
      // bestanden niet allebei als verplaatsbaar worden gemeld.
      alAanwezig.add(foto.naam.toLowerCase());
      continue;
    }
    try {
      await verplaats(token, `${inhoud.pad}/${foto.naam}`, `${inhoud.pad}/${doelmap}/${foto.naam}`);
      verplaatst.push(foto.naam);
      alAanwezig.add(foto.naam.toLowerCase());
    } catch (err) {
      mislukt.push({
        naam: foto.naam,
        reden: err instanceof Error ? err.message.slice(0, 160) : "onbekende fout",
      });
    }
  }

  return NextResponse.json({
    ok: mislukt.length === 0,
    pad: inhoud.pad,
    droog,
    fotomapBestond: Boolean(fotomap),
    verplaatst,
    overgeslagen,
    mislukt,
    reden:
      verplaatst.length > 0
        ? `${verplaatst.length} foto('s) ${droog ? "te verplaatsen" : "verplaatst"} naar ${doelmap}`
        : "niets te verplaatsen",
  });
}
