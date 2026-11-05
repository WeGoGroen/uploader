"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { detectServices, extractGrossFloorArea, extractKlant } from "@/lib/calendar-services";
import { adresSleutel, calendarLocationToBagQuery, sameAddress, splitAddress } from "@/lib/address-format";
import { checkBagAddress, type BagCheckResult } from "@/lib/bag-check";
import type { DraftRecord as ServerDraftRecord } from "@/lib/drafts";
import UploadPanel from "@/components/UploadPanel";
import { useRechten } from "@/components/RechtenProvider";
import ScanStatusKaart from "@/components/ScanStatus";
import MeerMenu from "@/components/MeerMenu";
import { useTaal } from "@/components/TaalProvider";
import { taalLocale, type Taal, type TaalSleutel } from "@/lib/taal";
import {
  energielabelStatus,
  isRecent,
  nenStatus,
  recenteClickUpTaak,
  recenteMediataskOrder,
  type ClickUpTaakSamenvatting,
  type DienstStatus,
  type MediataskOrderSamenvatting,
} from "@/lib/afspraak-status";

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

type KlaarMeldingen = Record<"energielabel" | "nen", Set<string>>;
/** Een foutmelding van de server (as-is) of een eigen melding als sleutel, zodat die meevertaalt. */
type AgendaFout = { tekst: string } | { sleutel: TaalSleutel };
const GEEN_MELDINGEN: KlaarMeldingen = { energielabel: new Set(), nen: new Set() };

/**
 * De uploadpagina's sturen wie er geen recht op heeft hierheen met
 * ?geenrecht=<soort> (zie app/<soort>/layout.tsx). Dat label hoort er ook
 * uit te komen: zonder melding is dat een stille sprong terug naar het
 * dashboard, en met de knop óók al weg uit de zijbalk is het enige wat je
 * ziet dat de pagina "niet laadt".
 */
const GEENRECHT_LABELS: Record<string, string> = {
  energielabel: "Energielabel",
  nen: "NEN2580",
  media: "Media",
};

/** Apart component omdat useSearchParams() een Suspense-grens nodig heeft. */
function GeenRechtMelding() {
  const { t } = useTaal();
  const soort = useSearchParams().get("geenrecht");
  if (!soort) return null;
  return (
    <p className="banner is-bad" style={{ marginBottom: 18 }}>
      <span>{t("dashboard.geenRecht", { soort: GEENRECHT_LABELS[soort] ?? soort })}</span>
    </p>
  );
}

function formatTime(iso: string | null, taal: Taal): string {
  if (!iso || iso.length === 10) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(taalLocale(taal), { hour: "2-digit", minute: "2-digit" });
}

/**
 * Een statuspil, met een weg terug als die er is.
 *
 * "Geüpload" was hiervóór een doodlopend eind: zodra er een order bestond
 * verdween de knop en stond er alleen nog een mededeling. Wie halverwege
 * wegklikte kwam daardoor niet meer bij zijn eigen upload - en dat is precies
 * het moment waarop je er terug wilt. Klaar betekent niet dat je er nooit meer
 * heen hoeft, dus de pil is nu zelf de link.
 */
function StatusPill({
  label,
  tone,
  href,
  bron,
  title,
}: {
  label: string;
  tone: "ok" | "busy" | "off" | "elders" | "handmatig";
  href?: string;
  /** Waar de status vandaan komt, klein achter het label ("buiten uploader"). */
  bron?: string;
  title?: string;
}) {
  const { t } = useTaal();
  const metDot = tone === "busy" || tone === "off";
  const cls = tone === "busy" ? "is-busy" : "is-off";
  const inhoud = metDot ? (
    <>
      <span className={`dot ${cls}`} />
      {label}
    </>
  ) : (
    <>
      {label}
      {bron && <span className="pill-bron">· {bron}</span>}
    </>
  );
  const klasse =
    tone === "ok" ? "pill is-ok" : tone === "elders" ? "pill is-elders" : tone === "handmatig" ? "pill is-handmatig" : "pill";
  const stijl = metDot ? { display: "inline-flex", alignItems: "center", gap: 6 } : undefined;

  if (!href) {
    return (
      <span className={klasse} style={stijl} title={title}>
        {inhoud}
      </span>
    );
  }
  return (
    <a
      href={href}
      className={klasse}
      style={{ ...(stijl ?? {}), textDecoration: "none" }}
      title={title ?? t("dashboard.pilOpenen")}
    >
      {inhoud}
    </a>
  );
}

