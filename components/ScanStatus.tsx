"use client";

import { useEffect, useState } from "react";

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
              <button
                type="button"
                className="btn btn-quiet"
                disabled={herstelBezig === r.orderId}
                onClick={() => herstel(r.orderId)}
              >
                {herstelBezig === r.orderId ? "Bezig…" : "Opnieuw versturen"}
              </button>
            )}
          </li>
        ))}
      </ul>

      {melding && <p className="note" style={{ padding: 0, marginTop: 10 }}>{melding}</p>}
    </section>
  );
}
