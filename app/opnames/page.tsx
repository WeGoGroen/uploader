"use client";

import { useCallback, useEffect, useState } from "react";
import { useRechten } from "@/components/RechtenProvider";
import { opnameLink } from "@/lib/opname-link";
import { vergeetTakenVoor } from "@/lib/upload-queue";
import { taakHoortBij } from "@/lib/upload-overview";
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

  async function removeDraft(id: string) {
    const draft = drafts?.find((d) => d.id === id);
    setVerwijderFout(null);

    /*
      Eerst de server, en pas uit de lijst halen als dat ook echt gelukt is.

      Dit stond op `.catch(() => {})` met de verwijdering er onvoorwaardelijk
      achter: een mislukte verwijdering zag er hier dus uit als een gelukte,
      terwijl de opname op het dashboard gewoon bleef staan — dat haalt zijn
      concepten opnieuw op en kreeg hem dan nog steeds terug.
    */
    try {
      const res = await fetch(`/api/drafts/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? `De server gaf ${res.status} terug.`);
      }
    } catch (err) {
      setVerwijderFout(
        err instanceof Error ? err.message : "Kon de opname niet verwijderen."
      );
      return;
    }

    setDrafts((prev) => prev?.filter((d) => d.id !== id) ?? null);

    /*
      En dan wat er op dit apparaat van klaarstaat.

      Het dashboard bouwt zijn lijst uit twee bronnen: de concepten van de
      server én de uploadwachtrij hier in de browser. Eén mislukte upload
      houdt zo'n regel in zijn eentje overeind. Zonder deze stap verdween de
      opname hier wel en bleef hij daar staan — precies de klacht.

      Wat al in Dropbox staat blijft staan: dat zijn de scans zelf, niet de
      administratie eromheen, en die weggooien is een ander besluit dan dit.
    */
    const adres = draft?.straatnaam || draft?.titel;
    if (!adres) return;
    try {
      await vergeetTakenVoor((t) => taakHoortBij(t, adres, draft?.soort));
    } catch {
      // De opname zelf is wél weg; alleen het opruimen hier is misgegaan. Dat
      // is precies het geval waarin hij op het dashboard blijft staan, dus dat
      // hoort de gebruiker te weten in plaats van het straks zelf te ontdekken.
      setVerwijderFout(
        "De opname is verwijderd, maar de bestanden die op dit apparaat klaarstonden " +
          "konden niet worden opgeruimd. Daardoor kan hij op het dashboard blijven staan."
      );
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
  const zichtbaar = drafts?.filter(magDitAfmaken) ?? null;

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
                    <a className="btn btn-primary" href={opnameLink(d)}>
                      Verder afmaken
                    </a>
                    <button className="btn-text" onClick={() => removeDraft(d.id)}>
                      Verwijderen
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
                    <a className="btn btn-primary" href={opnameLink(d)}>
                      Bijlages opnieuw uploaden
                    </a>
                    {d.clickupTaskUrl && (
                      <a className="btn btn-quiet" href={d.clickupTaskUrl} target="_blank" rel="noreferrer">
                        Open in ClickUp
                      </a>
                    )}
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
