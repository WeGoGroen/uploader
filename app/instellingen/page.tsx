"use client";

import { Children, useCallback, useEffect, useState, type ReactNode } from "react";

interface ConnectionStatus {
  connected: boolean;
  ok: boolean;
  label: string | null;
  error: string | null;
}

interface StatusResponse {
  clickup: ConnectionStatus;
  bag: ConnectionStatus;
  dropbox: ConnectionStatus;
  mediatask: ConnectionStatus;
  google: ConnectionStatus;
  sharepoint: ConnectionStatus;
  streetview: ConnectionStatus;
}

/** Statusstreep in de zijkant van een kaart: rood bij een probleem, grijs als
    er nog niets is ingesteld, niets als het in orde is. */
function cardClass(status: ConnectionStatus): string {
  return `conn ${status.ok ? "" : status.connected ? "is-bad" : "is-off"}`.trim();
}

function Pill({ status }: { status: ConnectionStatus }) {
  const cls = !status.connected ? "is-off" : status.ok ? "is-ok" : "is-bad";
  const label = !status.connected ? "Niet ingesteld" : status.ok ? "Verbonden" : "Probleem";
  return (
    <span className={`pill ${cls}`}>
      <span className={`dot ${cls}`} />
      {label}
    </span>
  );
}

/**
 * Eén koppelingkaart, met de kop als schakelaar. Een koppeling die het doet
 * hoeft niet open te staan: die uitleg is er voor als er iets mis is, en met
 * zeven kaarten open werd de pagina zo lang dat je moest scrollen om de
 * kapotte ertussen te vinden. Verbonden = dicht, probleem of niet ingesteld =
 * open. Zelf open- of dichtklikken wint daarna van die automatiek.
 *
 * Het eerste kind is altijd de kop (conn-top); de rest is de inhoud die
 * inklapt.
 */
function ConnCard({ status, children }: { status: ConnectionStatus; children: ReactNode }) {
  const [handmatig, setHandmatig] = useState<boolean | null>(null);
  const kinderen = Children.toArray(children);
  const open = handmatig ?? !status.ok;

  return (
    <div className={`${cardClass(status)}${open ? " is-open" : " is-dicht"}`}>
      <button
        type="button"
        className="conn-toggle"
        aria-expanded={open}
        onClick={() => setHandmatig(!open)}
      >
        {kinderen[0]}
        <svg className={`chev${open ? " is-open" : ""}`} width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && <div className="conn-body">{kinderen.slice(1)}</div>}
    </div>
  );
}

function ClickUpCard({ status }: { status: ConnectionStatus }) {
  return (
    <ConnCard status={status}>
      <div className="conn-top">
        <div className="conn-heading">
          <span className="conn-icon is-clickup">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M6 14l6-5 6 5-6 5-6-5Z" fill="currentColor" />
            </svg>
          </span>
          <div>
            <div className="conn-name">ClickUp</div>
            <p className="conn-role" style={{ margin: "2px 0 0" }}>
              {status.connected ? `Verbonden als ${status.label ?? "onbekend"}` : "Geen token ingesteld."}
            </p>
          </div>
        </div>
        <Pill status={status} />
      </div>
      {status.error && <p className="conn-err">{status.error}</p>}
      <p className="conn-hint">
        Geen inlogknop hier — dit werkt via een persoonlijk API-token in{" "}
        <code>CLICKUP_TOKEN</code> op de server (.env.local). Aanmaken via ClickUp
        → avatar → Settings → Apps → API Token.
      </p>
    </ConnCard>
  );
}

function BagCard({ status }: { status: ConnectionStatus }) {
  return (
    <ConnCard status={status}>
      <div className="conn-top">
        <div className="conn-heading">
          <span className="conn-icon is-bag">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M12 21s7-5.7 7-11a7 7 0 1 0-14 0c0 5.3 7 11 7 11Z" stroke="currentColor" strokeWidth="1.8" />
              <circle cx="12" cy="10" r="2.4" stroke="currentColor" strokeWidth="1.8" />
            </svg>
          </span>
          <div>
            <div className="conn-name">BAG</div>
            <p className="conn-role" style={{ margin: "2px 0 0" }}>
              Openbare adresdata (PDOK) — geen account nodig.
            </p>
          </div>
        </div>
        <Pill status={status} />
      </div>
      {status.error && <p className="conn-err">{status.error}</p>}
    </ConnCard>
  );
}

