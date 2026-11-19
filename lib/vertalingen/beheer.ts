/** Instellingen, gebruikers en het inlogscherm. Sleutels beginnen met "beheer.". */
export const nl = {
  // ---------- instellingen: algemeen ----------
  "beheer.instellingen.titel": "Instellingen",
  "beheer.instellingen.lede":
    "Storingen en koppelingen op één plek. Alles staat centraal ingesteld — inloggen doe je één keer, daarna werkt het voor het hele team.",
  "beheer.instellingen.tellerOk": "in orde",
  "beheer.instellingen.tellerProbleem": "met een probleem",
  "beheer.instellingen.tellerNietIngesteld": "niet ingesteld",
  "beheer.instellingen.koppelingen": "Koppelingen",
  "beheer.instellingen.koppelingenUitleg": "Live status van de diensten waar de app op leunt.",
  "beheer.instellingen.verversen": "Verversen",
  "beheer.instellingen.verversenBezig": "Verversen…",
  "beheer.instellingen.statusControleren": "Status controleren…",
  "beheer.instellingen.bezig": "Bezig…",
  "beheer.instellingen.bezigControleren": "Bezig met controleren…",
  "beheer.instellingen.opslaan": "Opslaan",
  "beheer.instellingen.annuleren": "Annuleren",
  "beheer.instellingen.opslaanMislukt": "Opslaan is mislukt. Probeer het opnieuw.",
  "beheer.instellingen.onbekend": "onbekend",
  "beheer.instellingen.verbondenAls": "Verbonden als {naam}",
  "beheer.instellingen.nogNietGekoppeld": "Nog niet gekoppeld.",
  // statuslabel
  "beheer.instellingen.pill.uitgezet": "Uitgezet",
  "beheer.instellingen.pill.nietIngesteld": "Niet ingesteld",
  "beheer.instellingen.pill.verbonden": "Verbonden",
  "beheer.instellingen.pill.probleem": "Probleem",
  // ClickUp
  "beheer.instellingen.clickup.geenToken": "Geen token ingesteld.",
  "beheer.instellingen.clickup.uitUitleg":
    "ClickUp staat uit: er wordt niet meer gemeten en er komen geen storingsmeldingen meer over. Energielabels aanmaken werkt zolang dit uitstaat niet.",
  "beheer.instellingen.clickup.aanUitleg":
    "Geen inlogknop hier — dit werkt via een persoonlijk API-token op de server (CLICKUP_TOKEN). Aanmaken via ClickUp → avatar → Settings → Apps → API Token.",
  "beheer.instellingen.clickup.staatUit": "ClickUp staat uit",
  "beheer.instellingen.clickup.staatAan": "ClickUp staat aan",
  "beheer.instellingen.clickup.omzettenMislukt": "omzetten mislukt",
  // BAG
  "beheer.instellingen.bag.rol": "Openbare adresdata (PDOK) — geen account nodig.",
  // Street View
  "beheer.instellingen.streetview.rolOk":
    "Straatbeeld + luchtfoto per adres — geen account nodig, alleen een API-key.",
  "beheer.instellingen.streetview.rol": "Straatbeeld + luchtfoto per adres.",
  "beheer.instellingen.streetview.uitleg":
    "Zet bij elke nieuwe projectmap automatisch vier beelden in de map “Foto's”: het straatbeeld van de voorkant, de linkerhoek en de rechterhoek, plus een luchtfoto van bovenaf. Zo zie je vóór de opname al het woningtype, de zijgevels en aanbouwen, en de dakvorm met eventuele dakkapellen en zonnepanelen. Alleen als die map nog leeg is — eigen foto's worden nooit overschreven. Instellen via",
  "beheer.instellingen.streetview.uitlegNa": "op de server.",
  // Dropbox
  "beheer.instellingen.dropbox.uitleg":
    "Maakt automatisch een projectmap per adres aan en zet de deel-link in de ClickUp-taak. Eén teamlid logt hieronder eenmalig in — daarna werkt Dropbox voor iedereen, net als bij ClickUp.",
  "beheer.instellingen.dropbox.opnieuwInloggen": "Opnieuw inloggen met Dropbox",
  "beheer.instellingen.dropbox.inloggen": "Inloggen met Dropbox",
  // Google Agenda
  "beheer.instellingen.google.verbondenAls": "Jouw account verbonden als {naam}",
  "beheer.instellingen.google.nietGekoppeld": "Nog niet gekoppeld voor jouw account.",
  "beheer.instellingen.google.uitlegVoor":
    "Haalt de afspraken van vandaag op bij het zoeken van een adres, zodat je het adres en de makelaarsinformatie uit de agenda-afspraak niet opnieuw hoeft over te typen.",
  "beheer.instellingen.google.uitlegNadruk": "In tegenstelling tot Dropbox is dit per teamlid",
  "beheer.instellingen.google.uitlegNa":
    "— elke gebruiker logt hier zelf in met zijn eigen Google-account (gekoppeld aan het actieve account in de zijbalk). Wissel eerst van account via Gebruikers voordat je hier inlogt, anders koppel je Google aan de verkeerde naam.",
  "beheer.instellingen.google.opnieuwInloggen": "Opnieuw inloggen met Google",
  "beheer.instellingen.google.inloggen": "Inloggen met Google",
  // SharePoint
  "beheer.instellingen.sharepoint.fout.url":
    "Dit lijkt geen SharePoint-link. Plak de volledige URL uit de adresbalk.",
  "beheer.instellingen.sharepoint.fout.onbereikbaar":
    "Deze map is niet te openen met het gekoppelde account. Controleer de link.",
  "beheer.instellingen.sharepoint.fout.geenOpslag":
    "Er is geen Redis-opslag gekoppeld, dus de wijziging kan niet bewaard worden.",
  "beheer.instellingen.sharepoint.fout.terugzetten": "Terugzetten is mislukt.",
  "beheer.instellingen.sharepoint.leestoegang": "Leestoegang tot {site}",
  "beheer.instellingen.sharepoint.deSite": "de site",
  "beheer.instellingen.sharepoint.geenToegang":
    "App-gegevens staan er, maar Microsoft geeft nog geen toegang.",
  "beheer.instellingen.sharepoint.nietIngesteld": "Nog niet ingesteld op de server.",
  "beheer.instellingen.sharepoint.uitleg":
    "Zet de hele opgeleverde map uit SharePoint — met dezelfde naam en indeling — als eigen map in de Dropbox-projectmap van dat adres, zodra de taak in ClickUp op klaar gaat. Eén teamlid logt hier eenmalig in; daarna werkt het voor iedereen.",
  "beheer.instellingen.sharepoint.map": "Map",
  "beheer.instellingen.sharepoint.heleBibliotheek": "(hele bibliotheek)",
  "beheer.instellingen.sharepoint.standaard": "standaard",
  "beheer.instellingen.sharepoint.site": "Site",
  "beheer.instellingen.sharepoint.gecontroleerd":
    "Opgeslagen en gecontroleerd — de app kan deze map openen.",
  "beheer.instellingen.sharepoint.opgeslagen":
    "Opgeslagen. Klik nu op \"Inloggen met Microsoft\" — de app weet nu bij welke organisatie hij moet aanmelden.",
  "beheer.instellingen.sharepoint.linkLabel": "Link naar de map in SharePoint",
  "beheer.instellingen.sharepoint.linkHint":
    "Open de map in SharePoint en plak de URL uit de adresbalk. Site en map worden er zelf uit gehaald.",
  "beheer.instellingen.sharepoint.mapLabel": "Map (wordt uit de link gehaald)",
  "beheer.instellingen.sharepoint.terugStandaard": "Terug naar standaardmap",
  "beheer.instellingen.sharepoint.mapAanpassen": "Map aanpassen",
  // Mediatask
  "beheer.instellingen.mediatask.fout.gegevens":
    "Mediatask wijst dit token/deze URL af. Controleer beide velden.",
  "beheer.instellingen.mediatask.fout.onbereikbaar":
    "Kon de basis-URL niet bereiken. Controleer of hij klopt (bv. https://wegogroen.apitome.io).",
  "beheer.instellingen.mediatask.verbonden": "Verbonden — {naam}",
  "beheer.instellingen.mediatask.uitlegVoor":
    "Voor het automatisch versturen van NEN2580-foto's en plattegronden naar Mediatask (zie",
  "beheer.instellingen.mediatask.uitlegLink": "Upload NEN",
  "beheer.instellingen.mediatask.uitlegNa":
    "). Vul hieronder handmatig het API-token en de basis-URL van jullie Mediatask-omgeving in — geen herdeploy nodig.",
  "beheer.instellingen.mediatask.basisUrl": "Basis-URL",
  "beheer.instellingen.mediatask.apiToken": "API-token",
  "beheer.instellingen.mediatask.aanpassen": "Gegevens aanpassen",
  "beheer.instellingen.mediatask.koppelen": "Handmatig koppelen",
  // Storingen
  "beheer.instellingen.storingen.titel": "Storingen",
  "beheer.instellingen.storingen.allesInOrde": "alles in orde",
  "beheer.instellingen.storingen.uitleg":
    "Wat de automatische controle als laatste zag. Alleen wat aandacht vraagt staat hier.",
  "beheer.instellingen.storingen.controleren": "Controleren…",
  "beheer.instellingen.storingen.nuControleren": "Nu controleren",
  "beheer.instellingen.storingen.mislukt": "De controle kon niet worden uitgevoerd.",
  "beheer.instellingen.storingen.nogGeen": "Nog geen controle gedraaid.",
  "beheer.instellingen.storingen.geenStoringen": "Alles in orde — geen storingen gevonden.",
  "beheer.instellingen.storingen.gecontroleerdOp": "Gecontroleerd op {tijd}",

  // ---------- gebruikers ----------
  "beheer.gebruikers.titel": "Gebruikers",
  "beheer.gebruikers.ledeVoor":
    "Elk teamlid gebruikt een eigen ClickUp-token, zodat taken op de juiste naam worden aangemaakt. BAG en Dropbox zijn gedeeld en hoeven maar één keer ingesteld te worden — zie",
  "beheer.gebruikers.ledeLink": "Koppelingen",
  "beheer.gebruikers.bestaande": "Bestaande gebruikers",
  "beheer.gebruikers.laden": "Laden…",
  "beheer.gebruikers.bezig": "Bezig…",
  "beheer.gebruikers.opslaan": "Opslaan",
  "beheer.gebruikers.annuleren": "Annuleren",
  "beheer.gebruikers.opslaanMislukt": "Opslaan is mislukt.",
  "beheer.gebruikers.opslaanMisluktOpnieuw": "Opslaan is mislukt. Probeer het opnieuw.",
  "beheer.gebruikers.fotoTeGroot": "Kies een kleinere foto (max 1,5 MB).",
  "beheer.gebruikers.fotoMislukt": "Foto uploaden is mislukt. Probeer het opnieuw.",
  "beheer.gebruikers.ongeldigAdres": "Dat lijkt geen geldig mailadres.",
  "beheer.gebruikers.tokenGeweigerd":
    "Dit token wordt geweigerd door ClickUp. Controleer of je 'm goed hebt gekopieerd.",
  "beheer.gebruikers.fotoWijzigen": "Profielfoto wijzigen",
  "beheer.gebruikers.fotoToevoegen": "Profielfoto toevoegen",
  "beheer.gebruikers.actief": "Actief op dit apparaat",
  "beheer.gebruikers.beschikbaar": "Beschikbaar",
  "beheer.gebruikers.tokenAanpassen": "Token aanpassen",
  "beheer.gebruikers.mailLabel": "Mailadres voor meldingen",
  "beheer.gebruikers.mailPlaceholder": "naam@wegogroen.nl",
  "beheer.gebruikers.geenMail": "Zonder adres krijgt {naam} geen bericht als een opname blijft liggen.",
  "beheer.gebruikers.nieuwToken": "Nieuw ClickUp API-token voor {naam}",
  "beheer.gebruikers.tokenOpslaan": "Token opslaan",
  "beheer.gebruikers.bezigControleren": "Bezig met controleren…",
  // mijn code
  "beheer.gebruikers.code.titel": "Mijn inlogcode",
  "beheer.gebruikers.code.logtInAlsVoor": "Je logt in als",
  "beheer.gebruikers.code.logtInAlsNa": "met vier cijfers.",
  "beheer.gebruikers.code.startcode":
    "Je gebruikt nog de startcode 0000. Die staat in je uitnodigingsmail en kent iedereen — kies nu je eigen code.",
  "beheer.gebruikers.code.huidig": "Huidige code",
  "beheer.gebruikers.code.nieuw": "Nieuwe code",
  "beheer.gebruikers.code.nogmaals": "Nogmaals",
  "beheer.gebruikers.code.wijzigen": "Code wijzigen",
  "beheer.gebruikers.code.nietGelijk": "De twee nieuwe codes zijn niet gelijk.",
  "beheer.gebruikers.code.gewijzigd": "Je code is gewijzigd.",
  "beheer.gebruikers.code.mislukt": "Wijzigen mislukt.",

  // ---------- inloggen ----------
  "beheer.login.ondertitel": "Upload portaal",
  "beheer.login.wieBenJe": "Wie ben je?",
  "beheer.login.evenKijken": "Even kijken…",
  "beheer.login.geenAccounts":
    "Er zijn nog geen accounts. Voeg ze toe vanuit het Business Control Center, bij Werknemers.",
  "beheer.login.wisselen": "wisselen",
  "beheer.login.vulCodeIn": "Vul je code van vier cijfers in",
  "beheer.login.cijfersIngevoerd": "{n} van {totaal} cijfers ingevoerd",
  "beheer.login.bezig": "Bezig met inloggen…",
  "beheer.login.startcode": "Nog niet gewijzigd? De startcode is 0000.",
  "beheer.login.wissen": "Wissen",
  "beheer.login.mislukt": "Inloggen mislukt.",
  "beheer.login.misluktVerbinding": "Inloggen mislukt — controleer je verbinding.",
} as const;

