import { NextResponse } from "next/server";
import { isInternRequest } from "@/lib/intern-auth";
import {
  createTemporaryUploadLink,
  folderExists,
  getSharedAccessToken,
  sanitizePathSegment,
} from "@/lib/dropbox";

export const maxDuration = 30;

/**
 * Een uploadlink voor één PDF in een bestaande energielabel-projectmap.
 *
 * Waarvoor: het afschrift van een geregistreerd label komt niet uit de API van
 * EP-Online — die levert alleen gegevens — maar moet na inloggen met
 * eHerkenning met de hand gedownload worden. Vanaf het dossier in het control
 * center sleep je die PDF erin, en dan hoort hij in de projectmap te staan
 * zonder dat iemand Dropbox openklikt en de juiste map zoekt.
 *
 * Het bestand gaat niet door deze server: de browser krijgt een tijdelijke
 * link die voor precies dit ene pad geldt, een uur lang, en stuurt het
 * rechtstreeks naar Dropbox. Het account-token blijft hier.
 *
 * Drie grenzen, en ze zijn het punt van deze route:
 *
 *  1. Alleen een projectmap onder "Automatie Energielabels" — direct, of in het
 *     archief "Afgerond". Een pad daarbuiten is geen label-dossier.
 *  2. De projectmap moet al bestaan. Deze route maakt er nooit een aan: geen
 *     map betekent dat een adres anders gespeld staat, en een tweede map naast
 *     de echte verspreidt de stukken zonder dat iemand het merkt.
 *  3. Alleen een PDF, in de submap "EP-Online". Die submap mag wel ontstaan,
 *     zoals de map van MO Consultancy bij de overdracht ook binnen de
 *     projectmap ontstaat.
 */

const HOOFDMAP = "Automatie Energielabels";
const SUBMAP = "EP-Online";

function isProjectmap(pad: string): boolean {
  if (!pad.startsWith(`/${HOOFDMAP}/`) || pad.includes("..") || pad.endsWith("/")) return false;
  const delen = pad.split("/").filter(Boolean);
  // ["Automatie Energielabels", "<adres>"] of ["Automatie Energielabels", "Afgerond", "<adres>"]
  if (delen.length === 2) return delen[1] !== "Afgerond";
  if (delen.length === 3) return delen[1] === "Afgerond";
  return false;
}

export async function POST(request: Request) {
  if (!isInternRequest(request)) {
    return NextResponse.json({ error: "niet_toegestaan" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as {
    projectmap?: string;
    bestandsnaam?: string;
  } | null;

  const projectmap = body?.projectmap?.trim() ?? "";
  if (!isProjectmap(projectmap)) {
    return NextResponse.json(
      { error: `alleen een projectmap onder /${HOOFDMAP} — kreeg "${projectmap}"` },
      { status: 400 }
    );
  }

  const naam = sanitizePathSegment(body?.bestandsnaam ?? "");
  if (!/\.pdf$/i.test(naam) || naam.length < 5 || naam.length > 180) {
    return NextResponse.json({ error: "alleen een PDF met een gewone bestandsnaam" }, { status: 400 });
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

  // Bestaat de projectmap? Staat hij er niet, dan geven we geen link: een
  // upload naar dat pad zou de map alsnog laten ontstaan. Dat gebeurt
  // bijvoorbeeld net na het archiveren, als het oude pad nog rondgaat.
  let bestaat: boolean;
  try {
    bestaat = await folderExists(token, projectmap);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message.slice(0, 200) : "Dropbox niet te bevragen" },
      { status: 502 }
    );
  }
  if (!bestaat) {
    return NextResponse.json(
      { error: `de projectmap ${projectmap} bestaat niet in Dropbox — er wordt geen nieuwe aangemaakt` },
      { status: 404 }
    );
  }

  const pad = `${projectmap}/${SUBMAP}/${naam}`;
  try {
    const link = await createTemporaryUploadLink(token, pad);
    return NextResponse.json({ ok: true, link, pad });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message.slice(0, 200) : "uploadlink maken mislukt" },
      { status: 502 }
    );
  }
}
