"use client";

import { useEffect, useState } from "react";
import { extractGrossFloorArea, extractKlant, matchServices } from "@/lib/calendar-services";
import { adresSleutel, calendarLocationToBagQuery, sameAddress, splitAddress } from "@/lib/address-format";
import { checkBagAddress, type BagCheckResult } from "@/lib/bag-check";
import type { DraftRecord as ServerDraftRecord } from "@/lib/drafts";
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
import MeerMenu from "@/components/MeerMenu";

interface CalendarEvent {
  id: string;
  summary: string;
  description: string | null;
  location: string | null;
  start: string | null;
  end: string | null;
}

// ClickUp geeft geen los "adres"-veld terug in de tasklijst — de taaknaam
// zelf IS het adres (zo aangemaakt bij het versturen), dus daarop matchen.

type DraftRecord = Pick<
  ServerDraftRecord,
  "straatnaam" | "status" | "clickupTaskUrl" | "heeftMediatask" | "incompleteDocs" | "updatedAt"
>;

type Dienst = "energielabel" | "nen";
type KlaarMeldingen = Record<Dienst, Set<string>>;

/** De handmatige "al gedaan"-meldingen per dienst; null als ophalen mislukt. */
async function haalKlaarMeldingen(): Promise<KlaarMeldingen | null> {
  try {
    const res = await fetch("/api/klaar-melden", { cache: "no-store" });
    if (!res.ok) return null;
    const data = (await res.json()) as { energielabel?: string[]; nen?: string[]; straten?: string[] };
    return { energielabel: new Set(data.energielabel ?? data.straten ?? []), nen: new Set(data.nen ?? []) };
  } catch {
    return null;
  }
}

/** Het label op een kaartje per status; null = geen statuslabel. */
function statusLabel(dienst: Dienst, status: DienstStatus): { tekst: string; klasse: string } | null {
  const naam = dienst === "nen" ? "NEN2580" : "Energielabel";
  switch (status) {
    case "geupload":
      return { tekst: dienst === "nen" ? "NEN2580 ingediend" : "Energielabel geüpload", klasse: "is-uploaded" };
    case "elders":
      return {
        tekst: dienst === "nen" ? "In Mediatask · buiten uploader" : "In ClickUp · buiten uploader",
        klasse: "is-uploaded",
      };
    case "handmatig":
      return { tekst: `${naam} al gedaan · handmatig`, klasse: "is-uploaded" };
    case "onaf":
      return {
        tekst: dienst === "nen" ? "NEN2580: concept, nog niet ingediend" : "Bijlages ontbreken",
        klasse: "is-warning",
      };
    default:
      return null;
  }
}

function formatTime(iso: string | null): string {
  if (!iso || iso.length === 10) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" });
}

/**
 * Toont de agenda-afspraken van vandaag boven het adres zoeken, zodat het
 * adres met één klik in het zoekveld komt i.p.v. te moeten worden
 * overgetypt. Alleen afspraken mét een ingevulde locatie tellen mee — losse
 * taken zonder adres ("sleutels ophalen") horen hier niet thuis. Als Google
 * Agenda niet gekoppeld is, tonen we een korte hint i.p.v. stilzwijgend
 * niets te laten zien — anders lijkt het net of er geen afspraken zijn.
 *
 * `context` bepaalt welke dienst deze pagina levert (energielabel of NEN2580)
 * — een afspraak die expliciet de ándere dienst noemt, of hier al is
 * geüpload, wordt grijs getoond zodat je 'm niet per ongeluk dubbel of
 * verkeerd oppakt. Voor NEN2580 checken we dat live bij Mediatask zelf
 * (i.p.v. alleen op onze eigen concept-administratie te vertrouwen, die kan
 * achterlopen als een order buiten deze app om is aangemaakt of het
 * concept-record niet is opgeslagen).
 */
