import { NextResponse } from "next/server";
import { haalBijlagen, handtekeningKlopt, leesHandtekening, vanRvo } from "@/lib/inkomende-mail";

export const maxDuration = 60;

/**
 * De mail van RVO met het afschrift van een geregistreerd energielabel.
 *
 * Wij zijn de certificaathouder, dus die mail komt bij ons binnen — op info@,
 * en van daar doorgestuurd naar het ontvangstadres van Resend. Tot nu toe hield
 * de keten daar op: iemand moest de mail opzoeken, de PDF opslaan en in de
 * juiste Dropbox-map slepen. Gebeurde dat niet, dan stond het label wel in het
 * landelijke register maar zat het bewijs niet bij de stukken van de klant.
 *
 * Deze route staat buiten de inlog (Resend heeft geen sessie) en beveiligt
 * zichzelf met de handtekening die Resend over de ruwe body zet.
 *
 * Wat hier níet gebeurt: beslissen bij welk adres de bijlage hoort. Dat weet
 * alleen het control center — dat heeft de opdrachten en de projectmappen. Deze
 * route meldt alleen wát er binnenkwam, met de verwijzing naar het bestand.
 */
export async function POST(request: Request) {
  const geheim = process.env.RESEND_WEBHOOK_SECRET;
  if (!geheim) {
    // Bewust dicht: zonder geheim kan iedereen die het adres kent ons een mail
    // laten verwerken en zo een bestand in een projectmap krijgen.
    return NextResponse.json({ error: "webhook_secret_niet_ingesteld" }, { status: 503 });
  }

  const ruweBody = await request.text();
  if (!handtekeningKlopt(geheim, ruweBody, leesHandtekening(request.headers))) {
    return NextResponse.json({ error: "ongeldige_handtekening" }, { status: 401 });
  }

  const gebeurtenis = JSON.parse(ruweBody) as {
    type?: string;
    data?: {
      email_id?: string;
      created_at?: string;
      from?: string;
      subject?: string;
      attachments?: { id?: string; filename?: string }[];
    };
  };

  // Alleen binnengekomen mail; de andere gebeurtenissen (afgeleverd, geopend)
  // gaan over wat wij zelf versturen en horen hier niet.
  if (gebeurtenis.type !== "email.received") {
    return NextResponse.json({ ok: true, overgeslagen: "geen ontvangen mail" });
  }

  const data = gebeurtenis.data ?? {};
  const emailId = data.email_id ?? "";
  if (!emailId) return NextResponse.json({ ok: true, overgeslagen: "geen email_id" });

  if (!vanRvo(data.from)) {
    return NextResponse.json({ ok: true, overgeslagen: `afzender ${data.from ?? "onbekend"}` });
  }

  /*
    De bijlagen opvragen bij Resend in plaats van ze uit de webhook lezen.

    De webhook draagt alleen metagegevens, en bij een mail zonder bijlagen
    scheelt dit het control center een nutteloze melding. Lukt het opvragen
    niet, dan vallen we terug op wat de webhook zelf noemt: die namen zijn
    genoeg om het bestand later alsnog op te halen.
  */
  let bijlagen: { id: string; filename: string; content_type?: string | null }[];
  try {
    bijlagen = await haalBijlagen(emailId);
  } catch {
    bijlagen = (data.attachments ?? [])
      .filter((b): b is { id: string; filename: string } => Boolean(b.id && b.filename))
      .map((b) => ({ id: b.id, filename: b.filename }));
  }

  const pdfs = bijlagen.filter((b) => /\.pdf$/i.test(b.filename));
  if (pdfs.length === 0) {
    return NextResponse.json({ ok: true, overgeslagen: "geen PDF in de mail" });
  }

  const basis = (process.env.CONTROL_CENTER_URL ?? "").replace(/\/+$/, "");
  const token = process.env.CONTROL_CENTER_TOKEN;
  if (!basis || !token) {
    // 503 en niet 200: dit hóórt door te komen, dus laat Resend het opnieuw
    // sturen zodra de koppeling er weer is.
    return NextResponse.json({ error: "control_center_niet_gekoppeld" }, { status: 503 });
  }

  const res = await fetch(`${basis}/api/mails/afschrift`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      email_id: emailId,
      afzender: data.from ?? null,
      onderwerp: data.subject ?? null,
      ontvangen_op: data.created_at ?? new Date().toISOString(),
      bijlagen: pdfs.map((b) => ({ id: b.id, filename: b.filename, content_type: b.content_type ?? null })),
    }),
    signal: AbortSignal.timeout(45_000),
  });

  if (!res.ok) {
    const tekst = (await res.text().catch(() => "")).slice(0, 200);
    // Ook hier geen 200: een mail die niet is aangemeld mag niet stil weg zijn.
    return NextResponse.json(
      { error: `control center gaf ${res.status}`, detail: tekst },
      { status: 502 }
    );
  }

  return NextResponse.json({ ok: true, aangemeld: pdfs.length });
}
