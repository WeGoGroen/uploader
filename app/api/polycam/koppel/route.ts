import { NextResponse } from "next/server";
import { checkSaveUrlJob, getMetadata, getSharedAccessToken, saveUrl } from "@/lib/dropbox";
import {
  beschikbareBestanden,
  deellinkVoor,
  haalScan,
  PolycamApiError,
  PolycamNietIngesteld,
  startLasExport,
  vindPuntenwolk,
} from "@/lib/polycam";
import { lasBestandsnaam, type KoppelAntwoord } from "@/lib/polycam-velden";

/**
 * Koppelt één Polycam-scan aan de opname, één stap per aanroep.
 *
 * Bewust zonder eigen opslag: de pagina vraagt dit om de paar seconden
 * opnieuw en stuurt mee wat het vorige antwoord teruggaf (exportGestart,
 * saveJobId). Zo hoeft geen enkele aanroep te wachten tot Polycam klaar is
 * met exporteren — dat kan minuten duren, langer dan een functie mag lopen.
 *
 * De LAS komt niet langs onze server: Dropbox haalt hem zelf op van de
 * tijdelijke downloadlink van Polycam (files/save_url), net als bij de
 * SharePoint-overdracht. Honderden MB's raken Vercel dus nooit.
 */

interface Body {
  captureId?: string;
  /** Projectmap in Dropbox, bv. "/Automatie Energielabels/Dorpsstraat 12 Zwolle". */
  dropboxPad?: string;
  /** "Begane grond" — voor de bestandsnaam. */
  verdieping?: string;
  exportGestart?: boolean;
  saveJobId?: string | null;
}

const LAZ_MAP = "LAZ";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Body;
  const captureId = body.captureId?.trim();
  if (!captureId) return NextResponse.json({ error: "missing_capture_id" }, { status: 400 });
  const dropboxPad = body.dropboxPad?.replace(/\/$/, "");
  if (!dropboxPad || !dropboxPad.startsWith("/")) {
    return NextResponse.json({ error: "missing_dropbox_pad" }, { status: 400 });
  }
  const verdieping = body.verdieping?.trim() || "Verdieping";

  try {
    const scan = await haalScan(captureId);
    if (!scan) return NextResponse.json({ error: "scan_niet_gevonden" }, { status: 404 });

    const antwoord: KoppelAntwoord = {
      fase: "wacht-upload",
      scan: { id: scan.id, naam: scan.naam, gemaaktOp: scan.gemaaktOp, openbaar: scan.openbaar },
      deellink: null,
      bestand: null,
      saveJobId: null,
      exportGestart: !!body.exportGestart,
      fout: null,
    };

    if (scan.status === "mislukt") {
      return NextResponse.json({ ...antwoord, fase: "fout", fout: "Polycam kon deze scan niet verwerken." });
    }
    // Nog niet (helemaal) geüpload of verwerkt: dan is er nog niets te delen
    // of te downloaden. De pagina vraagt het zo opnieuw.
    if (scan.status !== "klaar") return NextResponse.json(antwoord);

    antwoord.deellink = deellinkVoor(scan.id);
    const token = await getSharedAccessToken();

    // Loopt er al een Dropbox-opdracht, dan alleen de stand opvragen.
    if (body.saveJobId) {
      const { status, error } = await checkSaveUrlJob(token, body.saveJobId);
      if (status === "complete") return NextResponse.json({ ...antwoord, fase: "klaar" });
      if (status === "failed") {
        console.error("[polycam/koppel] save_url mislukt", error);
        return NextResponse.json({ ...antwoord, fase: "fout", fout: "Dropbox kon de LAS niet ophalen. Probeer het opnieuw." });
      }
      return NextResponse.json({ ...antwoord, fase: "opslaan", saveJobId: body.saveJobId });
    }

    const bestanden = await beschikbareBestanden(scan.id);
    const wolk = vindPuntenwolk(bestanden);
    const formaat = wolk?.formaat === "laz" ? "laz" : "las";
    const pad = `${dropboxPad}/${LAZ_MAP}/${lasBestandsnaam(verdieping, scan.naam, formaat)}`;
    antwoord.bestand = pad;

    // Al eerder opgeslagen (bv. na herladen): niet nog eens. save_url kent
    // geen overschrijven en zou er "… (1).las" naast zetten.
    if (await getMetadata(token, pad)) return NextResponse.json({ ...antwoord, fase: "klaar" });

    if (!wolk) {
      if (!body.exportGestart) await startLasExport(scan.id);
      return NextResponse.json({ ...antwoord, fase: "exporteren", exportGestart: true });
    }

    const { done, jobId } = await saveUrl(token, pad, wolk.url);
    return NextResponse.json({ ...antwoord, fase: done ? "klaar" : "opslaan", saveJobId: jobId });
  } catch (err) {
    if (err instanceof PolycamNietIngesteld) {
      return NextResponse.json({ error: "niet_ingesteld" }, { status: 503 });
    }
    console.error("[polycam/koppel]", err);
    const geenToegang = err instanceof PolycamApiError && (err.status === 401 || err.status === 403);
    return NextResponse.json(
      { error: geenToegang ? "geen_toegang" : "koppelen_mislukt" },
      { status: 502 }
    );
  }
}
