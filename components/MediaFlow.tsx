"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useIkBen } from "@/components/RechtenProvider";
import { enqueue, getServerSnapshot, getSnapshot, probeerOpnieuw, subscribe } from "@/lib/upload-queue";
import { MEDIA_STAPPEN, type MediaStap } from "@/lib/media-folders";
import { KOP_BYTES, herkenOpNaam, herkenUitKop, leesKop, type Herkenning } from "@/lib/media-herkennen";
import { leesbareOmvang, type StapInhoud } from "@/lib/media-inhoud";
import { relatieveTijd } from "@/lib/relatieve-tijd";
import { tijdslimiet } from "@/lib/tijdslimiet";
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

type Stap = "adres" | "upload" | "klaar";

/** Koppen tegelijk lezen bij het herkennen. Lokaal en snel; een paar honderd
    RAW's mogen de kiezer niet laten haperen, maar ook niet alles in één keer
    in het geheugen trekken. */
const HERKENNERS = 8;

/** Wat er van een gekozen bestand overbleef nadat het niet meeging. */
interface Overgeslagen {
  naam: string;
  reden: string;
}

/**
 * Welke soort een bestand is: eerst aan de naam, en alleen bij beeld (een JPEG
 * kan een foto en een panorama zijn) aan de eerste bytes. Een kop die niet te
 * lezen is maakt er een foto van — nooit een betaalde 360-bewerking.
 */
async function herkenBestand(file: File): Promise<Herkenning> {
  const opNaam = herkenOpNaam(file.name);
  if (opNaam !== "kijken") return opNaam;
  try {
    const kop = new Uint8Array(await file.slice(0, KOP_BYTES).arrayBuffer());
    return herkenUitKop(file.name, leesKop(kop));
  } catch {
    return herkenUitKop(file.name, null);
  }
}

/** Zo vaak kijken we in Dropbox zolang de pagina in beeld is. */
const DROPBOX_KIJK_MS = 15_000;
/** Kwam er in deze periode nog iets binnen, dan loopt er vermoedelijk nog een
    upload via de Dropbox-app. */
const NOG_BINNEN_MS = 2 * 60_000;

type DropboxStap = StapInhoud & { webUrl: string | null };

interface DropboxStand {
  stappen: Record<MediaStap["key"], DropboxStap>;
  /** Wanneer dit is opgehaald. Bewaard bij het ophalen, zodat "komt er nog
      binnen" niet tijdens het tekenen naar de klok hoeft te kijken. */
  opgehaaldOp: number;
}

/**
 * Wat er voor deze opname in Dropbox staat, bijgehouden zolang de pagina in
 * beeld is.
 *
 * De wachtrij weet alleen wat er vanaf dít apparaat via de uploader omhoog
 * ging. Wie via de Dropbox-app aanlevert — die uploadt door op de achtergrond,
 * met het scherm uit, wat een webpagina niet kan — was voor deze pagina
 * onzichtbaar: de stappen stonden op "leeg" terwijl de map volliep.
 *
 * Periodiek, omdat die bestanden binnenkomen terwijl de pagina openstaat en
 * de tellingen moeten meelopen zonder te verversen. Niet als de pagina uit
 * beeld is — dan kijkt niemand, en elke ronde is een Dropbox-aanroep voor
 * niets. Terug in beeld (bijvoorbeeld uit de Dropbox-app) kijkt hij meteen.
 */
