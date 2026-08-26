"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

/** Lengte van de toegangscode; bij dit aantal cijfers logt de app vanzelf in. */
const CODE_LENGTH = 4;

function LoginForm() {
  const params = useSearchParams();
  const next = params.get("next") || "/";
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Terugval voor een wachtwoord dat niet uit cijfers bestaat, mocht de code
  // later veranderen.
  const [manual, setManual] = useState(false);
  const [manualValue, setManualValue] = useState("");

  const login = useCallback(
    async (password: string) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch("/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) {
          setError(
            data?.error === "geen_wachtwoord_ingesteld"
              ? "Er is nog geen code ingesteld (APP_PASSWORD ontbreekt) — de app is nu onbeveiligd."
              : data?.error ?? "Inloggen mislukt."
          );
          setCode("");
          return;
        }
        // Harde navigatie: de nieuwe cookie moet meteen door de middleware
        // gezien worden op de doelpagina.
        window.location.href = next;
      } catch {
        setError("Inloggen mislukt — controleer je verbinding.");
        setCode("");
      } finally {
        setBusy(false);
      }
    },
    [next]
  );

  // Zodra de code compleet is meteen inloggen: scheelt een extra tik.
  useEffect(() => {
    if (code.length === CODE_LENGTH && !busy) void login(code);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

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
    if (manual) return;
    function onKey(e: KeyboardEvent) {
      if (/^[0-9]$/.test(e.key)) press(e.key);
      else if (e.key === "Backspace") backspace();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manual, busy]);

  return (
    <div className="login-card">
      <div className="mark" style={{ padding: 0 }}>
        <b>WeGoGroen</b>
        <span>Upload portaal</span>
      </div>

      {manual ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void login(manualValue);
          }}
          style={{ display: "flex", flexDirection: "column", gap: 12 }}
        >
          <div className="field is-wide">
            <label htmlFor="pw">Wachtwoord</label>
            <input
              id="pw"
              className="control"
              type="password"
              autoComplete="current-password"
              value={manualValue}
              onChange={(e) => setManualValue(e.target.value)}
              autoFocus
            />
          </div>
          {error && <p className="conn-err">{error}</p>}
          <button className="btn btn-primary btn-block" disabled={busy || !manualValue}>
            {busy ? "Bezig…" : "Inloggen"}
          </button>
          <button type="button" className="btn-text" onClick={() => setManual(false)}>
            Toegangscode gebruiken
          </button>
        </form>
      ) : (
        <>
          <p className="login-prompt">Voer de toegangscode in</p>

          <div className="pin-dots" aria-label={`${code.length} van ${CODE_LENGTH} cijfers ingevoerd`}>
            {Array.from({ length: CODE_LENGTH }, (_, i) => (
              <span key={i} className={`pin-dot${i < code.length ? " is-filled" : ""}`} />
            ))}
          </div>

          <p className={`login-msg${error ? " is-error" : ""}`}>
            {busy ? "Bezig met inloggen…" : error ?? ""}
          </p>

          <div className="keypad">
            {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
              <button key={d} type="button" className="keypad-key" onClick={() => press(d)} disabled={busy}>
                {d}
              </button>
            ))}
            <button type="button" className="keypad-key is-quiet" onClick={() => setManual(true)}>
              abc
            </button>
            <button type="button" className="keypad-key" onClick={() => press("0")} disabled={busy}>
              0
            </button>
            <button
              type="button"
              className="keypad-key is-quiet"
              onClick={backspace}
              disabled={busy || code.length === 0}
              aria-label="Wissen"
            >
              ⌫
            </button>
          </div>
        </>
      )}
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