function StreetViewCard({ status }: { status: ConnectionStatus }) {
  return (
    <ConnCard status={status}>
      <div className="conn-top">
        <div className="conn-heading">
          <span className="conn-icon is-bag">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M4 20V9l8-5 8 5v11" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
              <path d="M9.5 20v-5h5v5" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
            </svg>
          </span>
          <div>
            <div className="conn-name">Google Street View</div>
            <p className="conn-role" style={{ margin: "2px 0 0" }}>
              {status.ok ? "Straatbeeld + luchtfoto per adres — geen account nodig, alleen een API-key." : "Straatbeeld + luchtfoto per adres."}
            </p>
          </div>
        </div>
        <Pill status={status} />
      </div>
      {status.error && <p className="conn-err">{status.error}</p>}
      <p className="conn-hint">
        Zet bij elke nieuwe projectmap automatisch vier beelden in de map &ldquo;Foto&apos;s&rdquo;:
        het straatbeeld van de voorkant, de linkerhoek en de rechterhoek, plus een luchtfoto van
        bovenaf. Zo zie je vóór de opname al het woningtype, de zijgevels en aanbouwen, en de
        dakvorm met eventuele dakkapellen en zonnepanelen. Alleen als die map nog leeg is —
        eigen foto&apos;s worden nooit overschreven. Instellen via <code>GOOGLE_MAPS_API_KEY</code>
        op de server.
      </p>
    </ConnCard>
  );
}

function DropboxCard({ status }: { status: ConnectionStatus }) {
  return (
    <ConnCard status={status}>
      <div className="conn-top">
        <div className="conn-heading">
          <span className="conn-icon is-dropbox">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M7 3 2 6.3 7 9.6 2 12.9l5 3.3 5-3.3 5 3.3 5-3.3-5-3.3 5-3.3-5-3.3-5 3.3-5-3.3Zm5 15 5-3.3v2.2L12 20l-5-3.1v-2.2l5 3.3Z"
                fill="currentColor"
              />
            </svg>
          </span>
          <div>
            <div className="conn-name">Dropbox</div>
            <p className="conn-role" style={{ margin: "2px 0 0" }}>
              {status.connected ? `Verbonden als ${status.label ?? "onbekend"}` : "Nog niet gekoppeld."}
            </p>
          </div>
        </div>
        <Pill status={status} />
      </div>
      {status.error && <p className="conn-err">{status.error}</p>}
      <p className="conn-hint">
        Maakt automatisch een projectmap per adres aan en zet de deel-link in de
        ClickUp-taak. Eén teamlid logt hieronder eenmalig in — daarna werkt
        Dropbox voor iedereen, net als bij ClickUp.
      </p>
      <div className="conn-actions">
        <a
          href="/api/auth/dropbox/login"
          className={`btn ${status.connected ? "btn-quiet" : "btn-primary"}`}
        >
          {status.connected ? "Opnieuw inloggen met Dropbox" : "Inloggen met Dropbox"}
        </a>
      </div>
    </ConnCard>
  );
}