export default function TodayAppointments({
  onPick,
  context,
  onUseLocation,
}: {
  onPick: (address: string, klant: string | null, grossFloorArea: number | null) => void;
  context: "energielabel" | "nen" | "media";
  /** Terugval als een adres niet in de BAG staat én er geen gelijkende
      adressen te vinden zijn: adressen in de buurt via GPS. */
  onUseLocation?: () => void;
}) {
  const [events, setEvents] = useState<CalendarEvent[] | null>(null);
  const [drafts, setDrafts] = useState<DraftRecord[]>([]);
  const [mediataskOrders, setMediataskOrders] = useState<MediataskOrderSamenvatting[]>([]);
  const [clickupTaken, setClickupTaken] = useState<ClickUpTaakSamenvatting[]>([]);
  const [klaar, setKlaar] = useState<KlaarMeldingen>({ energielabel: new Set(), nen: new Set() });
  const [meldBezig, setMeldBezig] = useState<string | null>(null);
  const [connected, setConnected] = useState(true);
  // Welke "Bedoelde je?"-suggestie al is aangeklikt, per adres — anders
  // blijft dat blok na de keuze gewoon zichtbaar staan, want de BAG-uitslag
  // zelf verandert niet door een klik. Gekeyd op de BAG-zoektekst, net als
  // bagInfo hierboven.
  const [pickedFix, setPickedFix] = useState<Set<string>>(new Set());
  // Per opgeschoonde adrestekst: de BAG-uitslag, inclusief gelijkende
  // adressen als het adres zelf niet bestaat. Gekeyd op de adrestekst (niet
  // het event-id), zodat een in de agenda gecorrigeerd adres meteen een
  // verse controle krijgt i.p.v. de oude uitslag te behouden.
  const [bagInfo, setBagInfo] = useState<Record<string, BagCheckResult>>({});

  useEffect(() => {
    fetch("/api/calendar/today", { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) {
          setConnected(false);
          return;
        }
        const data = await res.json();
        setEvents(data.events ?? []);
      })
      .catch(() => setConnected(false));

    fetch("/api/drafts", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : { drafts: [] }))
      .then((data) => setDrafts(data.drafts ?? []))
      .catch(() => {});

    // Media heeft geen "al gedaan"-administratie: er hoort geen ClickUp-taak
    // of Mediatask-order bij, dus valt er ook niets op te halen om afspraken
    // mee te dimmen.
    if (context === "media") {
      // niets extra's nodig
    } else if (context === "nen") {
      fetch("/api/mediatask/orders", { cache: "no-store" })
        .then((res) => (res.ok ? res.json() : { orders: [] }))
        .then((data) => setMediataskOrders(data.orders ?? []))
        .catch(() => {});
    } else {
      fetch("/api/clickup/tasks", { cache: "no-store" })
        .then((res) => (res.ok ? res.json() : { tasks: [] }))
        .then((data) => setClickupTaken(data.tasks ?? []))
        .catch(() => {});
    }
    if (context !== "media") void haalKlaarMeldingen().then((m) => m && setKlaar(m));
  }, [context]);

  function laadKlaarMeldingen() {
    void haalKlaarMeldingen().then((m) => m && setKlaar(m));
  }

  async function zetKlaar(street: string, dienst: Dienst, aan: boolean) {
    setMeldBezig(street);
    try {
      await fetch("/api/klaar-melden", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ street, dienst, klaar: aan }),
      });
      laadKlaarMeldingen();
    } finally {
      setMeldBezig(null);
    }
  }

  // Controleer per afspraak of het adres in de BAG bestaat — een adres met
  // een typefout (of een niet-bestaand adres) valt zo meteen op in de lijst,
  // i.p.v. pas nadat het aanklikken stilletjes niets oplevert. De ruwe
  // agenda-locatie gaat eerst door calendarLocationToBagQuery: PDOK eist dat
  // élke term matcht, dus het ", Nederland"-achtervoegsel van Google Maps
  // (of een locatienaam vóór het adres) zou anders op elk geldig adres vals
  // alarm geven. Bestaat het adres niet, dan zoekt checkBagAddress meteen
  // zelf naar gelijkende adressen om uit te kiezen.
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

  const withAddress = (events ?? []).filter((e) => e.location?.trim());

  if (!connected) {
    return (
      <div className="today-appts is-compact">
        <div className="today-appt-connect-hint">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <rect x="3" y="4" width="18" height="17" rx="2" stroke="currentColor" strokeWidth="1.8" />
            <path d="M3 9h18M8 2v4M16 2v4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          <span>
            Log in met Google Agenda om je afspraken van vandaag hier te laden.{" "}
            <a href="/instellingen">Naar Koppelingen</a>
          </span>
        </div>
      </div>
    );
  }

  if (withAddress.length === 0) return null;

  // Er kunnen meerdere concept-records voor hetzelfde adres bestaan (bv. een
  // opnieuw gestarte zoekopdracht) — als ÉÉN daarvan al geüpload is, telt
  // dat, ook als een ander (later aangeraakt) concept nog openstaat.
  // Alleen recente concepten: een opname van vorig jaar op hetzelfde adres
  // zegt niets over de afspraak van vandaag (zie lib/afspraak-status.ts).
  function findDraft(street: string): DraftRecord | null {
    const matches = drafts.filter((d) => isRecent(d.updatedAt) && sameAddress(d.straatnaam, street));
    if (!matches.length) return null;
    return (
      matches.find((d) => d.status === "uploaded" || !!d.heeftMediatask) ?? matches[0]
    );
  }

  function statusVoor(street: string, draft: DraftRecord | null): DienstStatus {
    if (context === "media") return null;
    const handmatig = klaar[context].has(adresSleutel(street));
    return context === "energielabel"
      ? energielabelStatus({
          taak: recenteClickUpTaak(clickupTaken, street),
          conceptGeupload: draft?.status === "uploaded" || !!draft?.clickupTaskUrl,
          bijlagesOntbreken: (draft?.incompleteDocs ?? []).length > 0,
          handmatig,
        })
      : nenStatus({
          order: recenteMediataskOrder(mediataskOrders, street),
          conceptMetOrder: !!draft?.heeftMediatask,
          handmatig,
        });
  }

  return (
    <div className="today-appts is-compact">
      <div className="list-head">
        <span className="eyebrow">Afspraken vandaag</span>
      </div>
      <ul className="today-appts-list">
        {withAddress.map((e) => {
          const address = e.location!.trim();
          const { street, cityLine } = splitAddress(address);
          const time = formatTime(e.start);
          const services = matchServices(e.summary, e.description);
          const draft = findDraft(street);
          const klant = extractKlant(e.description);
          // Dezelfde opgeschoonde tekst als de BAG-check én als wat een klik
          // straks doorgeeft — zo voorspelt de waarschuwing precies wat er
          // bij aanklikken gebeurt.
          const bagQuery = calendarLocationToBagQuery(address);
          const bag = bagInfo[bagQuery];
          const bagMissing = bag?.ok === false && !pickedFix.has(bagQuery);

          // Grijs tonen als de afspraak expliciet de ándere dienst noemt
          // (bv. een pure NEN2580-afspraak op de energielabel-pagina), of als
          // deze dienst voor dit adres al is geüpload via het systeem.
          // Media kan bij elke afspraak spelen en houdt geen eigen status bij,
          // dus daar wordt niets gedimd.
          const otherServiceOnly =
            context === "media"
              ? false
              : context === "energielabel"
                ? services.nen && !services.energielabel
                : services.energielabel && !services.nen;
          // Alleen recent werk telt; "onaf" (concept, ontbrekende bijlages)
          // blijft juist opvallen, want daar moet nog iets gebeuren.
          const status = statusVoor(street, draft);
          const alreadyUploaded = status !== null && status !== "onaf";
          const label = context === "media" ? null : statusLabel(context, status);
          const isDimmed = otherServiceOnly || alreadyUploaded;

          return (
            <li key={e.id} className={context === "media" ? undefined : "today-appt-item"}>
              <button
                className={`today-appt-card${isDimmed ? " is-dimmed" : ""}`}
                onClick={() => onPick(bagQuery, klant, extractGrossFloorArea(e.description))}
              >
                <span className="today-appt-top">
                  {time && <span className="today-appt-time">{time}</span>}
                  <span className="today-appt-street">{street}</span>
                </span>
                {cityLine && <span className="today-appt-city">{cityLine}</span>}
                {alreadyUploaded || label ? (
                  // Geen BAG-waarschuwing meer bij al geüploade adressen: de
                  // opname is dan al gelukt, dus er valt niets meer te doen.
                  <span className="today-appt-services">
                    {klant && <span className="today-appt-service-tag is-makelaar">{klant}</span>}
                    {label && <span className={`today-appt-service-tag ${label.klasse}`}>{label.tekst}</span>}
                  </span>
                ) : (
                  (services.energielabel || services.nen || klant || bagMissing) && (
                    <span className="today-appt-services">
                      {bagMissing && <span className="today-appt-service-tag is-warning">⚠ Niet in BAG</span>}
                      {klant && <span className="today-appt-service-tag is-makelaar">{klant}</span>}
                      {services.energielabel && <span className="today-appt-service-tag">Energielabel</span>}
                      {services.nen && <span className="today-appt-service-tag is-nen">NEN2580</span>}
                    </span>
                  )
                )}
              </button>

              {/* Zelfde ⋯-menu als op het dashboard: met de hand markeren dat
                  een dienst voor dit adres al gedaan is. */}
              {context !== "media" && (
                <span className="today-appt-item-meer">
                  <MeerMenu
                    label={`Meer opties voor ${street}`}
                    bezig={meldBezig === street}
                    items={(["nen", "energielabel"] as const).map((d) => {
                      const aan = klaar[d].has(adresSleutel(street));
                      return {
                        label: d === "nen" ? "NEN2580 al gedaan" : "Energielabel al gedaan",
                        uitleg: aan ? "Tik om terug te draaien" : "Markeert deze afspraak als klaar",
                        aan,
                        onClick: () => zetKlaar(street, d, !aan),
                      };
                    })}
                  />
                </span>
              )}

              {/* Adres bestaat niet in de BAG: meteen de gevonden gelijkende
                  adressen aanbieden (één tik = doorgaan met het juiste adres),
                  of anders de locatie-terugval. */}
              {bagMissing && !alreadyUploaded && (
                <div className="today-appt-fix">
                  {bag!.similar.length > 0 ? (
                    <>
                      <span className="today-appt-fix-label">Bedoelde je?</span>
                      {bag!.similar.map((label) => (
                        <button
                          key={label}
                          type="button"
                          className="today-appt-fix-btn"
                          onClick={() => {
                            setPickedFix((p) => new Set(p).add(bagQuery));
                            onPick(label, klant, extractGrossFloorArea(e.description));
                          }}
                        >
                          {label}
                        </button>
                      ))}
                    </>
                  ) : (
                    onUseLocation && (
                      <>
                        <span className="today-appt-fix-label">Geen gelijkend adres gevonden.</span>
                        <button
                          type="button"
                          className="today-appt-fix-btn"
                          onClick={() => {
                            setPickedFix((p) => new Set(p).add(bagQuery));
                            onUseLocation();
                          }}
                        >
                          📍 Adressen in de buurt
                        </button>
                      </>
                    )
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
