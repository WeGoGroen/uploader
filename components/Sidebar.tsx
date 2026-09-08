"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { getServerSnapshot, getSnapshot, subscribe } from "@/lib/upload-queue";

interface ConnectionStatus {
  connected: boolean;
  ok: boolean;
  label: string | null;
  error: string | null;
  /** Bewust uitgezet in de instellingen; geen storing. */
  uit?: boolean;
}

interface StatusResponse {
  clickup: ConnectionStatus;
  bag: ConnectionStatus;
  dropbox: ConnectionStatus;
  mediatask: ConnectionStatus;
  google: ConnectionStatus;
  sharepoint: ConnectionStatus;
}

interface AccountsResponse {
  accounts: { name: string; avatar: string | null }[];
  active: string | null;
}

function initials(name: string): string {
  return name
    .split(" ")
    .filter(Boolean)
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

/**
 * Waar je een dienst weer aan de praat krijgt. Google en Dropbox kunnen
 * rechtstreeks naar hun inlogscherm; de rest vraagt om een token of instelling
 * en gaat dus naar de Koppelingen-pagina.
 */
const INLOG_ROUTE: Record<string, string> = {
  Dropbox: "/api/auth/dropbox/login",
  "Google Agenda": "/api/auth/google/login",
  // SharePoint staat hier bewust NIET bij: die koppeling draait app-only met
  // de sleutels die MO Consultancy heeft afgegeven, dus er valt niets in te
  // loggen. Een inlogknop zou naar een route wijzen die niet meer bestaat.
};

function SvcRow({ name, status }: { name: string; status: ConnectionStatus }) {
  const isOk = status.connected && status.ok;

  /*
    Uitgezet ziet er anders uit dan kapot.

    Een koppeling die je bewust niet gebruikt hoort geen rode driehoek met
    "HERSTELLEN" te krijgen — dan staat de statuslijst permanent te roepen om
    iets dat niemand gaat repareren, en kijkt niemand er meer naar. Een gedoofd
    streepje zegt genoeg: hij doet niets, en dat klopt zo.
  */
  if (status.uit) {
    return (
      <a href="/instellingen" className="svc is-uit">
        <span className="svc-check" aria-hidden="true" style={{ opacity: 0.35 }}>
          —
        </span>
        <span className="svc-name">{name}</span>
        <span className="svc-live" style={{ opacity: 0.5 }}>
          UIT
        </span>
      </a>
    );
  }

  // Een verbroken koppeling is geen detail maar werk dat stilligt, dus krijgt
  // hij een tag die je niet kunt missen — en die meteen naar de juiste plek
  // gaat in plaats van naar een instellingenpagina waar je zelf moet zoeken.
  const href = isOk ? "/instellingen" : INLOG_ROUTE[name] ?? "/instellingen";

  return (
    <a href={href} className={`svc ${isOk ? "" : "needs-login"}`}>
      {isOk ? (
        <span className="svc-check" aria-hidden="true">
          ✓
        </span>
      ) : (
        /* Een driehoek i.p.v. een bolletje: een gedoofd stipje leest als
           "staat uit", terwijl dit betekent dat er iets moet gebeuren. */
        <span className="svc-waarschuwing" aria-hidden="true">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
            <path d="M8 1.8 15 14H1L8 1.8Z" fill="currentColor" fillOpacity="0.2" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
            <path d="M8 6.2v3.1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            <circle cx="8" cy="11.5" r="0.9" fill="currentColor" />
          </svg>
        </span>
      )}
      <span className="svc-name">{name}</span>
      {isOk ? (
        <span className="svc-live">LIVE</span>
      ) : (
        <span className="svc-fix" title={status.error ?? undefined}>
          {INLOG_ROUTE[name] ? "INLOGGEN" : "HERSTELLEN"}
          <svg width="9" height="9" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M3 9l6-6M4.2 3H9v4.8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      )}
    </a>
  );
}

/**
 * Eén uploadknop in de zijbalk. Toont een rode teller zodra er voor deze soort
 * opname iets omhoog gaat — zo zie je vanaf elke pagina dat er nog werk loopt,
 * ook als je de uploadpagina zelf verlaten hebt.
 */
function NavUpload({
  href,
  label,
  actief,
  bezig,
  tag,
}: {
  href: string;
  label: string;
  actief: boolean;
  bezig: number;
  /** Bijschrift achter de naam: "bèta" of "binnenkort". */
  tag?: { woord: string; soort: "beta" | "binnenkort" };
}) {
  return (
    <a href={href} className="nav-upload" aria-current={actief ? "true" : undefined}>
      <span className="nav-upload-icon" aria-hidden="true">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none">
          <path d="M12 16V5m0 0L7.5 9.5M12 5l4.5 4.5" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M5 17v2h14v-2" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
        </svg>
      </span>
      <span className="nav-upload-tekst">
        {label}
        {tag && <span className={`nav-upload-tag is-${tag.soort}`}>{tag.woord}</span>}
      </span>
      {bezig > 0 && (
        <span className="nav-upload-teller" title={`${bezig} ${bezig === 1 ? "project" : "projecten"} aan het uploaden`}>
          {bezig}
        </span>
      )}
    </a>
  );
}

export default function Sidebar() {
  const pathname = usePathname();
  const [accountName, setAccountName] = useState<string | null>(null);
  const [svc, setSvc] = useState<StatusResponse | null>(null);
  const [accounts, setAccounts] = useState<AccountsResponse | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);
  // Lopende uploads komen uit de wachtrij buiten React. Tellen per project en
  // niet per bestand: twintig foto's van één adres is één ding dat loopt, en
  // "20" zou alarmerender lezen dan het is.
  const taken = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const bezigPerRoot = (root: string) =>
    new Set(
      taken.filter((t) => t.dropbox === "uploading" && t.folderPath.startsWith(root)).map((t) => t.folderPath)
    ).size;
  const bezigEnergie = bezigPerRoot("/Automatie Energielabels");
  const bezigNen = bezigPerRoot("/Automatie NEN2580");
  const bezigMedia = bezigPerRoot("/Automatie Media");
  const activeAvatar =
    accounts?.accounts?.find((a) => a.name === (accountName ?? accounts.active))?.avatar ?? null;

  function loadAll() {
    fetch("/api/clickup/list-meta", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setAccountName(data?.account?.username ?? null))
      .catch(() => {});

    // res.ok checken is hier geen franje: bij een 401 (uitgelogd) komt er
    // anders een foutobject binnen en klapt de render op accounts.accounts.
    fetch("/api/connections/status", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setSvc(data ?? null))
      .catch(() => {});

    fetch("/api/clickup/accounts", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setAccounts(data?.accounts ? data : null))
      .catch(() => {});

  }

  // Op de inlogpagina niets laden en niets tonen: die verzoeken zouden toch
  // 401 geven, en een navigatiemenu hoort niet zichtbaar te zijn als je nog
  // niet ingelogd bent.
  const onLoginPage = pathname === "/login";
  useEffect(() => {
    if (!onLoginPage) loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onLoginPage]);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => {
      if (userMenuRef.current?.contains(e.target as Node)) return;
      setMenuOpen(false);
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [menuOpen]);

  /**
   * Uitloggen in plaats van wisselen.
   *
   * Van gebruiker wisselen was één klik in dit menu — geen code, geen
   * bevestiging. Nu hoort de naam bij de inlog, dus wisselen betekent: sessie
   * weg, en op het inlogscherm je eigen code invullen.
   */
  async function uitloggen() {
    if (switching) return;
    setSwitching(true);
    try {
      await fetch("/api/auth/uitloggen", { method: "POST" });
      // Harde navigatie: de middleware moet de lege cookie meteen zien,
      // anders komt de volgende pagina nog uit de cache van de oude sessie.
      window.location.href = "/login";
    } finally {
      setSwitching(false);
    }
  }

  if (onLoginPage) return null;

  return (
    <aside className="side">
      <div className="mark">
        <b>WeGoGroen</b>
        <span>Upload portaal</span>
      </div>

      <nav className="nav" aria-label="Hoofdmenu">
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- de hele app navigeert bewust met gewone <a>-tags, niet next/link */}
        <a href="/" className="nav-item" aria-current={pathname === "/" ? "true" : undefined}>
          <span className="nav-icon" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path d="M4 11 12 4l8 7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M6 10.5V20h12v-9.5" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
            </svg>
          </span>
          Dashboard
        </a>

        {/* De drie uploadknoppen apart gezet: dat is het werk waarvoor de app
            bestaat, en als vierde en vijfde regel in een rij gelijkvormige
            links waren ze niet te onderscheiden van navigatie. */}
        <span className="nav-groep">Uploaden</span>
        <NavUpload
          href="/energielabel"
          label="Energielabel"
          actief={pathname === "/energielabel"}
          bezig={bezigEnergie}
        />
        <NavUpload
          href="/nen"
          label="NEN2580"
          actief={pathname === "/nen"}
          bezig={bezigNen}
          tag={{ woord: "bèta", soort: "beta" }}
        />
        <NavUpload
          href="/media"
          label="Media"
          actief={pathname.startsWith("/media")}
          bezig={bezigMedia}
          tag={{ woord: "binnenkort", soort: "binnenkort" }}
        />
      </nav>

      <div className="side-block is-compact" style={{ marginTop: "auto" }}>
        <span className="side-title">Status</span>
        {svc && (
          <>
            <SvcRow name="ClickUp" status={svc.clickup} />
            <SvcRow name="BAG" status={svc.bag} />
            <SvcRow name="Dropbox" status={svc.dropbox} />
            <SvcRow name="Mediatask" status={svc.mediatask} />
            <SvcRow name="Google Agenda" status={svc.google} />
            <SvcRow name="SharePoint" status={svc.sharepoint} />
          </>
        )}
      </div>

      <div className="side-foot">
        <a href="/gebruikers" className="side-tile" aria-current={pathname === "/gebruikers" ? "true" : undefined}>
          <span className="side-tile-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <circle cx="12" cy="8" r="3.4" stroke="currentColor" strokeWidth="1.8" />
              <path d="M5 20c1.2-4 4-6 7-6s5.8 2 7 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </span>
          Gebruikers
        </a>
        <a
          href="/instellingen"
          className="side-tile"
          aria-current={pathname === "/instellingen" ? "true" : undefined}
        >
          <span className="side-tile-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z"
                stroke="currentColor"
                strokeWidth="1.8"
              />
              <path
                d="M19.4 13.5c.06-.5.06-1 0-1.5l1.6-1.2-1.5-2.6-1.9.6a7.4 7.4 0 0 0-1.3-.75l-.3-2H10l-.3 2c-.47.2-.9.45-1.3.75l-1.9-.6-1.5 2.6L6.6 12c-.06.5-.06 1 0 1.5L5 14.7l1.5 2.6 1.9-.6c.4.3.83.55 1.3.75l.3 2h4l.3-2c.47-.2.9-.45 1.3-.75l1.9.6 1.5-2.6-1.6-1.2Z"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          Instellingen
        </a>
      </div>

      <div className="user" ref={userMenuRef}>
        <button
          type="button"
          className="user-badge"
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          onClick={() => setMenuOpen((v) => !v)}
        >
          <span className="avatar" style={{ overflow: "hidden", padding: 0 }}>
            {activeAvatar ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={activeAvatar} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            ) : accountName ? (
              initials(accountName)
            ) : (
              "?"
            )}
          </span>
          <span className="user-id">
            <b>{accountName ?? "Laden…"}</b>
            <span>ingelogd</span>
          </span>
          <svg className="user-chev" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        {menuOpen && (
          <div className="user-menu" role="menu">
            <a href="/gebruikers" className="user-menu-item" onClick={() => setMenuOpen(false)}>
              Mijn gegevens en code
            </a>
            <div className="user-menu-sep" />
            <button type="button" className="user-menu-item" onClick={uitloggen} disabled={switching}>
              {switching ? "Bezig…" : "Uitloggen"}
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}
