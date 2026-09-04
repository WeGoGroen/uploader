import type { Gezondheidsrapport } from "@/lib/health";
import { stuurMail } from "@/lib/mail";
import { getOptionalRedis } from "@/lib/redis";

/**
 * Wat te doen bij welke storing. Een melding "ClickUp faalt" helpt niemand om
 * half acht 's ochtends; deze zinnen zeggen wélke knop je moet indrukken.
 */
function watNuTeDoen(naam: string, detail: string): string {
  if (naam.startsWith("Google Agenda")) {
    const wie = naam.split("—")[1]?.trim() ?? "de betrokken gebruiker";
    return `De Google-koppeling van ${wie} werkt niet meer. Laat ${wie} in de app naar Koppelingen gaan en opnieuw op "Inloggen met Google" klikken. Tot die tijd ziet ${wie} geen afspraken en kan een opname niet vanuit de agenda gestart worden.`;
  }
  if (naam.startsWith("Dropbox")) {
    return 'De Dropbox-koppeling is verlopen of heeft geen schrijfrechten meer. Ga naar Koppelingen en klik op "Inloggen met Dropbox". Zolang dit staat kunnen er geen foto\'s en scans geüpload worden — dat blokkeert het hele veldwerk.';
  }
  if (naam === "ClickUp") {
    if (/lijst zonder velden/i.test(detail)) {
      return "De ingestelde ClickUp-lijst bevat geen velden. Waarschijnlijk wijst CLICKUP_LIST_ID naar de verkeerde lijst, of is de lijst hernoemd/verwijderd. Controleer de lijst-id in Vercel onder Settings → Environment Variables.";
    }
    return "Het ClickUp-token is verlopen of ingetrokken. Maak in ClickUp een nieuw API-token aan en zet dat in Vercel onder Settings → Environment Variables (CLICKUP_TOKEN). Zonder dit kunnen er geen energielabel-taken aangemaakt worden.";
  }
  if (naam === "Mediatask") {
    return "Mediatask is niet bereikbaar. Dat ligt meestal aan hun kant (hun server gaf eerder ook een 503-storing) en trekt vanzelf bij. Blijft het langer dan een uur staan, controleer dan het token en de basis-URL op de Koppelingen-pagina. NEN2580-orders kunnen tot die tijd niet verstuurd worden.";
  }
  if (naam.startsWith("BAG")) {
    return "De landelijke adressendienst (PDOK) geeft geen antwoord. Dit ligt buiten ons; kijk op status.pdok.nl. Zolang dit duurt kan een adres niet opgezocht worden en kan er geen nieuwe opname gestart worden.";
  }
  if (naam === "Opnames afgerond") {
    if (/ontbrekende bijlages/i.test(detail)) {
      return 'Bij deze opnames staat de ClickUp-taak er wel, maar zijn de documenten niet meegekomen. Ze zien er in het dashboard dus uit als afgerond terwijl er nog werk is. Open "Alle opnames" in de app, kijk onder "Bijlages ontbreken in ClickUp" en klik daar op "Bijlages opnieuw uploaden".';
    }
    return 'Deze opnames staan als geüpload geregistreerd, maar er hoort geen ClickUp-taak bij. Controleer in ClickUp of de taak bestaat; zo niet, open de opname opnieuw via "Alle opnames" en verstuur hem nog een keer.';
  }
  if (naam === "Openstaande concepten") {
    return 'Er staan opnames al meer dan een week halfaf. Kijk in de app onder "Alle opnames" bij "Niet afgemaakt": afmaken of verwijderen. Zolang ze blijven staan tellen ze mee in de lijst en blijft onduidelijk wat er nog echt moet gebeuren.';
  }
  if (naam === "Verweesde projectmappen") {
    return "Er staan lege projectmappen in Dropbox — meestal een map die is aangemaakt onder een adres dat daarna nog gecorrigeerd werd. Ze doen geen schade, maar maken de Dropbox onoverzichtelijk; verwijder ze als de bijbehorende opname onder de juiste naam bestaat.";
  }
  if (naam === "Google Street View") {
    if (/billing/i.test(detail)) {
      return "Google weigert de key omdat er geen actief billing-account aan het Cloud-project hangt. Koppel in console.cloud.google.com onder Billing een betaalmethode aan hetzelfde project als waar de key vandaan komt. Onder 10.000 aanvragen per maand kost dit niets. Tot die tijd krijgen nieuwe projectmappen geen straatbeelden en geen luchtfoto.";
    }
    return "Het automatische beeldmateriaal (straatbeeld en luchtfoto) wordt niet meer geplaatst. Controleer in console.cloud.google.com of de Street View Static API én de Maps Static API nog aan staan, of de key niet is ingetrokken, en of de dag-quota niet bereikt is. Nieuwe projectmappen worden gewoon aangemaakt, alleen zonder beeldmateriaal.";
  }
  if (naam === "Inlog actief") {
    return "LET OP: de app staat op dit moment open voor iedereen die het adres kent — inclusief de volledige Dropbox. Zet APP_PASSWORD terug in Vercel onder Settings → Environment Variables en deploy opnieuw. Dit heeft voorrang op al het andere.";
  }
  return "Onbekende controle — bekijk de app en de logboeken in Vercel.";
}

const BASIS = "https://energielabel-app.vercel.app";

/** Waar de ontvanger het in één klik oplost, als dat kan. */
function herstelKnop(naam: string): string | null {
  if (naam.startsWith("Google Agenda")) return `${BASIS}/api/auth/google/login`;
  if (naam.startsWith("Dropbox")) return `${BASIS}/api/auth/dropbox/login`;
  if (naam === "ClickUp" || naam === "Mediatask") return `${BASIS}/instellingen`;
  if (naam === "Opnames afgerond" || naam === "Openstaande concepten") return `${BASIS}/opnames`;
  return null;
}

