/**
 * De opgemaakte mails van WeGoGroen, op één plek.
 *
 * Bewust hier en niet dubbel in het Business Control Center: dat dashboard
 * heeft zelf geen mailkoppeling (zie lib/mail.ts) en stuurt zijn uitnodigingen
 * via de brug hieronder. Zou het BCC zijn eigen kopie van deze opmaak bouwen,
 * dan lopen de twee na de eerste kleurwijziging vanzelf uit elkaar — precies
 * het soort duplicatie dat in dit project al eerder een bug heeft opgeleverd.
 *
 * Tabel-opbouw en inline stijlen, geen CSS-variabelen en geen extern
 * lettertype: dit is de HTML die letterlijk naar Resend gaat, niet een
 * voorbeeld ervan. De achtergrond van de kaart én van de mail eromheen staat
 * daarom expliciet op wit — een mailclient die zelf een donkere achtergrond
 * kiest, mag die niet door de kaart heen laten schemeren.
 */

const GROEN_DIEP = "#3f6212";
const GROEN_TEKST = "#2f4a12";
const GROEN_LABEL = "#5c7a3a";
const GROEN_VLAK = "#f3f8ec";
const GROEN_RAND = "#dfeccc";
const TEKST = "#16181a";
const TEKST_ZACHT = "#3a3d36";
const TEKST_FLETS = "#8b9184";
const LIJN = "#eef1e8";
const KAART_RAND = "#e6e9e0";

function knop(tekst: string, url: string): string {
  return `
    <table role="presentation" cellpadding="0" cellspacing="0">
      <tr>
        <td style="border-radius:999px;background:${GROEN_DIEP};">
          <a href="${url}"
             style="display:inline-block;padding:13px 26px;font-size:14.5px;font-weight:600;color:#f4faec;text-decoration:none;border-radius:999px;">
            ${tekst} &nbsp;&rarr;
          </a>
        </td>
      </tr>
    </table>`;
}

function codeVak(label: string, waarde: string): string {
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="background:${GROEN_VLAK};border:1px solid ${GROEN_RAND};border-radius:12px;padding:20px 24px;">
          <p style="margin:0 0 8px;font-size:11px;font-weight:600;letter-spacing:0.12em;text-transform:uppercase;color:${GROEN_LABEL};">
            ${label}
          </p>
          <p style="margin:0;font-family:'SF Mono',SFMono-Regular,Consolas,'Liberation Mono',Menlo,monospace;font-size:32px;font-weight:600;letter-spacing:0.28em;color:${GROEN_TEKST};">
            ${waarde}
          </p>
        </td>
      </tr>
    </table>`;
}

/**
 * De kaart om elke mail heen: woordmerk, kop, vrije inhoud, knop, voettekst.
 * Expliciet wit op wit — geen enkele kleur hangt af van wat de mailclient
 * verder doet.
 */
function omslag(input: {
  eyebrow: string;
  titel: string;
  inhoud: string;
  vak?: string;
  knop?: string;
  voettekst: string;
}): string {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:32px 16px;background:#ffffff;">
    <!--[if mso]>
    <table role="presentation" width="100%"><tr><td>
    <![endif]-->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid ${KAART_RAND};border-radius:8px;">
      <tr>
        <td style="padding:36px 40px 28px;">
          <div style="font-size:15px;font-weight:700;letter-spacing:0.02em;color:${GROEN_DIEP};">
            WeGoGroen
          </div>
        </td>
      </tr>
      <tr>
        <td style="padding:0 40px;">
          <div style="height:1px;background:${LIJN};line-height:1px;font-size:1px;">&nbsp;</div>
        </td>
      </tr>
      <tr>
        <td style="padding:32px 40px 4px;">
          <p style="margin:0 0 6px;font-size:12px;font-weight:600;letter-spacing:0.10em;text-transform:uppercase;color:#8a9a7a;">
            ${input.eyebrow}
          </p>
          <h1 style="margin:0;font-size:23px;line-height:1.3;font-weight:700;color:${TEKST};">
            ${input.titel}
          </h1>
        </td>
      </tr>
      <tr>
        <td style="padding:18px 40px 0;font-size:15px;line-height:1.6;color:${TEKST_ZACHT};">
          ${input.inhoud}
        </td>
      </tr>
      ${input.vak ? `<tr><td style="padding:28px 40px 0;">${input.vak}</td></tr>` : ""}
      ${input.knop ? `<tr><td style="padding:28px 40px 0;">${input.knop}</td></tr>` : ""}
      <tr>
        <td style="padding:32px 40px 0;">
          <div style="height:1px;background:${LIJN};line-height:1px;font-size:1px;">&nbsp;</div>
        </td>
      </tr>
      <tr>
        <td style="padding:20px 40px 36px;font-size:12.5px;line-height:1.7;color:${TEKST_FLETS};">
          ${input.voettekst}<br>WeGoGroen
        </td>
      </tr>
    </table>
    <!--[if mso]>
    </td></tr></table>
    <![endif]-->
  </body>
</html>`;
}

