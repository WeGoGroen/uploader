"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useIkBen } from "@/components/RechtenProvider";
import { enqueue, getServerSnapshot, getSnapshot, subscribe } from "@/lib/upload-queue";
import { MEDIA_STAPPEN, type MediaStap } from "@/lib/media-folders";
import TodayAppointments from "@/components/TodayAppointments";
import type { AddressDetails, AddressSuggestion, NearbyAddress } from "@/lib/pdok";
import { meldAfgerond, meldGestart, startHartslag, type OpnameMelding } from "@/lib/opname-melden";
import {
  alleMediaSessies,
  bewaarMediaSessie,
  vergeetMediaSessie,
  type MediaSessie,
} from "@/lib/media-sessie";

interface DropboxFolder {
  path: string;
  url: string;
  /** Submappen die zijn klaargezet, zodat de balk kan tonen wat er staat. */
  subfolders?: string[];
}

function houseNumber(a: {
  huisnummer: number;
  huisletter: string | null;
  huisnummertoevoeging?: string | null;
}) {
  return [a.huisnummer, a.huisletter ?? "", a.huisnummertoevoeging ? `-${a.huisnummertoevoeging}` : ""].join("");
}

type Stap = "adres" | "photos" | "video" | "360" | "klaar";

/**
 * Media-opname als één doorlopende flow: eerst het adres (met de afspraken van
 * vandaag), daarna per soort een eigen scherm — foto's, dan video, dan 360.
 *
 * Bewust stappen binnen één pagina en geen losse routes: het adres en de
 * Dropbox-map worden één keer bepaald en gelden voor alle drie de stappen.
 * Met aparte pagina's zou je het adres per soort opnieuw moeten kiezen, of
 * zou het via de URL doorgegeven moeten worden en bij een verkeerde link
 * stilletjes in de verkeerde map landen.
 *
 * De map wordt pas aangemaakt bij het eerste bestand, ná de adrescontrole —
 * eerder aanmaken liet bij elke adrescorrectie een lege map achter.
 */