export default function Dashboard() {
  const { t, taal } = useTaal();
  // Alles toestaan tot het antwoord binnen is: anders knipperen de knoppen
  // weg en weer terug bij elke paginaopening.
  // Komt server-side mee (zie de layout): er is dus geen moment waarop het
  // scherm nog niet weet wat je mag en voor de zekerheid alles toont.
  const rechten = useRechten();

  const [events, setEvents] = useState<CalendarEvent[] | null>(null);
  const [calendarError, setCalendarError] = useState<AgendaFout | null>(null);
  const [drafts, setDrafts] = useState<DraftRecord[] | null>(null);
  const [mediataskOrders, setMediataskOrders] = useState<MediataskOrderSamenvatting[]>([]);
  const [clickupTaken, setClickupTaken] = useState<ClickUpTaakSamenvatting[]>([]);
  // Handmatige "toch al gedaan"-bevestigingen — het vangnet voor als de
  // automatische matching een echt afgeronde opname mist (net iets andere
  // adresschrijfwijze bij het starten). Zie lib/klaar-meldingen.ts.
  const [klaarMeldingen, setKlaarMeldingen] = useState<KlaarMeldingen>(GEEN_MELDINGEN);
  const [meldBezig, setMeldBezig] = useState<string | null>(null);
  // Wie er op dit apparaat actief is: het af-te-maken-paneel toont alleen
  // diens werk. De rest van het dashboard blijft over iedereen gaan.
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

  const load = useCallback(async () => {
    setCalendarError(null);
    const [evts, drafts, orders, taken, klaarGemeld] = await Promise.all([
      fetch("/api/calendar/today", { cache: "no-store" })
        .then(async (res) => {
          if (!res.ok) {
            const data = await res.json().catch(() => null);
            setCalendarError(
              data?.error != null ? { tekst: data.error } : { sleutel: "dashboard.agendaNietGekoppeld" }
            );
            return [] as CalendarEvent[];
          }
          const data = await res.json();
          return (data.events ?? []) as CalendarEvent[];
        })
        .catch(() => {
          setCalendarError({ sleutel: "dashboard.agendaOphalenMislukt" });
          return [] as CalendarEvent[];
        }),
      fetch("/api/drafts", { cache: "no-store" })
        .then((res) => (res.ok ? res.json() : { drafts: [] }))
        .then((data) => (data.drafts ?? []) as DraftRecord[])
        .catch(() => [] as DraftRecord[]),
      fetch("/api/mediatask/orders", { cache: "no-store" })
        .then((res) => (res.ok ? res.json() : { orders: [] }))
        .then((data) => (data.orders ?? []) as MediataskOrderSamenvatting[])
        .catch(() => [] as MediataskOrderSamenvatting[]),
      fetch("/api/clickup/tasks", { cache: "no-store" })
        .then((res) => (res.ok ? res.json() : { tasks: [] }))
        .then((data) => (data.tasks ?? []) as ClickUpTaakSamenvatting[])
        .catch(() => [] as ClickUpTaakSamenvatting[]),
      fetch("/api/klaar-melden", { cache: "no-store" })
        .then((res) => (res.ok ? res.json() : {}))
        .then(
          (data: { energielabel?: string[]; nen?: string[]; straten?: string[] }): KlaarMeldingen => ({
            energielabel: new Set(data.energielabel ?? data.straten ?? []),
            nen: new Set(data.nen ?? []),
          })
        )
        .catch(() => GEEN_MELDINGEN),
    ]);
    setEvents(evts);
    setDrafts(drafts);
    setMediataskOrders(orders);
    setClickupTaken(taken);
    setKlaarMeldingen(klaarGemeld);
  }, []);

  async function zetKlaar(street: string, dienst: "energielabel" | "nen", klaar: boolean) {
    setMeldBezig(street);
    try {
      await fetch("/api/klaar-melden", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ street, dienst, klaar }),
      });
      await load();
    } finally {
      setMeldBezig(null);
    }
  }

  useEffect(() => {
    load().finally(() => setLoading(false));
  }, [load]);


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
  //
  // Alleen recente concepten: een opname van vorig jaar op hetzelfde adres
  // zegt niets over de afspraak van vandaag (zie lib/afspraak-status.ts).
  function findDraft(street: string): DraftRecord | null {
    const matches = (drafts ?? []).filter((d) => isRecent(d.updatedAt) && sameAddress(d.straatnaam, street));
    if (!matches.length) return null;
    return (
      matches.find((d) => d.status === "uploaded" || !!d.clickupTaskUrl) ??
      matches.find((d) => !!d.heeftMediatask) ??
      matches[0]
    );
  }

  // Vangnet, zie lib/klaar-meldingen.ts: een expliciete "ik heb dit echt
  // gedaan"-bevestiging telt net zo goed mee als een automatische match.
  function isHandmatigKlaarGemeld(street: string, dienst: "energielabel" | "nen"): boolean {
    return klaarMeldingen[dienst].has(adresSleutel(splitAddress(street).street));
  }

  return (
    <>
      <header className="topline">
        <span className="eyebrow">{t("dashboard.titel")}</span>
      </header>

      <Suspense fallback={null}>
        <GeenRechtMelding />
      </Suspense>

      <div className="dash-grid">
        <div>
          <UploadPanel drafts={drafts} />
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
            {refreshing ? t("dashboard.verversenBezig") : t("dashboard.verversen")}
          </button>
        )}

        {loading && <p className="note">{t("dashboard.laden")}</p>}

        {!loading && calendarError && (
          <p className="note" style={{ padding: 0 }}>
            ⚠ {"tekst" in calendarError ? calendarError.tekst : t(calendarError.sleutel)}{" "}
            <a href="/instellingen" style={{ color: "var(--accent-text)" }}>
              {t("dashboard.naarInstellingen")}
            </a>
          </p>
        )}

        {!loading && !calendarError && withAddress.length === 0 && (
          <p className="note" style={{ padding: 0 }}>{t("dashboard.geenAfspraken")}</p>
        )}

        {!loading && withAddress.length > 0 && (
          <div className="section">
            <div className="section-head">
              <h2>{t("dashboard.afsprakenVandaag")}</h2>
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
                // Real-time bij ClickUp en Mediatask zelf gecheckt (onze eigen
                // concept-administratie kan achterlopen), maar alleen recent
                // werk telt — en per dienst: via de uploader, elders gemaakt,
                // nog niet af, of met de hand gemarkeerd.
                const elHandmatig = isHandmatigKlaarGemeld(statusStreet, "energielabel");
                const nenHandmatig = isHandmatigKlaarGemeld(statusStreet, "nen");
                const elStatus: DienstStatus = energielabelStatus({
                  taak: recenteClickUpTaak(clickupTaken, statusStreet),
                  conceptGeupload: draft?.status === "uploaded" || !!draft?.clickupTaskUrl,
                  bijlagesOntbreken: incompleteDocs.length > 0,
                  handmatig: elHandmatig,
                });
                const nenOrder = recenteMediataskOrder(mediataskOrders, statusStreet);
                const nStatus: DienstStatus = nenStatus({
                  order: nenOrder,
                  conceptMetOrder: !!draft?.heeftMediatask,
                  handmatig: nenHandmatig,
                });
                const energielabelDone = elStatus !== null && elStatus !== "onaf";
                const energielabelStarted = !!draft;
                const nenDone = nStatus !== null && nStatus !== "onaf";
                const time = formatTime(e.start, taal);
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
                // Is al het gedetecteerde werk voor dit adres al klaar, dan
                // helpt een BAG-waarschuwing niemand meer — er valt niets
                // meer te starten. Zonder deze check bleef "Bedoelde je?"
                // voor altijd staan bij een al afgeronde opname (de keuze
                // leeft alleen in React-state en is weg na een ververs of
                // herlaad), terwijl de groene pil er al naast stond.
                const bagBlocking =
                  bagMissing && (!services.energielabel || !energielabelDone) && (!services.nen || !nenDone);

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
                          {bagBlocking && (
                            <span className="today-appt-service-tag is-warning">{t("dashboard.nietInBag")}</span>
                          )}
                          {picked && (
                            <button
                              type="button"
                              className="today-appt-service-tag is-picked"
                              title={t("dashboard.andereKeuze")}
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
                        {bagBlocking && (
                          <div className="today-appt-fix">
                            {bag!.similar.length > 0 ? (
                              <>
                                <span className="today-appt-fix-label">{t("dashboard.bedoeldeJe")}</span>
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
                                {t("dashboard.geenGelijkendAdresZoek")}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="draft-actions today-appt-actions">
                      {services.energielabel &&
                        (() => {
                          const elUrl = draft
                            ? `/energielabel?draft=${draft.id}`
                            : `/energielabel?addr=${encodeURIComponent(bagQuery)}`;
                          if (elStatus === "geupload")
                            return <StatusPill label={t("dashboard.energielabelGeupload")} tone="ok" href={elUrl} />;
                          if (elStatus === "elders")
                            return (
                              <StatusPill
                                label={t("dashboard.inClickUp")}
                                bron={t("dashboard.buitenUploader")}
                                tone="elders"
                                title={t("dashboard.inClickUpUitleg")}
                              />
                            );
                          if (elStatus === "handmatig")
                            return <StatusPill label={t("dashboard.energielabelAlGedaan")} bron={t("dashboard.handmatig")} tone="handmatig" />;
                          if (elStatus === "onaf")
                            return (
                              <a
                                href={`/energielabel?draft=${draft!.id}`}
                                className="today-appt-service-tag is-warning"
                                title={t("dashboard.nietInClickUpGekomen", { bestanden: incompleteDocs.join(", ") })}
                              >
                                {t("dashboard.bijlagesOntbrekenAfmaken", { n: incompleteDocs.length })}
                              </a>
                            );
                          return energielabelStarted ? (
                            <StatusPill label={t("dashboard.energielabelConcept")} tone="busy" />
                          ) : (
                            <a href={elUrl} className="btn btn-quiet">
                              {t("dashboard.energielabelStarten")}
                            </a>
                          );
                        })()}
                      {services.nen &&
                        (() => {
                          const nenUrl = `/nen?addr=${encodeURIComponent(bagQuery)}${klant ? `&klant=${encodeURIComponent(klant)}` : ""}${grossFloorArea ? `&m2=${grossFloorArea}` : ""}`;
                          if (nStatus === "geupload")
                            return <StatusPill label={t("dashboard.nenIngediend")} tone="ok" href={nenUrl} />;
                          if (nStatus === "elders")
                            return (
                              <StatusPill
                                label={t("dashboard.inMediatask")}
                                bron={t("dashboard.buitenUploader")}
                                tone="elders"
                                title={t("dashboard.inMediataskUitleg")}
                              />
                            );
                          if (nStatus === "handmatig")
                            return <StatusPill label={t("dashboard.nenAlGedaan")} bron={t("dashboard.handmatig")} tone="handmatig" />;
                          if (nStatus === "onaf")
                            return (
                              <StatusPill
                                label={t("dashboard.nenConcept")}
                                tone="busy"
                                href={nenUrl}
                                title={t("dashboard.nenConceptUitleg")}
                              />
                            );
                          return (
                            <a href={nenUrl} className="btn btn-quiet">
                              {t("dashboard.nenUploaden")}
                            </a>
                          );
                        })()}
                      {/* Het ⋯-menu staat bij élke afspraak: een uitzondering,
                          geen vervolgstap, dus achter de puntjes en niet naast
                          "starten". Een vinkje laat zien wat al met de hand
                          gemarkeerd is; nog eens tikken draait het terug. */}
                      <span className="today-appt-meer">
                        <MeerMenu
                          label={t("dashboard.meerOpties", { adres: street })}
                          bezig={meldBezig === statusStreet}
                          items={[
                            {
                              label: t("dashboard.nenAlGedaan"),
                              uitleg: nenHandmatig ? t("dashboard.terugDraaien") : t("dashboard.markeerKlaar"),
                              aan: nenHandmatig,
                              onClick: () => zetKlaar(statusStreet, "nen", !nenHandmatig),
                            },
                            {
                              label: t("dashboard.energielabelAlGedaan"),
                              uitleg: elHandmatig ? t("dashboard.terugDraaien") : t("dashboard.markeerKlaar"),
                              aan: elHandmatig,
                              onClick: () => zetKlaar(statusStreet, "energielabel", !elHandmatig),
                            },
                          ]}
                        />
                      </span>
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
    </>
  );
}
