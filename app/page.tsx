"use client";

import { useCallback, useEffect, useState } from "react";
import { detectServices, extractGrossFloorArea, extractKlant } from "@/lib/calendar-services";
import { calendarLocationToBagQuery, sameAddress, splitAddress } from "@/lib/address-format";
import { checkBagAddress, type BagCheckResult } from "@/lib/bag-check";
import type { DraftRecord as ServerDraftRecord } from "@/lib/drafts";
import UploadPanel from "@/components/UploadPanel";
import ScanStatusKaart from "@/components/ScanStatus";

interface MediataskOrderSummary {
  address?: string;
}

interface CalendarEvent {
  id: string;
  summary: string;
  description: string | null;
  location: string | null;
  start: string | null;
  end: string | null;
}

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
  | "heeftMediatask"
>;

function formatTime(iso: string | null): string {
  if (!iso || iso.length === 10) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" });
}

function StatusPill({ label, tone }: { label: string; tone: "ok" | "busy" | "off" }) {
  if (tone === "ok") {
    return <span className="pill is-ok">{label}</span>;
  }
  const cls = tone === "busy" ? "is-busy" : "is-off";
  return (
    <span className="pill" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span className={`dot ${cls}`} />
      {label}
    </span>
  );
}

export default function Dashboard() {
  // Alles toestaan tot het antwoord binnen is: anders knipperen de knoppen
  // weg en weer terug bij elke paginaopening.
  const [rechten, setRechten] = useState({ energielabel: true, nen: true, media: true });

  useEffect(() => {
    fetch("/api/rechten", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { rechten?: { energielabel: boolean; nen: boolean; media: boolean } }) => {
        if (d.rechten) setRechten(d.rechten);
      })
      .catch(() => {});
  }, []);

  const [events, setEvents] = useState<CalendarEvent[] | null>(null);
  const [calendarError, setCalendarError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<DraftRecord[] | null>(null);
  const [mediataskOrders, setMediataskOrders] = useState<MediataskOrderSummary[]>([]);
  const [clickupTaskNames, setClickupTaskNames] = useState<string[]>([]);
  // Wie er op dit apparaat actief is: het af-te-maken-paneel toont alleen
  // diens werk. De rest van het dashboard blijft over iedereen gaan.
  const [actieveGebruiker, setActieveGebruiker] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // Per opgeschoonde adrestekst: de BAG-uitslag, inclusief gelijkende
  // adressen als het adres zelf niet bestaat. Gekeyd op de adrestekst (niet
  // het event-id), zodat een in de agenda gecorrigeerd adres meteen een
  // verse controle krijgt.
  const [bagInfo, setBagInfo] = useState<Record<string, BagCheckResult>>({});
  // Handmatig gekozen alternatief per afspraak — de actieknoppen gaan dan
  // met dát adres verder i.p.v. met het niet-bestaande agenda-adres.
  const [chosenAddress, setChosenAddress] = useState<Record<string, string>>({});
  // Uitslag van de ochtendcontrole. Alleen tonen als er iets mis is — een
  // groen vinkje elke dag wordt toch weggekeken.
  const [gezondheid, setGezondheid] = useState<{
    tijdstip: string;
    controles: { naam: string; ok: boolean; niveau?: string; detail: string }[];
  } | null>(null);

  const load = useCallback(async () => {
    setCalendarError(null);
    const [evts, drafts, orders, taskNames, actief] = await Promise.all([
      fetch("/api/calendar/today", { cache: "no-store" })
        .then(async (res) => {
          if (!res.ok) {
            const data = await res.json().catch(() => null);
            setCalendarError(data?.error ?? "Google Agenda is niet gekoppeld.");
            return [] as CalendarEvent[];
          }
          const data = await res.json();
          return (data.events ?? []) as CalendarEvent[];
        })
        .catch(() => {
          setCalendarError("Google Agenda kon niet worden opgehaald.");
          return [] as CalendarEvent[];
        }),
      fetch("/api/drafts", { cache: "no-store" })
        .then((res) => (res.ok ? res.json() : { drafts: [] }))
        .then((data) => (data.drafts ?? []) as DraftRecord[])
        .catch(() => [] as DraftRecord[]),
      fetch("/api/mediatask/orders", { cache: "no-store" })
        .then((res) => (res.ok ? res.json() : { orders: [] }))
        .then((data) => (data.orders ?? []) as MediataskOrderSummary[])
        .catch(() => [] as MediataskOrderSummary[]),
      fetch("/api/clickup/tasks", { cache: "no-store" })
        .then((res) => (res.ok ? res.json() : { names: [] }))
        .then((data) => (data.names ?? []) as string[])
        .catch(() => [] as string[]),
      fetch("/api/clickup/accounts", { cache: "no-store" })
        .then((res) => (res.ok ? res.json() : { active: null }))
        .then((data) => (data.active ?? null) as string | null)
        .catch(() => null),
    ]);
    setEvents(evts);
    setDrafts(drafts);
    setMediataskOrders(orders);
    setClickupTaskNames(taskNames);
    setActieveGebruiker(actief);
  }, []);

  useEffect(() => {
    load().finally(() => setLoading(false));
  }, [load]);

  useEffect(() => {
    fetch("/api/health/laatste", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        // Ook tonen bij aandachtspunten (bv. een afspraak zonder adres) —
        // dat is precies wat je 's ochtends nog wilt rechtzetten.
        if (d && (d.allesGoed === false || d.controles?.some((c: { niveau?: string }) => c.niveau === "let op")))
          setGezondheid(d);
      })
      .catch(() => {});
  }, []);

  // Controleer per afspraak of het adres in de BAG bestaat — een typefout of
  // niet-bestaand adres valt zo meteen op in de lijst, i.p.v. pas nadat
  // "starten" stilletjes niets oplevert. De ruwe agenda-locatie gaat eerst
  // door calendarLocationToBagQuery: PDOK eist dat élke term matcht, dus het
  // ", Nederland"-achtervoegsel van Google Maps (of een locatienaam vóór het
  // adres) zou anders op elk geldig adres vals alarm geven. Bestaat het adres
  // niet, dan zoekt checkBagAddress meteen zelf naar gelijkende adressen.
  useEffect(() => {
    const evts = (events ?? []).filter((e) => e.location?.trim());
    if (!evts.length) return;
    const queries = [...new Set(evts.map((e) => calendarLocationToBagQuery(e.location!.trim())))];
    let cancelled = false;
    void Promise.all(queries.map(async (q) => [q, await checkBagAddress(q)] as const)).then((entries) => {
      if (!cancelled) setBagInfo((prev) => ({ ...prev, ...Object.fromEntries(entries) }));
    });
    return () => {
      cancelled = true;
    };
  }, [events]);

  async function refresh() {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }

  const withAddress = (events ?? []).filter((e) => e.location?.trim());

  // Er kunnen meerdere concept-records voor hetzelfde adres bestaan (bv. een
  // opnieuw gestarte zoekopdracht) — als ÉÉN daarvan al geüpload is, telt
  // dat, ook als een ander (later aangeraakt) concept nog openstaat. Zonder
  // deze voorkeur kan een verlopen concept de echte upload-status verbergen.
  function findDraft(street: string): DraftRecord | null {
    const matches = (drafts ?? []).filter((d) => sameAddress(d.straatnaam, street));
    if (!matches.length) return null;
    return (
      matches.find((d) => d.status === "uploaded" || !!d.clickupTaskUrl) ??
      matches.find((d) => !!d.heeftMediatask) ??
      matches[0]
    );
  }

  // Real-time bij Mediatask zelf checken (niet alleen onze eigen concept-
  // administratie, die kan achterlopen) of er al een NEN2580-order bestaat.
  function hasMediataskOrder(street: string): boolean {
    return mediataskOrders.some((o) => !!o.address && sameAddress(o.address, street));
  }

  // Real-time bij ClickUp zelf checken (niet alleen onze eigen concept-
  // administratie, die kan achterlopen) of er al een energielabel-taak bestaat.
  function hasClickUpTask(street: string): boolean {
    return clickupTaskNames.some((name) => sameAddress(name, street));
  }

  // De ochtendcontrole staat in een eigen kolom. Als banner bovenin de
  // afsprakenkaart duwde hij de afspraken naar beneden en werd hij bij een
  // lange lijst juist weggekeken — terwijl het gaat om dingen die je vóór
  // vertrek wilt weten.
  const aandachtspunten = gezondheid
    ? (() => {
        const storingen = gezondheid.controles.filter((c) => !c.ok);
        const aandacht = gezondheid.controles.filter((c) => c.ok && c.niveau === "let op");
        const alles = [...storingen, ...aandacht];
        return (
          <div className={`dash-card${storingen.length > 0 ? " is-bad" : " is-warn"}`}>
            <div className="dash-card-head">
              <h2>{storingen.length > 0 ? "Storing" : "Aandachtspunten"}</h2>
              <span className="section-count">{alles.length}</span>
            </div>
            <ul className="sig-list">
              {alles.map((c) => (
                <li key={c.naam} className={c.ok ? "is-warn" : "is-bad"}>
                  <span className="sig-icon" aria-hidden="true">
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
                  <span className="sig-text">
                    <strong>{c.naam}</strong>
                    <span>{c.detail}</span>
                  </span>
                </li>
              ))}
            </ul>
            <p className="sig-time">
              Gecontroleerd op {new Date(gezondheid.tijdstip).toLocaleString("nl-NL")}
            </p>
          </div>
        );
      })()
    : null;

  return (
    <>
      <header className="topline">
        <span className="eyebrow">Dashboard</span>
      </header>

      <div className="dash-grid">
        <div>
          <UploadPanel drafts={drafts} actieveGebruiker={actieveGebruiker} />
          {/* Verwerking bij Mediatask hoort naast het openstaande werk: het is
              werk dat loopt, alleen niet bij ons. */}
          <ScanStatusKaart />
        </div>

        <div className="dash-agenda">
        <div className="pad" style={{ background: "var(--paper)", border: "1px solid var(--rule)", borderRadius: "var(--r)" }}>
        {!loading && (
          <button className="btn-refresh" onClick={refresh} disabled={refreshing} style={{ marginBottom: 4 }}>
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden="true"
              className={refreshing ? "spin" : undefined}
            >
              <path
                d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            {refreshing ? "Bezig met verversen…" : "Afspraken verversen"}
          </button>
        )}

        {loading && <p className="note">Laden…</p>}

        {!loading && calendarError && (
          <p className="note" style={{ padding: 0 }}>
            ⚠ {calendarError}{" "}
            <a href="/instellingen" style={{ color: "var(--accent-text)" }}>
              Naar Koppelingen
            </a>
          </p>
        )}

        {!loading && !calendarError && withAddress.length === 0 && (
          <p className="note" style={{ padding: 0 }}>Geen afspraken met een adres gevonden voor vandaag.</p>
        )}

        {!loading && withAddress.length > 0 && (
          <div className="section">
            <div className="section-head">
              <h2>Afspraken vandaag</h2>
              <span className="section-count">{withAddress.length}</span>
            </div>
            <div className="draft-list">
              {withAddress.map((e) => {
                const { street, cityLine } = splitAddress(e.location!.trim());
                // Dezelfde opgeschoonde tekst als de BAG-check én als wat de
                // startknoppen doorgeven — zo voorspelt de waarschuwing
                // precies wat er bij klikken gebeurt. Is er een alternatief
                // gekozen, dan gaan de knoppen daarmee verder. De keuze hangt
                // aan de adrestekst (niet aan het event-id): wordt het adres
                // in de agenda gecorrigeerd, dan vervalt de oude keuze vanzelf.
                const rawQuery = calendarLocationToBagQuery(e.location!.trim());
                const bag = bagInfo[rawQuery];
                const picked = chosenAddress[rawQuery];
                const bagQuery = picked ?? rawQuery;
                const bagMissing = !picked && bag?.ok === false;
                // Status (concept/geüpload) hoort bij het adres waarmee we
                // straks verdergaan — anders blijft de app naar het
                // niet-bestaande agenda-adres kijken.
                const statusStreet = picked ? splitAddress(picked).street : street;
                const draft = findDraft(statusStreet);
                // Bijlages die niet in ClickUp zijn beland maken de opname
                // onafgerond, óók al bestaat de taak. Anders staat er een
                // groen vinkje op werk dat nog gedaan moet worden.
                const incompleteDocs = draft?.incompleteDocs ?? [];
                const energielabelDone =
                  incompleteDocs.length === 0 &&
                  (hasClickUpTask(statusStreet) || draft?.status === "uploaded" || !!draft?.clickupTaskUrl);
                const energielabelStarted = !!draft;
                const nenDone = hasMediataskOrder(statusStreet) || !!draft?.heeftMediatask;
                const time = formatTime(e.start);
                const gedetecteerd = detectServices(e.summary, e.description);
                // De agenda zegt wat er op dit adres moet gebeuren; de rechten
                // zeggen wat deze opnemer mag. Een knop tonen die achter een
                // omleiding eindigt is erger dan geen knop.
                const services = {
                  ...gedetecteerd,
                  energielabel: gedetecteerd.energielabel && rechten.energielabel,
                  nen: gedetecteerd.nen && rechten.nen,
                };
                const klant = extractKlant(e.description);
                const grossFloorArea = extractGrossFloorArea(e.description);

                return (
                  <div className="draft-row" key={e.id} style={{ flexWrap: "wrap", alignItems: "flex-start" }}>
                    <div className="draft-info" style={{ alignItems: "flex-start", gap: 12 }}>
                      {time && (
                        <span className="today-appt-time" style={{ marginTop: 2 }}>
                          {time}
                        </span>
                      )}
                      <div>
                        <div className="draft-title">{street}</div>
                        {cityLine && <div className="draft-meta">{cityLine}</div>}
                        <div className="today-appt-services" style={{ marginTop: 6 }}>
                          {bagMissing && (
                            <span className="today-appt-service-tag is-warning">⚠ Niet in BAG</span>
                          )}
                          {picked && (
                            <button
                              type="button"
                              className="today-appt-service-tag is-picked"
                              title="Andere keuze maken"
                              onClick={() =>
                                setChosenAddress((p) => {
                                  const next = { ...p };
                                  delete next[rawQuery];
                                  return next;
                                })
                              }
                            >
                              ✓ {picked} ✕
                            </button>
                          )}
                          {klant && <span className="today-appt-service-tag is-makelaar">{klant}</span>}
                          {services.energielabel && <span className="today-appt-service-tag">Energielabel</span>}
                          {services.nen && <span className="today-appt-service-tag is-nen">NEN2580</span>}
                        </div>

                        {/* Adres bestaat niet in de BAG: meteen de gevonden
                            gelijkende adressen aanbieden — één tik zet het
                            juiste adres klaar voor de knoppen hiernaast. */}
                        {bagMissing && (
                          <div className="today-appt-fix">
                            {bag!.similar.length > 0 ? (
                              <>
                                <span className="today-appt-fix-label">Bedoelde je?</span>
                                {bag!.similar.map((label) => (
                                  <button
                                    key={label}
                                    type="button"
                                    className="today-appt-fix-btn"
                                    onClick={() => setChosenAddress((p) => ({ ...p, [rawQuery]: label }))}
                                  >
                                    {label}
                                  </button>
                                ))}
                              </>
                            ) : (
                              <span className="today-appt-fix-label">
                                Geen gelijkend adres gevonden — zoek het adres via de opnamepagina.
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="draft-actions" style={{ gap: 10, flexWrap: "wrap" }}>
                      {services.energielabel &&
                        (energielabelDone ? (
                          <StatusPill label="Energielabel geüpload" tone="ok" />
                        ) : incompleteDocs.length > 0 ? (
                          <a
                            href={`/energielabel?draft=${draft!.id}`}
                            className="today-appt-service-tag is-warning"
                            title={`Niet in ClickUp gekomen: ${incompleteDocs.join(", ")}`}
                          >
                            ⚠ Bijlages ontbreken ({incompleteDocs.length}) — afmaken
                          </a>
                        ) : energielabelStarted ? (
                          <StatusPill label="Energielabel: concept" tone="busy" />
                        ) : (
                          <a href={`/energielabel?addr=${encodeURIComponent(bagQuery)}`} className="btn btn-quiet">
                            Energielabel starten
                          </a>
                        ))}
                      {services.nen &&
                        (nenDone ? (
                          <StatusPill label="NEN2580 geüpload" tone="ok" />
                        ) : (
                          <a
                            href={`/nen?addr=${encodeURIComponent(bagQuery)}${klant ? `&klant=${encodeURIComponent(klant)}` : ""}${grossFloorArea ? `&m2=${grossFloorArea}` : ""}`}
                            className="btn btn-quiet"
                          >
                            NEN2580 uploaden
                          </a>
                        ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
        </div>
        </div>

      </div>

      {/* Onderaan en pagina-breed: het is naslag bij de dag, geen alarm dat
          bovenaan de afspraken hoort te staan. */}
      {aandachtspunten && (
        <section className="dash-signals" aria-label="Aandachtspunten">
          {aandachtspunten}
        </section>
      )}
    </>
  );
}
