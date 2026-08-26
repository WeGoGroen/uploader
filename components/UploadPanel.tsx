"use client";

import { useMemo, useState, useSyncExternalStore } from "react";
import { getServerSnapshot, getSnapshot, probeerOpnieuw, subscribe } from "@/lib/upload-queue";
import {
  PRODUCT_LABEL,
  bouwOpenstaand,
  type Openstaand,
  type OverzichtDraft,
  type Status,
} from "@/lib/upload-overview";
import { relatieveTijd } from "@/lib/relatieve-tijd";

/**
 * De linkerkolom van het dashboard: alles wat nog loopt of nog afgemaakt moet
 * worden. Eén regel per adres, met een tag per product (een pand kan zowel een
 * energielabel als een NEN2580 hebben) en een tag met de gebruiker van wie het
 * werk is.
 *
 * De hele regel is klikbaar: opnames staan in gedeelde opslag, dus iedereen
 * kan het werk van een ander afmaken — daar hoeft niemand op de oorspronkelijke
 * opnemer te wachten.
 *
 * De samenvoeg- en percentagelogica staat in lib/upload-overview.ts, zodat die
 * te testen is zonder een browser.
 */
const STATUS_LABEL: Record<Status, string> = {
  bezig: "Bezig",
  mislukt: "Vastgelopen",
  open: "Openstaand",
};

export default function UploadPanel({ drafts }: { drafts: OverzichtDraft[] | null }) {
  const alleTaken = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const [herstart, setHerstart] = useState<string[]>([]);
  const [kwijt, setKwijt] = useState<string[]>([]);

  const items = useMemo(() => bouwOpenstaand(alleTaken, drafts), [alleTaken, drafts]);

  async function opnieuw(regel: Openstaand) {
    const ids = regel.mislukt.map((t) => t.id);
    setHerstart((v) => [...v, ...ids]);
    const gestart = await probeerOpnieuw(ids);
    setHerstart((v) => v.filter((id) => !ids.includes(id)));
    // Nul betekent: de bestanden staan niet meer op dit apparaat. Dat eerlijk
    // zeggen is beter dan een knop die stil niets doet.
    if (gestart === 0) setKwijt((v) => [...v, regel.sleutel]);
  }

  return (
    <section className="dash-uploads" aria-label="Openstaand werk">
      <div className="dash-card">
        <div className="dash-card-head">
          <h2>Nog af te maken</h2>
          {/* Uitsplitsing i.p.v. één getal: "3" zegt niet of er iets loopt of
              iets vastligt, en dat is precies het verschil tussen wachten en
              ingrijpen. */}
          {items.length > 0 && (
            <span className="up-telling">
              {(["bezig", "mislukt", "open"] as Status[])
                .map((st) => ({ st, n: items.filter((i) => i.status === st).length }))
                .filter(({ n }) => n > 0)
                .map(({ st, n }) => (
                  <span key={st} className={`up-telling-item is-${st}`}>
                    {n} {STATUS_LABEL[st].toLowerCase()}
                  </span>
                ))}
            </span>
          )}
        </div>

        {items.length === 0 && (
          <div className="up-leeg">
            <span className="up-leeg-mark" aria-hidden="true">
              ✓
            </span>
            <p>
              Niets openstaand. Uploads die nog bezig zijn of zijn blijven liggen komen hier vanzelf
              te staan, met hun voortgang.
            </p>
          </div>
        )}

        <ul className="up-list">
          {items.map((r) => {
            const bezigHerstart = r.mislukt.some((t) => herstart.includes(t.id));
            const isKwijt = kwijt.includes(r.sleutel);
            // De hele kaart voert naar het eerste product; de tags eronder
            // wijzen elk naar hun eigen flow.
            const hoofdHref = r.invulHref ?? r.producten[0]?.href ?? "#";
            return (
              <li key={r.sleutel} className={`up-item is-${r.status}`}>
                <a className="up-hit" href={hoofdHref} aria-label={`Verder met ${r.adres}`}>
                  <span className="up-top">
                    <span className={`up-status is-${r.status}`}>{STATUS_LABEL[r.status]}</span>
                    {r.updatedAt && <span className="up-tijd">{relatieveTijd(r.updatedAt)}</span>}
                    {r.pct !== null && <span className="up-pct">{r.pct}%</span>}
                  </span>
                  <span className="up-addr">{r.adres}</span>
                </a>

                {r.pct !== null && (
                  <span
                    className="up-bar"
                    role="progressbar"
                    aria-valuenow={r.pct}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label={`Upload ${r.adres}`}
                  >
                    <span className="up-bar-fill" style={{ width: `${r.pct}%` }} />
                  </span>
                )}

                {/* Elke reden op een eigen regel: aan elkaar geplakt met " · "
                    werd dit bij twee of drie redenen onleesbaar. */}
                <ul className="up-redenen">
                  {r.redenen.map((reden) => (
                    <li key={reden}>{reden}</li>
                  ))}
                </ul>

                {r.ontbrekend.length > 0 && (
                  <a className="up-todo" href={r.invulHref ?? hoofdHref}>
                    <span className="up-todo-icon" aria-hidden="true">
                      <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
                        <path
                          d="M8 1.8 15 14H1L8 1.8Z"
                          fill="currentColor"
                          fillOpacity="0.16"
                          stroke="currentColor"
                          strokeWidth="1.4"
                          strokeLinejoin="round"
                        />
                        <path d="M8 6.2v3.1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                        <circle cx="8" cy="11.5" r="0.9" fill="currentColor" />
                      </svg>
                    </span>
                    <span className="up-todo-text">
                      <strong>
                        {r.ontbrekend.length} veld{r.ontbrekend.length === 1 ? "" : "en"} nog invullen
                      </strong>
                      <span className="up-todo-codes">{r.ontbrekend.join(" · ")}</span>
                    </span>
                  </a>
                )}

                <div className="up-voet">
                  <div className="up-tags">
                    {r.producten.map((p) => (
                      <a key={p.soort} className={`up-kind is-${p.soort}`} href={p.href}>
                        {PRODUCT_LABEL[p.soort]}
                      </a>
                    ))}
                    {r.gebruiker && <span className="up-user">{r.gebruiker}</span>}
                  </div>

                  {r.mislukt.length > 0 && !isKwijt && (
                    <button
                      type="button"
                      className="up-retry"
                      onClick={() => opnieuw(r)}
                      disabled={bezigHerstart}
                    >
                      {bezigHerstart ? "Bezig…" : "Upload afmaken"}
                    </button>
                  )}
                </div>

                {isKwijt && (
                  <span className="up-lost">
                    Bestanden staan niet meer op dit apparaat — open de opname en kies ze opnieuw.
                  </span>
                )}
              </li>
            );
          })}
        </ul>

        {/* Stond eerder in de zijbalk. Daar was het een tweede plek waar
            opnames leefden; hier staat het naast het werk zelf. */}
        <a href="/opnames" className="dash-meer">
          Alle opnames bekijken
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M6 3.5 10.5 8 6 12.5" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </a>
      </div>
    </section>
  );
}
