import { postbusStand } from "@/lib/postbus";

export const dynamic = "force-dynamic";

/**
 * Het koppelscherm van de postbus.
 *
 * Waarom een pagina en niet meteen de knop op Systemen in het control center:
 * die knop wijst hierheen, en deze pagina zit achter de inlog van deze app. Wie
 * hier niet ingelogd is, komt op het inlogscherm — een API-route zou in dat
 * geval een kale 401 in JSON teruggeven, en dat is geen scherm waar iemand iets
 * aan heeft. Openzetten kan niet: dan kan iedereen die het adres kent zijn
 * eigen postbus aan ons hangen, en zou een PDF uit een vreemde mailbox in de
 * projectmap van een klant kunnen belanden.
 */
export default async function PostbusPagina() {
  const stand = await postbusStand();
  const terug = (process.env.CONTROL_CENTER_URL ?? "").replace(/\/+$/, "");

  return (
    <main style={{ maxWidth: 640, margin: "60px auto", padding: "0 20px" }}>
      <h1>Postbus koppelen</h1>

      <p>
        Wij zijn certificaathouder, dus RVO mailt het afschrift van elk energielabel dat wij
        registreren naar ons toe. Met deze koppeling loopt het control center die mails langs en zet
        het de PDF in de projectmap van het adres.
      </p>

      <p>
        Log in met het account waar die mail binnenkomt. Er wordt alleen gezocht op de afzender{" "}
        <b>noreply_eponline@rvo.nl</b>, en de koppeling mag alleen lezen — versturen, verwijderen en
        labels wijzigen zitten er niet in. Intrekken kan altijd op{" "}
        <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>.
      </p>

      <p>
        {stand.gekoppeld ? (
          <>
            Nu gekoppeld als <b>{stand.adres ?? "een Google-account"}</b>.
          </>
        ) : (
          <>Nog niet gekoppeld.</>
        )}
      </p>

      <p>
        <a href="/api/postbus/koppel">
          {stand.gekoppeld ? "Opnieuw inloggen met Google" : "Inloggen met Google"}
        </a>
      </p>

      {terug ? (
        <p>
          <a href={`${terug}/systemen`}>← Terug naar Systemen</a>
        </p>
      ) : null}
    </main>
  );
}
