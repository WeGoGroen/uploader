"use client";

import { useCallback, useEffect, useState } from "react";
import { useRechten } from "@/components/RechtenProvider";
import { opnameLink } from "@/lib/opname-link";
import { vergeetTakenVoor } from "@/lib/upload-queue";
import { taakHoortBij } from "@/lib/upload-overview";
import { sameAddress } from "@/lib/address-format";
import type { DraftRecord as ServerDraftRecord } from "@/lib/drafts";

type DraftRecord = Pick<
  ServerDraftRecord,
  | "id"
  | "status"
  | "titel"
  | "straatnaam"
  | "postcode"
  | "woonplaats"
  | "accountName"
  | "clickupTaskUrl"
  | "incompleteDocs"
  | "updatedAt"
  | "createdAt"
  | "soort"
>;

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString("nl-NL", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function Opnames() {
  const [drafts, setDrafts] = useState<DraftRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [verwijderFout, setVerwijderFout] = useState<string | null>(null);
  const [verwijderBezig, setVerwijderBezig] = useState<string | null>(null);
  // Kerncijfers over de doorstroom. Bij honderden opnames per maand zegt een
  // lijst weinig; deze getallen wel.
  const [cijfers, setCijfers] = useState<{
    open: number;
    afgerond: number;
    vandaag: number;
    afgelopenWeek: number;
    bijlagesOntbreken: number;
    langOpenstaand: number;
  } | null>(null);

  const rechten = useRechten();

  const load = useCallback(async () => {
    setError(null);
    try {
      // Alleen het eigen af te maken werk: het volledige overzicht (iedereen,
      // inclusief afgerond) leeft in het Business Control Center.
      const res = await fetch("/api/drafts?mijn=1", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Onbekende fout");
      setDrafts(data.drafts ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kon concepten niet laden.");
    }
  }, []);

  useEffect(() => {
    load().finally(() => setLoading(false));
  }, [load]);

  useEffect(() => {
    fetch("/api/opnames/cijfers", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setCijfers(d?.error ? null : d))
      .catch(() => {});
  }, []);

  async function refresh() {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }

  /*
    Weghalen wat op het dashboard één regel is.

    Het dashboard voegt alles van één adres samen tot één regel — meerdere
    concepten, een afgeronde opname met ontbrekende bijlages, en de uploads op
    dit apparaat. Deze knop haalde daar precies één record uit. Wie twee keer
    op hetzelfde adres begonnen was, zag de regel dus gewoon blijven staan en
    kon niet weten waarom. Eén klik ruimt nu op wat het dashboard als één klus
    toont.
  */
  async function verwijderOpname(gekozen: DraftRecord) {
    const adres = gekozen.straatnaam || gekozen.titel;
    setVerwijderFout(null);
    setVerwijderBezig(gekozen.id);

    const samen = (drafts ?? []).filter(
      (d) =>
        d.id === gekozen.id ||
        (!!adres && !!d.straatnaam && sameAddress(d.straatnaam, adres))
    );

    try {
      const mislukt: string[] = [];
      for (const d of samen) {
        /*
          Pas weghalen als de server het ook echt gedaan heeft.

          Dit stond op `.catch(() => {})` met de regel er onvoorwaardelijk
          achter weg: een mislukte verwijdering zag er dan uit als een gelukte,
          terwijl het dashboard — dat opnieuw ophaalt — hem gewoon terugkreeg.
        */
        try {
          const res = await fetch(`/api/drafts/${d.id}`, { method: "DELETE" });
          if (!res.ok) {
            const data = await res.json().catch(() => null);
            throw new Error(data?.error ?? `de server gaf ${res.status} terug`);
          }
        } catch (err) {
          mislukt.push(err instanceof Error ? err.message : "onbekende fout");
        }

        /*
          En dan wat er op dit apparaat van klaarstaat: één mislukte upload
          houdt de dashboardregel in zijn eentje overeind, en het bestand komt
          bij het volgende bezoek gewoon weer uit IndexedDB terug.

          Wat al in Dropbox staat blijft staan. Dat zijn de scans zelf, niet de
          administratie eromheen.
        */
        const eigenAdres = d.straatnaam || d.titel;
        if (eigenAdres) {
          await vergeetTakenVoor((t) => taakHoortBij(t, eigenAdres, d.soort)).catch(() => {});
        }
      }

      if (mislukt.length > 0) {
        setVerwijderFout(
          mislukt.length === samen.length
            ? `Verwijderen mislukt: ${mislukt[0]}.`
            : `Niet alles is verwijderd (${mislukt.length} van ${samen.length}): ${mislukt[0]}.`
        );
      }

      // Opnieuw ophalen in plaats van de regel er lokaal uit halen. Wat je
      // hierna ziet is wat er werkelijk nog staat — anders blijft een mislukte
      // verwijdering onzichtbaar tot de volgende keer laden.
      await load();
    } finally {
      setVerwijderBezig(null);
    }
  }

  /*
    Alleen werk dat deze persoon ook kan afmaken.

    Deze pagina toont je eigen concepten, maar "eigen" gaat verder terug dan de
    persoonlijke inlogs: uit de tijd van de gedeelde code staat er werk op
    namen dat niet bij hun huidige rechten past. Een knop "verder afmaken" naar
    een formulier waar je niet mag komen eindigt op de omleiding terug naar het
    dashboard - en dan lijkt het alsof de app niet werkt.
  */
  const magDitAfmaken = (d: DraftRecord) =>
    d.soort === "nen" ? rechten.nen : d.soort === "media" ? rechten.media : rechten.energielabel;

  /*
    Een recht bepaalt wat je mag AFMAKEN, niet wat je mag ZIEN.

    Deze lijst filterde hele opnames weg op rechten. Het dashboard doet dat
    bewust niet — daar staat in UploadPanel: "Het adres zelf mag hij wel zien:
    hij heeft er NEN2580 op gedaan, en dat werk hoort niet te verdwijnen." Hier
    gebeurde het omgekeerde, en dat botste hard: een NEN-opname van iemand
    zonder NEN-recht stond wél op het dashboard en ontbrak hier volledig. Er
    was dus een regel op het dashboard waar nergens in de app een knop bij
    hoorde — niet om af te maken, en niet om weg te halen.

    De oorspronkelijke zorg blijft terecht: een knop "verder afmaken" naar een
    formulier waar je niet mag komen eindigt op de omleiding terug naar het
    dashboard. Die knop is dus wat hier verdwijnt, niet de opname.
  */
  const zichtbaar = drafts;

  const unfinished = zichtbaar?.filter((d) => d.status === "concept") ?? [];
  // Een opname met ontbrekende bijlages is óók nog af te maken werk: de
  // ClickUp-taak bestaat, maar de documenten zijn er niet in gekomen.
  const incomplete = zichtbaar?.filter((d) => d.status === "uploaded" && !!d.incompleteDocs?.length) ?? [];
  const nietsTeDoen = drafts !== null && unfinished.length === 0 && incomplete.length === 0;

  return (
    <>
      {/* Terugknop linksboven, zelfde vorm als op de documentenpagina. Deze
          pagina is een zijstap vanaf het dashboard, en zonder uitweg moest je
          via het menu terug — dat is een omweg voor iets wat één klik hoort te
          zijn. */}
      <header className="topline">
        <a href="/" className="btn-back">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M10 12.5 5.5 8 10 3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Terug naar dashboard
        </a>
        <span className="eyebrow">Af te maken</span>
      </header>

      <div className="pad" style={{ background: "var(--paper)", border: "1px solid var(--rule)", borderRadius: "var(--r)" }}>
        <h1>Nog af te maken</h1>
        <p className="lede">
          Alleen jouw werk dat nog niet klaar is: opnames die halverwege zijn
          blijven staan en taken waar bijlages missen. Wat afgerond is, verdwijnt
          hier vanzelf.
        </p>

        {cijfers && (
          <dl className="cijfers">
            <div>
              <dt>Vandaag afgerond</dt>
              <dd>{cijfers.vandaag}</dd>
            </div>
            <div>
              <dt>Afgelopen week</dt>
              <dd>{cijfers.afgelopenWeek}</dd>
            </div>
            <div>
              <dt>Openstaand</dt>
              <dd>{cijfers.open}</dd>
            </div>
            <div className={cijfers.langOpenstaand > 0 ? "is-warn" : undefined}>
              <dt>Langer dan een week</dt>
              <dd>{cijfers.langOpenstaand}</dd>
            </div>
            <div className={cijfers.bijlagesOntbreken > 0 ? "is-bad" : undefined}>
              <dt>Bijlages ontbreken</dt>
              <dd>{cijfers.bijlagesOntbreken}</dd>
            </div>
          </dl>
        )}

        {loading && !drafts && <p className="note">Concepten laden…</p>}
        {error && <p className="conn-err">{error}</p>}
        {verwijderFout && <p className="conn-err">{verwijderFout}</p>}

        {nietsTeDoen && (
          <p className="note">Niets meer af te maken — al je opnames zijn doorgezet.</p>
        )}

        {unfinished.length > 0 && (
          <div className="section">
            <div className="section-head">
              <h2>Niet afgemaakt</h2>
            </div>
            <div className="draft-list">
              {unfinished.map((d) => (
                <div className="draft-row" key={d.id}>
                  <div className="draft-info">
                    <span className="pill is-bad">Niet afgemaakt</span>
                    <div>
                      <div className="draft-title">
                        {d.straatnaam || d.titel || "Onbekend adres"}
                      </div>
                      <div className="draft-meta">
                        {d.postcode} {d.woonplaats}
                        {d.accountName ? ` · ${d.accountName}` : ""} · {formatDate(d.updatedAt)}
                      </div>
                    </div>
                  </div>
                  <div className="draft-actions">
                    {magDitAfmaken(d) ? (
                      <a className="btn btn-primary" href={opnameLink(d)}>
                        Verder afmaken
                      </a>
                    ) : (
                      <span className="note">
                        Jij mag dit soort opname niet afmaken — vraag of je dat
                        recht erbij krijgt, of haal hem weg.
                      </span>
                    )}
                    <button
                      className="btn-text"
                      onClick={() => verwijderOpname(d)}
                      disabled={verwijderBezig === d.id}
                    >
                      {verwijderBezig === d.id ? "Bezig…" : "Verwijderen"}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {incomplete.length > 0 && (
          <div className="section">
            <div className="section-head">
              <h2>Bijlages ontbreken in ClickUp</h2>
              <span className="section-count">{incomplete.length}</span>
            </div>
            <p className="note">
              Verwijderen haalt de opname hier en van het dashboard weg. De
              ClickUp-taak en de bestanden in Dropbox blijven staan.
            </p>
            <div className="draft-list">
              {incomplete.map((d) => (
                <div className="draft-row" key={d.id}>
                  <div className="draft-info">
                    <span className="pill is-bad">Incompleet</span>
                    <div>
                      <div className="draft-title">{d.straatnaam || d.titel || "Onbekend adres"}</div>
                      <div className="draft-meta">
                        Niet overgezet: {d.incompleteDocs!.join(", ")}
                      </div>
                      <div className="draft-meta">
                        {d.postcode} {d.woonplaats}
                        {d.accountName ? ` · ${d.accountName}` : ""} · {formatDate(d.updatedAt)}
                      </div>
                    </div>
                  </div>
                  <div className="draft-actions">
                    {magDitAfmaken(d) ? (
                      <a className="btn btn-primary" href={opnameLink(d)}>
                        Bijlages opnieuw uploaden
                      </a>
                    ) : (
                      <span className="note">
                        Jij mag dit soort opname niet afmaken — vraag of je dat
                        recht erbij krijgt, of haal hem weg.
                      </span>
                    )}
                    {d.clickupTaskUrl && (
                      <a className="btn btn-quiet" href={d.clickupTaskUrl} target="_blank" rel="noreferrer">
                        Open in ClickUp
                      </a>
                    )}
                    {/* Deze stonden wél op het dashboard maar waren nergens
                        weg te krijgen: deze sectie had geen verwijderknop. Dat
                        is precies het geval waarin je klikt op wat je wél kunt
                        vinden en de regel toch blijft staan. */}
                    <button
                      className="btn-text"
                      onClick={() => verwijderOpname(d)}
                      disabled={verwijderBezig === d.id}
                    >
                      {verwijderBezig === d.id ? "Bezig…" : "Verwijderen"}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <button className="btn-refresh" onClick={refresh} disabled={refreshing} style={{ marginTop: 20 }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true" className={refreshing ? "spin" : undefined}>
            <path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {refreshing ? "Bezig met verversen…" : "Lijst verversen"}
        </button>
      </div>
    </>
  );
}
