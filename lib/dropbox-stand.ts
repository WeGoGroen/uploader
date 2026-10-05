import { after } from "next/server";
import { detailProjectFolders, getSharedAccessToken, type ProjectMapDetail } from "@/lib/dropbox";
import { getOptionalRedis } from "@/lib/redis";

/**
 * De stand van de drie hoofdmappen, voor /api/intern/dropbox.
 *
 * Die listing loopt recursief door ruim 880 projectmappen met al hun
 * bestanden en duurt 23 tot 27 seconden — en het control center vroeg hem
 * zo'n zeventig keer per uur op (de synchronisatie en de controles, per
 * domein). Elke aanroep deed het hele werk opnieuw voor een antwoord dat in
 * die paar minuten nauwelijks veranderd was, en hij groeit mee met het
 * archief tot hij de maxDuration van 60 seconden raakt.
 *
 * Nu bewaren we de laatste volledige listing in Redis:
 *
 *  - jonger dan VERS_MS: zo terug;
 *  - ouder, maar jonger dan HOUDBAAR_MS: zo terug, en één verversing op de
 *    achtergrond (met een slot, zodat tien gelijktijdige vragen niet tien
 *    listings starten);
 *  - geen of te oud, of `vers`: wachten op een nieuwe listing.
 *
 * Alleen een listing waarin elke hoofdmap volledig gelukt is, wordt bewaard.
 * Een afgekapte of mislukte listing zegt "deze map is leeg" over mappen die
 * vol staan; die mag niet een kwartier blijven hangen.
 */

export const HOOFDMAPPEN = ["/Automatie Energielabels", "/Automatie NEN2580", "/Automatie Media"];

const SLEUTEL = "intern:dropbox:stand";
const SLOT = "intern:dropbox:stand:slot";
const VERS_MS = 4 * 60_000;
const HOUDBAAR_MS = 30 * 60_000;
const SLOT_S = 90;

export interface HoofdmapStand {
  root: string;
  volledig: boolean;
  projecten: ProjectMapDetail[];
  fout: string | null;
}

export interface DropboxStand {
  gemetenOp: string;
  mappen: HoofdmapStand[];
}

export async function haalDropboxStand(opties: { vers?: boolean } = {}): Promise<DropboxStand> {
  const redis = getOptionalRedis();
  if (!redis) return lees();

  const bewaard = opties.vers ? null : await leesBewaard();
  if (bewaard) {
    const leeftijd = Date.now() - new Date(bewaard.gemetenOp).getTime();
    if (leeftijd < VERS_MS) return bewaard;
    if (leeftijd < HOUDBAAR_MS) {
      ververs();
      return bewaard;
    }
  }
  return leesEnBewaar();
}

async function leesBewaard(): Promise<DropboxStand | null> {
  const ruw = await getOptionalRedis()
    ?.get(SLEUTEL)
    .catch(() => null);
  if (!ruw) return null;
  try {
    return JSON.parse(ruw) as DropboxStand;
  } catch {
    return null;
  }
}

/** Eén verversing op de achtergrond, met een slot over alle instanties heen. */
function ververs(): void {
  const redis = getOptionalRedis();
  if (!redis) return;
  const werk = redis
    .set(SLOT, "1", "EX", SLOT_S, "NX")
    .then(async (gekregen) => {
      // Een andere instantie is al bezig; zijn slot laten we staan.
      if (!gekregen) return;
      try {
        await leesEnBewaar();
      } finally {
        await redis.del(SLOT).catch(() => {});
      }
    })
    .catch(() => {});
  try {
    // Vercel zet de functie stil zodra het antwoord weg is; dit vraagt om te
    // wachten tot de listing klaar is.
    after(() => werk);
  } catch {
    // Buiten een verzoek: de belofte loopt zelf af.
  }
}

async function leesEnBewaar(): Promise<DropboxStand> {
  const stand = await lees();
  if (stand.mappen.every((m) => m.volledig && !m.fout)) {
    await getOptionalRedis()
      ?.set(SLEUTEL, JSON.stringify(stand), "PX", HOUDBAAR_MS)
      .catch(() => {});
  }
  return stand;
}

async function lees(): Promise<DropboxStand> {
  const token = await getSharedAccessToken();
  const gemetenOp = new Date().toISOString();
  const mappen = await Promise.all(
    HOOFDMAPPEN.map(async (root): Promise<HoofdmapStand> => {
      try {
        const { folders, volledig } = await detailProjectFolders(token, root);
        return { root, volledig, projecten: folders, fout: null };
      } catch (err) {
        return {
          root,
          volledig: false,
          projecten: [],
          fout: err instanceof Error ? err.message.slice(0, 200) : "onbekende fout",
        };
      }
    })
  );
  return { gemetenOp, mappen };
}