function useDropboxInhoud(projectmap: string | null): { stand: DropboxStand | null; fout: boolean } {
  const [stand, setStand] = useState<{ voor: string; stand: DropboxStand | null; fout: boolean } | null>(
    null
  );

  useEffect(() => {
    if (!projectmap) return;
    let weg = false;
    let bezig = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const kijk = async () => {
      if (timer) clearTimeout(timer);
      timer = null;
      // Uit beeld: niet opnieuw plannen. weerInBeeld() start het weer.
      if (weg || bezig || document.visibilityState !== "visible") return;
      bezig = true;
      try {
        const res = await fetch("/api/dropbox/media-inhoud", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectmap }),
          signal: tijdslimiet(20_000),
        });
        if (!res.ok) throw new Error(`media-inhoud gaf ${res.status}`);
        const data = (await res.json()) as { stappen: DropboxStand["stappen"] };
        if (!weg) {
          setStand({
            voor: projectmap,
            stand: { stappen: data.stappen, opgehaaldOp: Date.now() },
            fout: false,
          });
        }
      } catch {
        // Een hapering mag de laatst bekende stand niet wissen — die klopt
        // vrijwel zeker nog. Alleen zonder eerdere stand is er niets te tonen,
        // en dan moet het scherm dat ook kunnen zeggen i.p.v. te blijven
        // wachten. De volgende ronde probeert het gewoon opnieuw.
        if (!weg) {
          setStand((vorige) =>
            vorige?.voor === projectmap && vorige.stand
              ? { ...vorige, fout: true }
              : { voor: projectmap, stand: null, fout: true }
          );
        }
      } finally {
        bezig = false;
      }
      if (!weg) timer = setTimeout(() => void kijk(), DROPBOX_KIJK_MS);
    };

    const weerInBeeld = () => {
      if (document.visibilityState === "visible") void kijk();
    };

    void kijk();
    document.addEventListener("visibilitychange", weerInBeeld);
    return () => {
      weg = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", weerInBeeld);
    };
  }, [projectmap]);

  // Een stand van een vorige opname hoort niet bij deze.
  return stand && stand.voor === projectmap
    ? { stand: stand.stand, fout: stand.fout }
    : { stand: null, fout: false };
}

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

  // Bestanden die gekozen zijn maar niet meegingen, en waarom. Alleen voor
  // deze keer kiezen: na een ander adres hoort de lijst er niet meer bij.
  const [overgeslagen, setOvergeslagen] = useState<Overgeslagen[]>([]);
  // Hoeveel er nog herkend moet worden voordat het de wachtrij in gaat.
  const [herkennen, setHerkennen] = useState(0);
  // Waarom een bestand in zijn kolom staat ("RAW", "panorama 2:1 (…)"), per
  // submap en naam. Alleen voor wat op dit apparaat gekozen is.
  const [redenen, setRedenen] = useState<Record<string, string>>({});
  const [sleepErover, setSleepErover] = useState(false);

  const alleTaken = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const takenVanOpname = useMemo(
    () => alleTaken.filter((t) => t.folderPath === (folder?.path ?? "")),
    [alleTaken, folder]
  );

  const { stand: dropbox, fout: dropboxFout } = useDropboxInhoud(folder?.path ?? null);

  /**
   * Hoeveel bestanden er voor een stap staan.
   *
   * Dropbox is de bron: daar staat ook wat via de Dropbox-app binnenkwam. Wat
   * deze iPad zelf net afrondde telt als ondergrens, want Dropbox wordt maar
   * eens per vijftien seconden bekeken — zonder die ondergrens zou een zojuist
   * geüploade foto even niet meetellen.
   */
  function aantalVoor(st: MediaStap): number {
    const lokaal = takenVanOpname.filter((t) => t.folder === st.map && t.dropbox === "done").length;
    return Math.max(dropbox?.stappen[st.key]?.aantal ?? 0, lokaal);
  }

  /** Kwam er voor deze stap kort geleden nog iets binnen? */
  function komtNogBinnen(st: MediaStap): boolean {
    const laatste = dropbox?.stappen[st.key]?.laatste;
    return !!dropbox && !!laatste && dropbox.opgehaaldOp - Date.parse(laatste) < NOG_BINNEN_MS;
  }

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
    if (!address || folder || stap === "adres") return;
    const sleutel = `${address.straatnaam} ${houseNumber(address)}, ${address.woonplaatsnaam}`;
    if (mapGeprobeerdVoor.current === sleutel) return;
    mapGeprobeerdVoor.current = sleutel;
    void zorgVoorMap();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, stap, folder]);

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
    if (!address || !folder || stap === "adres") return;
    bewaarMediaSessie({
      folderPath: folder.path,
      folderUrl: folder.url,
      subfolders: folder.subfolders ?? [],
      address,
      stap: "upload",
    });
  }, [address, folder, stap]);

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
    setOvergeslagen([]);
    setRedenen({});
    // Nieuw adres: de poging-rem weer vrijgeven.
    mapGeprobeerdVoor.current = null;
    try {
      const res = await fetch(`/api/address/details?id=${encodeURIComponent(s.id)}`);
      const data = await res.json();
      const gevonden: AddressDetails | null = data.details ?? null;
      setAddress(gevonden);
      // Adres staat vast: door naar de eerste soort.
      if (gevonden) setStap("upload");
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
    if (bestanden.length === 0) return;
    setHerkennen((n) => n + bestanden.length);
    // De map en de herkenning tegelijk: het klaarzetten van de map kost een
    // paar Dropbox-rondes, het herkennen alleen lokaal lezen.
    const mapKlaar = zorgVoorMap();
    const uitslag: Herkenning[] = new Array(bestanden.length);
    let volgende = 0;
    await Promise.all(
      Array.from({ length: Math.min(HERKENNERS, bestanden.length) }, async () => {
        while (volgende < bestanden.length) {
          const i = volgende++;
          uitslag[i] = await herkenBestand(bestanden[i]);
          setHerkennen((n) => n - 1);
        }
      })
    );
    const doel = await mapKlaar;
    const weg: Overgeslagen[] = [];
    const nieuweRedenen: Record<string, string> = {};
    bestanden.forEach((file, i) => {
      const { soort, reden } = uitslag[i];
      const stapVan = soort ? MEDIA_STAPPEN.find((st) => st.soort === soort) : undefined;
      if (!stapVan) {
        weg.push({ naam: file.name, reden });
        return;
      }
      if (!doel) return;
      nieuweRedenen[`${stapVan.map}/${file.name}`] = reden;
      enqueue(doel.path, stapVan.map, file, account);
    });
    // Zonder map gaat er niets de wachtrij in; de balk bovenaan zegt dan al
    // waarom (folderError), en een lijst "overgeslagen" zou het verkeerde
    // verhaal vertellen.
    if (!doel) return;
    setRedenen((r) => ({ ...r, ...nieuweRedenen }));
    if (weg.length > 0) {
      setOvergeslagen((o) => [...o.filter((x) => !weg.some((w) => w.naam === x.naam)), ...weg]);
    }
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
    // Oudere opnames bewaarden de stap waar je stond (foto's, video, 360);
    // die bestaan niet meer, alles staat nu op één scherm.
    setStap("upload");
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
    setOvergeslagen([]);
    setRedenen({});
  }

  function naarKlaar() {
    // Hier is de opname afgerond; zonder dit blijft hij als "niet afgemaakt"
    // gelden en krijg je er een herinnering over.
    if (melding) meldAfgerond(melding);
    setStap("klaar");
    window.scrollTo(0, 0);
  }

  /**
   * De slotknop op het klaar-scherm: de opname is gedaan, dus hem afsluiten en
   * terug naar het adresscherm voor de volgende.
   *
   * Nog een keer als afgerond melden: de hartslag loopt door zolang dit scherm
   * open staat en zet de opname elke vijf minuten terug op "concept". Wie hier
   * even blijft staan kreeg er anders alsnog een herinnering over.
   *
   * De opname alleen uit "Openstaande opnames" halen als er niets meer loopt
   * of mislukt is. De wachtrij draait buiten dit scherm door, en die lijst is
   * op de mediapagina de enige weg terug naar een upload die nog onderweg is —
   * de zwevende melding van UploadResume is hier juist verborgen.
   */
  function afronden() {
    if (melding) meldAfgerond(melding);
    const onderweg = takenVanOpname.some((t) => t.dropbox === "uploading" || t.dropbox === "error");
    if (folder && !onderweg) vergeetMediaSessie(folder.path);
    opnieuwBeginnen();
    window.scrollTo(0, 0);
  }


  const bezigTotaal = takenVanOpname.filter((t) => t.dropbox === "uploading").length;
  // Voor het slotscherm: alles wat er voor deze opname in Dropbox staat.
  const totaalInDropbox = MEDIA_STAPPEN.reduce((som, s) => som + aantalVoor(s), 0);
  const bytesInDropbox = MEDIA_STAPPEN.reduce((som, s) => som + (dropbox?.stappen[s.key]?.bytes ?? 0), 0);

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
                <span className="dbx-folder-path">{folder.path}/In/Raw</span>
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

      </div>
    );
  }

  /**
   * Wat er per onderdeel nog loopt. Op het slotscherm, in de vaste kop: daar
   * staan de kolommen niet meer in beeld, en zonder dit lijkt een video die
   * nog omhoog gaat gestopt zodra je op "Klaar" tikt.
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
                Kies het pand. Daarna upload je alles in één keer: foto&apos;s, video en 360 worden
                vanzelf over de juiste mappen verdeeld.
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
            <button className="btn-back" onClick={() => setStap("upload")}>
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

        <div className="mt-scherm">
          {(() => {
            // Zelfde opbouw als de upload-pop-ups bij NEN en Energielabel: de
            // uitkomst in de kop, en per soort één regel met de uitkomst rechts.
            const perSoort = MEDIA_STAPPEN.map((s) => {
              const eigen = takenVanOpname.filter((t) => t.folder === s.map);
              const bezig = eigen.filter((t) => t.dropbox === "uploading").length;
              const mislukt = eigen.filter((t) => t.dropbox === "error").length;
              const lopend = eigen.filter((t) => t.dropbox !== "error");
              const pct =
                bezig > 0
                  ? Math.round(
                      lopend.reduce((tot, t) => tot + (t.dropbox === "done" ? 100 : t.pct), 0) / Math.max(1, lopend.length)
                    )
                  : null;
              return { s, aantal: aantalVoor(s), bytes: dropbox?.stappen[s.key]?.bytes ?? 0, bezig, mislukt, pct };
            });
            const misluktTotaal = perSoort.reduce((som, r) => som + r.mislukt, 0);
            const eersteMislukt = perSoort.find((r) => r.mislukt > 0);
            const nogNietBekeken = !dropbox && takenVanOpname.length === 0;
            const meervoud = (n: number) => `${n} bestand${n === 1 ? "" : "en"}`;

            const fout = misluktTotaal > 0 || (nogNietBekeken && dropboxFout) || (!nogNietBekeken && totaalInDropbox === 0);
            const bezig = bezigTotaal > 0 || (nogNietBekeken && !dropboxFout);
            const titel =
              bezigTotaal > 0
                ? `Nog ${meervoud(bezigTotaal)} onderweg naar Dropbox`
                : nogNietBekeken
                  ? // Zonder blik in Dropbox is "niets geüpload" een gok: via de
                    // Dropbox-app kan de map allang vol staan.
                    dropboxFout
                    ? "Dropbox kon niet worden bekeken"
                    : "Even kijken wat er in Dropbox staat…"
                  : totaalInDropbox === 0
                    ? // Niets aangeleverd: dan is "klaar" een loze bevestiging
                      // van werk dat niet gedaan is.
                      "Er is niets geüpload voor dit adres"
                    : misluktTotaal > 0
                      ? `${meervoud(misluktTotaal)} niet in Dropbox gekomen`
                      : `Klaar — ${meervoud(totaalInDropbox)} in Dropbox`;
            const onderTitel = [
              bytesInDropbox > 0 ? leesbareOmvang(bytesInDropbox) : null,
              // Via de Dropbox-app kan het nog doorlopen; dat eerlijk zeggen
              // i.p.v. "alles staat erin".
              MEDIA_STAPPEN.some(komtNogBinnen) ? "er komt nog binnen via de Dropbox-app" : null,
            ]
              .filter(Boolean)
              .join(" · ");
            const uitleg =
              bezigTotaal > 0
                ? "Loopt door, ook als je dit scherm verlaat"
                : nogNietBekeken && dropboxFout
                  ? "Via “Openen” bovenaan zie je wat er staat"
                  : !nogNietBekeken && totaalInDropbox === 0
                    ? "Ga terug om alsnog bestanden te kiezen"
                    : eersteMislukt
                      ? `Ga terug om ze bij ${eersteMislukt.s.naam} opnieuw te proberen`
                      : null;

            return (
              <>
                <div className="mt-head">
                  <span className={`mt-icon${fout ? " is-error" : ""}`} aria-hidden="true">
                    {fout ? "!" : bezig ? <span className="spinner" /> : "✓"}
                  </span>
                  <div className="mt-head-tekst">
                    <h1 className="mt-titel">{titel}</h1>
                    {onderTitel && <p>{onderTitel}</p>}
                  </div>
                </div>

                <div className="mt-body">
                  <ul className="mt-rows">
                    {perSoort.map(({ s, aantal, bytes, bezig: bz, mislukt, pct }) => (
                      <li key={s.key} className={`mt-row${aantal === 0 && mislukt === 0 && bz === 0 ? " is-muted" : ""}`}>
                        <span className="mt-k">{s.naam}</span>
                        <span className="mt-v">
                          {/* Wat nog onderweg is apart noemen: "0 bestanden" naast een
                              draaiend icoon las alsof er niets gekozen was. */}
                          {aantal === 0 && bz === 0 && mislukt === 0
                            ? "Niets geüpload"
                            : aantal === 0 && bz > 0
                              ? `${meervoud(bz)} onderweg`
                              : `${meervoud(aantal)}${bytes > 0 ? ` · ${leesbareOmvang(bytes)}` : ""}${bz > 0 ? ` · ${bz} onderweg` : ""}`}
                        </span>
                        {bz > 0 ? (
                          <span className="mt-s">
                            <span className="spinner" aria-hidden="true" />
                            {pct !== null ? `${pct}%` : "bezig"}
                          </span>
                        ) : mislukt > 0 ? (
                          <span className="mt-s is-error">⚠ {mislukt} mislukt</span>
                        ) : komtNogBinnen(s) ? (
                          <span className="mt-s">komt nog binnen</span>
                        ) : aantal > 0 ? (
                          <span className="mt-s is-done">✓ in Dropbox</span>
                        ) : (
                          <span className="mt-s">—</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>

                {/* Eén slotknop: afronden brengt je terug naar het adresscherm, dus
                    een aparte "Nieuw adres" ernaast deed hetzelfde. Dropbox blijft
                    bereikbaar via "Openen" in de balk bovenaan — dat scheelt de
                    opnemer een omweg langs de Dropbox-app om hier klaar te zijn. */}
                <div className="mt-foot">
                  {uitleg && <span className="mt-foot-tekst">{uitleg}</span>}
                  <button className="btn btn-primary mt-foot-knop" onClick={afronden}>
                    Afronden
                  </button>
                </div>
              </>
            );
          })()}
        </div>
      </>
    );
  }

  // ---------- Uploaden: één knop, drie kolommen ----------
  const telbaar = takenVanOpname.filter((t) => MEDIA_STAPPEN.some((st) => st.map === t.folder));
  const klaarTotaal = telbaar.filter((t) => t.dropbox === "done").length;
  const misluktTotaal = telbaar.filter((t) => t.dropbox === "error").length;
  const pctTotaal =
    telbaar.length > 0
      ? Math.round(
          telbaar.reduce((tot, t) => tot + (t.dropbox === "done" ? 100 : t.dropbox === "error" ? 0 : t.pct), 0) /
            telbaar.length
        )
      : 0;
  const nogTeGaan = telbaar
    .filter((t) => t.dropbox === "uploading" && t.etaSeconds != null)
    .reduce((max, t) => Math.max(max, t.etaSeconds ?? 0), 0);
  const ietsGekozen = telbaar.length > 0 || herkennen > 0;

  return (
    <>
      <div className="pinned-head" ref={pinnedHeadRef}>
        <div className="topline">
          <button className="btn-back" onClick={opnieuwBeginnen}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M10 12.5 5.5 8 10 3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Ander adres
          </button>
          <h2 style={{ fontSize: 17 }}>
            {address.straatnaam} {houseNumber(address)}
          </h2>
        </div>
        {renderDropboxBalk()}
      </div>
      <div className="pinned-head-spacer" style={{ height: pinnedHeadHeight }} />

      <div
        className="pad"
        style={{ background: "var(--paper)", border: "1px solid var(--rule)", borderRadius: "var(--r)" }}
      >
        <div>
          <h1>Media uploaden</h1>
          <p className="lede">
            Kies alles van deze opname in één keer. De uploader herkent zelf wat een foto, video of
            360-opname is en zet het in de juiste map.
          </p>
        </div>

        {/* Geen `accept`: zie MEDIA_STAPPEN. Wat er niet hoort laat de
            herkenning liggen, met de reden erbij. */}
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            // Eerst kopiëren, dan pas het veld leegmaken — zie kiesBestanden.
            const gekozen = [...(e.target.files ?? [])];
            e.target.value = "";
            void kiesBestanden(gekozen);
          }}
        />
        {/* Eén knop voor de hele opname. Dropbox-blauw en niet het groen van
            de app: "Klaar" staat onderaan in groen en is een heel andere
            handeling. Niet uitgeschakeld terwijl de map klaargezet wordt —
            kiesBestanden wacht daar zelf op. Op een computer mag je de
            bestanden er ook op slepen. */}
        <button
          type="button"
          className={`media-upknop${ietsGekozen ? " is-compact" : ""}${sleepErover ? " is-sleep" : ""}`}
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setSleepErover(true);
          }}
          onDragLeave={() => setSleepErover(false)}
          onDrop={(e) => {
            e.preventDefault();
            setSleepErover(false);
            void kiesBestanden([...e.dataTransfer.files]);
          }}
        >
          <span className="media-upknop-icoon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none">
              <path d="M12 16V4M6.5 9.5 12 4l5.5 5.5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
            </svg>
          </span>
          <span className="media-upknop-tekst">{ietsGekozen ? "Meer uploaden" : "Uploaden"}</span>
          <span className="media-upknop-sub">
            Foto&apos;s, video en 360 — alles door elkaar, we verdelen het zelf
          </span>
        </button>

        {ietsGekozen && (
          <div className="media-totaal">
            <div className="media-totaal-tekst">
              <span>
                {herkennen > 0 ? (
                  <>
                    <span className="spinner" /> {herkennen} bestand{herkennen === 1 ? "" : "en"} herkennen…
                  </>
                ) : (
                  <>
                    <b>{klaarTotaal}</b> van <b>{telbaar.length}</b> in Dropbox
                    {misluktTotaal > 0 && <span className="media-totaal-fout"> · {misluktTotaal} mislukt</span>}
                  </>
                )}
              </span>
              {bezigTotaal > 0 && (
                <span>
                  {bezigTotaal} bezig
                  {nogTeGaan > 0 && ` · nog ± ${Math.max(1, Math.round(nogTeGaan / 60))} min`}
                </span>
              )}
            </div>
            <span className="up-bar">
              <span className="up-bar-fill" style={{ width: `${pctTotaal}%` }} />
            </span>
          </div>
        )}

        <div className="media-kolommen">
          {MEDIA_STAPPEN.map((st) => {
            const eigen = takenVanOpname.filter((t) => t.folder === st.map);
            const klaar = eigen.filter((t) => t.dropbox === "done").length;
            const mislukt = eigen.filter((t) => t.dropbox === "error");
            const pct =
              eigen.length > 0
                ? Math.round(
                    eigen.reduce((tot, t) => tot + (t.dropbox === "done" ? 100 : t.dropbox === "error" ? 0 : t.pct), 0) /
                      eigen.length
                  )
                : 0;
            const inDropbox = dropbox?.stappen[st.key] ?? null;
            return (
              <section key={st.key} className="media-kolom" aria-label={st.naam}>
                <header className="media-kolom-kop">
                  <div className="media-kolom-rij">
                    <span className="media-kolom-titel">
                      {st.naam}
                      {eigen.length > 0 && klaar === eigen.length && (
                        <span className="media-kolom-ok" aria-hidden="true">
                          {" "}
                          ✓
                        </span>
                      )}
                    </span>
                    <span className="media-kolom-tel">
                      {eigen.length > 0 ? `${klaar}/${eigen.length}` : aantalVoor(st)}
                    </span>
                  </div>
                  <span className="media-kolom-map">naar {st.map}</span>
                  {eigen.length > 0 && (
                    <span className="up-bar media-kolom-bar">
                      <span
                        className={`up-bar-fill${mislukt.length > 0 ? " is-bad" : ""}`}
                        style={{ width: `${pct}%` }}
                      />
                    </span>
                  )}
                </header>

                {eigen.length === 0 ? (
                  <p className="media-kolom-leeg">{st.uitleg}</p>
                ) : (
                  <ul className="media-kolom-lijst">
                    {eigen.map((t) => (
                      <li key={t.id}>
                        <span className="media-kolom-r1">
                          <span className="media-kolom-naam">{t.name}</span>
                          {/* Ook bij "klaar" het percentage: 100% is het antwoord
                              op de vraag die je stelt terwijl je staat te wachten. */}
                          <span className={`media-kolom-st is-${t.dropbox}`}>
                            {t.dropbox === "error" ? "mislukt" : t.dropbox === "done" ? "✓ 100%" : `${t.pct}%`}
                          </span>
                        </span>
                        {redenen[`${st.map}/${t.name}`] && (
                          <span className="media-kolom-r2">{redenen[`${st.map}/${t.name}`]}</span>
                        )}
                        {t.dropbox === "uploading" && t.pct > 0 && (
                          <span className="up-bar media-kolom-bar-klein">
                            <span className="up-bar-fill" style={{ width: `${t.pct}%` }} />
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}

                {/* Wat er echt staat, ongeacht langs welke weg het kwam — ook
                    van een eerdere keer of via de Dropbox-app. */}
                {inDropbox && inDropbox.aantal > 0 && (
                  <p className="media-kolom-dbx">
                    In Dropbox: <strong>{aantalVoor(st)}</strong> · {leesbareOmvang(inDropbox.bytes)}
                    {inDropbox.laatste && ` · ${relatieveTijd(Date.parse(inDropbox.laatste))}`}
                  </p>
                )}

                {mislukt.length > 0 && (
                  <button
                    type="button"
                    className="media-kolom-opnieuw"
                    onClick={() => void probeerOpnieuw(mislukt.map((t) => t.id))}
                  >
                    ↻ Mislukte opnieuw proberen
                  </button>
                )}
              </section>
            );
          })}
        </div>

        {overgeslagen.length > 0 && (
          <details className="media-overgeslagen">
            <summary>Niet meegenomen ({overgeslagen.length})</summary>
            <ul>
              {overgeslagen.map((o) => (
                <li key={o.naam}>
                  <b>{o.naam}</b> — {o.reden}
                </li>
              ))}
            </ul>
          </details>
        )}

        <div className="form-foot">
          <button className="btn btn-quiet" onClick={opnieuwBeginnen}>
            Ander adres
          </button>
          {/* Niet "Afronden": dat is de knop op het slotscherm zelf. Deze
              brengt je daarheen, naar het overzicht van wat er staat. De
              uploads lopen op de achtergrond door. */}
          <button className="btn btn-primary" onClick={naarKlaar}>
            Klaar →
          </button>
        </div>
      </div>
    </>
  );
}
