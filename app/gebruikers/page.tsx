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
  /** Alleen een beheerder krijgt de hele lijst; een medewerker alleen zichzelf. */
  beheerder?: boolean;
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

/**
 * Je eigen inlogcode wijzigen.
 *
 * Iedereen begint op 0000 — die staat in de uitnodigingsmail en is dus geen
 * geheim. Zolang je hem niet vervangt, kan iedereen die de mail gezien heeft
 * onder jouw naam inloggen; vandaar dat de app erop blijft wijzen tot het
 * gebeurd is.
 */
function MijnCode() {
  const [wie, setWie] = useState<{ naam: string; codeGewijzigd: boolean } | null>(null);
  const [huidig, setHuidig] = useState("");
  const [nieuw, setNieuw] = useState("");
  const [nogmaals, setNogmaals] = useState("");
  const [bezig, setBezig] = useState(false);
  const [melding, setMelding] = useState<{ ok: boolean; tekst: string } | null>(null);

  useEffect(() => {
    fetch("/api/auth/wie", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { ingelogd?: boolean; naam?: string; codeGewijzigd?: boolean }) => {
        if (d.ingelogd && d.naam) setWie({ naam: d.naam, codeGewijzigd: Boolean(d.codeGewijzigd) });
      })
      .catch(() => {});
  }, []);

  async function opslaan(e: React.FormEvent) {
    e.preventDefault();
    setMelding(null);
    if (nieuw !== nogmaals) {
      setMelding({ ok: false, tekst: "De twee nieuwe codes zijn niet gelijk." });
      return;
    }
    setBezig(true);
    try {
      const res = await fetch("/api/auth/code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ huidig, nieuw }),
      });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) throw new Error(body?.error ?? "Wijzigen mislukt.");
      setMelding({ ok: true, tekst: "Je code is gewijzigd." });
      setHuidig("");
      setNieuw("");
      setNogmaals("");
      setWie((w) => (w ? { ...w, codeGewijzigd: true } : w));
    } catch (err) {
      setMelding({ ok: false, tekst: err instanceof Error ? err.message : "Wijzigen mislukt." });
    } finally {
      setBezig(false);
    }
  }

  if (!wie) return null;

  return (
    <div className="section">
      <div className="section-head">
        <h2>Mijn inlogcode</h2>
      </div>
      <p className="note" style={{ padding: 0, marginBottom: 12 }}>
        Je logt in als <strong>{wie.naam}</strong> met vier cijfers.
      </p>
      {!wie.codeGewijzigd && (
        <p className="conn-err" style={{ marginBottom: 12 }}>
          Je gebruikt nog de startcode 0000. Die staat in je uitnodigingsmail en kent iedereen —
          kies nu je eigen code.
        </p>
      )}
      <form onSubmit={opslaan} style={{ display: "grid", gap: 12, maxWidth: 520 }}>
        <div className="field is-wide">
          <label htmlFor="huidig">Huidige code</label>
          <input
            id="huidig"
            className="control"
            inputMode="numeric"
            maxLength={4}
            value={huidig}
            onChange={(e) => setHuidig(e.target.value.replace(/\D/g, ""))}
          />
        </div>
        <div style={{ display: "grid", gap: 12, gridTemplateColumns: "1fr 1fr" }}>
          <div className="field is-wide">
            <label htmlFor="nieuw">Nieuwe code</label>
            <input
              id="nieuw"
              className="control"
              inputMode="numeric"
              maxLength={4}
              value={nieuw}
              onChange={(e) => setNieuw(e.target.value.replace(/\D/g, ""))}
            />
          </div>
          <div className="field is-wide">
            <label htmlFor="nogmaals">Nogmaals</label>
            <input
              id="nogmaals"
              className="control"
              inputMode="numeric"
              maxLength={4}
              value={nogmaals}
              onChange={(e) => setNogmaals(e.target.value.replace(/\D/g, ""))}
            />
          </div>
        </div>
        <div>
          <button className="btn btn-primary" disabled={bezig || huidig.length !== 4 || nieuw.length !== 4}>
            {bezig ? "Bezig…" : "Code wijzigen"}
          </button>
        </div>
        {melding && (
          <p className={melding.ok ? "note" : "conn-err"} style={{ padding: 0 }}>
            {melding.tekst}
          </p>
        )}
      </form>
    </div>
  );
}

export default function Gebruikers() {
  const [accounts, setAccounts] = useState<AccountsResponse | null>(null);
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

  const load = useCallback(() => {
    fetch("/api/clickup/accounts", { cache: "no-store" })
      .then((res) => res.json())
      .then(setAccounts)
      .catch(() => {});
  }, []);

  useEffect(load, [load]);

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

        <MijnCode />

        {/* Het team inzien is beheerderswerk. Een opnemer heeft hier alleen
            zijn eigen code en token te zoeken. */}
        {accounts?.beheerder && (
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
        )}

      </div>
    </>
  );
}
