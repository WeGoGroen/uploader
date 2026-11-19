"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useTaal } from "@/components/TaalProvider";
import TaalKnop from "@/components/TaalKnop";

/** Lengte van de inlogcode; bij dit aantal cijfers logt de app vanzelf in. */
const CODE_LENGTH = 4;

interface Account {
  naam: string;
  avatar: string | null;
  codeGewijzigd: boolean;
}

/** De initialen als er geen avatar is — zelfde idee als in het dashboard. */
function initialen(naam: string): string {
  return naam
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((d) => d[0]?.toUpperCase() ?? "")
    .join("");
}

/**
 * Inloggen in twee stappen: eerst wie je bent, dan je eigen code.
 *
 * Hiervóór was er één code voor iedereen en koos je daarna zelf een naam op de
 * gebruikerspagina — met één klik, zonder iets in te vullen. Daardoor wist de
 * app niet wie er werkte, en kon een opname op de naam van een collega belanden
 * zonder dat iemand dat merkte. Dezelfde opzet als het Business Control Center
 * dus: je naam is de inlog, niet een keuze achteraf.
 */
function LoginForm() {
  /*
    Na het inloggen kom je altijd op het dashboard uit.

    Er zat een ?next=-doorstuur op: de middleware onthield welke pagina je
    wilde, en je landde daar weer. Bedoeld voor een gedeelde link, maar in de
    praktijk werkt het andersom — je sessie verloopt terwijl je ergens in een
    formulier of op de instellingen staat, je logt opnieuw in, en je staat
    midden in datzelfde scherm in plaats van bij het begin van je dag. De
    sessie in deze app duurt dertig dagen, dus opnieuw inloggen betekent bijna
    altijd: nieuw apparaat, nieuwe dag, nieuwe opname.
  */
  const next = "/";
  const { t } = useTaal();

  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [gekozen, setGekozen] = useState<Account | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/auth/accounts", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { accounts?: Account[] }) => setAccounts(d.accounts ?? []))
      .catch(() => setAccounts([]));
  }, []);

  const login = useCallback(
    async (naam: string, ingevoerd: string) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch("/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ naam, code: ingevoerd }),
        });
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        if (!res.ok) {
          setError(data?.error ?? t("beheer.login.mislukt"));
          setCode("");
          return;
        }
        // Harde navigatie: de nieuwe cookie moet meteen door de middleware
        // gezien worden op de doelpagina.
        window.location.href = next;
      } catch {
        setError(t("beheer.login.misluktVerbinding"));
        setCode("");
      } finally {
        setBusy(false);
      }
    },
    [next, t]
  );

  // Zodra de code compleet is meteen inloggen: scheelt een extra tik.
  useEffect(() => {
    if (gekozen && code.length === CODE_LENGTH && !busy) void login(gekozen.naam, code);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, gekozen]);

  function press(digit: string) {
    if (busy) return;
    setError(null);
    setCode((c) => (c.length >= CODE_LENGTH ? c : c + digit));
  }

  function backspace() {
    setError(null);
    setCode((c) => c.slice(0, -1));
  }

  // Ook gewoon met een fysiek toetsenbord te bedienen.
  useEffect(() => {
    if (!gekozen) return;
    function onKey(e: KeyboardEvent) {
      if (/^[0-9]$/.test(e.key)) press(e.key);
      else if (e.key === "Backspace") backspace();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gekozen, busy]);

  return (
    <div className="login-card">
      <div className="mark" style={{ padding: 0 }}>
        <b>WeGoGroen</b>
        <span>{t("beheer.login.ondertitel")}</span>
      </div>

      {!gekozen ? (
        <>
          <p className="login-prompt">{t("beheer.login.wieBenJe")}</p>
          {accounts === null ? (
            <p className="login-msg">{t("beheer.login.evenKijken")}</p>
          ) : accounts.length === 0 ? (
            <p className="login-msg is-error">{t("beheer.login.geenAccounts")}</p>
          ) : (
            <div className="login-accounts">
              {accounts.map((a) => (
                <button
                  key={a.naam}
                  type="button"
                  className="login-account"
                  onClick={() => {
                    setGekozen(a);
                    setCode("");
                    setError(null);
                  }}
                >
                  <span className="login-avatar" aria-hidden="true">
                    {a.avatar ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={a.avatar} alt="" />
                    ) : (
                      initialen(a.naam)
                    )}
                  </span>
                  <span className="login-naam">{a.naam}</span>
                </button>
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          <button type="button" className="login-gekozen" onClick={() => setGekozen(null)}>
            <span className="login-avatar" aria-hidden="true">
              {gekozen.avatar ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={gekozen.avatar} alt="" />
              ) : (
                initialen(gekozen.naam)
              )}
            </span>
            <span className="login-naam">{gekozen.naam}</span>
            <span className="login-wissel">{t("beheer.login.wisselen")}</span>
          </button>

          <p className="login-prompt">{t("beheer.login.vulCodeIn")}</p>

          <div className="pin-dots" aria-label={t("beheer.login.cijfersIngevoerd", { n: code.length, totaal: CODE_LENGTH })}>
            {Array.from({ length: CODE_LENGTH }, (_, i) => (
              <span key={i} className={`pin-dot${i < code.length ? " is-filled" : ""}`} />
            ))}
          </div>

          <p className={`login-msg${error ? " is-error" : ""}`}>
            {busy
              ? t("beheer.login.bezig")
              : error ?? (gekozen.codeGewijzigd ? "" : t("beheer.login.startcode"))}
          </p>

          <div className="keypad">
            {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
              <button key={d} type="button" className="keypad-key" onClick={() => press(d)} disabled={busy}>
                {d}
              </button>
            ))}
            <span />
            <button type="button" className="keypad-key" onClick={() => press("0")} disabled={busy}>
              0
            </button>
            <button
              type="button"
              className="keypad-key is-quiet"
              onClick={backspace}
              disabled={busy || code.length === 0}
              aria-label={t("beheer.login.wissen")}
            >
              ⌫
            </button>
          </div>
        </>
      )}

      <TaalKnop />
    </div>
  );
}

export default function LoginPage() {
  return (
    <div className="login-wrap">
      <Suspense fallback={null}>
        <LoginForm />
      </Suspense>
    </div>
  );
}