export const en: Partial<Record<keyof typeof nl, string>> = {
  // instellingen: algemeen
  "beheer.instellingen.titel": "Settings",
  "beheer.instellingen.lede":
    "Issues and connections in one place. Everything is set up centrally — sign in once and it works for the whole team.",
  "beheer.instellingen.tellerOk": "OK",
  "beheer.instellingen.tellerProbleem": "with a problem",
  "beheer.instellingen.tellerNietIngesteld": "not set up",
  "beheer.instellingen.koppelingen": "Connections",
  "beheer.instellingen.koppelingenUitleg": "Live status of the services the app relies on.",
  "beheer.instellingen.verversen": "Refresh",
  "beheer.instellingen.verversenBezig": "Refreshing…",
  "beheer.instellingen.statusControleren": "Checking status…",
  "beheer.instellingen.bezig": "Working…",
  "beheer.instellingen.bezigControleren": "Checking…",
  "beheer.instellingen.opslaan": "Save",
  "beheer.instellingen.annuleren": "Cancel",
  "beheer.instellingen.opslaanMislukt": "Saving failed. Please try again.",
  "beheer.instellingen.onbekend": "unknown",
  "beheer.instellingen.verbondenAls": "Connected as {naam}",
  "beheer.instellingen.nogNietGekoppeld": "Not connected yet.",
  "beheer.instellingen.pill.uitgezet": "Turned off",
  "beheer.instellingen.pill.nietIngesteld": "Not set up",
  "beheer.instellingen.pill.verbonden": "Connected",
  "beheer.instellingen.pill.probleem": "Problem",
  // ClickUp
  "beheer.instellingen.clickup.geenToken": "No token set.",
  "beheer.instellingen.clickup.uitUitleg":
    "ClickUp is turned off: it is no longer checked and no more issue alerts are raised for it. Creating energy labels does not work while this is off.",
  "beheer.instellingen.clickup.aanUitleg":
    "No sign-in button here — this works with a personal API token on the server (CLICKUP_TOKEN). Create one in ClickUp → avatar → Settings → Apps → API Token.",
  "beheer.instellingen.clickup.staatUit": "ClickUp is off",
  "beheer.instellingen.clickup.staatAan": "ClickUp is on",
  "beheer.instellingen.clickup.omzettenMislukt": "switching failed",
  // BAG
  "beheer.instellingen.bag.rol": "Public address data (PDOK) — no account needed.",
  // Street View
  "beheer.instellingen.streetview.rolOk":
    "Street view + aerial photo per address — no account needed, just an API key.",
  "beheer.instellingen.streetview.rol": "Street view + aerial photo per address.",
  "beheer.instellingen.streetview.uitleg":
    "For every new project folder, automatically puts four images in the “Foto's” folder: the street view of the front, the left corner and the right corner, plus an aerial photo from above. That way you see the property type, side walls and extensions, and the roof shape with any dormers and solar panels before the survey. Only when that folder is still empty — your own photos are never overwritten. Set up via",
  "beheer.instellingen.streetview.uitlegNa": "on the server.",
  // Dropbox
  "beheer.instellingen.dropbox.uitleg":
    "Automatically creates a project folder per address and puts the share link in the ClickUp task. One team member signs in once below — after that Dropbox works for everyone, just like ClickUp.",
  "beheer.instellingen.dropbox.opnieuwInloggen": "Sign in with Dropbox again",
  "beheer.instellingen.dropbox.inloggen": "Sign in with Dropbox",
  // Google Agenda
  "beheer.instellingen.google.verbondenAls": "Your account connected as {naam}",
  "beheer.instellingen.google.nietGekoppeld": "Not connected yet for your account.",
  "beheer.instellingen.google.uitlegVoor":
    "Fetches today's appointments when you search for an address, so you don't have to retype the address and estate agent details from the calendar appointment.",
  "beheer.instellingen.google.uitlegNadruk": "Unlike Dropbox, this is per team member",
  "beheer.instellingen.google.uitlegNa":
    "— each user signs in here with their own Google account (linked to the active account in the sidebar). Switch accounts via Users before signing in here, or you will link Google to the wrong name.",
  "beheer.instellingen.google.opnieuwInloggen": "Sign in with Google again",
  "beheer.instellingen.google.inloggen": "Sign in with Google",
  // SharePoint
  "beheer.instellingen.sharepoint.fout.url":
    "This doesn't look like a SharePoint link. Paste the full URL from the address bar.",
  "beheer.instellingen.sharepoint.fout.onbereikbaar":
    "This folder can't be opened with the connected account. Check the link.",
  "beheer.instellingen.sharepoint.fout.geenOpslag":
    "No Redis storage is connected, so the change can't be saved.",
  "beheer.instellingen.sharepoint.fout.terugzetten": "Resetting failed.",
  "beheer.instellingen.sharepoint.leestoegang": "Read access to {site}",
  "beheer.instellingen.sharepoint.deSite": "the site",
  "beheer.instellingen.sharepoint.geenToegang":
    "App credentials are in place, but Microsoft isn't granting access yet.",
  "beheer.instellingen.sharepoint.nietIngesteld": "Not set up on the server yet.",
  "beheer.instellingen.sharepoint.uitleg":
    "Copies the entire delivered folder from SharePoint — with the same name and structure — as its own folder into that address's Dropbox project folder, as soon as the task in ClickUp is marked done. One team member signs in here once; after that it works for everyone.",
  "beheer.instellingen.sharepoint.map": "Folder",
  "beheer.instellingen.sharepoint.heleBibliotheek": "(entire library)",
  "beheer.instellingen.sharepoint.standaard": "default",
  "beheer.instellingen.sharepoint.site": "Site",
  "beheer.instellingen.sharepoint.gecontroleerd": "Saved and verified — the app can open this folder.",
  "beheer.instellingen.sharepoint.opgeslagen":
    "Saved. Now click \"Sign in with Microsoft\" — the app now knows which organisation to sign in to.",
  "beheer.instellingen.sharepoint.linkLabel": "Link to the folder in SharePoint",
  "beheer.instellingen.sharepoint.linkHint":
    "Open the folder in SharePoint and paste the URL from the address bar. The site and folder are taken from it automatically.",
  "beheer.instellingen.sharepoint.mapLabel": "Folder (taken from the link)",
  "beheer.instellingen.sharepoint.terugStandaard": "Back to default folder",
  "beheer.instellingen.sharepoint.mapAanpassen": "Change folder",
  // Mediatask
  "beheer.instellingen.mediatask.fout.gegevens":
    "Mediatask rejects this token/URL. Check both fields.",
  "beheer.instellingen.mediatask.fout.onbereikbaar":
    "Couldn't reach the base URL. Check that it's correct (e.g. https://wegogroen.apitome.io).",
  "beheer.instellingen.mediatask.verbonden": "Connected — {naam}",
  "beheer.instellingen.mediatask.uitlegVoor":
    "For automatically sending NEN2580 photos and floor plans to Mediatask (see",
  "beheer.instellingen.mediatask.uitlegLink": "Upload NEN",
  "beheer.instellingen.mediatask.uitlegNa":
    "). Enter the API token and base URL of your Mediatask environment manually below — no redeploy needed.",
  "beheer.instellingen.mediatask.basisUrl": "Base URL",
  "beheer.instellingen.mediatask.apiToken": "API token",
  "beheer.instellingen.mediatask.aanpassen": "Edit details",
  "beheer.instellingen.mediatask.koppelen": "Connect manually",
  // Storingen
  "beheer.instellingen.storingen.titel": "Issues",
  "beheer.instellingen.storingen.allesInOrde": "all OK",
  "beheer.instellingen.storingen.uitleg":
    "What the automatic check saw last. Only things that need attention are listed here.",
  "beheer.instellingen.storingen.controleren": "Checking…",
  "beheer.instellingen.storingen.nuControleren": "Check now",
  "beheer.instellingen.storingen.mislukt": "The check could not be run.",
  "beheer.instellingen.storingen.nogGeen": "No check has run yet.",
  "beheer.instellingen.storingen.geenStoringen": "All OK — no issues found.",
  "beheer.instellingen.storingen.gecontroleerdOp": "Checked on {tijd}",

  // gebruikers
  "beheer.gebruikers.titel": "Users",
  "beheer.gebruikers.ledeVoor":
    "Each team member uses their own ClickUp token, so tasks are created under the right name. BAG and Dropbox are shared and only need to be set up once — see",
  "beheer.gebruikers.ledeLink": "Connections",
  "beheer.gebruikers.bestaande": "Existing users",
  "beheer.gebruikers.laden": "Loading…",
  "beheer.gebruikers.bezig": "Working…",
  "beheer.gebruikers.opslaan": "Save",
  "beheer.gebruikers.annuleren": "Cancel",
  "beheer.gebruikers.opslaanMislukt": "Saving failed.",
  "beheer.gebruikers.opslaanMisluktOpnieuw": "Saving failed. Please try again.",
  "beheer.gebruikers.fotoTeGroot": "Choose a smaller photo (max 1.5 MB).",
  "beheer.gebruikers.fotoMislukt": "Uploading the photo failed. Please try again.",
  "beheer.gebruikers.ongeldigAdres": "That doesn't look like a valid email address.",
  "beheer.gebruikers.tokenGeweigerd":
    "ClickUp rejects this token. Check that you copied it correctly.",
  "beheer.gebruikers.fotoWijzigen": "Change profile photo",
  "beheer.gebruikers.fotoToevoegen": "Add profile photo",
  "beheer.gebruikers.actief": "Active on this device",
  "beheer.gebruikers.beschikbaar": "Available",
  "beheer.gebruikers.tokenAanpassen": "Change token",
  "beheer.gebruikers.mailLabel": "Email address for notifications",
  "beheer.gebruikers.mailPlaceholder": "name@wegogroen.nl",
  "beheer.gebruikers.geenMail": "Without an address, {naam} won't be notified when a survey is left pending.",
  "beheer.gebruikers.nieuwToken": "New ClickUp API token for {naam}",
  "beheer.gebruikers.tokenOpslaan": "Save token",
  "beheer.gebruikers.bezigControleren": "Checking…",
  "beheer.gebruikers.code.titel": "My sign-in code",
  "beheer.gebruikers.code.logtInAlsVoor": "You sign in as",
  "beheer.gebruikers.code.logtInAlsNa": "with four digits.",
  "beheer.gebruikers.code.startcode":
    "You're still using the starting code 0000. It's in your invitation email and everyone knows it — choose your own code now.",
  "beheer.gebruikers.code.huidig": "Current code",
  "beheer.gebruikers.code.nieuw": "New code",
  "beheer.gebruikers.code.nogmaals": "Repeat",
  "beheer.gebruikers.code.wijzigen": "Change code",
  "beheer.gebruikers.code.nietGelijk": "The two new codes don't match.",
  "beheer.gebruikers.code.gewijzigd": "Your code has been changed.",
  "beheer.gebruikers.code.mislukt": "Changing failed.",

  // inloggen
  "beheer.login.ondertitel": "Upload portal",
  "beheer.login.wieBenJe": "Who are you?",
  "beheer.login.evenKijken": "One moment…",
  "beheer.login.geenAccounts":
    "There are no accounts yet. Add them from the Business Control Center, under Werknemers.",
  "beheer.login.wisselen": "switch",
  "beheer.login.vulCodeIn": "Enter your four-digit code",
  "beheer.login.cijfersIngevoerd": "{n} of {totaal} digits entered",
  "beheer.login.bezig": "Signing in…",
  "beheer.login.startcode": "Not changed yet? The starting code is 0000.",
  "beheer.login.wissen": "Delete",
  "beheer.login.mislukt": "Sign-in failed.",
  "beheer.login.misluktVerbinding": "Sign-in failed — check your connection.",
};
