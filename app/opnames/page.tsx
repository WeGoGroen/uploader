"use client";

import { useCallback, useEffect, useState } from "react";
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
>;

interface SyncState {
  busy: boolean;
  message: string | null;
  failed: boolean;
}

/**
 * Handmatig de finale bestanden uit SharePoint halen. Normaal doet de
 * ClickUp-webhook dit vanzelf zodra de taak op klaar gaat; deze knop is voor
 * opnames van vóór die koppeling, of als de uitbestede partij achteraf nog
 * een bestand toevoegt.
 */
function SharePointButton({ addressLine, woonplaats }: { addressLine: string; woonplaats: string }) {
  const [state, setState] = useState<SyncState>({ busy: false, message: null, failed: false });

  async function run() {
    setState({ busy: true, message: null, failed: false });
    try {
      const res = await fetch("/api/sharepoint/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ addressLine, woonplaats }),
      });
      const data = await res.json();
      if (!res.ok) {
        setState({
          busy: false,
          failed: true,
          message:
            data?.detail ??
            (data?.error === "niets_gevonden"
              ? "Niets gevonden in SharePoint voor dit adres."
              : "Ophalen is mislukt."),
        });
        return;
      }
      const copied = (data.copied as string[]).length;
      const skipped = (data.skipped as string[]).length;
      const pending = ((data.pending as string[] | undefined) ?? []).length;
      setState({
        busy: false,
        failed: false,
        message:
          pending > 0
            ? `${copied} in Dropbox gezet, ${pending} nog onderweg — de map blijft oranje.`
            : copied === 0 && skipped > 0
              ? "Stond er al — niets nieuws opgehaald."
              : `${copied} bestand${copied === 1 ? "" : "en"} in Dropbox gezet.`,
      });
    } catch {
      setState({ busy: false, failed: true, message: "Ophalen is mislukt." });
    }
  }

  return (
    <>
      <button className="btn btn-quiet" onClick={run} disabled={state.busy}>
        {state.busy ? "Bezig met ophalen…" : "Finale bestanden ophalen"}
      </button>
      {state.message && (
        <span className={state.failed ? "conn-err" : "draft-meta"} style={{ marginLeft: 8 }}>
          {state.message}
        </span>
      )}
    </>
  );
}

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

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/drafts", { cache: "no-store" });
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
    await fetch(`/api/drafts/${id}`, { method: "DELETE" }).catch(() => {});
    setDrafts((prev) => prev?.filter((d) => d.id !== id) ?? null);
  }

  const unfinished = drafts?.filter((d) => d.status === "concept") ?? [];
  // Een opname met ontbrekende bijlages hoort niet tussen de afgeronde: de
  // ClickUp-taak bestaat, maar de documenten zijn er niet in gekomen.
  const uploaded = drafts?.filter((d) => d.status === "uploaded" && !d.incompleteDocs?.length) ?? [];
  const incomplete = drafts?.filter((d) => d.status === "uploaded" && !!d.incompleteDocs?.length) ?? [];

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
        <span className="eyebrow">Recente opnames</span>
      </header>

      <div className="pad" style={{ background: "var(--paper)", border: "1px solid var(--rule)", borderRadius: "var(--r)" }}>
        <h1>Recente opnames</h1>
        <p className="lede">
          Opnames die je op dit apparaat bent begonnen — afgerond en geüpload naar
          ClickUp, of nog niet afgemaakt.
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

        {drafts && drafts.length === 0 && (
          <p className="note">Nog geen opnames gestart via de app.</p>
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
                    <a className="btn btn-primary" href={`/energielabel?draft=${d.id}`}>
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
                    <a className="btn btn-primary" href={`/energielabel?draft=${d.id}`}>
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

        {uploaded.length > 0 && (
          <div className="section">
            <div className="section-head">
              <h2>Geüpload naar ClickUp</h2>
            </div>
            <div className="draft-list">
              {uploaded.map((d) => (
                <div className="draft-row" key={d.id}>
                  <div className="draft-info">
                    <span className="pill is-ok">Geüpload</span>
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
                    {d.clickupTaskUrl && (
                      <a className="btn btn-quiet" href={d.clickupTaskUrl} target="_blank" rel="noreferrer">
                        Open in ClickUp
                      </a>
                    )}
                    {d.straatnaam && d.woonplaats && (
                      <SharePointButton addressLine={d.straatnaam} woonplaats={d.woonplaats} />
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
