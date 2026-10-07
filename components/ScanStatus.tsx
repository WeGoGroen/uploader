"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Verwerkingsstatus van de scans bij Mediatask, op het dashboard.
 *
 * Tot nu toe was dit alleen te zien in de pop-up tijdens het versturen. Die
 * mag je sluiten — verwerking duurt een kwartier — maar daarmee was er geen
 * enkele plek meer waar je kon zien of het goed gekomen is. Dat moest je dan
 * in Mediatask zelf gaan opzoeken.
 *
 * De kaart verschijnt alleen als er iets te melden is: bij alles verwerkt en
 * niets in behandeling zou het een lege kaart zijn die elke dag ruimte kost.
 */
interface ScanStatus {
  orderId: number;
  adres: string;
  totaal: number;
  klaar: number;
  stand: "verwerkt" | "bezig" | "mislukt" | "geen";
  ouderdomUur: number | null;
}

export default function ScanStatusKaart() {
  const [rijen, setRijen] = useState<ScanStatus[] | null>(null);
  const [herstelBezig, setHerstelBezig] = useState<number | null>(null);
  const [melding, setMelding] = useState<string | null>(null);
  const [menuVoor, setMenuVoor] = useState<number | null>(null);
  const [verbergBezig, setVerbergBezig] = useState<number | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Menu sluiten bij een tik ernaast of Escape, zoals elk uitklapmenu.
  useEffect(() => {
    if (menuVoor === null) return;
    function weg(e: PointerEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuVoor(null);
    }
    function esc(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuVoor(null);
    }
    document.addEventListener("pointerdown", weg);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", weg);
      document.removeEventListener("keydown", esc);
    };
  }, [menuVoor]);

  function laad(ververs = false) {
    fetch(`/api/mediatask/scanstatus${ververs ? "?ververs=1" : ""}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setRijen(d?.statussen ?? null))
      .catch(() => {});
  }

  useEffect(() => {
    laad();
    // Verwerking duurt minuten, niet seconden: elke twee minuten is ruim
    // genoeg en houdt het aantal aanroepen bij Mediatask laag.
    // Bewust zónder ververs: elke peiling kost bij Mediatask een aanroep per
    // order, en met meerdere dashboards open loopt dat hard op. De cache van
    // drie minuten aan de serverkant is voor een verwerking van een kwartier
    // ruim vers genoeg.
    const t = setInterval(() => laad(), 120000);
    return () => clearInterval(t);
  }, []);

  async function herstel(orderId: number) {
    setHerstelBezig(orderId);
    setMelding(null);
    try {
      const res = await fetch(`/api/mediatask/pointclouds/controle?orderId=${orderId}`);
      const d = await res.json();
      const opnieuw = d.problemen?.[0]?.opnieuwVerstuurd ?? [];
      const mis = d.problemen?.[0]?.nietGelukt ?? [];
      setMelding(
        opnieuw.length > 0
          ? `${opnieuw.join(", ")} opnieuw verstuurd — verwerking duurt weer even.`
          : mis.length > 0
            ? `Niet gelukt: ${mis.join(", ")}`
            : d.problemen?.[0]?.reden ?? "Niets om opnieuw te versturen."
      );
      laad(true);
    } catch {
      setMelding("Opnieuw versturen mislukt.");
    } finally {
      setHerstelBezig(null);
    }
  }

  /**
   * Voor een melding die niet klopt: de order is bij Mediatask goed
   * doorgekomen, maar er hangt nog een puntenwolk zonder beelden aan. De
   * server kijkt eerst nog één keer vers, en onthoudt het daarna voor
   * iedereen — ook de ochtendcontrole en de agent slaan deze scans dan over.
   */
  async function verberg(orderId: number) {
    setMenuVoor(null);
    setVerbergBezig(orderId);
    setMelding(null);
    try {
      const res = await fetch("/api/mediatask/scanstatus", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMelding(d.error ?? "Verbergen mislukt.");
        return;
      }
      // Meteen uit de lijst, niet pas na de volgende peiling.
      setRijen((rs) => (rs ? rs.filter((r) => r.orderId !== orderId) : rs));
      setMelding(
        d.alAlsnogVerwerkt
          ? "Mediatask had de scan intussen alsnog verwerkt."
          : "Verborgen. Komt er later een nieuwe afgekeurde scan bij deze order, dan zie je die weer."
      );
    } catch {
      setMelding("Verbergen mislukt.");
    } finally {
      setVerbergBezig(null);
    }
  }

  // Ook kort de geslaagde tonen. Zonder dat verdwijnt een rij die op "bezig"
  // stond zonder bevestiging uit beeld, en dat leest als "waar is het
  // gebleven?" in plaats van "het is goed gekomen". Na een paar uur is het
  // oude koek en zou het alleen nog ruimte kosten.
  const tonen = (rijen ?? []).filter(
    (r) =>
      r.stand === "bezig" ||
      r.stand === "mislukt" ||
      (r.stand === "verwerkt" && r.ouderdomUur !== null && r.ouderdomUur <= 6)
  );
  if (tonen.length === 0) return null;

  return (
    <section className="dash-card" aria-label="Scans bij Mediatask" style={{ marginTop: 12 }}>
      <div className="dash-card-head">
        <h2>Scans bij Mediatask</h2>
        <span className="section-count">{tonen.length}</span>
      </div>

      <ul className="scanstatus-lijst">
        {tonen.map((r) => (
          <li
            key={r.orderId}
            className={r.stand === "mislukt" ? "is-bad" : r.stand === "verwerkt" ? "is-goed" : ""}
          >
            <span className="scanstatus-icoon" aria-hidden="true">
              {r.stand === "mislukt" ? "⚠" : r.stand === "verwerkt" ? "✓" : <span className="spinner" />}
            </span>
            <span className="scanstatus-tekst">
              <b>{r.adres}</b>
              <span>
                {r.stand === "mislukt"
                  ? `${r.totaal - r.klaar} van ${r.totaal} scans afgekeurd door Mediatask`
                  : r.stand === "verwerkt"
                    ? `${r.totaal} ${r.totaal === 1 ? "scan" : "scans"} verwerkt en goedgekeurd`
                    : `${r.klaar} van ${r.totaal} scans verwerkt — dit duurt tot een kwartier`}
              </span>
            </span>
            {r.stand === "mislukt" && (
              <span className="scanstatus-acties">
                <button
                  type="button"
                  className="btn btn-quiet"
                  disabled={herstelBezig === r.orderId || verbergBezig === r.orderId}
                  onClick={() => herstel(r.orderId)}
                >
                  {herstelBezig === r.orderId ? "Bezig…" : "Opnieuw versturen"}
                </button>
                <div className="scanstatus-meer" ref={menuVoor === r.orderId ? menuRef : undefined}>
                  <button
                    type="button"
                    className="scanstatus-meer-knop"
                    aria-label={`Meer opties voor ${r.adres}`}
                    aria-haspopup="menu"
                    aria-expanded={menuVoor === r.orderId}
                    disabled={verbergBezig === r.orderId}
                    onClick={() => setMenuVoor(menuVoor === r.orderId ? null : r.orderId)}
                  >
                    {verbergBezig === r.orderId ? (
                      <span className="spinner" aria-hidden="true" />
                    ) : (
                      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                        <circle cx="3" cy="8" r="1.5" />
                        <circle cx="8" cy="8" r="1.5" />
                        <circle cx="13" cy="8" r="1.5" />
                      </svg>
                    )}
                  </button>
                  {menuVoor === r.orderId && (
                    <div className="scanstatus-menu" role="menu">
                      <button type="button" role="menuitem" className="user-menu-item" onClick={() => verberg(r.orderId)}>
                        <span className="scanstatus-menu-tekst">
                          <b>Verbergen</b>
                          <span>Staat goed bij Mediatask</span>
                        </span>
                      </button>
                    </div>
                  )}
                </div>
              </span>
            )}
          </li>
        ))}
      </ul>

      {melding && <p className="note" style={{ padding: 0, marginTop: 10 }}>{melding}</p>}
    </section>
  );
}
