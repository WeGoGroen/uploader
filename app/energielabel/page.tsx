"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useIkBen } from "@/components/RechtenProvider";
import type { AddressDetails, AddressSuggestion, NearbyAddress } from "@/lib/pdok";
import { DOCUMENT_FOLDER_MAP } from "@/lib/documents";
import { enqueue, getServerSnapshot, getSnapshot, removeTask, subscribe } from "@/lib/upload-queue";
import { clearDraftLocal, listPendingLocalDrafts, markDraftSynced, saveDraftLocal } from "@/lib/local-drafts";
import TodayAppointments from "@/components/TodayAppointments";
// Gedeeld met het dashboard: één plek die bepaalt wanneer een opname "af" is,
// zodat de waarschuwing daar niet iets anders betekent dan de blokkade hier.
import {
  isEmptyFieldValue,
  isRequiredField as isRequiredFieldShared,
  veldCode,
} from "@/lib/required-fields";

interface ClickUpFieldOption {
  id: string;
  name: string;
}

interface ClickUpField {
  id: string;
  name: string;
  type: string;
  required: boolean;
  options: ClickUpFieldOption[];
}

interface ListMeta {
  account: { id: number; username: string };
  fields: ClickUpField[];
  members: { id: number; name: string; email: string }[];
  statuses: string[];
}

type FieldValue = string | string[] | boolean;
type Step = "search" | "fields" | "dropbox" | "documents";

interface DropboxFolder {
  path: string;
  url: string;
}

interface DropboxFileEntry {
  name: string;
  size: number;
}

// D2 t/m D5 in ClickUp zijn attachment-velden (niet via de app in te vullen)
// — DOCUMENT_FOLDER_MAP (lib/documents.ts) koppelt ze aan de vaste Dropbox-
// submappen, en wordt ook door de create-task route gebruikt om diezelfde
// bestanden automatisch als bijlage in ClickUp te zetten.
const DOCUMENT_FIELDS = DOCUMENT_FOLDER_MAP;

/** "45 sec", "2 min 10 sec" — zelfde weergave als bij NEN2580. */
function formatEta(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return "";
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} sec`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  if (minutes < 60) return rest ? `${minutes} min ${rest} sec` : `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const restMin = minutes % 60;
  return restMin ? `${hours} uur ${restMin} min` : `${hours} uur`;
}

const PRIORITIES = ["Urgent", "High", "Normal", "Low", "Clear"];

// Het team gebruikt zelf al lettercodes in de veldnamen (A1, B2, Mo-7, ...).
// Daar groeperen we op, i.p.v. een eigen indeling te verzinnen.
const GROUP_TITLES: Record<string, string> = {
  A: "Algemeen",
  B: "Isolatie",
  C: "Aanbouw",
  D: "Documentatie",
  E: "Extra",
  Mo: "Model-check",
};
const GROUP_ORDER = ["A", "B", "C", "D", "E", "Mo"];
// Deze secties beginnen ingeklapt: Aanbouw en Extra zijn de uitzondering,
// niet de regel — meestal niet van toepassing. Model-check is een vaste
// checklist die al op "ja" staat, dus die hoeft niet standaard open.
const DEFAULT_COLLAPSED = ["C", "E", "Mo"];

function fieldGroup(name: string): string {
  const code = name.split(" ")[0] ?? "";
  const match = code.match(/^([A-Za-z]+)/);
  return match ? match[1] : "Overig";
}

function findFieldByPrefix(fields: ClickUpField[], prefix: string): ClickUpField | undefined {
  return fields.find((f) => f.name.startsWith(prefix));
}

/**
 * De nummering die het team zelf in de veldnaam zet, als reeks getallen:
 * "D8.1 Polycam link - Begane grond" → [8, 1], "Mo-7 ..." → [7].
 *
 * ClickUp geeft velden terug in de volgorde waarin ze ooit zijn aangemaakt,
 * niet op nummer. Daardoor stond D8.5 (Extra) zomaar boven D8.2 (1e
 * verdieping) en las de Polycam-lijst niet van beneden naar boven, terwijl je
 * de etages in die volgorde loopt. Een veld zonder nummer zakt naar onderen.
 */
function fieldSortKey(name: string): number[] {
  // Bewust niet op een spatie splitsen: "D8.6Polycam link" mist die spatie.
  const naNaam = name.trim().replace(/^[A-Za-z]+/, "");
  const cijfers = naNaam.match(/^[\s\-.]*(\d+(?:[.\-]\d+)*)/);
  return cijfers ? cijfers[1].split(/[.\-]/).map(Number) : [Number.MAX_SAFE_INTEGER];
}

function vergelijkOpNummer(a: ClickUpField, b: ClickUpField): number {
  const ka = fieldSortKey(a.name);
  const kb = fieldSortKey(b.name);
  for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
    // Korter is eerder: "D8" staat boven "D8.1".
    const va = ka[i] ?? -1;
    const vb = kb[i] ?? -1;
    if (va !== vb) return va - vb;
  }
  return 0;
}

/** A3 Bouwjaar heeft één optie per jaartal ("1920"), met "<1650" als vangnet
    voor alles daarvoor. */
function matchYearOption(year: number, options: ClickUpFieldOption[]): string | undefined {
  const exact = options.find((o) => o.name === String(year));
  if (exact) return exact.id;
  if (year < 1650) {
    return options.find((o) => o.name === "<1650")?.id;
  }
  return undefined;
}

/** Bouwjaarklasse-opties van B2/B3/B4/B5 (Isolatie vloer/gevel/hellend
    dak/plat dak) — conform de NTA8800-forfaitaire periodes. Vóór 1965 heeft
    elke periode een "met spouw"/"zonder spouw"-variant en vanaf 2018 een
    "1 jan in gebruik"/"Overig"-variant; geen van beide is uit het bouwjaar
    alleen af te leiden, dus die laten we bewust over aan de opnemer. */
const INSULATION_FIELD_PREFIXES = ["B2", "B3", "B4", "B5"];

function insulationYearRangeLabel(year: number): string | null {
  if (year < 1965 || year >= 2018) return null;
  if (year <= 1974) return "Van 1965 t/m 1974";
  if (year <= 1982) return "Van 1975 t/m 1982";
  if (year <= 1987) return "Van 1983 t/m 1987";
  if (year <= 1991) return "Van 1988 t/m 1991";
  if (year <= 2013) return "Van 1992 t/m 2013";
  if (year === 2014) return "2014";
  return "Van 2015 t/m 2017";
}

function matchInsulationYearOption(
  year: number,
  options: ClickUpFieldOption[]
): string | undefined {
  const label = insulationYearRangeLabel(year);
  if (!label) return undefined;
  return options.find((o) => o.name === label)?.id;
}

/** A2 Opnemende adviseur gebruikt afgekorte namen ("F. de Laat"), de ClickUp-
    accountnaam is voluit ("Floris de Laat"). Match op de achternaam, met de
    voorletter als terugval — geen hardcoded namenlijst nodig. */
function matchAdviseurOption(username: string, options: ClickUpFieldOption[]): string | undefined {
  const uname = username.toLowerCase().trim();
  for (const o of options) {
    const namePart = o.name.replace(/^[A-Za-z]\.\s*/, "").toLowerCase().trim();
    if (namePart && uname.includes(namePart)) return o.id;
  }
  const initial = uname[0];
  return options.find((o) => o.name.toLowerCase().startsWith(initial + "."))?.id;
}

type Status = "loading" | "error" | "ready";

function houseNumber(a: {
  huisnummer: number;
  huisletter: string | null;
  huisnummertoevoeging?: string | null;
}) {
  return [
    a.huisnummer,
    a.huisletter ?? "",
    a.huisnummertoevoeging ? `-${a.huisnummertoevoeging}` : "",
  ].join("");
}

const COMPASS_DEGREES: Record<string, number> = {
  N: 0,
  NO: 45,
  O: 90,
  ZO: 135,
  Z: 180,
  ZW: 225,
  W: 270,
  NW: 315,
};

// Positie van elke windrichting op de rand van de cirkel (0° = boven = N,
// met de klok mee) — knoppen staan zo echt op een kompasring i.p.v. in een
// vierkant rooster.
const COMPASS_LAYOUT: { name: string; deg: number; x: number; y: number }[] = Object.entries(
  COMPASS_DEGREES
).map(([name, deg]) => {
  const rad = (deg * Math.PI) / 180;
  const r = 39; // percentage vanaf het midden
  return { name, deg, x: 50 + r * Math.sin(rad), y: 50 - r * Math.cos(rad) };
});

// Kleine streepjes rondom de ring, om de 15°, voor een echt instrument-gevoel.
const COMPASS_TICKS = Array.from({ length: 24 }, (_, i) => i * 15);

function nearestCompassName(heading: number): string {
  let best = "N";
  let bestDiff = Infinity;
  for (const [name, deg] of Object.entries(COMPASS_DEGREES)) {
    const diff = Math.min(Math.abs(heading - deg), 360 - Math.abs(heading - deg));
    if (diff < bestDiff) {
      bestDiff = diff;
      best = name;
    }
  }
  return best;
}

type DeviceOrientationEventIOS = typeof DeviceOrientationEvent & {
  requestPermission?: () => Promise<"granted" | "denied">;
};

/** Popup met alle A8-opties gerangschikt als een echt kompas. Kan de
    richtingssensor van het apparaat gebruiken: de wijzerplaat draait live
    mee terwijl je de tablet/telefoon beweegt, met een vaste pijl bovenaan
    die aangeeft waar je nu naartoe kijkt — één tik om die richting vast te
    leggen, of gewoon een windrichting rechtstreeks aantikken. */