function GoogleCard({ status }: { status: ConnectionStatus }) {
  return (
    <ConnCard status={status}>
      <div className="conn-top">
        <div className="conn-heading">
          <span className="conn-icon" style={{ background: "rgba(234, 67, 53, 0.12)", color: "#ea4335" }}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <rect x="3" y="4" width="18" height="17" rx="2" stroke="currentColor" strokeWidth="1.8" />
              <path d="M3 9h18M8 2v4M16 2v4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </span>
          <div>
            <div className="conn-name">Google Agenda</div>
            <p className="conn-role" style={{ margin: "2px 0 0" }}>
              {status.connected ? `Jouw account verbonden als ${status.label ?? "onbekend"}` : "Nog niet gekoppeld voor jouw account."}
            </p>
          </div>
        </div>
        <Pill status={status} />
      </div>
      {status.error && <p className="conn-err">{status.error}</p>}
      <p className="conn-hint">
        Haalt de afspraken van vandaag op bij het zoeken van een adres, zodat je het adres en de
        makelaarsinformatie uit de agenda-afspraak niet opnieuw hoeft over te typen.{" "}
        <b>In tegenstelling tot Dropbox is dit per teamlid</b> — elke gebruiker logt hier zelf in met
        zijn eigen Google-account (gekoppeld aan het actieve account in de zijbalk). Wissel eerst van
        account via Gebruikers voordat je hier inlogt, anders koppel je Google aan de verkeerde naam.
      </p>
      <div className="conn-actions">
        <a href="/api/auth/google/login" className={`btn ${status.connected ? "btn-quiet" : "btn-primary"}`}>
          {status.connected ? "Opnieuw inloggen met Google" : "Inloggen met Google"}
        </a>
      </div>
    </ConnCard>
  );
}

interface SharePointConfig {
  siteUrl: string;
  rootPath: string;
}