function opmaak(rapport: Gezondheidsrapport, storingen: Gezondheidsrapport["controles"]): string {
  const rijen = storingen
    .map((c) => {
      const knop = herstelKnop(c.naam);
      // Vermelden wat de app zelf al probeerde: anders lijkt elke melding op
      // "doe jij het maar", terwijl een deel al vanzelf opgelost wordt.
      const geprobeerd =
        c.pogingen > 1
          ? `<div style="color:#8a938d;font-size:12px;margin-top:6px">De app heeft dit ${c.pogingen} keer opnieuw geprobeerd voordat hij het opgaf.</div>`
          : `<div style="color:#8a938d;font-size:12px;margin-top:6px">Opnieuw proberen heeft hier geen zin — dit vraagt om een handeling.</div>`;
      return `
      <li style="margin:0 0 18px">
        <div style="font-weight:700;color:#be2f3a">${c.naam}</div>
        <div style="color:#54605a;font-size:13px;margin:2px 0 6px">${c.detail}</div>
        <div style="background:#f4f6f4;border-left:3px solid #1a8748;padding:10px 12px;border-radius:6px">
          ${watNuTeDoen(c.naam, c.detail)}
          ${geprobeerd}
        </div>
        ${
          knop
            ? `<p style="margin:8px 0 0"><a href="${knop}" style="display:inline-block;background:#147a44;color:#fff;text-decoration:none;padding:8px 14px;border-radius:8px;font-size:13px;font-weight:600">Nu herstellen</a></p>`
            : ""
        }
      </li>`;
    })
    .join("");

  const hersteld = rapport.controles.filter((c) => c.ok && c.pogingen > 1);
  const goed = rapport.controles.filter((c) => c.niveau === "ok").map((c) => c.naam);
  // Aandachtspunten stonden alleen op het dashboard en haalden de mail nooit.
  // Ze mogen geen mail veroorzaken (dan komt er elke zondag één omdat er geen
  // afspraken zijn), maar als er tóch een mail uitgaat horen ze erbij: het is
  // precies het soort ding dat anders maanden blijft liggen.
  const aandacht = rapport.controles.filter((c) => c.niveau === "let op" && c.pogingen === 1);

  return `
  <div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;max-width:640px;color:#1a201c;line-height:1.5">
    <h2 style="margin:0 0 4px">Ochtendcontrole: ${storingen.length} ${storingen.length === 1 ? "storing" : "storingen"}</h2>
    <p style="margin:0 0 18px;color:#54605a;font-size:13px">
      Gecontroleerd op ${new Date(rapport.tijdstip).toLocaleString("nl-NL")}
    </p>
    <ul style="list-style:none;padding:0;margin:0">${rijen}</ul>
    ${
      hersteld.length > 0
        ? `<p style="color:#54605a;font-size:13px">Zelf opgelost: ${hersteld
            .map((c) => `${c.naam} (${c.pogingen} pogingen)`)
            .join(", ")}. Hier hoef je niets voor te doen.</p>`
        : ""
    }
    ${
      aandacht.length > 0
        ? `<h3 style="margin:24px 0 8px;font-size:15px">Ook het bekijken waard</h3>
           <ul style="list-style:none;padding:0;margin:0">${aandacht
             .map(
               (c) => `<li style="margin:0 0 12px">
                 <div style="font-weight:650;color:#9a5b06">${c.naam}</div>
                 <div style="color:#54605a;font-size:13px;margin:2px 0 6px">${c.detail}</div>
                 <div style="background:#f4f6f4;border-left:3px solid #9a5b06;padding:10px 12px;border-radius:6px;font-size:13px">
                   ${watNuTeDoen(c.naam, c.detail)}
                 </div>
               </li>`
             )
             .join("")}</ul>`
        : ""
    }
    ${goed.length > 0 ? `<p style="color:#54605a;font-size:13px">Wel in orde: ${goed.join(", ")}.</p>` : ""}
    <p style="font-size:13px">
      <a href="https://energielabel-app.vercel.app/" style="color:#147a44">Open het dashboard</a>
    </p>
  </div>`;
}

/**
 * Mailt alleen bij echte storingen, en hoogstens één keer per dag per
 * combinatie van storingen — anders levert een dienst die de hele ochtend
 * hapert een postvak vol identieke meldingen op.
 */
export async function mailBijStoring(
  rapport: Gezondheidsrapport,
  /** Bij een proefmelding de dagrem overslaan, anders kun je maar één keer per
      dag testen of de meldketen nog werkt. */
  negeerDagrem = false
): Promise<string> {
  const storingen = rapport.controles.filter((c) => c.niveau === "fout");
  if (storingen.length === 0) return "geen storingen, geen mail";

  const kenmerk = `${new Date().toISOString().slice(0, 10)}:${storingen.map((c) => c.naam).sort().join("|")}`;
  const redis = getOptionalRedis();
  if (redis && !negeerDagrem) {
    const al = await redis.get(`health:gemaild:${kenmerk}`).catch(() => null);
    if (al) return "vandaag al gemeld";
    await redis.set(`health:gemaild:${kenmerk}`, "1", "EX", 60 * 60 * 20).catch(() => {});
  }

  const res = await stuurMail(
    `⚠ WeGoGroen upload portaal: ${storingen.length} ${storingen.length === 1 ? "storing" : "storingen"}`,
    opmaak(rapport, storingen),
    undefined,
    "storing"
  );
  return res.verstuurd
    ? `mail verstuurd naar ${res.ontvangers?.join(", ")}`
    : `mail niet verstuurd (${res.reden})`;
}
