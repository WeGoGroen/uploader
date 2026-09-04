/**
 * Verstuurt meldingen per mail via Resend. Bewust zonder extra pakket: het is
 * één HTTP-aanroep, dus een SDK zou alleen gewicht toevoegen.
 *
 * Ontbreekt de sleutel, dan doet dit niets en gaat de rest gewoon door — een
 * ontbrekende mailkoppeling mag nooit de gezondheidscontrole laten sneuvelen.
 */

export interface MailResultaat {
  verstuurd: boolean;
  reden?: string;
  /** Naar wie het ging — zodat de app kan tonen wie er gewaarschuwd is en er
      geen twijfel bestaat of iemand het gezien hoort te hebben. */
  ontvangers?: string[];
}

export async function stuurMail(
  onderwerp: string,
  html: string,
  /**
   * Aan wie. Leeg = de vaste storingsontvangers hieronder. Meegeven is voor
   * berichten die bij één persoon horen — een herinnering over een eigen
   * opname hoort niet bij het hele kantoor in de bus te vallen.
   */
  aanOverride?: string[],
  /**
   * Voor het archief in het Business Control Center: welk soort mail dit is.
   * Vrije tekst, want dit dashboard heeft geen mailkoppeling van zichzelf en
   * hoeft dus geen vaste lijst met soorten te kennen — het toont gewoon wat
   * hier binnenkomt.
   */
  soort = "onbekend"
): Promise<MailResultaat> {
  const key = process.env.RESEND_API_KEY;
  // Vaste ontvangers, bewust in de code en niet in een omgevingsvariabele: een
  // mailadres is geen geheim, en zo kan een storingsmelding nooit stilvallen
  // doordat iemand een instelling in Vercel vergat te zetten. ALERT_EMAIL kan
  // dit overschrijven (komma's tussen meerdere adressen) als de bezetting
  // verandert.
  const naar = (aanOverride?.length
    ? aanOverride
    : (process.env.ALERT_EMAIL ?? "floris@wegogroen.nl,yannick@wegogroen.nl").split(",")
  )
    .map((a) => a.trim())
    .filter(Boolean);
  // Zonder eigen geverifieerd domein levert Resend alleen af op het adres van
  // de accounthouder; dat is hier precies de bedoeling.
  const van = process.env.MAIL_FROM || "WeGoGroen <onboarding@resend.dev>";

  if (!key) {
    const resultaat = { verstuurd: false, reden: "RESEND_API_KEY ontbreekt" };
    await archiveer(soort, onderwerp, naar, resultaat);
    return resultaat;
  }
  if (naar.length === 0) {
    const resultaat = { verstuurd: false, reden: "geen ontvangers ingesteld" };
    await archiveer(soort, onderwerp, naar, resultaat);
    return resultaat;
  }

  async function verstuur(aan: string[]): Promise<Response> {
    return fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: van, to: aan, subject: onderwerp, html }),
    });
  }

  try {
    let res = await verstuur(naar);
    let aan = naar;

    // Zolang wegogroen.nl niet geverifieerd is bij Resend, weigert hij elke
    // ontvanger behalve de accounthouder — en dan komt de melding bij níemand
    // aan. Liever één iemand gewaarschuwd dan een storing die niemand ziet,
    // dus in dat geval nog één poging naar het adres dat Resend zelf noemt.
    if (res.status === 403 && naar.length > 1) {
      const body = await res.clone().text().catch(() => "");
      const eigen = body.match(/[\w.+-]+@[\w.-]+\.\w+/)?.[0];
      if (eigen) {
        aan = [eigen];
        res = await verstuur(aan);
      }
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const resultaat = { verstuurd: false, reden: `Resend gaf ${res.status}: ${body.slice(0, 200)}` };
      await archiveer(soort, onderwerp, aan, resultaat);
      return resultaat;
    }
    const resultaat = { verstuurd: true, ontvangers: aan };
    await archiveer(soort, onderwerp, aan, resultaat);
    return resultaat;
  } catch (err) {
    const resultaat = { verstuurd: false, reden: err instanceof Error ? err.message : "onbekende fout" };
    await archiveer(soort, onderwerp, naar, resultaat);
    return resultaat;
  }
}

/**
 * Meldt een verzendpoging aan het archief in het Business Control Center —
 * gelukt of niet, want een mislukte poging is minstens zo interessant als een
 * geslaagde.
 *
 * Dit dashboard heeft zelf geen database; het BCC wel, dus daar staat het
 * archief. Hetzelfde dienst-token waarmee de uploader er al binnenkomt voor
 * andere dingen, nu de andere kant op. Puur aanvulling: lukt het melden niet
 * (BCC onbereikbaar, geen koppeling ingesteld), dan is de mail zelf gewoon
 * verstuurd en verandert er verder niets.
 */
async function archiveer(
  soort: string,
  onderwerp: string,
  ontvangers: string[],
  resultaat: MailResultaat
): Promise<void> {
  const basis = (process.env.CONTROL_CENTER_URL ?? "").replace(/\/+$/, "");
  const token = process.env.CONTROL_CENTER_TOKEN;
  if (!basis || !token) return;
  try {
    await fetch(`${basis}/api/mails`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        soort,
        onderwerp,
        ontvangers,
        verstuurd: resultaat.verstuurd,
        reden: resultaat.reden ?? null,
      }),
    });
  } catch {
    // Aanvulling, geen voorwaarde — zie hierboven.
  }
}
