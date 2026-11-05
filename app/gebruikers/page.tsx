"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTaal } from "@/components/TaalProvider";

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
  const { t } = useTaal();
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
      setMelding({ ok: false, tekst: t("beheer.gebruikers.code.nietGelijk") });
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
      if (!res.ok) throw new Error(body?.error ?? t("beheer.gebruikers.code.mislukt"));
      setMelding({ ok: true, tekst: t("beheer.gebruikers.code.gewijzigd") });
      setHuidig("");
      setNieuw("");
      setNogmaals("");
      setWie((w) => (w ? { ...w, codeGewijzigd: true } : w));
    } catch (err) {
      setMelding({ ok: false, tekst: err instanceof Error ? err.message : t("beheer.gebruikers.code.mislukt") });
    } finally {
      setBezig(false);
    }
  }

  if (!wie) return null;

  return (
    <div className="section">
      <div className="section-head">
        <h2>{t("beheer.gebruikers.code.titel")}</h2>
      </div>
      <p className="note" style={{ padding: 0, marginBottom: 12 }}>
        {t("beheer.gebruikers.code.logtInAlsVoor")} <strong>{wie.naam}</strong>{" "}
        {t("beheer.gebruikers.code.logtInAlsNa")}
      </p>
      {!wie.codeGewijzigd && (
        <p className="conn-err" style={{ marginBottom: 12 }}>
          {t("beheer.gebruikers.code.startcode")}
        </p>
      )}
      <form onSubmit={opslaan} style={{ display: "grid", gap: 12, maxWidth: 520 }}>
        <div className="field is-wide">
          <label htmlFor="huidig">{t("beheer.gebruikers.code.huidig")}</label>
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
            <label htmlFor="nieuw">{t("beheer.gebruikers.code.nieuw")}</label>
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
            <label htmlFor="nogmaals">{t("beheer.gebruikers.code.nogmaals")}</label>
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
            {bezig ? t("beheer.gebruikers.bezig") : t("beheer.gebruikers.code.wijzigen")}
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
  const { t } = useTaal();
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
      setAvatarError(t("beheer.gebruikers.fotoTeGroot"));
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
        setAvatarError(t("beheer.gebruikers.fotoMislukt"));
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
            ? t("beheer.gebruikers.ongeldigAdres")
            : (data.error ?? t("beheer.gebruikers.opslaanMislukt"))
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
            ? t("beheer.gebruikers.tokenGeweigerd")
            : t("beheer.gebruikers.opslaanMisluktOpnieuw")
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
        <span className="eyebrow">{t("beheer.gebruikers.titel")}</span>
      </header>

      <div className="pad" style={{ background: "var(--paper)", border: "1px solid var(--rule)", borderRadius: "var(--r)" }}>
        <h1>{t("beheer.gebruikers.titel")}</h1>
        <p className="lede" style={{ maxWidth: "none" }}>
          {t("beheer.gebruikers.ledeVoor")}{" "}
          <a href="/instellingen" style={{ color: "var(--accent-text)" }}>
            {t("beheer.gebruikers.ledeLink")}
          </a>
          .
        </p>

        <MijnCode />

        {/* Het team inzien is beheerderswerk. Een opnemer heeft hier alleen
            zijn eigen code en token te zoeken. */}
        {accounts?.beheerder && (
        <div className="section">
          <div className="section-head">
            <h2>{t("beheer.gebruikers.bestaande")}</h2>
          </div>
          {!accounts && <p className="note">{t("beheer.gebruikers.laden")}</p>}
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
                        title={t("beheer.gebruikers.fotoWijzigen")}
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
                          {isActive ? t("beheer.gebruikers.actief") : t("beheer.gebruikers.beschikbaar")}
                        </span>
                        <button
                          type="button"
                          className="user-card-foto"
                          onClick={() => fileInputRefs.current[a.name]?.click()}
                        >
                          {a.avatar ? t("beheer.gebruikers.fotoWijzigen") : t("beheer.gebruikers.fotoToevoegen")}
                        </button>
                      </div>
                    </div>

                    <div className="user-card-actions">
                        <button
                          className="btn btn-quiet"
                          onClick={() => (editingToken === a.name ? setEditingToken(null) : startEditingToken(a.name))}
                        >
                          {editingToken === a.name ? t("beheer.gebruikers.annuleren") : t("beheer.gebruikers.tokenAanpassen")}
                        </button>
                    </div>
                    <div className="user-card-mail">
                      <div className="field is-wide">
                        <label htmlFor={`mail-${a.name}`}>{t("beheer.gebruikers.mailLabel")}</label>
                        <input
                          id={`mail-${a.name}`}
                          className="control"
                          type="email"
                          inputMode="email"
                          placeholder={t("beheer.gebruikers.mailPlaceholder")}
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
                        {mailBezig === a.name ? t("beheer.gebruikers.bezig") : t("beheer.gebruikers.opslaan")}
                      </button>
                    </div>
                    {!a.email && (
                      <p className="conn-hint">
                        {t("beheer.gebruikers.geenMail", { naam: a.name })}
                      </p>
                    )}
                    {mailFout && <p className="conn-err">{mailFout}</p>}

                    {editingToken === a.name && (
                      <div className="user-card-token">
                        <div className="field">
                          <label htmlFor={`token-${a.name}`}>{t("beheer.gebruikers.nieuwToken", { naam: a.name })}</label>
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
                          {tokenBusy ? t("beheer.gebruikers.bezigControleren") : t("beheer.gebruikers.tokenOpslaan")}
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
