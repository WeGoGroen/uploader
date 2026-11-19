"use client";

import { useEffect, useState } from "react";
import MeerMenu from "@/components/MeerMenu";
import { useTaal } from "@/components/TaalProvider";

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
  const { t } = useTaal();
  const [rijen, setRijen] = useState<ScanStatus[] | null>(null);
  const [herstelBezig, setHerstelBezig] = useState<number | null>(null);
  const [melding, setMelding] = useState<string | null>(null);
  const [verbergBezig, setVerbergBezig] = useState<number | null>(null);

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
    const timer = setInterval(() => laad(), 120000);
    return () => clearInterval(timer);
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
          ? t("dashboard.scans.opnieuwVerstuurd", { scans: opnieuw.join(", ") })
          : mis.length > 0
            ? t("dashboard.scans.nietGelukt", { scans: mis.join(", ") })
            : d.problemen?.[0]?.reden ?? t("dashboard.scans.nietsOpnieuw")
      );
      laad(true);
    } catch {
      setMelding(t("dashboard.scans.opnieuwMislukt"));
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
        setMelding(d.error ?? t("dashboard.scans.verbergenMislukt"));
        return;
      }
      // Meteen uit de lijst, niet pas na de volgende peiling.
      setRijen((rs) => (rs ? rs.filter((r) => r.orderId !== orderId) : rs));
      setMelding(
        d.alAlsnogVerwerkt
          ? t("dashboard.scans.alsnogVerwerkt")
          : t("dashboard.scans.verborgen")
      );
    } catch {
      setMelding(t("dashboard.scans.verbergenMislukt"));
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
    <section className="dash-card" aria-label={t("dashboard.scans.titel")} style={{ marginTop: 12 }}>
      <div className="dash-card-head">
        <h2>{t("dashboard.scans.titel")}</h2>
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
                  ? t("dashboard.scans.afgekeurd", { n: r.totaal - r.klaar, totaal: r.totaal })
                  : r.stand === "verwerkt"
                    ? t(r.totaal === 1 ? "dashboard.scans.verwerkt.een" : "dashboard.scans.verwerkt.meer", { n: r.totaal })
                    : t("dashboard.scans.bezig", { n: r.klaar, totaal: r.totaal })}
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
                  {herstelBezig === r.orderId ? t("dashboard.bezig") : t("dashboard.scans.opnieuwVersturen")}
                </button>
                <MeerMenu
                  label={t("dashboard.meerOpties", { adres: r.adres })}
                  bezig={verbergBezig === r.orderId}
                  items={[
                    {
                      label: t("dashboard.scans.verbergen"),
                      uitleg: t("dashboard.scans.verbergenUitleg"),
                      onClick: () => verberg(r.orderId),
                    },
                  ]}
                />
              </span>
            )}
          </li>
        ))}
      </ul>

      {melding && <p className="note" style={{ padding: 0, marginTop: 10 }}>{melding}</p>}
    </section>
  );
}
