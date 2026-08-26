"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface Account {
  name: string;
  avatar: string | null;
  email: string | null;
}

interface AccountsResponse {
  accounts: Account[];
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

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export default function Gebruikers() {
  const [accounts, setAccounts] = useState<AccountsResponse | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);
  const [uploadingAvatar, setUploadingAvatar] = useState<string | null>(null);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  // Mailadres per gebruiker: hier bijgehouden en niet uit ClickUp gehaald,
  // want wie alleen NEN2580 of media uploadt hoeft geen ClickUp-lid te zijn.
  const [mailBezig, setMailBezig] = useState<string | null>(null);
  const [mailFout, setMailFout] = useState<string | null>(null);
  const [mailWaarde, setMailWaarde] = useState<Record<string, string>>({});
  const fileInputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const [editingToken, setEditingToken] = useState<string | null>(null);
  const [tokenValue, setTokenValue] = useState("");
  const [tokenBusy, setTokenBusy] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch("/api/clickup/accounts", { cache: "no-store" })
      .then((res) => res.json())
      .then(setAccounts)
      .catch(() => {});
  }, []);

  useEffect(load, [load]);

  async function switchAccount(accountName: string) {
    if (switching || accountName === accounts?.active) return;
    setSwitching(accountName);
    try {
      await fetch("/api/clickup/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: accountName }),
      });
      load();
    } finally {
      setSwitching(null);
    }
  }

  async function uploadAvatar(accountName: string, file: File) {
    setAvatarError(null);
    if (file.size > 1_500_000) {
      setAvatarError("Kies een kleinere foto (max 1,5 MB).");
      return;
    }
    setUploadingAvatar(accountName);
    try {
      const dataUrl = await fileToDataUrl(file);
      const res = await fetch("/api/clickup/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: accountName, avatar: dataUrl }),
      });
      if (!res.ok) {
        setAvatarError("Foto uploaden is mislukt. Probeer het opnieuw.");
        return;
      }
      load();
    } finally {
      setUploadingAvatar(null);
    }
  }

  async function bewaarMail(accountName: string) {
    setMailBezig(accountName);
    setMailFout(null);
    try {
      const res = await fetch("/api/clickup/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: accountName, email: mailWaarde[accountName] ?? "" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMailFout(
          data.error === "ongeldig_adres"
            ? "Dat lijkt geen geldig mailadres."
            : (data.error ?? "Opslaan is mislukt.")
        );
        return;
      }
      await load();
    } finally {
      setMailBezig(null);
    }
  }

  function startEditingToken(accountName: string) {
    setEditingToken(accountName);
    setTokenValue("");
    setTokenError(null);
  }

  async function saveToken(accountName: string) {
    if (!tokenValue.trim()) return;
    setTokenBusy(true);
    setTokenError(null);
    try {
      const res = await fetch("/api/clickup/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: accountName, token: tokenValue.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setTokenError(
          data?.error === "invalid_token"
            ? "Dit token wordt geweigerd door ClickUp. Controleer of je 'm goed hebt gekopieerd."
            : "Opslaan is mislukt. Probeer het opnieuw."
        );
        return;
      }
      setEditingToken(null);
      setTokenValue("");
      load();
    } finally {
      setTokenBusy(false);
    }
  }

  async function submit() {
    if (!name.trim() || !token.trim()) return;
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch("/api/clickup/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), token: token.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(
          data?.error === "invalid_token"
            ? "Dit token wordt geweigerd door ClickUp. Controleer of je 'm goed hebt gekopieerd."
            : "Toevoegen is mislukt. Probeer het opnieuw."
        );
        return;
      }
      setSuccess(`${name.trim()} is toegevoegd en is nu het actieve account op dit apparaat.`);
      setName("");
      setToken("");
      load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <header className="topline">
        <span className="eyebrow">Gebruikers</span>
      </header>

      <div className="pad" style={{ background: "var(--paper)", border: "1px solid var(--rule)", borderRadius: "var(--r)" }}>
        <h1>Gebruikers</h1>
        <p className="lede" style={{ maxWidth: "none" }}>
          Elk teamlid gebruikt een eigen ClickUp-token, zodat taken op de juiste naam
          worden aangemaakt. BAG en Dropbox zijn gedeeld en hoeven maar één keer
          ingesteld te worden — zie{" "}
          <a href="/instellingen" style={{ color: "var(--accent-text)" }}>
            Koppelingen
          </a>
          .
        </p>

        <div className="section">
          <div className="section-head">
            <h2>Bestaande gebruikers</h2>
          </div>
          {!accounts && <p className="note">Laden…</p>}
          {avatarError && <p className="conn-err">{avatarError}</p>}
          {accounts && (
            <div className="user-list">
              {accounts.accounts.map((a) => {
                const isActive = a.name === accounts.active;
                return (
                  <div className={`user-card${isActive ? " is-active" : ""}`} key={a.name}>
                    <div className="user-card-row">
                      <button
                        type="button"
                        className="user-card-avatar"
                        onClick={() => fileInputRefs.current[a.name]?.click()}
                        title="Profielfoto wijzigen"
                      >
                        {a.avatar ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={a.avatar} alt="" />
                        ) : (
                          initials(a.name)
                        )}
                        {uploadingAvatar === a.name && (
                          <span className="user-card-avatar-busy">
                            <span className="spinner" style={{ width: 14, height: 14 }} />
                          </span>
                        )}
                      </button>
                      <input
                        ref={(el) => {
                          fileInputRefs.current[a.name] = el;
                        }}
                        type="file"
                        accept="image/*"
                        style={{ display: "none" }}
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          e.target.value = "";
                          if (file) uploadAvatar(a.name, file);
                        }}
                      />

                      <div className="user-card-info">
                        <div className="user-card-name">{a.name}</div>
                        <span className={`pill ${isActive ? "is-ok" : "is-off"}`}>
                          {isActive ? "Actief op dit apparaat" : "Beschikbaar"}
                        </span>
                        <button
                          type="button"
                          className="user-card-foto"
                          onClick={() => fileInputRefs.current[a.name]?.click()}
                        >
                          {a.avatar ? "Profielfoto wijzigen" : "Profielfoto toevoegen"}
                        </button>
                      </div>
                    </div>

                    <div className="user-card-actions">
                        {!isActive && (
                          <button
                            className="btn btn-quiet"
                            disabled={switching === a.name}
                            onClick={() => switchAccount(a.name)}
                          >
                            {switching === a.name ? "Bezig…" : "Wissel naar dit account"}
                          </button>
                        )}
                        <button
                          className="btn btn-quiet"
                          onClick={() => (editingToken === a.name ? setEditingToken(null) : startEditingToken(a.name))}
                        >
                          {editingToken === a.name ? "Annuleren" : "Token aanpassen"}
                        </button>
                    </div>
                    <div className="user-card-mail">
                      <div className="field is-wide">
                        <label htmlFor={`mail-${a.name}`}>Mailadres voor meldingen</label>
                        <input
                          id={`mail-${a.name}`}
                          className="control"
                          type="email"
                          inputMode="email"
                          placeholder="naam@wegogroen.nl"
                          value={mailWaarde[a.name] ?? a.email ?? ""}
                          onChange={(e) =>
                            setMailWaarde((v) => ({ ...v, [a.name]: e.target.value }))
                          }
                        />
                      </div>
                      <button
                        className="btn btn-quiet"
                        disabled={mailBezig === a.name || (mailWaarde[a.name] ?? a.email ?? "") === (a.email ?? "")}
                        onClick={() => bewaarMail(a.name)}
                      >
                        {mailBezig === a.name ? "Bezig…" : "Opslaan"}
                      </button>
                    </div>
                    {!a.email && (
                      <p className="conn-hint">
                        Zonder adres krijgt {a.name} geen bericht als een opname blijft liggen.
                      </p>
                    )}
                    {mailFout && <p className="conn-err">{mailFout}</p>}

                    {editingToken === a.name && (
                      <div className="user-card-token">
                        <div className="field">
                          <label htmlFor={`token-${a.name}`}>Nieuw ClickUp API-token voor {a.name}</label>
                          <input
                            id={`token-${a.name}`}
                            className="control"
                            placeholder="pk_..."
                            value={tokenValue}
                            onChange={(e) => setTokenValue(e.target.value)}
                          />
                        </div>
                        {tokenError && <p className="conn-err">{tokenError}</p>}
                        <button
                          className="btn btn-primary"
                          disabled={tokenBusy || !tokenValue.trim()}
                          onClick={() => saveToken(a.name)}
                        >
                          {tokenBusy ? "Bezig met controleren…" : "Token opslaan"}
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="conn user-add-card">
          <div className="conn-top">
            <div className="conn-heading">
              <span className="conn-icon" style={{ background: "rgba(74, 222, 128, 0.14)", color: "#1c7a41" }}>
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <circle cx="9" cy="8" r="3.2" stroke="currentColor" strokeWidth="1.8" />
                  <path d="M3 19c1-3.4 3.4-5.2 6-5.2s5 1.8 6 5.2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                  <path d="M18 8v5M15.5 10.5h5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
              </span>
              <div>
                <div className="conn-name">Nieuwe gebruiker toevoegen</div>
                <p className="conn-role" style={{ margin: "2px 0 0" }}>
                  Elk teamlid krijgt een eigen ClickUp-token, zodat taken op de juiste naam komen te staan.
                </p>
              </div>
            </div>
          </div>

          <div className="section-body is-single-wide" style={{ padding: 0, marginTop: 4 }}>
            <div className="addr-edit-row" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div className="field">
                <label htmlFor="g-name">Naam</label>
                <input
                  id="g-name"
                  className="control"
                  placeholder="Bijv. Yannick"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="g-token">ClickUp API-token</label>
                <input
                  id="g-token"
                  className="control"
                  placeholder="pk_..."
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                />
              </div>
            </div>
            <p className="conn-hint">
              Aanmaken via ClickUp → avatar rechtsboven → Settings → Apps → API Token.
              Het token wordt bij het opslaan direct gecontroleerd bij ClickUp.
            </p>
            {error && <p className="conn-err">{error}</p>}
            {success && <p className="note" style={{ color: "var(--accent-text)", padding: 0 }}>{success}</p>}
            <button
              className="btn btn-primary"
              disabled={busy || !name.trim() || !token.trim()}
              onClick={submit}
            >
              {busy ? "Bezig met controleren…" : "Gebruiker toevoegen"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