const BCC_URL = process.env.NEXT_PUBLIC_BCC_URL || "https://wegogroen-control.vercel.app";
const UPLOADER_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://energielabel-app.vercel.app";

/** De welkomstmail voor een nieuw account in het Business Control Center. */
export function bccUitnodiging(input: { naam: string; code: string; beheerder?: string | null }): {
  onderwerp: string;
  html: string;
} {
  const html = omslag({
    eyebrow: "Nieuwe collega",
    titel: `Welkom bij WeGoGroen,<br>${input.naam}.`,
    inhoud: `
      <p style="margin:0 0 14px;">
        ${input.beheerder ?? "Er is"} een account voor je klaargezet in het
        <strong>Business Control Center</strong> &mdash; het dashboard waarin we
        opdrachten, opnames en opleveringen bijhouden.
      </p>
      <p style="margin:0;">
        Log in met de code hieronder. Bij de eerste keer inloggen vraagt het
        systeem je meteen om er je eigen code van te maken.
      </p>`,
    vak: codeVak("Tijdelijke inlogcode", input.code),
    knop: knop("Inloggen bij het Business Control Center", `${BCC_URL}/login`),
    voettekst:
      "Geen account verwacht? Dan kun je deze mail negeren &mdash; er verandert niets zonder dat je zelf inlogt.",
  });
  return { onderwerp: "Welkom bij het Business Control Center", html };
}

/** De welkomstmail voor iemand die toegang krijgt tot de opname-app. */
export function uploaderUitnodiging(input: {
  naam: string;
  appWachtwoord: string;
  rechten: { energielabel: boolean; nen: boolean; media: boolean };
}): { onderwerp: string; html: string } {
  const soorten = [
    input.rechten.energielabel && "energielabels",
    input.rechten.nen && "NEN2580-opnames",
    input.rechten.media && "fotografie en video",
  ].filter(Boolean) as string[];
  const soortenTekst =
    soorten.length === 1
      ? soorten[0]
      : `${soorten.slice(0, -1).join(", ")} en ${soorten[soorten.length - 1]}`;

  const html = omslag({
    eyebrow: "Toegang tot de opname-app",
    titel: `Welkom, ${input.naam}.`,
    inhoud: `
      <p style="margin:0 0 14px;">
        Je kunt nu in de WeGoGroen-opnameapp terecht voor <strong>${soortenTekst}</strong>.
        Iedereen gebruikt dezelfde toegangscode voor de app zelf; wat je
        onder je eigen naam uploadt, komt automatisch op de juiste opdracht.
      </p>
      <p style="margin:0;">
        Voor energielabels heb je daarnaast eenmalig je eigen ClickUp-token
        nodig &mdash; die plak je zelf onder <strong>Gebruikers</strong> in de app,
        zodat taken op jouw naam komen te staan.
      </p>`,
    vak: codeVak("Toegangscode voor de app", input.appWachtwoord),
    knop: knop("Openen in de opnameapp", `${UPLOADER_URL}/gebruikers`),
    voettekst: "Vragen over je toegang? Neem contact op met wie je uitgenodigd heeft.",
  });
  return { onderwerp: "Welkom bij de WeGoGroen-opnameapp", html };
}