export default function MediaFlow() {
  const [stap, setStap] = useState<Stap>("adres");
  // Opgeslagen opnames van dit apparaat. In state en niet direct uit
  // localStorage gelezen tijdens het renderen: opslag is geen React-bron, dus
  // een wijziging zou anders pas bij een toevallige hertekening zichtbaar zijn.
  const [sessies, setSessies] = useState<MediaSessie[]>([]);
  useEffect(() => setSessies(alleMediaSessies()), []);

  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<AddressSuggestion[]>([]);
  const [searching, setSearching] = useState(false);
  const [showManualSearch, setShowManualSearch] = useState(false);
  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [nearby, setNearby] = useState<NearbyAddress[] | null>(null);

  const [address, setAddress] = useState<AddressDetails | null>(null);
  const [loadingAddress, setLoadingAddress] = useState(false);

  const [folder, setFolder] = useState<DropboxFolder | null>(null);
  const [folderBusy, setFolderBusy] = useState(false);
  const [folderError, setFolderError] = useState<string | null>(null);
  const folderInFlight = useRef<Promise<DropboxFolder | null> | null>(null);

  // Uit de sessie: zonder ClickUp-token gaf dit null, en dan kreeg de
  // opname geen eigenaar.
  const account = useIkBen();
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Vaste kop bovenaan, zelfde patroon als de energielabel-flow: meet de
  // werkelijke hoogte zodat de rest van de pagina er niet onder schuift.
  const [pinnedHeadHeight, setPinnedHeadHeight] = useState(0);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const pinnedHeadRef = (el: HTMLDivElement | null) => {
    resizeObserverRef.current?.disconnect();
    if (!el) return;
    const ro = new ResizeObserver((entries) => setPinnedHeadHeight(entries[0].contentRect.height + 12));
    ro.observe(el);
    resizeObserverRef.current = ro;
  };

  const huidige: MediaStap | null = MEDIA_STAPPEN.find((s) => s.key === stap) ?? null;
  const stapIndex = huidige ? MEDIA_STAPPEN.indexOf(huidige) : -1;

  const alleTaken = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const takenVanOpname = useMemo(
    () => alleTaken.filter((t) => t.folderPath === (folder?.path ?? "")),
    [alleTaken, folder]
  );
  const taken = useMemo(
    () => (huidige ? takenVanOpname.filter((t) => t.folder === huidige.map) : []),
    [takenVanOpname, huidige]
  );

  // Vanuit het dashboard via /media?addr=<adres>: meteen doorzoeken en
  // selecteren, zodat je niet opnieuw hoeft te zoeken naar een adres dat je
  // net al in de lijst met openstaand werk zag staan.
  useEffect(() => {
    const addr = new URLSearchParams(window.location.search).get("addr");
    if (addr) void pickFromAppointment(addr);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Zodra het adres vaststaat en je op een uploadstap komt: de map alvast
  // klaarzetten. Dan staat het pad al in de balk bovenaan vóór je het eerste
  // bestand kiest, en scheelt het wachten op het moment dat je wél haast hebt.
  //
  // Eén poging per adres, bijgehouden in een ref. Met `folderBusy` als
  // voorwaarde ontstond een lus: bij een fout sprong die terug op false,
  // waarna het effect opnieuw afvuurde en het opnieuw probeerde — gemeten
  // 216 aanroepen bij één keer openen van de pagina. Een ref verandert niets
  // aan de render en kan het effect dus ook niet opnieuw aanzetten.
  const mapGeprobeerdVoor = useRef<string | null>(null);
  useEffect(() => {
    if (!address || folder || !huidige) return;
    const sleutel = `${address.straatnaam} ${houseNumber(address)}, ${address.woonplaatsnaam}`;
    if (mapGeprobeerdVoor.current === sleutel) return;
    mapGeprobeerdVoor.current = sleutel;
    void zorgVoorMap();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, huidige, folder]);

  // Eén id per opname, zodat de server dezelfde opname bijwerkt i.p.v. bij
  // elke hartslag een nieuwe aan te maken. Hangt aan de projectmap: dat is
  // wat een media-opname uniek maakt.
  const melding: OpnameMelding | null =
    address && folder
      ? {
          id: `media-${folder.path}`,
          soort: "media",
          straatnaam: `${address.straatnaam} ${houseNumber(address)}`,
          postcode: address.postcode,
          woonplaats: address.woonplaatsnaam,
          accountName: account,
        }
      : null;

  // De server weet nu dát er een media-opname loopt, en blijft dat weten
  // zolang de pagina open staat — anders zou een uur fotograferen als
  // "gestopt" gelezen worden.
  useEffect(() => {
    if (!melding) return;
    meldGestart(melding);
    return startHartslag(melding);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [melding?.id, melding?.accountName]);

  // Onthouden waar je was, zodat terugkomen niet betekent: adres opnieuw
  // opzoeken. Alleen zinvol zodra de map bestaat — dat is het moment waarop er
  // ook echt iets te hervatten valt.
  useEffect(() => {
    if (!address || !folder || !huidige) return;
    bewaarMediaSessie({
      folderPath: folder.path,
      folderUrl: folder.url,
      subfolders: folder.subfolders ?? [],
      address,
      stap: huidige.key,
    });
  }, [address, folder, huidige]);

  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    // Ook stoppen zodra er een adres gekozen is: setQuery(label) zet anders
    // meteen een nieuwe zoekopdracht in gang en knippert de lijst terug.
    if (query.trim().length < 3 || address || loadingAddress) {
      setSuggestions([]);
      return;
    }
    debounce.current = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(`/api/address/search?q=${encodeURIComponent(query)}`);
        const data = await res.json();
        setSuggestions(data.suggestions ?? []);
      } catch {
        setSuggestions([]);
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [query, address, loadingAddress]);

  function startNearbySearch() {
    setLocationError(null);
    setNearby(null);
    setAddress(null);
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

  async function kiesAdres(s: AddressSuggestion) {
    setSuggestions([]);
    setNearby(null);
    setQuery(s.label);
    setLoadingAddress(true);
    setAddress(null);
    setFolder(null);
    setFolderError(null);
    // Nieuw adres: de poging-rem weer vrijgeven.
    mapGeprobeerdVoor.current = null;
    try {
      const res = await fetch(`/api/address/details?id=${encodeURIComponent(s.id)}`);
      const data = await res.json();
      const gevonden: AddressDetails | null = data.details ?? null;
      setAddress(gevonden);
      // Adres staat vast: door naar de eerste soort.
      if (gevonden) setStap("photos");
    } finally {
      setLoadingAddress(false);
    }
  }

  async function pickFromAppointment(addressText: string) {
    setQuery(addressText);
    setAddress(null);
    setShowManualSearch(true);
    setSearching(true);
    try {
      const res = await fetch(`/api/address/search?q=${encodeURIComponent(addressText)}`);
      const data = await res.json();
      const beste: AddressSuggestion | undefined = data.suggestions?.[0];
      if (beste) await kiesAdres(beste);
      else setSuggestions(data.suggestions ?? []);
    } finally {
      setSearching(false);
    }
  }

  async function zorgVoorMap(): Promise<DropboxFolder | null> {
    if (folder) return folder;
    if (!address) return null;
    // Loopt er al een aanvraag, dan die afwachten: een dubbeltik op een iPad
    // vuurt beide clicks af vóórdat React de nieuwe state getekend heeft.
    if (folderInFlight.current) return folderInFlight.current;
    const run = (async () => {
      setFolderBusy(true);
      setFolderError(null);
      try {
        const res = await fetch("/api/dropbox/folder", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            woonplaats: address.woonplaatsnaam,
            straatEnNummer: `${address.straatnaam} ${houseNumber(address)}`,
            kind: "media",
          }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.path) {
          setFolderError(data?.error ?? "De Dropbox-map kon niet worden aangemaakt.");
          return null;
        }
        setFolder(data);
        return data as DropboxFolder;
      } catch {
        setFolderError("De Dropbox-map kon niet worden aangemaakt.");
        return null;
      } finally {
        setFolderBusy(false);
      }
    })();
    folderInFlight.current = run;
    try {
      return await run;
    } finally {
      folderInFlight.current = null;
    }
  }

  /**
   * De bestanden zijn hier al een gewone array: de aanroeper kopieert de
   * FileList synchroon vóórdat het invoerveld leeggemaakt wordt. Dat is geen
   * detail — een FileList is een levende verwijzing naar het invoerveld, dus
   * na `value = ""` was hij leeg tegen de tijd dat deze functie na de eerste
   * await verderging. Gevolg: je koos foto's en er gebeurde niets.
   */
  async function kiesBestanden(bestanden: File[]) {
    if (bestanden.length === 0 || !huidige) return;
    const doel = await zorgVoorMap();
    if (!doel) return;
    for (const file of bestanden) enqueue(doel.path, huidige.map, file, account);
  }

  /**
   * Terug in een eerder gestarte opname. Alles komt uit de lokale opslag, dus
   * dit is meteen klaar: geen adres opnieuw opzoeken, geen wachten op de BAG.
   */
  function hervat(sessie: MediaSessie) {
    setAddress(sessie.address);
    setFolder({ path: sessie.folderPath, url: sessie.folderUrl, subfolders: sessie.subfolders });
    setFolderError(null);
    setQuery("");
    setSuggestions([]);
    setNearby(null);
    setStap((sessie.stap as Stap) ?? "photos");
    window.scrollTo(0, 0);
  }

  function opnieuwBeginnen() {
    // Verse lijst bij terugkeer naar de adresstap: dat is de enige plek waar
    // hij getoond wordt, en hier is het een gebeurtenis en geen effect.
    setSessies(alleMediaSessies());
    setStap("adres");
    setQuery("");
    setSuggestions([]);
    setNearby(null);
    setLocationError(null);
    setShowManualSearch(false);
    setAddress(null);
    setFolder(null);
    setFolderError(null);
  }

  function volgende() {
    const volgend = MEDIA_STAPPEN[stapIndex + 1];
    // Bij de laatste stap is de opname afgerond; zonder dit blijft hij als
    // "niet afgemaakt" gelden en krijg je er een herinnering over.
    if (!volgend && melding) meldAfgerond(melding);
    setStap(volgend ? volgend.key : "klaar");
    window.scrollTo(0, 0);
  }

  function vorige() {
    const vorig = MEDIA_STAPPEN[stapIndex - 1];
    setStap(vorig ? vorig.key : "adres");
    window.scrollTo(0, 0);
  }

  const bezigTotaal = takenVanOpname.filter((t) => t.dropbox === "uploading").length;

  /**
   * Scherm wakker houden zolang er iets omhoog gaat. Een webpagina kan niet
   * doorwerken als iOS het tabblad opschort — valt het scherm in slaap, dan
   * stopt de upload en gaat hij pas verder als je de app weer opent. Dit is
   * het enige wat een webapp daar realistisch tegen kan doen; Safari kent
   * geen achtergrond-upload.
   */
  useEffect(() => {
    if (bezigTotaal === 0) return;
    type Slot = { release: () => Promise<void> };
    let slot: Slot | null = null;
    let losgelaten = false;
    const wakeLock = (navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<Slot> } })
      .wakeLock;
    void wakeLock
      ?.request("screen")
      .then((s) => {
        if (losgelaten) void s.release();
        else slot = s;
      })
      // Geweigerd of niet ondersteund: dan werkt uploaden gewoon door, alleen
      // zonder deze bescherming.
      .catch(() => {});
    return () => {
      losgelaten = true;
      void slot?.release().catch(() => {});
    };
  }, [bezigTotaal]);


  /**
   * Media-opnames op dit apparaat waar nog iets loopt of is blijven liggen.
   * Zelfde gedachte als "Nog af te maken" op het dashboard: de wachtrij loopt
   * door als je wegklikt, dus je moet er ook weer in kunnen.
   */
  const lopendeOpnames = useMemo(() => {
    return sessies
      .map((sessie) => {
        const eigen = alleTaken.filter((t) => t.folderPath === sessie.folderPath);
        const bezig = eigen.filter((t) => t.dropbox === "uploading").length;
        const mislukt = eigen.filter((t) => t.dropbox === "error").length;
        const klaar = eigen.filter((t) => t.dropbox === "done").length;
        const meetbaar = eigen.filter((t) => t.dropbox !== "error");
        const pct =
          bezig > 0 && meetbaar.length > 0
            ? Math.round(
                meetbaar.reduce((tot, t) => tot + (t.dropbox === "done" ? 100 : t.pct), 0) /
                  meetbaar.length
              )
            : null;
        // Per onderdeel apart, zodat te zien is wélk deel nog loopt — één
        // opgeteld getal verbergt dat de foto's klaar zijn en de video niet.
        const onderdelen = MEDIA_STAPPEN.map((st) => {
          const vanStap = eigen.filter((t) => t.folder === st.map);
          return {
            key: st.key,
            naam: st.naam,
            bezig: vanStap.filter((t) => t.dropbox === "uploading").length,
            klaar: vanStap.filter((t) => t.dropbox === "done").length,
            mislukt: vanStap.filter((t) => t.dropbox === "error").length,
            totaal: vanStap.length,
          };
        }).filter((o) => o.totaal > 0);
        return { sessie, bezig, mislukt, klaar, totaal: eigen.length, pct, onderdelen };
      })
      // Ook opnames zonder lopende upload horen erbij: sluit je de iPad en is
      // de wachtrij leeg, dan is er nog steeds een half afgemaakte opname om
      // in terug te keren. Alleen op de wachtrij filteren liet die verdwijnen.
      .map((r) => ({
        ...r,
        status: r.bezig > 0 ? ("bezig" as const) : r.mislukt > 0 ? ("mislukt" as const) : ("open" as const),
      }));
  }, [alleTaken, sessies]);
  // Alleen de mappen waar daadwerkelijk iets in geüpload wordt; de kale "in"
  // is een tussenlaag en zegt de opnemer niets.
  const mediaSubmappen = (folder?.subfolders ?? []).filter((naam) => naam.includes("/"));

  function renderDropboxBalk() {
    return (
      <div className={`dbx-strip${folder ? " is-ready" : ""}`}>
        <div className="dbx-strip-top">
          <span className="conn-icon is-dropbox dbx-strip-icon">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M7 3 2 6.3 7 9.6 2 12.9l5 3.3 5-3.3 5 3.3 5-3.3-5-3.3 5-3.3-5-3.3-5 3.3-5-3.3Zm5 15 5-3.3v2.2L12 20l-5-3.1v-2.2l5 3.3Z"
                fill="currentColor"
              />
            </svg>
          </span>
          <span className={`dbx-strip-text${folder ? "" : " is-wrap"}`}>
            {folderBusy ? (
              <>
                <span className="spinner" /> Dropbox-map klaarzetten…
              </>
            ) : folderError ? (
              <span className="is-warning-row">⚠ {folderError}</span>
            ) : folder ? (
              <>
                <span className="dbx-strip-check" aria-hidden="true">
                  ✓
                </span>
                <span className="dbx-folder-path">
                  {folder.path}
                  {huidige ? `/${huidige.map}` : ""}
                </span>
              </>
            ) : (
              "Map wordt klaargezet…"
            )}
          </span>
          {bezigTotaal > 0 && <span className="dbx-strip-progress-label">{bezigTotaal} bezig</span>}
          {folder && (
            <a href={folder.url} target="_blank" rel="noopener noreferrer" className="btn-open-dbx">
              Openen
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M6 4h6v6M12 4 4 12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </a>
          )}
        </div>

        {/* Welke mappen er klaarstaan, met per map hoeveel er al in zit. Zo is
            te zien dat de structuur er is zonder Dropbox te openen. */}
        {folder && mediaSubmappen.length > 0 && (
          <div className="dbx-strip-docs">
            {mediaSubmappen.map((naam) => {
              const stapVanMap = MEDIA_STAPPEN.find((st) => st.map === naam);
              const aantal = takenVanOpname.filter(
                (t) => t.folder === naam && t.dropbox === "done"
              ).length;
              const actief = stapVanMap && huidige && stapVanMap.key === huidige.key;
              return (
                <div key={naam} className={`dbx-strip-doc-row${aantal > 0 ? " is-done" : ""}`}>
                  {aantal > 0 ? (
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <path d="M3.5 8.5 6.5 11.5 12.5 4.5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  ) : (
                    <span className="dbx-strip-doc-empty" aria-hidden="true" />
                  )}
                  <span className="dbx-strip-doc-label">
                    {naam}
                    {actief && <span className="dbx-strip-doc-now">hier</span>}
                  </span>
                  <span className="dbx-strip-doc-status">
                    {aantal > 0 ? `${aantal} bestand${aantal === 1 ? "" : "en"}` : "leeg"}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  /**
   * Wat er per onderdeel nog loopt. Staat onder de Dropbox-balk in de vaste
   * kop, zodat een video die nog omhoog gaat in beeld blijft terwijl je al bij
   * 360 bezig bent — anders lijkt het alsof die upload gestopt is zodra je
   * doorklikt.
   */
  function renderVoortgangPerOnderdeel() {
    const regels = MEDIA_STAPPEN.map((st) => {
      const eigen = takenVanOpname.filter((t) => t.folder === st.map);
      const bezig = eigen.filter((t) => t.dropbox === "uploading");
      const mislukt = eigen.filter((t) => t.dropbox === "error").length;
      const klaar = eigen.filter((t) => t.dropbox === "done").length;
      const pct =
        bezig.length > 0
          ? Math.round(
              eigen
                .filter((t) => t.dropbox !== "error")
                .reduce((tot, t) => tot + (t.dropbox === "done" ? 100 : t.pct), 0) /
                Math.max(1, eigen.filter((t) => t.dropbox !== "error").length)
            )
          : null;
      return { st, bezigAantal: bezig.length, mislukt, klaar, totaal: eigen.length, pct };
    }).filter((r) => r.bezigAantal > 0 || r.mislukt > 0);

    if (regels.length === 0) return null;

    return (
      <div className="mediabalk">
        {regels.map((r) => (
          <div key={r.st.key} className={`mediabalk-rij${r.bezigAantal === 0 ? " is-bad" : ""}`}>
            <span className="mediabalk-naam">{r.st.naam}</span>
            <span className="mediabalk-staat">
              {r.bezigAantal > 0
                ? `${r.klaar}/${r.totaal} klaar`
                : `${r.mislukt} mislukt`}
            </span>
            {r.pct !== null && (
              <>
                <span className="mediabalk-bar">
                  <span className="mediabalk-bar-fill" style={{ width: `${r.pct}%` }} />
                </span>
                <span className="mediabalk-pct">{r.pct}%</span>
              </>
            )}
          </div>
        ))}
      </div>
    );
  }

  /** Waar je in de flow bent: 1 Foto's → 2 Video → 3 360. */
  function renderStappen() {
    return (
      <ol className="media-steps" aria-label="Stappen">
        {MEDIA_STAPPEN.map((s, i) => {
          const gedaan = stap === "klaar" || i < stapIndex;
          const nu = s.key === stap;
          const aantal = takenVanOpname.filter((t) => t.folder === s.map && t.dropbox === "done").length;
          return (
            <li key={s.key} className={`media-step${nu ? " is-now" : ""}${gedaan ? " is-done" : ""}`}>
              <span className="media-step-nr" aria-hidden="true">
                {i + 1}
              </span>
              <span className="media-step-label">
                {s.naam}
                {aantal > 0 && <span className="media-step-count">{aantal}</span>}
              </span>
            </li>
          );
        })}
      </ol>
    );
  }

  // ---------- Stap 1: adres ----------
  if (stap === "adres" || !address) {
    return (
      <>
        <header className="topline">
          <span className="eyebrow">Upload media</span>
        </header>

        {loadingAddress ? (
          <div
            className="pad"
            style={{ background: "var(--paper)", border: "1px solid var(--rule)", borderRadius: "var(--r)" }}
          >
            <p className="note">Adresgegevens ophalen…</p>
          </div>
        ) : (
          <div className="addr-grid">
            <section className="addr-find" aria-label="Adres zoeken">
              <h1>Upload media</h1>
              <p className="lede">
                Kies het pand. Daarna doorloop je in drie stappen de foto&apos;s, de video en de
                360-opnames.
              </p>

              {lopendeOpnames.length > 0 && (
                <div className="media-lopend">
                  <div className="list-head">
                    <span className="eyebrow">Openstaande opnames</span>
                  </div>
                  <ul className="media-lopend-list">
                    {lopendeOpnames.map((r) => (
                      <li key={r.sessie.folderPath}>
                        {/* Een knop en geen link: hervatten gebeurt uit de
                            lokale opslag, dus zonder de pagina te herladen. */}
                        <button type="button" className="media-lopend-knop" onClick={() => hervat(r.sessie)}>
                          <span className="media-lopend-top">
                            <span className={`up-status is-${r.status}`}>
                              {r.status === "bezig"
                                ? "Bezig"
                                : r.status === "mislukt"
                                  ? "Vastgelopen"
                                  : "Openstaand"}
                            </span>
                            {r.pct !== null && <span className="media-lopend-pct">{r.pct}%</span>}
                          </span>
                          <span className="media-lopend-adres">
                            {r.sessie.address.straatnaam} {houseNumber(r.sessie.address)}
                          </span>
                          <span className="media-lopend-meta">
                            {r.status === "bezig"
                              ? `${r.bezig} van ${r.totaal} bestand${r.totaal === 1 ? "" : "en"} nog bezig`
                              : r.status === "mislukt"
                                ? `${r.mislukt} bestand${r.mislukt === 1 ? "" : "en"} mislukt`
                                : `${r.klaar} geüpload — verder waar je gebleven was`}
                          </span>
                          {r.onderdelen.length > 0 && (
                            <span className="media-lopend-delen">
                              {r.onderdelen.map((o) => (
                                <span
                                  key={o.key}
                                  className={`media-deel${
                                    o.bezig > 0 ? " is-bezig" : o.mislukt > 0 ? " is-bad" : " is-klaar"
                                  }`}
                                >
                                  {o.naam}{" "}
                                  <b>
                                    {o.bezig > 0
                                      ? `${o.klaar}/${o.totaal}`
                                      : o.mislukt > 0
                                        ? `${o.mislukt} mislukt`
                                        : `${o.klaar} klaar`}
                                  </b>
                                </span>
                              ))}
                            </span>
                          )}
                          {r.pct !== null && (
                            <span className="up-bar">
                              <span className="up-bar-fill" style={{ width: `${r.pct}%` }} />
                            </span>
                          )}
                        </button>
                        <button
                          type="button"
                          className="media-lopend-weg"
                          aria-label="Uit de lijst halen"
                          title="Uit de lijst halen"
                          onClick={() => {
                            vergeetMediaSessie(r.sessie.folderPath);
                            setSessies(alleMediaSessies());
                          }}
                        >
                          ✕
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {renderStappen()}

              <button className="btn btn-primary btn-block" onClick={startNearbySearch} disabled={locating}>
                {locating && <span className="spinner on-accent" />}
                <span>{locating ? "Locatie ophalen…" : "Locatie ophalen"}</span>
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
                        <button className="row" onClick={() => kiesAdres(a)}>
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

              <TodayAppointments
                onPick={(adres) => void pickFromAppointment(adres)}
                context="media"
                onUseLocation={startNearbySearch}
              />
            </section>

            <section className="addr-detail" aria-label="Gekozen pand">
              <div className="placeholder">
                <span className="placeholder-mark">
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M12 21s7-5.7 7-11a7 7 0 1 0-14 0c0 5.3 7 11 7 11Z" stroke="currentColor" strokeWidth="1.6" />
                    <circle cx="12" cy="10" r="2.6" stroke="currentColor" strokeWidth="1.6" />
                  </svg>
                </span>
                <p>
                  Kies een afspraak van vandaag, bepaal je locatie, of zoek een adres. Daarna gaan de
                  bestanden per soort naar Dropbox.
                </p>
              </div>
            </section>
          </div>
        )}
      </>
    );
  }

  // ---------- Slot ----------
  if (stap === "klaar") {
    return (
      <>
        <div className="pinned-head" ref={pinnedHeadRef}>
          <div className="topline">
            <button className="btn-back" onClick={() => setStap("360")}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M10 12.5 5.5 8 10 3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Terug
            </button>
            <h2 style={{ fontSize: 17 }}>
              {address.straatnaam} {houseNumber(address)}
            </h2>
          </div>
          {renderDropboxBalk()}
          {renderVoortgangPerOnderdeel()}
        </div>
        <div className="pinned-head-spacer" style={{ height: pinnedHeadHeight }} />

        <div
          className="pad"
          style={{ background: "var(--paper)", border: "1px solid var(--rule)", borderRadius: "var(--r)" }}
        >
          {renderStappen()}
          <h1>Klaar</h1>
          <p className="lede">
            {bezigTotaal > 0
              ? `Nog ${bezigTotaal} bestand${bezigTotaal === 1 ? "" : "en"} onderweg naar Dropbox — dat loopt door, ook als je dit scherm verlaat.`
              : takenVanOpname.length === 0
                ? // Niets gekozen: dan is "alles staat in Dropbox" een loze
                  // bevestiging van werk dat niet gedaan is.
                  "Er is niets geüpload voor dit adres. Ga terug om alsnog bestanden te kiezen."
                : "Alles staat in Dropbox."}
          </p>

          <ul className="media-files">
            {MEDIA_STAPPEN.map((s) => {
              const eigen = takenVanOpname.filter((t) => t.folder === s.map);
              const klaar = eigen.filter((t) => t.dropbox === "done").length;
              const mislukt = eigen.filter((t) => t.dropbox === "error").length;
              return (
                <li key={s.key}>
                  <span className="media-file-name">{s.naam}</span>
                  <span className="media-file-state">
                    {eigen.length === 0
                      ? "niets"
                      : `${klaar}/${eigen.length}${mislukt > 0 ? ` · ${mislukt} mislukt` : ""}`}
                  </span>
                </li>
              );
            })}
          </ul>

          <div className="form-foot" style={{ marginTop: 16 }}>
            <button className="btn btn-quiet" onClick={opnieuwBeginnen}>
              Nieuw adres
            </button>
            {folder && (
              <a className="btn btn-primary" href={folder.url} target="_blank" rel="noopener noreferrer">
                Openen in Dropbox
              </a>
            )}
          </div>
        </div>
      </>
    );
  }

  // ---------- Stap 2/3/4: per soort uploaden ----------
  const soort = huidige!;
  const klaar = taken.filter((t) => t.dropbox === "done").length;
  const mislukt = taken.filter((t) => t.dropbox === "error").length;
  const laatste = stapIndex === MEDIA_STAPPEN.length - 1;

  return (
    <>
      <div className="pinned-head" ref={pinnedHeadRef}>
        <div className="topline">
          <button className="btn-back" onClick={vorige}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M10 12.5 5.5 8 10 3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {stapIndex === 0 ? "Ander adres" : "Vorige"}
          </button>
          <h2 style={{ fontSize: 17 }}>
            {address.straatnaam} {houseNumber(address)}
          </h2>
        </div>
        {renderDropboxBalk()}
        {renderVoortgangPerOnderdeel()}
      </div>
      <div className="pinned-head-spacer" style={{ height: pinnedHeadHeight }} />

      <div
        className="pad"
        style={{ background: "var(--paper)", border: "1px solid var(--rule)", borderRadius: "var(--r)" }}
      >
        {renderStappen()}

        <h1>{soort.naam}</h1>
        <p className="lede">{soort.uitleg}</p>

        <input
          ref={inputRef}
          type="file"
          multiple
          accept={soort.accept}
          hidden
          onChange={(e) => {
            // Eerst kopiëren, dan pas het veld leegmaken — zie kiesBestanden.
            const gekozen = [...(e.target.files ?? [])];
            e.target.value = "";
            void kiesBestanden(gekozen);
          }}
        />
        {/* Uploadknop in Dropbox-vorm: het logo, de actie en de bestemming
            eronder. Bewust Dropbox-blauw en niet het groen van de app —
            "Volgende" staat op dezelfde pagina en dat is een heel andere
            handeling; twee groene knoppen naast elkaar nodigen uit tot de
            verkeerde tik. */}
        <button
          type="button"
          className="btn-dropbox"
          disabled={folderBusy}
          onClick={() => inputRef.current?.click()}
        >
          <span className="btn-dropbox-mark" aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
              <path
                d="M7 3 2 6.3 7 9.6 2 12.9l5 3.3 5-3.3 5 3.3 5-3.3-5-3.3 5-3.3-5-3.3-5 3.3-5-3.3Zm5 15 5-3.3v2.2L12 20l-5-3.1v-2.2l5 3.3Z"
                fill="currentColor"
              />
            </svg>
          </span>
          <span className="btn-dropbox-tekst">
            <strong>{folderBusy ? "Map klaarzetten…" : `${soort.naam} kiezen`}</strong>
            <span className="btn-dropbox-doel">
              {folder ? `naar ${folder.path}/${soort.map}` : "naar Dropbox"}
            </span>
          </span>
          {/* Rechts een expliciete actie i.p.v. een los pijltje: op een tablet
              is dat de plek waar de duim landt, en "Uploaden" zegt wat er
              gebeurt terwijl een pijl geraden moet worden. */}
          <span className="btn-dropbox-actie" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path d="M12 17V5M7 10l5-5 5 5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M5 19h14" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
            </svg>
            Uploaden
          </span>
        </button>
        {taken.length > 0 && (
          <p className="media-hint">
            {klaar}/{taken.length} geüpload{mislukt > 0 ? ` · ${mislukt} mislukt` : ""}
          </p>
        )}

        {taken.length > 0 && (
          <ul className="media-files">
            {taken.map((t) => (
              <li
                key={t.id}
                className={
                  t.dropbox === "error" ? "is-error" : t.dropbox === "done" ? "is-done" : undefined
                }
              >
                <span className="media-file-name">{t.name}</span>
                {/* Ook bij "klaar" het percentage tonen. Een los vinkje liet in
                    het midden of het bestand hélemaal over was; 100% is het
                    antwoord op de vraag die je stelt terwijl je staat te
                    wachten. */}
                <span className="media-file-state">
                  {t.dropbox === "error" ? (
                    "mislukt"
                  ) : t.dropbox === "done" ? (
                    <>
                      <span className="media-file-check" aria-hidden="true">
                        ✓
                      </span>
                      100%
                    </>
                  ) : (
                    `${t.pct}%`
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}

        <div className="form-foot" style={{ marginTop: 16 }}>
          <button className="btn btn-quiet" onClick={vorige}>
            {stapIndex === 0 ? "Ander adres" : "Vorige"}
          </button>
          {/* Overslaan mag: niet elke opname heeft alle drie de soorten. De
              uploads lopen op de achtergrond door als je verdergaat. */}
          <button className="btn btn-primary" onClick={volgende}>
            {laatste ? "Afronden →" : taken.length === 0 ? "Overslaan →" : "Volgende →"}
          </button>
        </div>
      </div>
    </>
  );
}