function CompassPicker({
  options,
  value,
  onSelect,
  onClose,
}: {
  options: ClickUpFieldOption[];
  value: string | undefined;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const [heading, setHeading] = useState<number | null>(null);
  const [accuracy, setAccuracy] = useState<number | null>(null);
  const [liveStatus, setLiveStatus] = useState<"requesting" | "active" | "unavailable" | "denied">("requesting");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Vraagt meteen bij het openen van het kompas toegang tot de
  // richtingssensor — geen aparte "activeren"-knop meer nodig. Dit gebeurt
  // in dezelfde klik-context als het openen van de popup, wat iOS Safari
  // accepteert als geldige gebruikersactie voor requestPermission().
  useEffect(() => {
    let cancelled = false;
    async function activate() {
      const DOE = DeviceOrientationEvent as unknown as DeviceOrientationEventIOS;
      try {
        if (typeof DOE.requestPermission === "function") {
          const result = await DOE.requestPermission();
          if (cancelled) return;
          if (result !== "granted") {
            setLiveStatus("denied");
            return;
          }
        }
        if (!cancelled) setLiveStatus("active");
      } catch {
        if (!cancelled) setLiveStatus("unavailable");
      }
    }
    void activate();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (liveStatus !== "active") return;

    let gotReading = false;
    const timeout = setTimeout(() => {
      if (!gotReading) setLiveStatus("unavailable");
    }, 3000);

    const handler = (e: DeviceOrientationEvent) => {
      const ev = e as DeviceOrientationEvent & { webkitCompassHeading?: number; webkitCompassAccuracy?: number };
      const compassHeading =
        ev.webkitCompassHeading != null ? ev.webkitCompassHeading : e.absolute && e.alpha != null ? (360 - e.alpha) % 360 : null;
      if (compassHeading == null) return;
      gotReading = true;
      clearTimeout(timeout);
      setHeading(compassHeading);
      // webkitCompassAccuracy: geschatte afwijking in graden (iOS). Negatief
      // betekent "nog niet gekalibreerd". Op andere platformen is er geen
      // vergelijkbaar getal — dan alleen op event.absolute vertrouwen.
      setAccuracy(ev.webkitCompassAccuracy != null ? ev.webkitCompassAccuracy : e.absolute ? 0 : null);
    };

    window.addEventListener("deviceorientation", handler, true);
    return () => {
      clearTimeout(timeout);
      window.removeEventListener("deviceorientation", handler, true);
    };
  }, [liveStatus]);

  const liveName = heading != null ? nearestCompassName(heading) : null;
  const liveOption = liveName ? options.find((o) => o.name === liveName) : undefined;
  const needsCalibration = accuracy != null && (accuracy < 0 || accuracy > 15);

  return (
    <div className="compass-overlay" onClick={onClose}>
      <div className="compass-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Kies voorgevelrichting">
        <div className="compass-modal-head">
          <h3>Oriëntatie voorgevel</h3>
          <button type="button" className="compass-close" onClick={onClose} aria-label="Sluiten">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="compass-wrap">
          <span className="compass-pointer" aria-hidden="true" />
          <div
            className="compass-rose"
            style={heading != null ? { transform: `rotate(${-heading}deg)` } : undefined}
          >
            <div className="compass-ticks" aria-hidden="true">
              {COMPASS_TICKS.map((deg) => (
                <span
                  key={deg}
                  className={`compass-tick${deg % 90 === 0 ? " is-major" : ""}`}
                  style={{ transform: `rotate(${deg}deg)` }}
                />
              ))}
            </div>
            {COMPASS_LAYOUT.map((p) => {
              const opt = options.find((o) => o.name === p.name);
              const active = !!opt && opt.id === value;
              const isLive = liveStatus === "active" && p.name === liveName;
              const isNorth = p.name === "N";
              return (
                <button
                  key={p.name}
                  type="button"
                  className={`compass-btn${active ? " is-active" : ""}${isLive ? " is-live" : ""}${isNorth ? " is-north" : ""}`}
                  style={{ left: `${p.x}%`, top: `${p.y}%` }}
                  disabled={!opt}
                  onClick={() => opt && onSelect(opt.id)}
                >
                  <span
                    className="compass-btn-label"
                    style={heading != null ? { transform: `rotate(${heading}deg)` } : undefined}
                  >
                    {active && <span className="compass-btn-check" aria-hidden="true">✓</span>}
                    {p.name}
                  </span>
                </button>
              );
            })}
            <div className="compass-center" style={heading != null ? { transform: `rotate(${heading}deg)` } : undefined}>
              {liveStatus === "active" && heading != null ? (
                <span className="compass-center-deg">{Math.round(heading)}°</span>
              ) : (
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.3" />
                  <path d="M12 12 15.5 8.5 14 14 12 12l-3.5 1.5L12 12Z" fill="currentColor" />
                </svg>
              )}
            </div>
          </div>
        </div>

        <p className="compass-legend">
          <span><span className="compass-legend-dot is-live" /> jouw richting nu</span>
          <span><span className="compass-legend-dot is-active" /> opgeslagen</span>
        </p>

        {liveStatus === "requesting" && <p className="note">Toestemming vragen voor de richtingssensor…</p>}
        {liveStatus === "denied" && (
          <p className="note conn-err">
            Geen toestemming voor de kompassensor. Zet dit aan bij Instellingen → Safari (of je browser) → Motion &amp; Oriëntatie, of kies hierboven handmatig een richting.
          </p>
        )}
        {liveStatus === "unavailable" && (
          <p className="note conn-err">Geen kompassensor gevonden op dit apparaat. Kies hierboven handmatig een richting.</p>
        )}
        {liveStatus === "active" && needsCalibration && (
          <p className="note compass-calibrate">
            〰️ Kompas nog niet nauwkeurig — beweeg je toestel een paar keer in een 8-vorm om te kalibreren.
          </p>
        )}
        {liveStatus === "active" && heading != null && liveOption && (
          <button type="button" className="btn btn-primary btn-block compass-live-btn" onClick={() => onSelect(liveOption.id)}>
            Gebruik huidige richting: {liveName} ({Math.round(heading)}°)
          </button>
        )}
      </div>
    </div>
  );
}

export default function Home() {
  const [status, setStatus] = useState<Status>("loading");
  const [statusError, setStatusError] = useState<string | null>(null);
  const [meta, setMeta] = useState<ListMeta | null>(null);
  const [step, setStep] = useState<Step>("search");

  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<AddressSuggestion[]>([]);
  const [searching, setSearching] = useState(false);
  const [showManualSearch, setShowManualSearch] = useState(false);

  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [nearby, setNearby] = useState<NearbyAddress[] | null>(null);

  const [address, setAddress] = useState<AddressDetails | null>(null);
  const [loadingAddress, setLoadingAddress] = useState(false);
  const [editingAddr, setEditingAddr] = useState(false);
  const [addrHuisnummer, setAddrHuisnummer] = useState("");
  const [addrHuisletter, setAddrHuisletter] = useState("");
  const [addrToevoeging, setAddrToevoeging] = useState("");
  const [addrPostcode, setAddrPostcode] = useState("");

  // Taaknaam en toegewezene staan vast (volledig adres / de ingelogde ClickUp-
  // gebruiker). Prioriteit en Status zijn losse keuzevelden. Daarnaast alle
  // ~44 technische velden uit de ClickUp-List, live opgehaald.
  const [titel, setTitel] = useState("");
  const [assigneeId, setAssigneeId] = useState<number | "">("");
  const [priority, setPriority] = useState("Urgent");
  const [taskStatus, setTaskStatus] = useState("");
  const [beschrijving, setBeschrijving] = useState("");
  const [fieldValues, setFieldValues] = useState<Record<string, FieldValue>>({});
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    () => new Set(DEFAULT_COLLAPSED)
  );
  // Id van het A8-veld waarvoor het kompas-popup open staat, of null.
  const [compassFieldId, setCompassFieldId] = useState<string | null>(null);
  // Pas na een geblokkeerde poging om verder te gaan markeren we lege
  // verplichte velden rood — niet meteen bij het openen van de pagina.
  const [showRequiredErrors, setShowRequiredErrors] = useState(false);
  const [requiredError, setRequiredError] = useState<string | null>(null);

  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createdTaskUrl, setCreatedTaskUrl] = useState<string | null>(null);
  const [dropboxFolderUrl, setDropboxFolderUrl] = useState<string | null>(null);
  const [createdTaskId, setCreatedTaskId] = useState<string | null>(null);
  const [createdDropboxPath, setCreatedDropboxPath] = useState<string | null>(null);
  const [attachmentWarnings, setAttachmentWarnings] = useState<string[]>([]);
  // Categorieën die niet (volledig) zijn overgezet, zodat de opnemer het met
  // één tik opnieuw kan proberen i.p.v. vast te lopen op een foutmelding.
  const [mislukteDocs, setMislukteDocs] = useState<{ key: string; label: string }[]>([]);
  const [opnieuwBezig, setOpnieuwBezig] = useState(false);

  /**
   * Zet één documentcategorie over naar ClickUp. Blijft doorproberen zolang
   * de server meldt dat er nog werk ligt (te weinig tijd binnen één aanroep,
   * of losse bestanden die het niet haalden) — dat is precies waar het eerder
   * op strandde bij een map met twaalf gevelfoto's.
   */
  async function zetCategorieOver(
    taskId: string,
    dropboxPath: string,
    d: { key: string; label: string }
  ): Promise<string | null> {
    let laatsteFout = "onbekende fout";
    // Doorgaan waar de vorige poging stopte i.p.v. opnieuw bij bestand één.
    // Elke serveraanroep heeft een tijdsbudget van 45s; een categorie met veel
    // foto's paste daar niet in, en omdat elke poging weer vooraan begon kwam
    // de staart nooit aan de beurt en werd de kop dubbel bijgevoegd.
    let skip = 0;
    // Aantal rondes ruim genoeg voor een flinke serie foto's, met een harde
    // bovengrens zodat een blijvende fout niet eindeloos doorpompt.
    for (let poging = 0; poging < 12; poging++) {
      try {
        const r = await fetch("/api/clickup/attach-document", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ taskId, docKey: d.key, dropboxFolderPath: dropboxPath, skip }),
        });
        const rd = await r.json();
        if (!r.ok) throw new Error(rd.error ?? "onbekende fout");

        if (typeof rd.volgendeSkip === "number") skip = rd.volgendeSkip;

        if (rd.afgekapt) {
          laatsteFout = "niet alles paste binnen één poging";
          // Even ademruimte voor ClickUp voordat we het restant oppakken.
          await new Promise((res) => setTimeout(res, 2000));
          continue;
        }

        const mislukt: string[] = rd.mislukt ?? [];
        if (mislukt.length === 0) return null;

        // Nog één gerichte herkansing voor precies de bestanden die faalden —
        // niet de hele categorie, anders staan de geslaagde er dubbel in.
        laatsteFout = `${mislukt.length} van ${rd.fileCount} bestanden mislukten`;
        await new Promise((res) => setTimeout(res, 2000));
        const r2 = await fetch("/api/clickup/attach-document", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ taskId, docKey: d.key, dropboxFolderPath: dropboxPath, only: mislukt }),
        });
        const rd2 = await r2.json();
        if (r2.ok && !rd2.afgekapt && (rd2.mislukt?.length ?? 0) === 0) return null;
        return `${rd2.mislukt?.length ?? mislukt.length} bestanden bleven mislukken`;
      } catch (err) {
        laatsteFout = err instanceof Error ? err.message : "onbekende fout";
        await new Promise((res) => setTimeout(res, 2000));
      }
    }
    return laatsteFout;
  }

  /** Alleen de categorieën die eerder niet lukten opnieuw proberen. */
  async function probeerBijlagenOpnieuw() {
    if (!createdTaskId || !createdDropboxPath) return;
    setOpnieuwBezig(true);
    const nogSteedsMis: { key: string; label: string }[] = [];
    const nieuweWaarschuwingen: string[] = [];
    for (const d of mislukteDocs) {
      const fout = await zetCategorieOver(createdTaskId, createdDropboxPath, d);
      if (fout) {
        nogSteedsMis.push(d);
        nieuweWaarschuwingen.push(`${d.label}: overzetten naar ClickUp mislukt (${fout})`);
      }
    }
    setMislukteDocs(nogSteedsMis);
    setAttachmentWarnings(nieuweWaarschuwingen);
    setOpnieuwBezig(false);
  }

  // Voortgangspopup bij "Taak aanmaken in ClickUp": laat per onderdeel zien
  // wat er nu gebeurt, met een vinkje zodra het klaar is en een lopende
  // teller — i.p.v. één stille wachttijd tijdens het overzetten van bijlages.
  const [uploadProgress, setUploadProgress] = useState<{
    taskDone: boolean;
    docs: Record<string, "pending" | "done" | "error" | "skip">;
    startedAt: number;
  } | null>(null);
  const [uploadElapsed, setUploadElapsed] = useState(0);

  // Dropbox-map: wordt opgehaald zodra de opnemer bij de Dropbox-stap komt,
  // dus vóórdat de ClickUp-taak bestaat — zo kan er al geüpload worden
  // terwijl de rest van het formulier nog wordt afgerond.
  const [dropboxFolder, setDropboxFolder] = useState<DropboxFolder | null>(null);
  const [dropboxLoading, setDropboxLoading] = useState(false);
  const [dropboxError, setDropboxError] = useState<string | null>(null);

  // Al geüploade bestanden per documentcategorie (D2 t/m D5) — automatisch
  // opgehaald uit de bijbehorende Dropbox-submap zodra die pagina geopend
  // wordt, zodat de opnemer niet zelf hoeft te melden wat er al staat.
  const [docFiles, setDocFiles] = useState<Record<string, DropboxFileEntry[]>>({});
  const [docFolderUrls, setDocFolderUrls] = useState<Record<string, string | null>>({});
  const [docFilesLoading, setDocFilesLoading] = useState(false);
  // Uploaden gebeurt via dezelfde wachtrij als bij NEN2580: rechtstreeks naar
  // Dropbox, meerdere tegelijk, foto's automatisch verkleind, en de voortgang
  // blijft staan als je tussendoor naar een ander tabblad gaat.
  const alleUploads = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const uploadTaken = useMemo(
    () => alleUploads.filter((t) => t.folderPath === (dropboxFolder?.path ?? "")),
    [alleUploads, dropboxFolder]
  );
  // Foto's gaan op de achtergrond naar Dropbox, en ClickUp krijgt zijn
  // bijlages door de Dropbox-map úit te lezen. Wie de taak aanmaakt terwijl er
  // nog een upload loopt, krijgt dus een taak zonder die foto's — ze staan er
  // op dat moment simpelweg nog niet. Daarom pas doorgaan als de map compleet is.
  const lopendeUploads = useMemo(
    () => uploadTaken.filter((t) => t.dropbox === "uploading").length,
    [uploadTaken]
  );
  const docInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const [teVerwijderen, setTeVerwijderen] = useState<string | null>(null);
  const [verwijderBezig, setVerwijderBezig] = useState<string | null>(null);

  // De wachtrij zit buiten React, dus verversen gebeurt hier op basis van het
  // aantal afgeronde uploads i.p.v. vanuit de upload zelf.
  const uploadsKlaar = uploadTaken.filter((t) => t.dropbox === "done").length;
  useEffect(() => {
    if (uploadsKlaar > 0 && dropboxFolder) void refreshDocFiles(dropboxFolder);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uploadsKlaar]);

  async function verwijderDocBestand(folder: string, name: string) {
    if (!dropboxFolder) return;
    setVerwijderBezig(`${folder}/${name}`);
    try {
      const res = await fetch("/api/dropbox/delete-file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: `${dropboxFolder.path}/${folder}/${name}` }),
      });
      if (res.ok) {
        removeTask(dropboxFolder.path, folder, name);
        void refreshDocFiles(dropboxFolder);
      }
    } finally {
      setVerwijderBezig(null);
      setTeVerwijderen(null);
    }
  }

  // De topbalk + Dropbox-balk staan samen vast bovenaan (position: fixed);
  // deze meet hun werkelijke hoogte zodat de rest van de pagina precies
  // genoeg ruimte vrijhoudt, ongeacht hoeveel tekst er in past.
  const [pinnedHeadHeight, setPinnedHeadHeight] = useState(0);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const pinnedHeadRef = (el: HTMLDivElement | null) => {
    resizeObserverRef.current?.disconnect();
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      setPinnedHeadHeight(entries[0].contentRect.height + 12);
    });
    ro.observe(el);
    resizeObserverRef.current = ro;
  };

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Concepten: elke opname krijgt een eigen id zodra er een adres gekozen is,
  // zodat "niet afgemaakt" werk later exact hervat kan worden. Opslaan gebeurt
  // gedebouncet op de achtergrond — de opnemer merkt er niets van.
  const [draftId, setDraftId] = useState<string | null>(null);
  const draftSaveRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingDraftIdRef = useRef<string | null>(null);
  const resumedRef = useRef(false);

  const ikBen = useIkBen();

  useEffect(() => {
    fetch("/api/clickup/list-meta", { cache: "no-store" })
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Onbekende fout");
        setMeta(data);
        setStatus("ready");
      })
      .catch((err) => {
        setStatusError(err instanceof Error ? err.message : "Kon ClickUp niet bereiken.");
        setStatus("error");
      });
  }, []);

  // Concept hervatten via /?draft=<id>: alle formuliervelden terugzetten
  // zoals ze waren toen de opnemer wegging.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("draft");
    if (!id) return;
    resumedRef.current = true;
    fetch(`/api/drafts/${id}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        const draft = data?.draft;
        if (!draft) return;
        const s = draft.state ?? {};
        setDraftId(draft.id);
        if (s.address) setAddress(s.address);
        if (typeof s.titel === "string") setTitel(s.titel);
        if (s.assigneeId !== undefined) setAssigneeId(s.assigneeId);
        if (typeof s.priority === "string") setPriority(s.priority);
        if (typeof s.taskStatus === "string") setTaskStatus(s.taskStatus);
        if (typeof s.beschrijving === "string") setBeschrijving(s.beschrijving);
        if (s.fieldValues) setFieldValues(s.fieldValues);
        if (s.dropboxFolder) setDropboxFolder(s.dropboxFolder);
        if (typeof s.step === "string") setStep(s.step);
      })
      .catch(() => {});
  }, []);

  // Vanuit het dashboard via /energielabel?addr=<adres>: meteen doorzoeken
  // en selecteren, zodat je niet opnieuw hoeft te zoeken naar een adres dat
  // je net al in de afsprakenlijst zag staan.
  useEffect(() => {
    const addr = new URLSearchParams(window.location.search).get("addr");
    if (!addr) return;
    // De ClickUp-veldmeta (voor autofill van o.a. bouwjaar) wordt async
    // opgehaald — zonder deze wacht-stap start de adreszoekopdracht soms
    // vóórdat `meta` er is, waardoor selectAddress() de autofill overslaat.
    if (!meta) return;
    void pickFromAppointment(addr);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta]);

  // Sla het concept op zodra er een adres is — een half ingevulde opname mag
  // nooit verloren gaan als het scherm dichtgaat. Offline-vangnet: het id
  // wordt meteen (synchroon) vastgelegd zodat de localStorage-back-up direct
  // op elke wijziging kan schrijven, ook zonder verbinding; de echte
  // netwerk-save naar Redis blijft gedebouncet.
  useEffect(() => {
    if (!address || !meta) return;
    const id = draftId ?? pendingDraftIdRef.current ?? crypto.randomUUID();
    pendingDraftIdRef.current = id;
    if (!draftId) setDraftId(id);

    const straatnaam = `${address.straatnaam} ${houseNumber(address)}`;
    const payload = {
      id,
      status: "concept" as const,
      titel,
      straatnaam,
      postcode: address.postcode,
      woonplaats: address.woonplaatsnaam,
      // Wie het werk doet, uit de sessie; het ClickUp-account is een
      // koppeling en niet per se dezelfde bron.
      accountName: ikBen ?? meta.account.username,
      // Eén keer hier afleiden i.p.v. bij elke dashboardweergave opnieuw: de
      // lijsten dragen de formulierstaat bewust niet meer mee.
      adviseur: huidigeAdviseur(),
      ontbrekendeVelden: missingRequiredFields.map((f) => veldCode(f.name)),
      state: { address, titel, assigneeId, priority, taskStatus, beschrijving, fieldValues, dropboxFolder, step },
    };

    // Meteen lokaal wegschrijven — geen debounce, geen netwerk nodig.
    saveDraftLocal(id, straatnaam, payload, true);

    if (draftSaveRef.current) clearTimeout(draftSaveRef.current);
    draftSaveRef.current = setTimeout(() => {
      fetch("/api/drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
        .then((res) => {
          if (res.ok) markDraftSynced(id);
        })
        .catch(() => {
          // Blijft gemarkeerd als "pendingSync" in localStorage — wordt
          // automatisch opnieuw geprobeerd zodra de verbinding terugkomt.
        });
    }, 800);
    return () => {
      if (draftSaveRef.current) clearTimeout(draftSaveRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, titel, assigneeId, priority, taskStatus, beschrijving, fieldValues, dropboxFolder, step, meta]);

  // Zodra de verbinding terugkomt (of bij het opstarten): probeer alle
  // lokaal opgeslagen concepten die nog niet bevestigd zijn gesynchroniseerd
  // alsnog naar de server te sturen.
  useEffect(() => {
    function syncPendingDrafts() {
      for (const local of listPendingLocalDrafts()) {
        fetch("/api/drafts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(local.payload),
        })
          .then((res) => {
            if (res.ok) markDraftSynced(local.id);
          })
          .catch(() => {});
      }
    }
    syncPendingDrafts();
    window.addEventListener("online", syncPendingDrafts);
    return () => window.removeEventListener("online", syncPendingDrafts);
  }, []);

  // Ververst de upload-status op de achtergrond zolang er in de opname
  // gewerkt wordt, zodat de documentenpagina bij aankomst al up-to-date is
  // i.p.v. dat de opnemer daar zelf op "Verversen" moet klikken.
  useEffect(() => {
    if (!dropboxFolder) return;
    if (step !== "fields" && step !== "dropbox" && step !== "documents") return;
    const id = setInterval(() => {
      void refreshDocFiles(dropboxFolder);
    }, 15000);
    return () => clearInterval(id);
  }, [dropboxFolder, step]);

  // Lopende teller voor de uploadpopup ("Bezig: Xs").
  useEffect(() => {
    if (!uploadProgress) return;
    const id = setInterval(() => {
      setUploadElapsed(Math.round((Date.now() - uploadProgress.startedAt) / 1000));
    }, 500);
    return () => clearInterval(id);
  }, [uploadProgress]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (query.trim().length < 3) {
      setSuggestions([]);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(`/api/address/search?q=${encodeURIComponent(query)}`);
        const data = await res.json();
        setSuggestions(data.suggestions ?? []);
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  // Groepeer de technische velden één keer, niet bij elke render.
  const groupedFields = useMemo(() => {
    if (!meta) return [];
    const byGroup = new Map<string, ClickUpField[]>();
    for (const f of meta.fields) {
      const g = fieldGroup(f.name);
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g)!.push(f);
    }
    const keys = [...byGroup.keys()].sort((a, b) => {
      const ia = GROUP_ORDER.indexOf(a);
      const ib = GROUP_ORDER.indexOf(b);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });
    return keys.map((key) => ({
      key,
      title: GROUP_TITLES[key] ?? key,
      fields: [...byGroup.get(key)!].sort(vergelijkOpNummer),
    }));
  }, [meta]);

  // Documentatie (D) krijgt een eigen stap vlak vóór het versturen, met de
  // Dropbox-map er meteen bovenop — de rest van de technische velden blijft
  // op de vorige stap staan.
  const technicalGroups = useMemo(
    () => groupedFields.filter((g) => g.key !== "D"),
    [groupedFields]
  );
  const documentationGroup = useMemo(
    () => groupedFields.find((g) => g.key === "D") ?? null,
    [groupedFields]
  );
  // D1 Aantal Rekenzone's krijgt een eigen kaart onderaan de technische
  // velden: het bepaalt de rest van de indeling, dus het hoort ingevuld te
  // zijn vóór de Dropbox-map en de Polycam-links in beeld komen.
  const rekenzonesField = useMemo(
    () => (documentationGroup ? findFieldByPrefix(documentationGroup.fields, "D1") : undefined),
    [documentationGroup]
  );
  const documentationRestFields = useMemo(
    () => documentationGroup?.fields.filter((f) => f.id !== rekenzonesField?.id) ?? [],
    [documentationGroup, rekenzonesField]
  );

  // Welke verplichte velden op de technische-veldenstap nog leeg zijn.
  // Hiermee kan de opnemer vóór het klikken al zien hoeveel er nog mist,
  // i.p.v. pas ná een geblokkeerde poging.
  // Bewust over technicalGroups i.p.v. meta.fields: ClickUp levert de velden
  // in een eigen volgorde, terwijl de pagina ze gegroepeerd toont. Door de
  // weergavevolgorde te volgen springt "ga erheen" naar het bovenste lege
  // veld en noemt de foutmelding ze in de volgorde waarin je ze tegenkomt.
  // D1 staat als eigen kaart onderaan deze stap en sluit de rij dus af; de
  // rest van groep D heeft een eigen stap en telt hier niet mee.
  const missingRequiredFields = useMemo(() => {
    const uitGroepen = technicalGroups
      .flatMap((g) => g.fields)
      .filter((f) => isRequiredField(f) && isEmptyFieldValue(fieldValues[f.id]));
    // D1 is altijd verplicht, ook als ClickUp het veld niet zo markeert.
    return rekenzonesField && isEmptyFieldValue(fieldValues[rekenzonesField.id])
      ? [...uitGroepen, rekenzonesField]
      : uitGroepen;
    // isRequiredField leest meta en fieldValues, dus die twee zijn de echte
    // afhankelijkheden naast de groepen zelf.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [technicalGroups, meta, fieldValues, rekenzonesField]);
  const missingByGroup = useMemo(() => {
    const counts = new Map<string, number>();
    for (const f of missingRequiredFields) {
      const g = fieldGroup(f.name);
      counts.set(g, (counts.get(g) ?? 0) + 1);
    }
    return counts;
  }, [missingRequiredFields]);

  // Springt naar het eerstvolgende lege verplichte veld. Zit dat in een
  // ingeklapte groep, dan gaat die eerst open — anders zou de knop naar iets
  // springen dat niet in beeld staat.
  function jumpToFirstMissing() {
    const target = missingRequiredFields[0];
    if (!target) return;
    const group = fieldGroup(target.name);
    setCollapsedGroups((prev) => {
      if (!prev.has(group)) return prev;
      const next = new Set(prev);
      next.delete(group);
      return next;
    });
    // Na het uitklappen bestaat het element pas nadat React opnieuw getekend
    // heeft. Bewust setTimeout en géén requestAnimationFrame: in een tab die
    // niet in beeld staat vuurt rAF helemaal niet, en dan zou de knop niets
    // doen zodra iemand terugkomt op een weggeklikt tabblad.
    setTimeout(() => {
      const el = document.getElementById(`f-${target.id}`);
      if (!el) return;
      // Eerst focussen, dan scrollen: in omgekeerde volgorde breekt focus()
      // de nog lopende smooth-scroll af en blijft de pagina staan waar hij
      // stond (live vastgesteld in Chrome).
      el.focus({ preventScroll: true });
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 0);
  }

  /** Wie er als A2 "Opnemende adviseur" op de opname staat. */
  function huidigeAdviseur(): string | null {
    const a2 = meta?.fields.find((f) => f.name.startsWith("A2"));
    if (!a2) return null;
    const gekozen = fieldValues[a2.id];
    if (typeof gekozen !== "string" || !gekozen) return null;
    return a2.options.find((o) => o.id === gekozen)?.name ?? null;
  }

  function startNearbySearch() {
    setLocationError(null);
    setNearby(null);
    setAddress(null);
    setCreatedTaskUrl(null);
    setCreateError(null);
    setShowManualSearch(false);

    if (!("geolocation" in navigator)) {
      setLocationError("Locatie wordt niet ondersteund door deze browser. Gebruik handmatig zoeken.");
      return;
    }

    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        try {
          const res = await fetch(
            `/api/address/nearby?lat=${position.coords.latitude}&lon=${position.coords.longitude}`
          );
          if (!res.ok) throw new Error("failed");
          const data = await res.json();
          setNearby(data.addresses ?? []);
        } catch {
          setLocationError("Ophalen van adressen in de buurt is mislukt. Probeer opnieuw of zoek handmatig.");
        } finally {
          setLocating(false);
        }
      },
      (err) => {
        setLocating(false);
        setLocationError(
          err.code === err.PERMISSION_DENIED
            ? "Locatietoegang geweigerd. Zet dit aan in je browserinstellingen, of zoek handmatig. Let op: locatie werkt alleen over https of op localhost."
            : "Locatie kon niet worden bepaald. Probeer opnieuw of zoek handmatig."
        );
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }

  async function selectAddress(suggestion: AddressSuggestion) {
    setNearby(null);
    setSuggestions([]);
    setQuery(suggestion.label);
    setLoadingAddress(true);
    setAddress(null);
    setDraftId(null);
    setCreatedTaskUrl(null);
    setCreateError(null);
    setStep("search");
    setFieldValues({});
    setShowRequiredErrors(false);
    setRequiredError(null);
    setCollapsedGroups(new Set(DEFAULT_COLLAPSED));
    setDropboxFolder(null);
    setDropboxError(null);
    setDocFiles({});
    try {
      const res = await fetch(`/api/address/details?id=${encodeURIComponent(suggestion.id)}`);
      const data = await res.json();
      const a: AddressDetails | null = data.details ?? null;
      setAddress(a);
      if (a && meta) {
        void ensureDropboxFolder(a);
        setTitel(`${a.straatnaam} ${houseNumber(a)}, ${a.postcode} ${a.woonplaatsnaam}`);
        // "Open" is de status waarmee een nieuwe opname start — dat is niet
        // per se de eerste status in de lijst (volgorde is vrij in ClickUp).
        const openStatus = meta.statuses.find((s) => s.toLowerCase() === "open");
        setTaskStatus(openStatus ?? meta.statuses[0] ?? "");
        setAssigneeId(meta.account.id);
        setPriority("Urgent");
        const lines = [
          `${a.straatnaam} ${houseNumber(a)}, ${a.postcode} ${a.woonplaatsnaam}`,
          a.bouwjaar !== null ? `Bouwjaar: ${a.bouwjaar} (BAG)` : null,
          `BAG-objectnummer: ${a.adresseerbaarobjectId}`,
        ].filter((l): l is string => l !== null);
        setBeschrijving(lines.join("\n"));

        // Autofill vanuit BAG en account: A1 Adres, A3 Bouwjaar, A2 Opnemende
        // adviseur. De opnemer kan dit altijd nog aanpassen op de volgende
        // pagina, dit is alleen een vliegende start.
        const initial: Record<string, FieldValue> = {};
        const adresField = findFieldByPrefix(meta.fields, "A1");
        if (adresField) {
          initial[adresField.id] =
            `${a.straatnaam} ${houseNumber(a)}, ${a.postcode} ${a.woonplaatsnaam}`;
        }
        const bouwjaarField = findFieldByPrefix(meta.fields, "A3");
        if (bouwjaarField && a.bouwjaar !== null) {
          const optId = matchYearOption(a.bouwjaar, bouwjaarField.options);
          if (optId) initial[bouwjaarField.id] = optId;
        }
        const adviseurField = findFieldByPrefix(meta.fields, "A2");
        if (adviseurField) {
          const optId = matchAdviseurOption(meta.account.username, adviseurField.options);
          if (optId) initial[adviseurField.id] = optId;
        }
        // A8 Oriëntatie voorgevel: bewust NIET automatisch invullen (ook al
        // is 'm uit de BAG-pandvorm af te leiden) — de opnemer moet dit
        // altijd zelf bevestigen, dus dit veld laadt altijd leeg.
        // Isolatie vloer/gevel/hellend dak/plat dak: bij een ondubbelzinnige
        // bouwjaarklasse (1965 t/m 2017) vast invullen; daarbuiten (spouw-
        // variant vóór 1965, "1 jan in gebruik" vanaf 2018) blijft dit
        // bewust leeg, want dat is niet uit het bouwjaar af te leiden.
        if (a.bouwjaar !== null) {
          for (const prefix of INSULATION_FIELD_PREFIXES) {
            const field = findFieldByPrefix(meta.fields, prefix);
            if (!field) continue;
            const optId = matchInsulationYearOption(a.bouwjaar, field.options);
            if (optId) initial[field.id] = optId;
          }
        }
        // Model-check is een vaste checklist ("is dit gecontroleerd?") — die
        // staat standaard op ja, de opnemer vinkt uit wat niet is gecheckt.
        for (const f of meta.fields) {
          if (f.type === "checkbox" && fieldGroup(f.name) === "Mo") {
            initial[f.id] = true;
          }
        }
        setFieldValues(initial);
      }
    } finally {
      setLoadingAddress(false);
    }
  }

  function setFieldValue(id: string, value: FieldValue) {
    setFieldValues((prev) => ({ ...prev, [id]: value }));
  }

  // Kleine wikkel om de gedeelde regels (lib/required-fields.ts), zodat de
  // aanroepen hieronder alleen het veld hoeven mee te geven.
  function isRequiredField(f: ClickUpField): boolean {
    return isRequiredFieldShared(f, meta?.fields ?? [], fieldValues);
  }

  // Vanuit "Afspraken vandaag": zoekt direct op het adres uit de afspraak en
  // selecteert de beste match, zodat de tweede kolom meteen gevuld is i.p.v.
  // dat de opnemer nog handmatig een zoekresultaat moet aanklikken.
  async function pickFromAppointment(addressText: string) {
    setQuery(addressText);
    setAddress(null);
    setCreatedTaskUrl(null);
    setShowManualSearch(true);
    setSearching(true);
    try {
      const res = await fetch(`/api/address/search?q=${encodeURIComponent(addressText)}`);
      const data = await res.json();
      const best: AddressSuggestion | undefined = data.suggestions?.[0];
      if (best) {
        await selectAddress(best);
        // Vanuit een agenda-afspraak is het adres al bevestigd en de
        // technische velden zijn al zo goed mogelijk voorgevuld vanuit de
        // BAG — meteen doorspringen naar die stap scheelt een extra klik
        // die anders elke keer nodig was.
        goToFields();
      } else {
        setSuggestions(data.suggestions ?? []);
      }
    } finally {
      setSearching(false);
    }
  }

  function startEditingAddress() {
    if (!address) return;
    setAddrHuisnummer(String(address.huisnummer));
    setAddrHuisletter(address.huisletter ?? "");
    setAddrToevoeging(address.huisnummertoevoeging ?? "");
    setAddrPostcode(address.postcode);
    setEditingAddr(true);
  }

  function saveAddressEdit() {
    setAddress((prev) => {
      if (!prev) return prev;
      const huisnummer = parseInt(addrHuisnummer, 10);
      const next: AddressDetails = {
        ...prev,
        huisnummer: Number.isFinite(huisnummer) ? huisnummer : prev.huisnummer,
        huisletter: addrHuisletter.trim() || null,
        huisnummertoevoeging: addrToevoeging.trim() || null,
        postcode: addrPostcode.trim().toUpperCase(),
      };
      // Wijzigt het huisnummer, dan hoort de al aangemaakte projectmap niet
      // meer bij dit adres. Zonder deze reset houdt goToDropboxStep de oude
      // map vast (die stapt eruit zodra dropboxFolder gevuld is) en zouden de
      // foto's van "Dam 1A" in de map van "Dam 1" belanden.
      if (`${prev.straatnaam} ${houseNumber(prev)}` !== `${next.straatnaam} ${houseNumber(next)}`) {
        setDropboxFolder(null);
        setDocFiles({});
      }
      const line = `${next.straatnaam} ${houseNumber(next)}, ${next.postcode} ${next.woonplaatsnaam}`;
      setTitel(line);
      setBeschrijving((prevB) => {
        const lines = prevB.split("\n");
        if (lines.length > 0) lines[0] = line;
        return lines.join("\n");
      });
      if (meta) {
        const adresField = findFieldByPrefix(meta.fields, "A1");
        if (adresField) {
          setFieldValues((fv) => ({ ...fv, [adresField.id]: line }));
        }
      }
      return next;
    });
    setEditingAddr(false);
  }

  function buildCustomFieldsPayload(): { id: string; value: string | boolean | string[] }[] {
    if (!meta) return [];
    const out: { id: string; value: string | boolean | string[] }[] = [];
    for (const f of meta.fields) {
      const v = fieldValues[f.id];
      if (v === undefined) continue;

      if (f.type === "checkbox") {
        if (v === true) out.push({ id: f.id, value: true });
        continue;
      }
      if (f.type === "labels") {
        const arr = v as string[];
        if (arr.length) out.push({ id: f.id, value: arr });
        continue;
      }
      if (typeof v === "string" && v.trim() !== "") {
        out.push({ id: f.id, value: v });
      }
    }
    return out;
  }

  async function submitTask() {
    if (!address) return;
    setCreating(true);
    setCreateError(null);
    setUploadProgress({
      taskDone: false,
      docs: Object.fromEntries(DOCUMENT_FIELDS.map((d) => [d.key, "pending"])),
      startedAt: Date.now(),
    });
    setUploadElapsed(0);
    try {
      const res = await fetch("/api/clickup/create-task", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // Zonder dit id kan de server een herhaalde verzending niet van een
          // nieuwe onderscheiden, en ontstaan er twee taken voor één pand.
          opnameId: draftId ?? pendingDraftIdRef.current ?? undefined,
          address,
          titel,
          assigneeId: assigneeId || null,
          priority,
          status: taskStatus,
          beschrijving,
          customFields: buildCustomFieldsPayload(),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setCreateError("Taak aanmaken mislukt. Probeer het opnieuw.");
        setUploadProgress(null);
        return;
      }
      setCreatedTaskUrl(data.task.url);
      setDropboxFolderUrl(data.dropboxFolderUrl ?? null);
      setUploadProgress((p) => (p ? { ...p, taskDone: true } : p));

      // Per documentcategorie apart overzetten, zodat de popup live per
      // onderdeel een vinkje kan tonen i.p.v. één lange stille wachttijd.
      const dropboxPath: string | null = data.dropboxFolderPath ?? null;
      const warnings: string[] = [];
      const mis: { key: string; label: string }[] = [];
      setCreatedTaskId(data.task.id);
      setCreatedDropboxPath(dropboxPath);
      if (dropboxPath) {
        // Bewust één categorie tegelijk. Ze gingen hiervoor alle vier
        // tegelijk omhoog, en dat is precies waar ClickUp op omvalt: vier
        // gelijktijdige reeksen uploads vanuit hetzelfde account leveren
        // 500-fouten op. Rustig achter elkaar is trager maar haalt het wél.
        for (const d of DOCUMENT_FIELDS) {
          const fout = await zetCategorieOver(data.task.id, dropboxPath, d);
          if (fout) {
            warnings.push(`${d.label}: overzetten naar ClickUp mislukt (${fout})`);
            mis.push({ key: d.key, label: d.label });
            setUploadProgress((p) => (p ? { ...p, docs: { ...p.docs, [d.key]: "error" } } : p));
          } else {
            setUploadProgress((p) => (p ? { ...p, docs: { ...p.docs, [d.key]: "done" } } : p));
          }
        }
        setMislukteDocs(mis);
      } else {
        setUploadProgress((p) =>
          p ? { ...p, docs: Object.fromEntries(DOCUMENT_FIELDS.map((d) => [d.key, "skip"])) } : p
        );
      }
      setAttachmentWarnings(warnings);

      if (draftId && address) {
        fetch("/api/drafts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: draftId,
            status: "uploaded",
            titel,
            straatnaam: `${address.straatnaam} ${houseNumber(address)}`,
            postcode: address.postcode,
            woonplaats: address.woonplaatsnaam,
            accountName: ikBen ?? meta?.account.username ?? null,
            clickupTaskUrl: data.task.url,
            // Mislukte bijlages meeschrijven: de taak staat er dan wel, maar
            // de opname is niet compleet. Zonder dit werd zo'n opname als
            // "geüpload" afgevinkt en verdween het resterende werk uit beeld.
            incompleteDocs: mis.map((d) => d.label),
            // Eén keer hier afleiden i.p.v. bij elke dashboardweergave opnieuw: de
      // lijsten dragen de formulierstaat bewust niet meer mee.
      adviseur: huidigeAdviseur(),
      ontbrekendeVelden: missingRequiredFields.map((f) => veldCode(f.name)),
      state: { address, titel, assigneeId, priority, taskStatus, beschrijving, fieldValues, dropboxFolder, step },
          }),
        }).catch(() => {});
        markDraftSynced(draftId);
        clearDraftLocal(draftId);
      }
    } catch {
      setCreateError("Taak aanmaken mislukt. Probeer het opnieuw.");
    } finally {
      setCreating(false);
      setTimeout(() => setUploadProgress(null), 1000);
    }
  }

  function resetSearch() {
    if (draftId) clearDraftLocal(draftId);
    pendingDraftIdRef.current = null;
    setQuery("");
    setSuggestions([]);
    setAddress(null);
    setDraftId(null);
    setCreatedTaskUrl(null);
    setDropboxFolderUrl(null);
    setAttachmentWarnings([]);
    setMislukteDocs([]);
    setCreatedTaskId(null);
    setCreatedDropboxPath(null);
    setCreateError(null);
    setNearby(null);
    setLocationError(null);
    setShowManualSearch(false);
    setFieldValues({});
    setShowRequiredErrors(false);
    setRequiredError(null);
    setStep("search");
    setDropboxFolder(null);
    setDropboxError(null);
    setDocFiles({});
  }

  function goToFields() {
    setStep("fields");
    window.scrollTo(0, 0);
  }

  // Wordt aangeroepen zodra er een adres bekend is, zodat de Dropbox-map en
  // deel-link al klaarstaan vóórdat de opnemer bij de Dropbox-stap komt — de
  // kaart bovenaan elke volgende pagina kan dan meteen de echte map tonen.
  // Herbruikbaar voor zowel de eerste keer (na het aanmaken van de map) als
  // een handmatige "Verversen" — zo kan de banner altijd de actuele
  // upload-voortgang tonen, niet alleen op de documentenpagina.
  async function refreshDocFiles(folder: DropboxFolder) {
    setDocFilesLoading(true);
    try {
      const entries = await Promise.all(
        DOCUMENT_FIELDS.map(async (d) => {
          try {
            const res = await fetch("/api/dropbox/files", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ path: `${folder.path}/${d.folder}` }),
            });
            const data = await res.json();
            return [
              d.key,
              { files: res.ok ? (data.files as DropboxFileEntry[]) : [], url: data.url as string | null },
            ] as const;
          } catch {
            return [d.key, { files: [] as DropboxFileEntry[], url: null }] as const;
          }
        })
      );
      setDocFiles(Object.fromEntries(entries.map(([k, v]) => [k, v.files])));
      setDocFolderUrls(Object.fromEntries(entries.map(([k, v]) => [k, v.url])));
    } finally {
      setDocFilesLoading(false);
    }
  }

  async function ensureDropboxFolder(a: AddressDetails) {
    setDropboxLoading(true);
    setDropboxError(null);
    try {
      const straatEnNummer = `${a.straatnaam} ${houseNumber(a)}`;
      const res = await fetch("/api/dropbox/folder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          woonplaats: a.woonplaatsnaam,
          straatEnNummer,
          postcode: a.postcode,
          huisnummer: a.huisnummer,
          huisletter: a.huisletter,
          huisnummertoevoeging: a.huisnummertoevoeging,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setDropboxError(data.error ?? "Dropbox-map aanmaken mislukt.");
        return;
      }
      setDropboxFolder(data);
      void refreshDocFiles(data);
    } catch {
      setDropboxError("Dropbox-map aanmaken mislukt. Probeer het opnieuw.");
    } finally {
      setDropboxLoading(false);
    }
  }

  async function goToDropboxStep() {
    const missing = missingRequiredFields;
    if (missing.length > 0) {
      setShowRequiredErrors(true);
      setRequiredError(`Vul eerst de verplichte velden in: ${missing.map((f) => f.name).join(", ")}.`);
      window.scrollTo(0, 0);
      return;
    }
    setShowRequiredErrors(false);
    setRequiredError(null);
    setStep("dropbox");
    window.scrollTo(0, 0);
    if (!address || dropboxFolder || dropboxLoading) return;
    await ensureDropboxFolder(address);
  }

  async function goToDocumentsStep() {
    setRequiredError(null);
    setStep("documents");
    window.scrollTo(0, 0);
    if (!dropboxFolder) return;
    await refreshDocFiles(dropboxFolder);
  }

  function renderDropboxCard() {
    const uploadedCount = DOCUMENT_FIELDS.filter((d) => (docFiles[d.key]?.length ?? 0) > 0).length;
    return (
      <div className={`dbx-strip${dropboxFolder ? " is-ready" : dropboxError ? " is-off" : ""}`}>
        <div className="dbx-strip-top">
          <span className="conn-icon is-dropbox dbx-strip-icon">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M7 3 2 6.3 7 9.6 2 12.9l5 3.3 5-3.3 5 3.3 5-3.3-5-3.3 5-3.3-5-3.3-5 3.3-5-3.3Zm5 15 5-3.3v2.2L12 20l-5-3.1v-2.2l5 3.3Z"
                fill="currentColor"
              />
            </svg>
          </span>

          {dropboxLoading && (
            <span className="dbx-strip-text">
              <span className="spinner" /> Dropbox-map klaarzetten…
            </span>
          )}

          {dropboxFolder && (
            <>
              <span className="dbx-strip-text">
                <span className="dbx-strip-check" aria-hidden="true">✓</span>
                Map aangemaakt — <span className="dbx-folder-path">{dropboxFolder.path}</span>
              </span>
              <span className="dbx-strip-progress-label">
                {uploadedCount}/{DOCUMENT_FIELDS.length} geüpload
              </span>
              <button
                type="button"
                className="dbx-strip-refresh"
                onClick={() => refreshDocFiles(dropboxFolder)}
                disabled={docFilesLoading}
                title="Nu verversen"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true" className={docFilesLoading ? "spin" : undefined}>
                  <path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              <a
                href={dropboxFolder.url}
                target="_blank"
                rel="noopener noreferrer"
                className="btn-open-dbx"
              >
                Openen
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path
                    d="M6 4h6v6M12 4 4 12"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </a>
            </>
          )}

          {dropboxError && (
            <>
              <span className="dbx-strip-text conn-err" style={{ margin: 0 }}>{dropboxError}</span>
              <a href="/instellingen" className="btn-text">
                Naar Verbindingen
              </a>
            </>
          )}
        </div>

        {dropboxFolder && (
          <div className="dbx-strip-docs">
            {DOCUMENT_FIELDS.map((d) => {
              const done = (docFiles[d.key]?.length ?? 0) > 0;
              return (
                <div key={d.key} className={`dbx-strip-doc-row${done ? " is-done" : ""}`}>
                  {done ? (
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <path d="M3.5 8.5 6.5 11.5 12.5 4.5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  ) : (
                    <span className="dbx-strip-doc-empty" aria-hidden="true" />
                  )}
                  <span className="dbx-strip-doc-label">{d.label}</span>
                  <span className="dbx-strip-doc-status">
                    {done ? `${docFiles[d.key]!.length} bestand${docFiles[d.key]!.length > 1 ? "en" : ""}` : "nog niets"}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  function renderPinnedHead(topline: ReactNode) {
    return (
      <>
        <div className="pinned-head" ref={pinnedHeadRef}>
          {topline}
          {renderDropboxCard()}
        </div>
        <div className="pinned-head-spacer" style={{ height: pinnedHeadHeight }} />
      </>
    );
  }

  function toggleGroup(key: string) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function renderField(f: ClickUpField) {
    const required = isRequiredField(f);
    // Verplichte lege velden meteen rood tonen (niet pas na een mislukte
    // poging om verder te gaan) — zo valt het meteen op, ook zonder eerst
    // tegen de foutmelding aan te lopen.
    const isMissing = required && isEmptyFieldValue(fieldValues[f.id]);
    const requiredMark = required ? <span className="field-required-mark"> *</span> : null;

    if (f.type === "checkbox") {
      // B7 Isolatie Deur krijgt dezelfde regelopbouw als de dropdown-velden
      // (label boven, control eronder) i.p.v. de compacte inline checkbox —
      // valt zo meteen op tussen B2 t/m B5.
      if (f.name.startsWith("B7")) {
        const checked = fieldValues[f.id] === true;
        return (
          <div className="field" key={f.id}>
            <label htmlFor={`f-${f.id}`}>{f.name}</label>
            <button
              type="button"
              id={`f-${f.id}`}
              className={`toggle-btn${checked ? " is-on" : ""}`}
              aria-pressed={checked}
              onClick={() => setFieldValue(f.id, !checked)}
            >
              {checked ? "Geïsoleerd" : "Ongeïsoleerd"}
            </button>
          </div>
        );
      }
      return (
        <div className="field" key={f.id}>
          <label htmlFor={`f-${f.id}`} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              id={`f-${f.id}`}
              type="checkbox"
              checked={fieldValues[f.id] === true}
              onChange={(e) => setFieldValue(f.id, e.target.checked)}
              style={{ width: 18, height: 18 }}
            />
            {f.name}
          </label>
        </div>
      );
    }

    if (f.type === "drop_down") {
      const filled = !!fieldValues[f.id];
      const showBouwjaarTag =
        address?.bouwjaar != null && INSULATION_FIELD_PREFIXES.some((p) => f.name.startsWith(p));
      const isOrientatie = f.name.startsWith("A8");
      return (
        <div className={`field${isMissing ? " field-missing" : ""}`} key={f.id}>
          <label htmlFor={`f-${f.id}`}>
            {f.name}
            {requiredMark}
            {showBouwjaarTag && <span className="field-year-tag">BJ {address!.bouwjaar}</span>}
          </label>
          <div className={isOrientatie ? "field-with-compass" : undefined}>
            <select
              id={`f-${f.id}`}
              className={`control${filled ? " is-filled" : ""}`}
              value={(fieldValues[f.id] as string) ?? ""}
              onChange={(e) => setFieldValue(f.id, e.target.value)}
            >
              <option value="">Kies…</option>
              {f.options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
            {isOrientatie && (
              <button
                type="button"
                className="btn-compass"
                onClick={() => setCompassFieldId(f.id)}
                title="Kies via kompas"
                aria-label="Kies voorgevelrichting via kompas"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" />
                  <path d="M12 12 15.5 8.5 14 14 12 12l-3.5 1.5L12 12Z" fill="currentColor" />
                </svg>
              </button>
            )}
          </div>
          {isOrientatie && compassFieldId === f.id && (
            <CompassPicker
              options={f.options}
              value={fieldValues[f.id] as string | undefined}
              onSelect={(optId) => {
                setFieldValue(f.id, optId);
                setCompassFieldId(null);
              }}
              onClose={() => setCompassFieldId(null)}
            />
          )}
        </div>
      );
    }

    if (f.type === "labels") {
      const selected = (fieldValues[f.id] as string[]) ?? [];
      return (
        <div className="field is-wide" key={f.id}>
          <label htmlFor={`f-${f.id}`}>{f.name}</label>
          <select
            id={`f-${f.id}`}
            className="control"
            multiple
            size={6}
            style={{ minHeight: 140, paddingTop: 8 }}
            value={selected}
            onChange={(e) =>
              setFieldValue(
                f.id,
                Array.from(e.target.selectedOptions).map((o) => o.value)
              )
            }
          >
            {f.options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </div>
      );
    }

    if (f.type === "text") {
      return (
        <div className={`field is-wide${isMissing ? " field-missing" : ""}`} key={f.id}>
          <label htmlFor={`f-${f.id}`}>
            {f.name}
            {requiredMark}
          </label>
          <textarea
            id={`f-${f.id}`}
            className="control"
            rows={2}
            value={(fieldValues[f.id] as string) ?? ""}
            onChange={(e) => setFieldValue(f.id, e.target.value)}
          />
        </div>
      );
    }

    // url — de Polycam-links (D8.x) krijgen de volle breedte, die URL's zijn lang.
    return (
      <div className={`field${f.name.startsWith("D8") ? " is-wide" : ""}${isMissing ? " field-missing" : ""}`} key={f.id}>
        <label htmlFor={`f-${f.id}`}>
          {f.name}
          {requiredMark}
        </label>
        <input
          id={`f-${f.id}`}
          type="url"
          className="control"
          value={(fieldValues[f.id] as string) ?? ""}
          onChange={(e) => setFieldValue(f.id, e.target.value)}
          placeholder="https://…"
        />
      </div>
    );
  }

  return (
    <>
      <header className="topline">
        <div>
          <span className="eyebrow">Nieuwe opdracht</span>
        </div>
      </header>

      {status === "loading" && (
        <div className="pad" style={{ background: "var(--paper)", border: "1px solid var(--rule)", borderRadius: "var(--r)" }}>
          <p className="lede">ClickUp-gegevens laden…</p>
        </div>
      )}

      {status === "error" && (
        <div className="pad" style={{ background: "var(--paper)", border: "1px solid var(--rule)", borderRadius: "var(--r)" }}>
          <div className="banner is-bad">{statusError}</div>
          <a href="/instellingen" className="btn-text">
            Naar Verbindingen
          </a>
        </div>
      )}

      {/* ---------- STAP 1: adres + basistaak ---------- */}
      {status === "ready" && meta && !createdTaskUrl && step === "search" && (
        <div className="addr-grid">
          <section className="addr-find" aria-label="Adres zoeken">
            <h1>Welk pand neem je op?</h1>

            <button
              className="btn btn-primary btn-block"
              onClick={startNearbySearch}
              disabled={locating}
            >
              {locating && <span className="spinner on-accent" />}
              <span>{locating ? "Locatie ophalen…" : "📍 Locatie ophalen"}</span>
            </button>

            {locationError && <p className="note" style={{ color: "var(--bad)" }}>{locationError}</p>}

            <div className="search">
              <svg width="18" height="18" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <circle cx="7" cy="7" r="4.6" stroke="currentColor" strokeWidth="1.6" />
                <path d="M10.6 10.6 14 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
              <input
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setAddress(null);
                  setCreatedTaskUrl(null);
                  setShowManualSearch(true);
                }}
                placeholder="Of zoek op straat of postcode"
                aria-label="Zoek handmatig op adres"
              />
            </div>
            {searching && <p className="note">Zoeken…</p>}

            {nearby && nearby.length === 0 && <p className="note">Geen adressen gevonden in de buurt.</p>}

            {((nearby && nearby.length > 0) || (showManualSearch && suggestions.length > 0)) && (
              <div>
                <div className="list-head">
                  <span className="eyebrow">
                    {showManualSearch && suggestions.length > 0 ? "Zoekresultaten" : "Dichtstbijzijnde adressen"}
                  </span>
                </div>
                <ul className="rows">
                  {(showManualSearch && suggestions.length > 0
                    ? suggestions.map((a) => ({ ...a, distanceMeters: null as number | null }))
                    : (nearby ?? []).map((a) => ({ ...a, distanceMeters: a.distanceMeters as number | null }))
                  ).map((a) => (
                    <li key={a.id}>
                      <button className="row" onClick={() => selectAddress(a)}>
                        <span className="row-main">
                          <span className="row-street">{a.label}</span>
                        </span>
                        {a.distanceMeters !== null && (
                          <span className="row-dist">
                            {a.distanceMeters < 1000
                              ? `${a.distanceMeters} m`
                              : `${(a.distanceMeters / 1000).toFixed(1)} km`}
                          </span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <TodayAppointments onPick={pickFromAppointment} context="energielabel" onUseLocation={startNearbySearch} />
          </section>

          <section className="addr-detail" aria-label="Gekozen pand">
            {!address && !loadingAddress && (
              <div className="placeholder">
                <span className="placeholder-mark">
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path
                      d="M12 21s7-5.7 7-11a7 7 0 1 0-14 0c0 5.3 7 11 7 11Z"
                      stroke="currentColor"
                      strokeWidth="1.6"
                    />
                    <circle cx="12" cy="10" r="2.6" stroke="currentColor" strokeWidth="1.6" />
                  </svg>
                </span>
                <p>Bepaal je locatie of zoek een adres. De pandgegevens verschijnen hier.</p>
              </div>
            )}

            {loadingAddress && (
              <div className="pad">
                <div className="banner" style={{ background: "var(--inset)" }}>
                  <span className="spinner" />
                  <span>Pandgegevens ophalen uit de BAG…</span>
                </div>
              </div>
            )}

            {address && !loadingAddress && (
              <div className="pad">
                <span className="eyebrow">Controleer het adres</span>
                <div className="card">
                  {editingAddr ? (
                    <div className="addr-edit">
                      <div className="addr-edit-row">
                        <div className="field">
                          <label htmlFor="f-huisnr">Huisnummer</label>
                          <input
                            id="f-huisnr"
                            className="control"
                            inputMode="numeric"
                            value={addrHuisnummer}
                            onChange={(e) => setAddrHuisnummer(e.target.value)}
                          />
                        </div>
                        <div className="field">
                          <label htmlFor="f-huisletter">Letter</label>
                          <input
                            id="f-huisletter"
                            className="control"
                            value={addrHuisletter}
                            onChange={(e) => setAddrHuisletter(e.target.value)}
                          />
                        </div>
                        <div className="field">
                          <label htmlFor="f-toevoeging">Toevoeging</label>
                          <input
                            id="f-toevoeging"
                            className="control"
                            value={addrToevoeging}
                            onChange={(e) => setAddrToevoeging(e.target.value)}
                          />
                        </div>
                      </div>
                      <div className="addr-edit-row">
                        <div className="field is-wide">
                          <label htmlFor="f-postcode">Postcode</label>
                          <input
                            id="f-postcode"
                            className="control"
                            value={addrPostcode}
                            onChange={(e) => setAddrPostcode(e.target.value)}
                          />
                        </div>
                      </div>
                      <div className="addr-edit-actions">
                        <button className="btn btn-quiet" onClick={() => setEditingAddr(false)}>
                          Annuleren
                        </button>
                        <button className="btn btn-primary" onClick={saveAddressEdit}>
                          Opslaan
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="card-head">
                        <div className="card-head-row">
                          <div>
                            <h2>
                              {address.straatnaam} {houseNumber(address)}
                            </h2>
                            <p>
                              {address.postcode} {address.woonplaatsnaam}
                            </p>
                          </div>
                          <button className="btn-edit-addr" onClick={startEditingAddress}>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                              <path
                                d="M4 16.5V20h3.5L18.4 9.1a1.5 1.5 0 0 0 0-2.1l-1.4-1.4a1.5 1.5 0 0 0-2.1 0L4 16.5Z"
                                stroke="currentColor"
                                strokeWidth="1.8"
                                strokeLinejoin="round"
                              />
                            </svg>
                            Aanpassen
                          </button>
                        </div>
                      </div>
                      <dl className="facts">
                        <div className="fact">
                          <dt>Bouwjaar</dt>
                          <dd>{address.bouwjaar ?? "Onbekend"}</dd>
                        </div>
                      </dl>
                    </>
                  )}
                </div>

                <div className="section">
                  <div className="section-head">
                    <h2>Nieuwe taak in ClickUp</h2>
                  </div>
                  <div className="section-body">
                    <div className="field is-wide">
                      <label>Taaknaam</label>
                      <p className="note" style={{ padding: 0, margin: 0 }}>{titel}</p>
                    </div>

                    <div className="field">
                      <label htmlFor="f-priority">Prioriteit</label>
                      <select
                        id="f-priority"
                        className="control"
                        value={priority}
                        onChange={(e) => setPriority(e.target.value)}
                      >
                        {PRIORITIES.map((p) => (
                          <option key={p} value={p}>
                            {p}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="field">
                      <label htmlFor="f-status">Status</label>
                      <select
                        id="f-status"
                        className="control"
                        value={taskStatus}
                        onChange={(e) => setTaskStatus(e.target.value)}
                      >
                        {meta.statuses.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>

                <button className="btn btn-primary btn-block" onClick={goToFields}>
                  Verder naar technische velden →
                </button>
              </div>
            )}
          </section>
        </div>
      )}

      {/* ---------- STAP 2: technische velden, pagina-breed ---------- */}
      {status === "ready" && meta && !createdTaskUrl && step === "fields" && address && (
        <>
          {renderPinnedHead(
            <div className="topline">
              <button className="btn-back" onClick={() => setStep("search")}>
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M10 12.5 5.5 8 10 3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Terug naar adres
              </button>
              <h2 style={{ fontSize: 17 }}>{titel}</h2>
            </div>
          )}

          {showRequiredErrors && requiredError && (
            <div className="banner is-bad" style={{ margin: "0 0 16px" }}>{requiredError}</div>
          )}

          <div className="sections">
            {technicalGroups.map((group) => {
              const collapsed = collapsedGroups.has(group.key);
              const missingHere = missingByGroup.get(group.key) ?? 0;
              return (
                <div className="section" key={group.key}>
                  <button
                    type="button"
                    className="section-head section-head-toggle"
                    onClick={() => toggleGroup(group.key)}
                    aria-expanded={!collapsed}
                  >
                    <h2>{group.title}</h2>
                    {/* Een ingeklapte groep mag niet verbergen dat er nog
                        verplichte velden leeg staan. */}
                    {missingHere > 0 && (
                      <span className="section-missing">
                        {missingHere} nog leeg
                      </span>
                    )}
                    <span className="section-count">{group.fields.length} velden</span>
                    <svg
                      className={`chev${collapsed ? "" : " is-open"}`}
                      width="16"
                      height="16"
                      viewBox="0 0 16 16"
                      fill="none"
                      aria-hidden="true"
                    >
                      <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                  {!collapsed && (
                    <div className="section-body">{group.fields.map(renderField)}</div>
                  )}
                </div>
              );
            })}

            {/* D1 hoort qua nummering bij de documentatie, maar bepaalt de
                indeling van al het werk daarna — dus vullen we het hier in,
                als afsluiting van de technische velden. */}
            {rekenzonesField && (
              <div className="section">
                <div className="section-head">
                  <h2>{rekenzonesField.name}</h2>
                </div>
                <div className="section-body is-single-wide">{renderField(rekenzonesField)}</div>
              </div>
            )}
          </div>

          <div className="form-foot">
            <button className="btn btn-quiet is-danger" onClick={resetSearch}>
              Annuleren
            </button>
            {/* Vóór het klikken laten zien wat er nog mist, met één tik naar
                het eerste lege veld — i.p.v. een foutmelding bovenaan waarin
                je zelf de veldnamen moet terugzoeken. */}
            {missingRequiredFields.length > 0 ? (
              <button type="button" className="form-foot-missing" onClick={jumpToFirstMissing}>
                Nog {missingRequiredFields.length}{" "}
                {missingRequiredFields.length === 1 ? "verplicht veld" : "verplichte velden"} leeg — ga
                erheen →
              </button>
            ) : (
              <span className="form-foot-ok">✓ Alle verplichte velden ingevuld</span>
            )}
            <button className="btn btn-primary" onClick={goToDropboxStep}>
              Verder naar Dropbox →
            </button>
          </div>
        </>
      )}

      {/* ---------- STAP 3: documentatie + Dropbox, laatste stap ---------- */}
      {status === "ready" && meta && !createdTaskUrl && step === "dropbox" && address && (
        <>
          {renderPinnedHead(
            <div className="topline">
              <button className="btn-back" onClick={() => setStep("fields")}>
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M10 12.5 5.5 8 10 3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Terug
              </button>
              <h2 style={{ fontSize: 17 }}>{titel}</h2>
            </div>
          )}

          <div className="sections">
            {documentationGroup && (
              <div className="section">
                <div className="section-head">
                  <h2>Overig — {documentationGroup.title}</h2>
                  <span className="section-count">{documentationRestFields.length} velden</span>
                </div>
                <div className="section-body">{documentationRestFields.map(renderField)}</div>
              </div>
            )}
          </div>

          <div className="form-foot">
            <button className="btn btn-quiet is-danger" onClick={resetSearch}>
              Annuleren
            </button>
            <button className="btn btn-primary" onClick={goToDocumentsStep}>
              Verder naar Documenten →
            </button>
          </div>
        </>
      )}

      {/* ---------- STAP 4: documenten (D2 t/m D5), laatste stap ---------- */}
      {status === "ready" && meta && !createdTaskUrl && step === "documents" && address && (
        <>
          <div className="topline">
            <button className="btn-back" onClick={() => setStep("dropbox")}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M10 12.5 5.5 8 10 3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Terug
            </button>
            <h2 style={{ fontSize: 17 }}>{titel}</h2>
          </div>

          <div className="sections">
            {renderDropboxCard()}

            <div className="section">
              <div className="section-head">
                <h2>Documenten</h2>
                <button type="button" className="btn-refresh" onClick={goToDocumentsStep} disabled={docFilesLoading}>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true" className={docFilesLoading ? "spin" : undefined}>
                    <path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  {docFilesLoading ? "Bezig met verversen…" : "Verversen"}
                </button>
              </div>
              <div className="doc-list">
                {DOCUMENT_FIELDS.map((d) => {
                  const files = docFiles[d.key];
                  const missing = dropboxFolder && !docFilesLoading && files && files.length === 0;
                  return (
                    <div className={`doc-row${missing ? " is-missing" : ""}`} key={d.key}>
                      <div className="doc-row-head">
                        <span className="doc-title">{d.label}</span>
                        <span className="doc-row-head-right">
                          <span className="doc-folder">Dropbox: {d.folder}</span>
                          {docFolderUrls[d.key] && (
                            <a
                              href={docFolderUrls[d.key]!}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="doc-open-folder"
                            >
                              Uploaden
                              <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                                <path d="M6 4h6v6M12 4 4 12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                              </svg>
                            </a>
                          )}
                        </span>
                      </div>
                      <input
                        ref={(el) => {
                          docInputRefs.current[d.key] = el;
                        }}
                        type="file"
                        multiple
                        style={{ display: "none" }}
                        onChange={(e) => {
                          const chosen = [...(e.target.files ?? [])];
                          e.target.value = "";
                          if (!dropboxFolder) return;
                          for (const file of chosen)
                            enqueue(dropboxFolder.path, d.folder, file, meta?.account.username ?? null);
                        }}
                      />
                      <button
                        type="button"
                        className="btn-pick-file"
                        disabled={!dropboxFolder}
                        onClick={() => docInputRefs.current[d.key]?.click()}
                        style={{ marginBottom: 8 }}
                      >
                        <span className="conn-icon is-dropbox" style={{ width: 16, height: 16 }}>
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                            <path
                              d="M7 3 2 6.3 7 9.6 2 12.9l5 3.3 5-3.3 5 3.3 5-3.3-5-3.3 5-3.3-5-3.3-5 3.3-5-3.3Zm5 15 5-3.3v2.2L12 20l-5-3.1v-2.2l5 3.3Z"
                              fill="currentColor"
                            />
                          </svg>
                        </span>
                        Bestand kiezen
                      </button>

                      {uploadTaken
                        .filter((t) => t.folder === d.folder && t.dropbox !== "done")
                        .map((t) => (
                          <div key={t.id} className="doc-upload-progress">
                            <span className="note" style={{ padding: 0, fontWeight: 600, color: "var(--ink)" }}>
                              {t.name}
                            </span>
                            {t.dropbox === "uploading" && (
                              <>
                                <div className="doc-upload-bar">
                                  <div className="doc-upload-bar-fill" style={{ width: `${t.pct}%` }} />
                                </div>
                                <span className="note" style={{ padding: 0 }}>
                                  Dropbox: {t.pct}%
                                  {formatEta(t.etaSeconds) && (
                                    <span className="upload-eta"> · nog {formatEta(t.etaSeconds)}</span>
                                  )}
                                </span>
                              </>
                            )}
                            {t.dropbox === "error" && (
                              <span className="note" style={{ padding: 0, color: "var(--bad)" }}>
                                ⚠ {t.dropboxError}
                              </span>
                            )}
                          </div>
                        ))}

                      {!dropboxFolder ? (
                        <p className="note" style={{ padding: 0, margin: 0 }}>
                          Dropbox-map nog niet aangemaakt.
                        </p>
                      ) : docFilesLoading && !files ? (
                        <p className="note" style={{ padding: 0, margin: 0 }}>Bestanden ophalen…</p>
                      ) : files && files.length > 0 ? (
                        <ul className="doc-files">
                          {files.map((f) => (
                            <li key={f.name} className="has-actions">
                              <span className="doc-file-line">
                                <span className="doc-file-check" aria-hidden="true">✓</span>
                                <span className="doc-file-name" title={f.name}>{f.name}</span>
                                <button
                                  type="button"
                                  className="doc-file-del"
                                  aria-label={`${f.name} verwijderen`}
                                  onClick={() =>
                                    setTeVerwijderen(
                                      teVerwijderen === `${d.folder}/${f.name}` ? null : `${d.folder}/${f.name}`
                                    )
                                  }
                                >
                                  ✕
                                </button>
                              </span>
                              {teVerwijderen === `${d.folder}/${f.name}` && (
                                <span className="doc-file-confirm">
                                  <span>Verwijderen?</span>
                                  <button
                                    type="button"
                                    className="doc-file-yes"
                                    disabled={verwijderBezig === `${d.folder}/${f.name}`}
                                    onClick={() => verwijderDocBestand(d.folder, f.name)}
                                  >
                                    {verwijderBezig === `${d.folder}/${f.name}` ? "Bezig…" : "Ja, verwijder"}
                                  </button>
                                  <button type="button" className="doc-file-no" onClick={() => setTeVerwijderen(null)}>
                                    Nee
                                  </button>
                                </span>
                              )}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="note" style={{ padding: 0, margin: 0 }}>
                          Nog niets geüpload naar deze map.
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="form-foot">
            <button className="btn btn-quiet is-danger" onClick={resetSearch}>
              Annuleren
            </button>
            <button
              className="btn btn-primary"
              onClick={submitTask}
              disabled={creating || lopendeUploads > 0}
              title={
                lopendeUploads > 0
                  ? "De foto's staan nog niet allemaal in Dropbox; ClickUp zou ze dan missen."
                  : undefined
              }
            >
              {(creating || lopendeUploads > 0) && <span className="spinner on-accent" />}
              <span>
                {lopendeUploads > 0
                  ? `Nog ${lopendeUploads} bestand${lopendeUploads === 1 ? "" : "en"} aan het uploaden…`
                  : creating
                    ? "Bezig…"
                    : "Taak aanmaken in ClickUp"}
              </span>
            </button>
          </div>
          {createError && (
            <div className="pad" style={{ paddingTop: 0 }}>
              <p className="note" style={{ color: "var(--bad)" }}>{createError}</p>
            </div>
          )}
        </>
      )}

      {createdTaskUrl && (
        <div className="pad" style={{ background: "var(--paper)", border: "1px solid var(--rule)", borderRadius: "var(--r)" }}>
          <div className="banner is-ok">✓ Taak aangemaakt in ClickUp.</div>

          <div className="result-links">
            <a href={createdTaskUrl} target="_blank" rel="noopener noreferrer" className="result-link is-clickup">
              <span className="result-link-icon">
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M6 14l6-5 6 5-6 5-6-5Z" fill="currentColor" />
                </svg>
              </span>
              <span className="result-link-text">
                <b>Open taak in ClickUp</b>
                <span>Bekijk en werk de opname verder af</span>
              </span>
              <svg className="result-link-arrow" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M6 4h6v6M12 4 4 12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </a>

            {dropboxFolderUrl ? (
              <a href={dropboxFolderUrl} target="_blank" rel="noopener noreferrer" className="result-link is-dropbox">
                <span className="result-link-icon">
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path
                      d="M7 3 2 6.3 7 9.6 2 12.9l5 3.3 5-3.3 5 3.3 5-3.3-5-3.3 5-3.3-5-3.3-5 3.3-5-3.3Zm5 15 5-3.3v2.2L12 20l-5-3.1v-2.2l5 3.3Z"
                      fill="currentColor"
                    />
                  </svg>
                </span>
                <span className="result-link-text">
                  <b>Open Dropbox-map</b>
                  <span>Alle documenten voor dit adres</span>
                </span>
                <svg className="result-link-arrow" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M6 4h6v6M12 4 4 12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </a>
            ) : (
              <p className="note" style={{ padding: 0, margin: 0 }}>
                Geen Dropbox-map aangemaakt — Dropbox is nog niet gekoppeld
                (zie Verbindingen).
              </p>
            )}
          </div>

          {attachmentWarnings.length > 0 && (
            <div className="note" style={{ color: "var(--bad)" }}>
              {attachmentWarnings.map((w) => (
                <p key={w} style={{ margin: "2px 0" }}>⚠ {w}</p>
              ))}
              <p style={{ margin: "8px 0 0", color: "var(--ink-soft)" }}>
                De taak staat er wel — alleen deze bijlagen ontbreken nog. De bestanden staan veilig in
                Dropbox, dus opnieuw proberen kan zonder risico.
              </p>
            </div>
          )}

          {/* Nooit doodlopen op een foutmelding: het overzetten is met één tik
              opnieuw te starten, en de bestanden staan al in Dropbox. */}
          {mislukteDocs.length > 0 && (
            <button
              className="btn btn-primary btn-block"
              onClick={probeerBijlagenOpnieuw}
              disabled={opnieuwBezig}
              style={{ marginBottom: 10 }}
            >
              {opnieuwBezig && <span className="spinner on-accent" />}
              <span>
                {opnieuwBezig
                  ? "Bezig met opnieuw overzetten…"
                  : `Bijlagen opnieuw overzetten (${mislukteDocs.length})`}
              </span>
            </button>
          )}

          <button
            className={mislukteDocs.length > 0 ? "btn btn-quiet btn-block" : "btn btn-primary btn-block"}
            onClick={resetSearch}
          >
            Nieuwe opdracht
          </button>
        </div>
      )}

      {uploadProgress && (
        <div className="upload-overlay">
          <div className="upload-modal" role="dialog" aria-label="Bezig met uploaden naar ClickUp">
            <h3>Bezig met uploaden naar ClickUp…</h3>
            <ul className="upload-list">
              <li className={uploadProgress.taskDone ? "is-done" : "is-busy"}>
                {uploadProgress.taskDone ? (
                  <span className="upload-check" aria-hidden="true">✓</span>
                ) : (
                  <span className="spinner" aria-hidden="true" />
                )}
                ClickUp-taak aanmaken
              </li>
              {DOCUMENT_FIELDS.map((d) => {
                const s = uploadProgress.docs[d.key];
                return (
                  <li key={d.key} className={s === "done" || s === "skip" ? "is-done" : s === "error" ? "is-error" : "is-busy"}>
                    {s === "done" || s === "skip" ? (
                      <span className="upload-check" aria-hidden="true">✓</span>
                    ) : s === "error" ? (
                      <span className="upload-warn" aria-hidden="true">⚠</span>
                    ) : (
                      <span className="spinner" aria-hidden="true" />
                    )}
                    {d.label}
                  </li>
                );
              })}
            </ul>
            <p className="upload-timer">Bezig: {uploadElapsed}s</p>
          </div>
        </div>
      )}
    </>
  );
}