function SharePointCard({ status, onSaved }: { status: ConnectionStatus; onSaved: () => void }) {
  const [config, setConfig] = useState<SharePointConfig | null>(null);
  const [isDefault, setIsDefault] = useState(true);
  const [editing, setEditing] = useState(false);
  const [siteUrl, setSiteUrl] = useState("");
  const [rootPath, setRootPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<"verified" | "stored" | null>(null);

  useEffect(() => {
    fetch("/api/sharepoint/config", { cache: "no-store" })
      .then((res) => res.json())
      .then((data: { config: SharePointConfig; isDefault: boolean }) => {
        setConfig(data.config);
        setIsDefault(data.isDefault);
      })
      .catch(() => {});
  }, []);

  function startEditing() {
    setSiteUrl(config?.siteUrl ?? "");
    setRootPath(config?.rootPath ?? "");
    setError(null);
    setSaved(null);
    setEditing(true);
  }

  async function save() {
    if (!siteUrl.trim()) return;
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const res = await fetch("/api/sharepoint/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteUrl: siteUrl.trim(), rootPath: rootPath.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(
          data?.error === "invalid_url"
            ? "Dit lijkt geen SharePoint-link. Plak de volledige URL uit de adresbalk."
            : data?.error === "site_unreachable"
              ? "Deze map is niet te openen met het gekoppelde account. Controleer de link."
              : data?.error === "no_storage"
                ? "Er is geen Redis-opslag gekoppeld, dus de wijziging kan niet bewaard worden."
                : "Opslaan is mislukt. Probeer het opnieuw."
        );
        return;
      }
      setConfig(data.config);
      setIsDefault(data.isDefault);
      setSaved(data.verified ? "verified" : "stored");
      setEditing(false);
      onSaved();
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/sharepoint/config", { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) {
        setError("Terugzetten is mislukt.");
        return;
      }
      setConfig(data.config);
      setIsDefault(true);
      setEditing(false);
      setSaved(null);
      onSaved();
    } finally {
      setBusy(false);
    }
  }

  return (
    <ConnCard status={status}>
      <div className="conn-top">
        <div className="conn-heading">
          <span className="conn-icon" style={{ background: "rgba(3, 120, 124, 0.12)", color: "#03787c" }}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M4 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7Z" stroke="currentColor" strokeWidth="1.8" />
              <path d="M12 10v6m0 0-2.5-2.5M12 16l2.5-2.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <div>
            <div className="conn-name">SharePoint (Microsoft 365)</div>
            <p className="conn-role" style={{ margin: "2px 0 0" }}>
              {status.ok
                ? `Leestoegang tot ${status.label ?? "de site"}`
                : status.connected
                  ? "App-gegevens staan er, maar Microsoft geeft nog geen toegang."
                  : "Nog niet ingesteld op de server."}
            </p>
          </div>
        </div>
        <Pill status={status} />
      </div>
      {status.error && <p className="conn-err">{status.error}</p>}
      <p className="conn-hint">
        Zet de hele opgeleverde map uit SharePoint — met dezelfde naam en indeling — als eigen
        map in de Dropbox-projectmap van dat adres, zodra de taak in ClickUp op klaar gaat.
        Eén teamlid logt hier eenmalig in; daarna werkt het voor iedereen.
      </p>

      {/* De map staat vast ingesteld. Alleen tonen, niet zomaar aanpasbaar: een
          typefout hierin legt de hele automatische overdracht stil. */}
      {config && !editing && (
        <div className="conn-fixed">
          <div className="conn-fixed-row">
            <span className="conn-fixed-label">Map</span>
            <span className="conn-fixed-value">
              {config.rootPath || "(hele bibliotheek)"}
              {isDefault && <span className="conn-tag">standaard</span>}
            </span>
          </div>
          <div className="conn-fixed-row">
            <span className="conn-fixed-label">Site</span>
            <span className="conn-fixed-value is-url">{config.siteUrl}</span>
          </div>
        </div>
      )}

      {saved === "verified" && !editing && (
        <p className="conn-hint">Opgeslagen en gecontroleerd — de app kan deze map openen.</p>
      )}
      {saved === "stored" && !editing && (
        <p className="conn-hint">
          Opgeslagen. Klik nu op &quot;Inloggen met Microsoft&quot; — de app weet nu bij welke
          organisatie hij moet aanmelden.
        </p>
      )}

      {editing ? (
        <div className="section-body is-single-wide" style={{ padding: 0 }}>
          <div className="field">
            <label htmlFor="sp-site">Link naar de map in SharePoint</label>
            <input
              id="sp-site"
              className="control"
              placeholder="https://…sharepoint.com/sites/…/Forms/AllItems.aspx?id=…"
              value={siteUrl}
              onChange={(e) => setSiteUrl(e.target.value)}
            />
            <p className="conn-hint" style={{ marginTop: 4 }}>
              Open de map in SharePoint en plak de URL uit de adresbalk. Site en map worden er
              zelf uit gehaald.
            </p>
          </div>
          <div className="field">
            <label htmlFor="sp-root">Map (wordt uit de link gehaald)</label>
            <input
              id="sp-root"
              className="control"
              placeholder="Gereed"
              value={rootPath}
              onChange={(e) => setRootPath(e.target.value)}
            />
          </div>
          {error && <p className="conn-err">{error}</p>}
          <div className="conn-actions">
            <button className="btn btn-primary" disabled={busy || !siteUrl.trim()} onClick={save}>
              {busy ? "Bezig met controleren…" : "Opslaan"}
            </button>
            <button className="btn btn-quiet" onClick={() => setEditing(false)} disabled={busy}>
              Annuleren
            </button>
            {!isDefault && (
              <button className="btn-text" onClick={reset} disabled={busy}>
                Terug naar standaardmap
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="conn-actions">
          <button className="btn btn-quiet" onClick={startEditing}>
            Map aanpassen
          </button>
        </div>
      )}
      {error && !editing && <p className="conn-err">{error}</p>}
    </ConnCard>
  );
}

function MediataskCard({ status, onSaved }: { status: ConnectionStatus; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [token, setToken] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!token.trim() || !baseUrl.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/mediatask/credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: token.trim(), baseUrl: baseUrl.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(
          data?.error === "invalid_credentials"
            ? "Mediatask wijst dit token/deze URL af. Controleer beide velden."
            : data?.error === "unreachable"
              ? "Kon de basis-URL niet bereiken. Controleer of hij klopt (bv. https://wegogroen.apitome.io)."
              : "Opslaan is mislukt. Probeer het opnieuw."
        );
        return;
      }
      setEditing(false);
      setToken("");
      setBaseUrl("");
      onSaved();
    } finally {
      setBusy(false);
    }
  }

  return (
    <ConnCard status={status}>
      <div className="conn-top">
        <div className="conn-heading">
          <span className="conn-icon" style={{ background: "rgba(37, 99, 235, 0.12)", color: "#2563eb" }}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M4 6h16M4 12h16M4 18h10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </span>
          <div>
            <div className="conn-name">Mediatask</div>
            <p className="conn-role" style={{ margin: "2px 0 0" }}>
              {status.connected ? `Verbonden — ${status.label ?? "onbekend"}` : "Nog niet gekoppeld."}
            </p>
          </div>
        </div>
        <Pill status={status} />
      </div>
      {status.error && <p className="conn-err">{status.error}</p>}
      <p className="conn-hint">
        Voor het automatisch versturen van NEN2580-foto&apos;s en plattegronden naar Mediatask (zie{" "}
        <a href="/nen" style={{ color: "var(--accent-text)" }}>Upload NEN</a>). Vul hieronder handmatig het
        API-token en de basis-URL van jullie Mediatask-omgeving in — geen herdeploy nodig.
      </p>

      {editing ? (
        <div className="section-body is-single-wide" style={{ padding: 0, marginTop: 10 }}>
          <div className="field">
            <label htmlFor="mt-cred-base">Basis-URL</label>
            <input
              id="mt-cred-base"
              className="control"
              placeholder="https://wegogroen.apitome.io"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="mt-cred-token">API-token</label>
            <input
              id="mt-cred-token"
              className="control"
              placeholder="SxpBWwy…"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          </div>
          {error && <p className="conn-err">{error}</p>}
          <div className="conn-actions">
            <button className="btn btn-primary" disabled={busy || !token.trim() || !baseUrl.trim()} onClick={save}>
              {busy ? "Bezig met controleren…" : "Opslaan"}
            </button>
            <button className="btn btn-quiet" onClick={() => setEditing(false)} disabled={busy}>
              Annuleren
            </button>
          </div>
        </div>
      ) : (
        <div className="conn-actions">
          <button className="btn btn-quiet" onClick={() => setEditing(true)}>
            {status.connected ? "Gegevens aanpassen" : "Handmatig koppelen"}
          </button>
        </div>
      )}
    </ConnCard>
  );
}

interface Controle {
  naam: string;
  ok: boolean;
  niveau?: "ok" | "let op" | "fout";
  detail: string;
}

interface Gezondheid {
  tijdstip: string;
  allesGoed?: boolean;
  controles: Controle[];
}

/**
 * De storingen stonden op het dashboard, onder de afspraken van vandaag. Daar
 * waren ze op het verkeerde moment in beeld: wie 's ochtends zijn route
 * bekijkt gaat geen koppeling repareren, en wie een storing zoekt kijkt hier.
 * Naast de koppelingen zelf staan ze bovendien in hun context — de melding en
 * de knop om het recht te zetten op één pagina.
 */
function Storingen() {
  const [rapport, setRapport] = useState<Gezondheid | null>(null);
  const [bezig, setBezig] = useState(false);
  const [fout, setFout] = useState<string | null>(null);

  // Eerst de laatste uitslag: die staat klaar en is er meteen. Een verse
  // controle draait alle diensten langs en duurt seconden — dat is een keuze
  // van de gebruiker, geen wachttijd bij het openen van de pagina.
  useEffect(() => {
    fetch("/api/health/laatste", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setRapport(d))
      .catch(() => {});
  }, []);

  const nuControleren = async () => {
    setBezig(true);
    setFout(null);
    try {
      const res = await fetch("/api/health", { cache: "no-store" });
      if (!res.ok) throw new Error("controle mislukt");
      setRapport(await res.json());
    } catch {
      setFout("De controle kon niet worden uitgevoerd.");
    } finally {
      setBezig(false);
    }
  };

  const storingen = rapport?.controles.filter((c) => !c.ok) ?? [];
  const aandacht = rapport?.controles.filter((c) => c.ok && c.niveau === "let op") ?? [];
  const alles = [...storingen, ...aandacht];

  return (
    <section className="set-sectie">
      <div className="set-sectie-head">
        <div>
          <h2>Storingen</h2>
          <p className="set-sectie-uitleg">
            Wat de automatische controle als laatste zag. Alleen wat aandacht vraagt staat hier.
          </p>
        </div>
        <button className="btn-refresh" onClick={nuControleren} disabled={bezig}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true" className={bezig ? "spin" : undefined}>
            <path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {bezig ? "Controleren…" : "Nu controleren"}
        </button>
      </div>

      {fout && <p className="conn-err">{fout}</p>}

      {!rapport && !fout && <p className="note" style={{ padding: 0 }}>Nog geen controle gedraaid.</p>}

      {rapport && alles.length === 0 && (
        <div className="set-rustig">
          <span className="dot is-ok" />
          Alles in orde — geen storingen gevonden.
        </div>
      )}

      {alles.length > 0 && (
        <ul className="sig-list">
          {alles.map((c) => (
            <li key={c.naam} className={c.ok ? "is-warn" : "is-bad"}>
              <span className="sig-icon" aria-hidden="true">
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
                  <path d="M8 1.8 15 14H1L8 1.8Z" fill="currentColor" fillOpacity="0.16" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
                  <path d="M8 6.2v3.1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                  <circle cx="8" cy="11.5" r="0.9" fill="currentColor" />
                </svg>
              </span>
              <span className="sig-text">
                <strong>{c.naam}</strong>
                <span>{c.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      )}

      {rapport && (
        <p className="sig-time">Gecontroleerd op {new Date(rapport.tijdstip).toLocaleString("nl-NL")}</p>
      )}
    </section>
  );
}

export default function Instellingen() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/connections/status", { cache: "no-store" });
      const data: StatusResponse = await res.json();
      setStatus(data);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Eén regel die de hele pagina samenvat, zodat je in één oogopslag ziet of
  // er iets aandacht vraagt zonder zeven kaarten langs te hoeven lopen.
  const all = status ? Object.values(status) : [];
  const okCount = all.filter((c) => c.ok).length;
  const problems = all.filter((c) => c.connected && !c.ok).length;
  const missing = all.filter((c) => !c.connected).length;

  return (
    <>
      <header className="topline">
        <span className="eyebrow">Instellingen</span>
      </header>

      {/* Twee blokken onder elkaar in plaats van één lange kaart: eerst wat er
          mis is, dan waar je het regelt. De samenvatting staat in de kop, want
          dat is het antwoord op de vraag waarmee je hier binnenkomt. */}
      <div className="set-page">
        <div className="set-hero">
          <div className="set-hero-tekst">
            <h1>Instellingen</h1>
            <p className="lede">
              Storingen en koppelingen op één plek. Alles staat centraal ingesteld — inloggen doe
              je één keer, daarna werkt het voor het hele team.
            </p>
          </div>
          {status && (
            <div className="set-tellers">
              <span className="set-teller is-ok">
                <b>{okCount}</b> in orde
              </span>
              <span className={`set-teller${problems > 0 ? " is-bad" : " is-leeg"}`}>
                <b>{problems}</b> met een probleem
              </span>
              <span className={`set-teller${missing > 0 ? " is-off" : " is-leeg"}`}>
                <b>{missing}</b> niet ingesteld
              </span>
            </div>
          )}
        </div>

        <Storingen />

        <section className="set-sectie">
          <div className="set-sectie-head">
            <div>
              <h2>Koppelingen</h2>
              <p className="set-sectie-uitleg">
                Live status van de diensten waar de app op leunt.
              </p>
            </div>
            <button className="btn-refresh" onClick={load} disabled={loading}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true" className={loading ? "spin" : undefined}>
                <path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              {loading ? "Verversen…" : "Verversen"}
            </button>
          </div>

          {loading && !status && <p className="note" style={{ padding: 0 }}>Status controleren…</p>}

          {status && (
            <div className="conn-grid">
              <SharePointCard status={status.sharepoint} onSaved={load} />
              <DropboxCard status={status.dropbox} />
              <ClickUpCard status={status.clickup} />
              <GoogleCard status={status.google} />
              <MediataskCard status={status.mediatask} onSaved={load} />
              <BagCard status={status.bag} />
              <StreetViewCard status={status.streetview} />
            </div>
          )}
        </section>
      </div>
    </>
  );
}
