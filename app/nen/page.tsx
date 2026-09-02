"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { AddressDetails, AddressSuggestion, NearbyAddress } from "@/lib/pdok";
import TodayAppointments from "@/components/TodayAppointments";
import type { DraftRecord as ServerDraftRecord } from "@/lib/drafts";
import { normalizeForMatch } from "@/lib/address-format";
import { matchGrossFloorAreaBracket } from "@/lib/mediatask-format";
import { meldGestart, startHartslag, type OpnameMelding } from "@/lib/opname-melden";

// Zelfde submap-structuur als het NEN2580-sjabloon in Dropbox ("Voorbeeld
// Map NEN2580"). Optimized staat vooraan: dat is de map waar de opnemer
// tijdens de opname het vaakst een bestand in kiest.
const NEN_DOC_FOLDERS = ["Optimized", "Additionals", "Photo's", "Video", "RAW"] as const;

// Leesbare Nederlandse labels voor de dynamische productconfiguratie-velden
// van Mediatask (die zelf alleen de Engelse veldnaam teruggeven).
const MEDIATASK_FIELD_LABELS: Record<string, string> = {
  gross_floor_area: "Bruto vloeroppervlak",
  option: "2D of 3D",
  style: "Stijl",
  measurement_type: "Metingstype",
  measurement_date: "Meetdatum",
  property_type: "Pandtype",
  house_type: "Woningtype",
};

function mediataskFieldLabel(name: string): string {
  return MEDIATASK_FIELD_LABELS[name] ?? name;
}

type DraftRecord = Pick<ServerDraftRecord, "id" | "status" | "straatnaam" | "state">;

interface MediataskAgency {
  id: string;
  name: string;
  code: string;
}
interface MediataskPriority {
  id: string;
  name: string;
  description: string;
}
interface MediataskProductConfigOption {
  name: string;
  type: "select" | "string" | "date" | "number";
  values?: string[];
}
interface MediataskProduct {
  id: number;
  full_name: string;
  short_name: string;
  configuration: MediataskProductConfigOption[];
}

interface DropboxFolder {
  path: string;
  url: string;
}

function houseNumber(a: { huisnummer: number; huisletter: string | null; huisnummertoevoeging?: string | null }) {
  return [a.huisnummer, a.huisletter ?? "", a.huisnummertoevoeging ? `-${a.huisnummertoevoeging}` : ""].join("");
}

/**
 * Koppelt een (net aangemaakte) Mediatask-order aan het bestaande concept,
 * zodat een tweede bezoek aan dit adres dezelfde order terugvindt i.p.v. een
 * nieuwe aan te maken. Best-effort: de order is het echte werk, dit is de
 * boekhouding erna.
 */
function koppelOrderAanConcept(
  draft: DraftRecord,
  orderId: number,
  state: string
): void {
  void fetch("/api/drafts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: draft.id,
      status: draft.status,
      straatnaam: draft.straatnaam,
      state: {
        ...draft.state,
        mediatask: { orderId, state, submittedAt: Date.now() },
      },
    }),
  }).catch(() => {});
}

export default function UploadNen() {
  const router = useRouter();
  // ---------- Stap 1: adres zoeken — identiek aan de ClickUp-opnameflow ----------
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

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Vaste Dropbox-statusbalk bovenaan, zelfde patroon als de ClickUp-opnameflow —
  // meet de werkelijke hoogte zodat de rest van de pagina niet onder de balk schuift.
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

  // Klant-naam uit de agenda-afspraak (indien bekend), om het Mediatask-
  // bureau automatisch te filteren zodra de configuratie geladen is. Wordt
  // expliciet doorgegeven (niet alleen via state) omdat afterAddressSelected
  // anders een verouderde waarde zou kunnen lezen (state is nog niet
  // gecommit binnen dezelfde afhandeling).
  // Wie er ingelogd is; hoort bij de melding dat deze opname loopt, zodat een
  // herinnering bij de juiste persoon terechtkomt.
  const [account, setAccount] = useState<string | null>(null);
  useEffect(() => {
    fetch("/api/clickup/list-meta", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setAccount(d?.account?.username ?? null))
      .catch(() => {});
  }, []);

  const [klantHint, setKlantHint] = useState<string | null>(null);
  const [grossFloorAreaHint, setGrossFloorAreaHint] = useState<number | null>(null);

  async function selectAddress(suggestion: AddressSuggestion, klant?: string | null, grossFloorArea?: number | null) {
    setNearby(null);
    setSuggestions([]);
    setQuery(suggestion.label);
    setLoadingAddress(true);
    setAddress(null);
    setKlantHint(klant ?? null);
    setGrossFloorAreaHint(grossFloorArea ?? null);
    resetMediataskState();
    try {
      const res = await fetch(`/api/address/details?id=${encodeURIComponent(suggestion.id)}`);
      const data = await res.json();
      const a: AddressDetails | null = data.details ?? null;
      setAddress(a);
      if (a) void afterAddressSelected(a, klant ?? null, grossFloorArea ?? null);
    } finally {
      setLoadingAddress(false);
    }
  }

  // Vanuit "Afspraken vandaag": zoekt direct op het adres uit de afspraak en
  // selecteert de beste match, zodat de tweede kolom meteen gevuld is i.p.v.
  // dat de opnemer nog handmatig een zoekresultaat moet aanklikken.
  async function pickFromAppointment(addressText: string, klant?: string | null, grossFloorArea?: number | null) {
    setQuery(addressText);
    setAddress(null);
    setShowManualSearch(true);
    setSearching(true);
    try {
      const res = await fetch(`/api/address/search?q=${encodeURIComponent(addressText)}`);
      const data = await res.json();
      const best: AddressSuggestion | undefined = data.suggestions?.[0];
      if (best) {
        await selectAddress(best, klant, grossFloorArea);
      } else {
        setSuggestions(data.suggestions ?? []);
      }
    } finally {
      setSearching(false);
    }
  }

  // Vanuit het dashboard via /nen?addr=<adres>&klant=<naam>&m2=<oppervlakte>:
  // meteen doorzoeken en selecteren, zodat je niet opnieuw hoeft te zoeken
  // naar een adres dat je net al in de afsprakenlijst zag staan.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const addr = params.get("addr");
    if (!addr) return;
    const m2 = params.get("m2");
    void pickFromAppointment(addr, params.get("klant"), m2 ? Number(m2) : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Een losse NEN-opname schreef niets naar de server, dus niemand kon zien
  // dát hij liep. Nu wel — inclusief een hartslag, want de tijd tussen twee
  // formulierwijzigingen zegt niets over of iemand nog bezig is.
  const nenMelding: OpnameMelding | null = address
    ? {
        id: `nen-${address.straatnaam} ${houseNumber(address)}, ${address.woonplaatsnaam}`,
        soort: "nen",
        straatnaam: `${address.straatnaam} ${houseNumber(address)}`,
        postcode: address.postcode,
        woonplaats: address.woonplaatsnaam,
        accountName: account,
      }
    : null;

  useEffect(() => {
    if (!nenMelding) return;
    meldGestart(nenMelding);
    return startHartslag(nenMelding);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nenMelding?.id, nenMelding?.accountName]);

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
      // Was er al een map aangemaakt voor het oude huisnummer, dan hoort die
      // niet meer bij dit adres — weggooien, zodat ensureNenFolder er straks
      // een verse maakt i.p.v. de bestanden in de verkeerde map te zetten.
      if (`${prev.straatnaam} ${houseNumber(prev)}` !== `${next.straatnaam} ${houseNumber(next)}`) {
        setDropboxFolder(null);
        setFileCounts(null);
        setDocFiles({});
        setDocFolderUrls({});
      }
      void afterAddressSelected(next, klantHint, grossFloorAreaHint);
      return next;
    });
    setEditingAddr(false);
  }

  function resetAll() {
    setQuery("");
    setSuggestions([]);
    setNearby(null);
    setLocationError(null);
    setShowManualSearch(false);
    setAddress(null);
    resetMediataskState();
  }

  // ---------- Stap 2: Mediatask-configuratie ----------
  const [dropboxFolder, setDropboxFolder] = useState<DropboxFolder | null>(null);
  // Aanmaken van de projectmap is uitgesteld tot ná de adrescontrole, dus de
  // voortgang en een eventuele fout horen zichtbaar te zijn op de knop die
  // hem aanmaakt i.p.v. in een spinner die eeuwig doordraait.
  const [folderBusy, setFolderBusy] = useState(false);
  const [folderError, setFolderError] = useState<string | null>(null);
  const folderInFlight = useRef<Promise<DropboxFolder | null> | null>(null);
  const [existingDraft, setExistingDraft] = useState<DraftRecord | null>(null);

  const [config, setConfig] = useState<{
    agencies: MediataskAgency[];
    priorities: MediataskPriority[];
    products: MediataskProduct[];
  } | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [configLoading, setConfigLoading] = useState(false);

  const [productId, setProductId] = useState<number | "">("");
  const [priorityId, setPriorityId] = useState("");
  const [agencyId, setAgencyId] = useState("");
  const [productConfig, setProductConfig] = useState<Record<string, string>>({});

  // Handmatige invoer — zichtbaar zolang Mediatask nog niet gekoppeld is (of
  // als de live lijst een keuze niet bevat), zodat het formulier nu al
  // compleet en bruikbaar is. Schakelt vanzelf uit zodra de live config met
  // opties beschikbaar komt.
  const [manualProductId, setManualProductId] = useState("");
  const [manualPriorityId, setManualPriorityId] = useState("");
  const [manualAgencyId, setManualAgencyId] = useState("");
  const [manualConfigRows, setManualConfigRows] = useState<{ key: string; value: string }[]>([
    { key: "house_type", value: "" },
    { key: "style", value: "" },
    { key: "option", value: "" },
  ]);
  const [extraPhotoUrls, setExtraPhotoUrls] = useState("");
  const [extraDrawingUrls, setExtraDrawingUrls] = useState("");

  const [mtCity, setMtCity] = useState("");
  const [mtStreet, setMtStreet] = useState("");
  const [mtNumber, setMtNumber] = useState("");
  const [mtPostcode, setMtPostcode] = useState("");

  const [fileCounts, setFileCounts] = useState<Record<(typeof NEN_DOC_FOLDERS)[number], number> | null>(null);
  const [filesLoading, setFilesLoading] = useState(false);
  const [docFiles, setDocFiles] = useState<Record<string, { name: string; size: number }[]>>({});
  const [docFolderUrls, setDocFolderUrls] = useState<Record<string, string | null>>({});
  // De Mediatask-order-sectie staat standaard ingeklapt — die gegevens staan
  // al als vinklijst in de adreskaart, het volledige formulier is alleen
  // nodig als je iets wilt aanpassen.
  const [showMediataskForm, setShowMediataskForm] = useState(false);
  // Voordat de documenten open gaan, eerst laten bevestigen dat het
  // automatisch gekozen bureau klopt — dat is de meest foutgevoelige
  // autofill (fuzzy match op de agenda-tekst) en pas hierna zichtbaar.
  const [showAgencyConfirm, setShowAgencyConfirm] = useState(false);
  // "Aanpassen" op de bevestigingspop-up wisselt zonder de pop-up te
  // verlaten naar een klein bureau-keuzeveld, i.p.v. door te springen naar
  // het volledige Mediatask-formulier — dit is verreweg het vaakst het enige
  // wat fout staat.
  const [agencyEditMode, setAgencyEditMode] = useState(false);

  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [result, setResult] = useState<{ orderId: number; state: string } | null>(null);
  const [statusRefreshing, setStatusRefreshing] = useState(false);
  // Voortgang van het aanmaken van de concept-order in de bevestigingspop-up.
  // De order gaat tegenwoordig al bij "Ja, klopt" naar Mediatask, zodat de
  // puntenwolken tijdens het uploaden alvast doorgestuurd kunnen worden —
  // "fout" blokkeert niets: dan valt de flow terug op aanmaken bij het
  // afronden, zoals voorheen.
  const [orderSetup, setOrderSetup] = useState<"idle" | "bezig" | "fout">("idle");

  function resetMediataskState() {
    setDropboxFolder(null);
    setFolderBusy(false);
    setFolderError(null);
    setExistingDraft(null);
    setConfig(null);
    setConfigError(null);
    setFileCounts(null);
    setDocFiles({});
    setDocFolderUrls({});
    setShowMediataskForm(false);
    setShowAgencyConfirm(false);
    setAgencyEditMode(false);
    setResult(null);
    setSendError(null);
    setOrderSetup("idle");
    setProductId("");
    setProductConfig({});
    setManualProductId("");
    setManualPriorityId("");
    setManualAgencyId("");
    setExtraPhotoUrls("");
    setExtraDrawingUrls("");
  }

  async function refreshFileCounts(folder: { path: string; url: string }) {
    setFilesLoading(true);
    try {
      const results = await Promise.all(
        NEN_DOC_FOLDERS.map((name) =>
          fetch("/api/dropbox/files", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: `${folder.path}/${name}` }),
          })
            .then((r) => r.json())
            .catch(() => ({ files: [] }))
        )
      );
      const counts = {} as Record<(typeof NEN_DOC_FOLDERS)[number], number>;
      const files: Record<string, { name: string; size: number }[]> = {};
      const urls: Record<string, string | null> = {};
      NEN_DOC_FOLDERS.forEach((name, i) => {
        counts[name] = results[i].files?.length ?? 0;
        files[name] = results[i].files ?? [];
        urls[name] = results[i].url ?? null;
      });
      setFileCounts(counts);
      setDocFiles(files);
      setDocFolderUrls(urls);
    } finally {
      setFilesLoading(false);
    }
  }

  async function afterAddressSelected(a: AddressDetails, klant: string | null = null, grossFloorAreaHintArg: number | null = null) {
    // BAG is de gezaghebbende bron voor het bruto vloeroppervlak — de
    // agenda-notitie (vrije tekst) is alleen een fallback voor het geval de
    // BAG dit object niet registreert.
    const grossFloorArea = a.oppervlakte ?? grossFloorAreaHintArg;
    setConfigLoading(true);
    setMtCity(a.woonplaatsnaam);
    setMtStreet(a.straatnaam);
    setMtNumber(houseNumber(a));
    setMtPostcode(a.postcode);

    const straatEnNummer = `${a.straatnaam} ${houseNumber(a)}`;

    // De Dropbox-map wordt hier bewust NIET aangemaakt. Het adres mag op dit
    // punt nog gecorrigeerd worden ("Aanpassen"), en de mapnaam bevat het
    // huisnummer — een map aanmaken vóór die controle leverde bij elke
    // correctie een tweede map op, met de eerste leeg achtergebleven. De map
    // volgt nu uit ensureNenFolder(), bij het openen van de documenten.

    const configPromise = fetch("/api/mediatask/config", { cache: "no-store" })
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Mediatask niet bereikbaar");
        return data;
      })
      .catch((err) => {
        setConfigError(err instanceof Error ? err.message : "Mediatask niet bereikbaar");
        return null;
      });

    // De lijst geeft samenvattingen terug zonder formulierstaat; voor de
    // Mediatask-ordergegevens is de volledige opname nodig. Die halen we
    // gericht op voor dit ene adres i.p.v. alles mee te slepen.
    const draftsPromise = fetch("/api/drafts", { cache: "no-store" })
      .then((res) => res.json())
      .then(async (data) => {
        const kort = (data.drafts ?? []).find(
          (d: { straatnaam: string }) => d.straatnaam === straatEnNummer
        );
        if (!kort) return null;
        const vol = await fetch(`/api/drafts/${kort.id}`, { cache: "no-store" })
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null);
        return (vol?.draft ?? null) as DraftRecord | null;
      })
      .catch(() => null);

    const [cfg, draft] = await Promise.all([configPromise, draftsPromise]);

    if (cfg) {
      setConfig(cfg);

      // Standaardproduct: dit is verreweg het meest gebruikte NEN2580-product
      // — scheelt een keuze die de opnemer anders elke keer opnieuw maakt.
      // Kan altijd nog aangepast worden.
      const defaultProduct = cfg.products.find(
        (p: MediataskProduct) => p.full_name === "Floorplanner NEN2580 plans NEW"
      );
      if (defaultProduct) {
        setProductId(defaultProduct.id);

        // Standaardwaarden voor de productconfiguratie: 3D-uitvoering,
        // standaardstijl, meting type A, meetdatum = vandaag (dag van
        // uploaden), en bruto vloeroppervlak indien uit de agenda-notitie te
        // herleiden. Blijft leeg als een veld niet in dit product voorkomt.
        const todayIso = new Date().toISOString().slice(0, 10);
        const initialConfig: Record<string, string> = {};
        for (const c of defaultProduct.configuration) {
          if (c.name === "option") initialConfig.option = "3D";
          else if (c.name === "style") initialConfig.style = "STD";
          else if (c.name === "measurement_type") initialConfig.measurement_type = "A";
          else if (c.name === "measurement_date") initialConfig.measurement_date = todayIso;
          else if (c.name === "gross_floor_area" && grossFloorArea) {
            const bracket = matchGrossFloorAreaBracket(grossFloorArea, c.values);
            if (bracket) initialConfig.gross_floor_area = bracket;
          }
        }
        setProductConfig(initialConfig);
      }

      // Bureau automatisch filteren op de klantnaam uit de agenda-afspraak
      // (het "Klant:"-veld) — anders gewoon de gebruikelijke fallback bij
      // precies één bureau.
      const matchedAgency =
        klant &&
        cfg.agencies.find((ag: MediataskAgency) => {
          const a1 = normalizeForMatch(ag.name);
          const a2 = normalizeForMatch(klant);
          return a1 === a2 || a1.startsWith(a2) || a2.startsWith(a1);
        });
      if (matchedAgency) setAgencyId(matchedAgency.id);
      else if (cfg.agencies.length === 1) setAgencyId(cfg.agencies[0].id);

      // Prioriteit standaard op "no" (normale planning) — "yes" is
      // uitzondering (spoed), dat vinkt de opnemer zelf aan indien nodig.
      const defaultPriority = cfg.priorities.find((p: MediataskPriority) => p.name.toLowerCase() === "no");
      if (defaultPriority) setPriorityId(defaultPriority.id);
      else if (cfg.priorities.length === 1) setPriorityId(cfg.priorities[0].id);
    }
    setConfigLoading(false);

    if (draft) {
      setExistingDraft(draft);
      const mediatask = draft.state?.mediatask as { orderId: number; state: string } | undefined;
      if (mediatask) {
        setResult({ orderId: mediatask.orderId, state: mediatask.state });
      }
    }
  }

  const selectedProduct = config?.products.find((p) => p.id === productId) ?? null;

  const finalProductId = config?.products.length ? productId : manualProductId ? Number(manualProductId) : "";
  const finalPriorityId = config?.priorities.length ? priorityId : manualPriorityId;
  const finalAgencyId = config?.agencies.length ? agencyId : manualAgencyId;
  const finalProductConfig = selectedProduct
    ? productConfig
    : Object.fromEntries(manualConfigRows.filter((r) => r.key.trim()).map((r) => [r.key.trim(), r.value]));

  async function send() {
    if (!finalProductId || !finalPriorityId || !finalAgencyId || !mtCity || !mtStreet || !mtNumber) return;
    setSending(true);
    setSendError(null);
    try {
      const res = await fetch("/api/mediatask/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dropboxFolderPath: dropboxFolder?.path ?? null,
          productId: finalProductId,
          priorityId: finalPriorityId,
          agencyId: finalAgencyId,
          productConfiguration: finalProductConfig,
          // Echt indienen bij Mediatask (niet als concept laten staan). Lukt
          // het indienen niet, dan blijft de order als concept bestaan en
          // komt dat als submitError terug — zie hieronder.
          submitNow: true,
          city: mtCity,
          street: mtStreet,
          number: mtNumber,
          postcode: mtPostcode,
          extraPhotoUrls: extraPhotoUrls.split("\n").map((s) => s.trim()).filter(Boolean),
          extraDrawingUrls: extraDrawingUrls.split("\n").map((s) => s.trim()).filter(Boolean),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSendError(data.error ?? "Versturen naar Mediatask mislukt.");
        return;
      }
      setResult({ orderId: data.order.id, state: data.order.state });
      // Order staat er wél, alleen het indienen faalde — melden zonder de
      // upload als mislukt te tonen (opnieuw versturen zou dubbelen).
      if (data.submitError) {
        setSendError(
          `Order #${data.order.id} is aangemaakt, maar het indienen mislukte (${data.submitError}). Dien 'm handmatig in bij Mediatask — niet opnieuw versturen, dan ontstaat er een dubbele order.`
        );
      }

      // Koppeling bewaren op het bestaande concept (indien er een is), zodat
      // de status hier later terug te vinden is.
      if (existingDraft) {
        await fetch("/api/drafts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: existingDraft.id,
            status: existingDraft.status,
            straatnaam: existingDraft.straatnaam,
            state: {
              ...existingDraft.state,
              mediatask: { orderId: data.order.id, state: data.order.state, submittedAt: Date.now() },
            },
          }),
        }).catch(() => {});
      }
    } catch {
      setSendError("Versturen naar Mediatask mislukt.");
    } finally {
      setSending(false);
    }
  }

  /**
   * Maakt de Dropbox-projectmap aan (of hergebruikt een bestaande) op het
   * moment dat de opnemer verder gaat naar de documenten — dus ná de
   * adrescontrole. Eén keer per opname: is de map er al, dan komt hij
   * ongewijzigd terug. Levert null bij een fout, met de melding in
   * folderError, zodat de doorgaan-knop niet stil blijft hangen.
   */
  async function ensureNenFolder(): Promise<DropboxFolder | null> {
    if (dropboxFolder) return dropboxFolder;
    if (!address) return null;
    // Loopt er al een aanvraag, dan die afwachten i.p.v. een tweede sturen.
    // De disabled-knop is hiervoor geen afdoende slot: een dubbeltik op een
    // iPad vuurt beide clicks af vóórdat React de nieuwe state getekend
    // heeft, en dat leverde twee POST's op.
    if (folderInFlight.current) return folderInFlight.current;
    const run = createNenFolder();
    folderInFlight.current = run;
    try {
      return await run;
    } finally {
      folderInFlight.current = null;
    }
  }

  async function createNenFolder(): Promise<DropboxFolder | null> {
    if (!address) return null;
    setFolderBusy(true);
    setFolderError(null);
    try {
      const straatEnNummer = `${address.straatnaam} ${houseNumber(address)}`;
      // Dezelfde adresnotatie als de ClickUp-flow, maar in de aparte
      // "Automatie NEN2580"-hoofdmap (kind: "nen") met het NEN2580-sjabloon
      // als submapstructuur i.p.v. de energielabel-mappen.
      const res = await fetch("/api/dropbox/folder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ woonplaats: address.woonplaatsnaam, straatEnNummer, kind: "nen" }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.path) {
        setFolderError(data?.error ?? "De Dropbox-map kon niet worden aangemaakt.");
        return null;
      }
      setDropboxFolder(data);
      void refreshFileCounts(data);
      return data as DropboxFolder;
    } catch {
      setFolderError("De Dropbox-map kon niet worden aangemaakt.");
      return null;
    } finally {
      setFolderBusy(false);
    }
  }

  function renderDropboxCard() {
    return (
      <div className={`dbx-strip${dropboxFolder ? " is-ready" : ""}`}>
        <div className="dbx-strip-top">
          <span className="conn-icon is-dropbox dbx-strip-icon">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M7 3 2 6.3 7 9.6 2 12.9l5 3.3 5-3.3 5 3.3 5-3.3-5-3.3 5-3.3-5-3.3-5 3.3-5-3.3Zm5 15 5-3.3v2.2L12 20l-5-3.1v-2.2l5 3.3Z"
                fill="currentColor"
              />
            </svg>
          </span>
          {!dropboxFolder && (
            <span className={`dbx-strip-text${dropboxFolder ? "" : " is-wrap"}`}>
              {folderBusy ? (
                <>
                  <span className="spinner" /> Dropbox-map klaarzetten…
                </>
              ) : folderError ? (
                <span className="is-warning-row">⚠ {folderError}</span>
              ) : (
                // Geen spinner zolang er niets loopt: de map komt pas bij
                // "Documenten uploaden", en een eeuwig draaiend rondje zou
                // suggereren dat de app vastzit.
                "Map wordt aangemaakt zodra je de documenten opent"
              )}
            </span>
          )}
          {dropboxFolder && (
            <>
              <span className="dbx-strip-text">
                <span className="dbx-strip-check" aria-hidden="true">✓</span>
                Map aangemaakt — <span className="dbx-folder-path">{dropboxFolder.path}</span>
              </span>
              {result && (
                <span className="dbx-strip-progress-label" title={`Mediatask-order #${result.orderId}`}>
                  <span className="dbx-strip-check" aria-hidden="true">✓</span> Gelinked in Mediatask
                </span>
              )}
              <button
                type="button"
                className="dbx-strip-refresh"
                onClick={() => refreshFileCounts(dropboxFolder)}
                disabled={filesLoading}
                title="Nu verversen"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true" className={filesLoading ? "spin" : undefined}>
                  <path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              <a href={dropboxFolder.url} target="_blank" rel="noopener noreferrer" className="btn-open-dbx">
                Openen
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M6 4h6v6M12 4 4 12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </a>
            </>
          )}
        </div>
        {dropboxFolder && (
          <div className="dbx-strip-docs">
            {NEN_DOC_FOLDERS.map((name) => {
              const count = fileCounts?.[name] ?? 0;
              const done = count > 0;
              return (
                <div key={name} className={`dbx-strip-doc-row${done ? " is-done" : ""}`}>
                  {done ? (
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <path d="M3.5 8.5 6.5 11.5 12.5 4.5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  ) : (
                    <span className="dbx-strip-doc-empty" aria-hidden="true" />
                  )}
                  <span className="dbx-strip-doc-label">{name}</span>
                  <span className="dbx-strip-doc-status">
                    {filesLoading ? "…" : `${count} bestand${count === 1 ? "" : "en"}`}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  // Is er (automatisch of handmatig) een makelaar gekozen? Bepaalt de rode
  // waarschuwing in de adreskaart én of de bevestigingspop-up door mag naar
  // de documentenpagina.
  const agencyChosen = !!(config?.agencies.length ? agencyId : manualAgencyId);

  // Overzicht van alle al ingevulde Mediatask-ordergegevens (m.u.v. de
  // foto/tekening-URL's), als vinklijst onder het adres — zodat in één oogopslag
  // zichtbaar is wat er al is voorgevuld, zonder eerst de sectie open te klappen.
  function renderMediataskSummary() {
    const items: { label: string; value: string }[] = [];

    const productLabel = selectedProduct?.full_name ?? (manualProductId || null);
    if (productLabel) items.push({ label: "Product", value: productLabel });

    const agencyLabel = config?.agencies.find((a) => a.id === agencyId)?.name ?? (manualAgencyId || null);
    if (agencyLabel) items.push({ label: "Makelaar", value: agencyLabel });

    const priorityLabel = config?.priorities.find((p) => p.id === priorityId)?.name ?? (manualPriorityId || null);
    if (priorityLabel) items.push({ label: "Prioriteit", value: priorityLabel });

    for (const [key, value] of Object.entries(finalProductConfig)) {
      if (!value) continue;
      items.push({ label: mediataskFieldLabel(key), value });
    }

    // Ontbrekende makelaar prominent rood bovenaan — dit is het enige veld
    // dat de flow echt blokkeert, dus dat mag niet stilletjes ontbreken.
    const missingAgency = !configLoading && !agencyChosen;

    if (items.length === 0 && !missingAgency) return null;

    return (
      <div className="dbx-strip-docs">
        {missingAgency && (
          <div className="dbx-strip-doc-row is-warning-row">
            <span aria-hidden="true">⚠</span>
            <span className="dbx-strip-doc-label">Makelaar</span>
            <span className="dbx-strip-doc-status">nog niet gekozen</span>
          </div>
        )}
        {items.map((it) => (
          <div key={it.label} className="dbx-strip-doc-row is-done">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M3.5 8.5 6.5 11.5 12.5 4.5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span className="dbx-strip-doc-label">{it.label}</span>
            <span className="dbx-strip-doc-status">{it.value}</span>
          </div>
        ))}
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

  // Klapt de Mediatask-ordersectie open (staat standaard dicht, de vinklijst
  // in de adreskaart is al genoeg) en scrolt ernaartoe zodat hij ook echt in
  // beeld komt.
  function goToMediataskSection() {
    setShowMediataskForm(true);
    requestAnimationFrame(() => {
      document.getElementById("mediatask-order-section")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  /**
   * "Ja, klopt" in de bevestigingspop-up: map klaarzetten, de order alvast
   * als concept bij Mediatask aanmaken, en dan door naar de documenten.
   *
   * De order ontstond vroeger pas bij het afronden. Nu hij er meteen is, kan
   * elke scan die bij Dropbox binnenkomt op de achtergrond direct door naar
   * Mediatask — bij het afronden hangt hij er dan al. Lukt het aanmaken hier
   * niet, dan gaat de flow gewoon door zonder ordernummer en ontstaat de
   * order alsnog bij het afronden, zoals voorheen.
   */
  async function bevestigEnDoor() {
    // Normaal staat de map er al (aangemaakt bij "Documenten uploaden"); is
    // dat toen mislukt, dan hier nog één poging i.p.v. stil niets doen.
    const folder = await ensureNenFolder();
    if (!folder) return;

    // Al een order voor dit adres (bv. uit een eerdere sessie)? Die
    // hergebruiken — een tweede aanmaak zou een dubbele order opleveren.
    let orderId = result?.orderId ?? null;
    if (!orderId && finalProductId && finalPriorityId && finalAgencyId) {
      setOrderSetup("bezig");
      try {
        const res = await fetch("/api/mediatask/orders", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            draftOnly: true,
            dropboxFolderPath: folder.path,
            productId: Number(finalProductId),
            priorityId: finalPriorityId,
            agencyId: finalAgencyId,
            productConfiguration: finalProductConfig,
            city: mtCity,
            street: mtStreet,
            number: mtNumber,
            postcode: mtPostcode,
          }),
        });
        const data = await res.json();
        if (res.ok) {
          orderId = data.order.id as number;
          setResult({ orderId, state: data.order.state });
          setOrderSetup("idle");
          if (existingDraft) koppelOrderAanConcept(existingDraft, orderId, data.order.state);
        } else {
          setOrderSetup("fout");
        }
      } catch {
        setOrderSetup("fout");
      }
    }

    setShowAgencyConfirm(false);
    const addrTekst = `${address?.straatnaam ?? ""} ${address ? houseNumber(address) : ""}`.trim();
    const params = new URLSearchParams();
    params.set("path", folder.path);
    params.set("dropboxUrl", folder.url);
    params.set("addr", addrTekst);
    if (finalProductId) params.set("productId", String(finalProductId));
    if (finalPriorityId) params.set("priorityId", finalPriorityId);
    if (finalAgencyId) params.set("agencyId", finalAgencyId);
    params.set("config", JSON.stringify(finalProductConfig));
    params.set("city", mtCity);
    params.set("street", mtStreet);
    params.set("number", mtNumber);
    params.set("postcode", mtPostcode);
    // Het ordernummer mee: daarmee stuurt de documentenpagina elke geslaagde
    // Dropbox-upload uit Optimized direct door als puntenwolk.
    if (orderId) params.set("orderId", String(orderId));
    // Het concept meegeven, zodat de documentenpagina 'm na een
    // geslaagde order kan afsluiten — anders blijft het adres
    // eeuwig als openstaande opname in beeld staan.
    if (existingDraft) params.set("draft", existingDraft.id);
    router.push(`/nen/documenten?${params.toString()}`);
  }

  async function refreshStatus() {
    if (!result) return;
    setStatusRefreshing(true);
    try {
      const res = await fetch(`/api/mediatask/orders/${result.orderId}`, { cache: "no-store" });
      const data = await res.json();
      if (res.ok) setResult({ orderId: result.orderId, state: data.order.state });
    } finally {
      setStatusRefreshing(false);
    }
  }

  return (
    <>
      <header className="topline">
        <span className="eyebrow">Upload NEN2580</span>
      </header>

      {!address && !loadingAddress && (
        <div className="addr-grid">
          <section className="addr-find" aria-label="Adres zoeken">
            <h1>Upload NEN2580</h1>

            <button className="btn btn-primary btn-block" onClick={startNearbySearch} disabled={locating}>
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
                            {a.distanceMeters < 1000 ? `${a.distanceMeters} m` : `${(a.distanceMeters / 1000).toFixed(1)} km`}
                          </span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <TodayAppointments onPick={pickFromAppointment} context="nen" onUseLocation={startNearbySearch} />
          </section>

          <section className="addr-detail" aria-label="Gekozen pand">
            <div className="placeholder">
              <span className="placeholder-mark">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M12 21s7-5.7 7-11a7 7 0 1 0-14 0c0 5.3 7 11 7 11Z" stroke="currentColor" strokeWidth="1.6" />
                  <circle cx="12" cy="10" r="2.6" stroke="currentColor" strokeWidth="1.6" />
                </svg>
              </span>
              <p>Bepaal je locatie of zoek een adres. Daarna kies je het NEN-product en versturen we de foto&apos;s uit Dropbox naar Mediatask.</p>
            </div>
          </section>
        </div>
      )}

      {loadingAddress && (
        <div className="pad" style={{ background: "var(--paper)", border: "1px solid var(--rule)", borderRadius: "var(--r)" }}>
          <div className="banner" style={{ background: "var(--inset)" }}>
            <span className="spinner" />
            <span>Pandgegevens ophalen uit de BAG…</span>
          </div>
        </div>
      )}

      {address && !loadingAddress && (
        <>
          {renderPinnedHead(
            <div className="topline">
              <button className="btn-back" onClick={resetAll}>
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M10 12.5 5.5 8 10 3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                Ander adres
              </button>
              <h2 style={{ fontSize: 17 }}>
                {address.straatnaam} {houseNumber(address)}
              </h2>
            </div>
          )}

        <div className="pad" style={{ background: "var(--paper)", border: "1px solid var(--rule)", borderRadius: "var(--r)" }}>
          <span className="eyebrow">Controleer het adres</span>
          <div className="card">
            {editingAddr ? (
              <div className="addr-edit">
                <div className="addr-edit-row">
                  <div className="field">
                    <label htmlFor="f-huisnr">Huisnummer</label>
                    <input id="f-huisnr" className="control" inputMode="numeric" value={addrHuisnummer} onChange={(e) => setAddrHuisnummer(e.target.value)} />
                  </div>
                  <div className="field">
                    <label htmlFor="f-huisletter">Letter</label>
                    <input id="f-huisletter" className="control" value={addrHuisletter} onChange={(e) => setAddrHuisletter(e.target.value)} />
                  </div>
                  <div className="field">
                    <label htmlFor="f-toevoeging">Toevoeging</label>
                    <input id="f-toevoeging" className="control" value={addrToevoeging} onChange={(e) => setAddrToevoeging(e.target.value)} />
                  </div>
                </div>
                <div className="addr-edit-row">
                  <div className="field is-wide">
                    <label htmlFor="f-postcode">Postcode</label>
                    <input id="f-postcode" className="control" value={addrPostcode} onChange={(e) => setAddrPostcode(e.target.value)} />
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
                        <path d="M4 16.5V20h3.5L18.4 9.1a1.5 1.5 0 0 0 0-2.1l-1.4-1.4a1.5 1.5 0 0 0-2.1 0L4 16.5Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                      </svg>
                      Aanpassen
                    </button>
                  </div>
                  {configLoading && !renderMediataskSummary() && (
                    <div className="card-mediatask-summary">
                      <span className="note" style={{ padding: 0, display: "inline-flex", alignItems: "center", gap: 8 }}>
                        <span className="spinner" /> Mediatask-gegevens ophalen…
                      </span>
                    </div>
                  )}
                  {renderMediataskSummary() && (
                    <div className="card-mediatask-summary">
                      {renderMediataskSummary()}
                      <button type="button" className="btn-edit-addr" onClick={goToMediataskSection}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                          <path d="M4 16.5V20h3.5L18.4 9.1a1.5 1.5 0 0 0 0-2.1l-1.4-1.4a1.5 1.5 0 0 0-2.1 0L4 16.5Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                        </svg>
                        Aanpassen
                      </button>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>

          <div className="section">
            <div className="section-head">
              <h2>Documenten</h2>
              <button
                type="button"
                className="btn btn-primary"
                disabled={configLoading || folderBusy}
                onClick={async () => {
                  // Hier is het adres gecontroleerd (de adreskaart met
                  // "Aanpassen" staat er direct boven), dus nu mag de map
                  // aangemaakt worden — en niet eerder.
                  if (!(await ensureNenFolder())) return;
                  setShowAgencyConfirm(true);
                }}
              >
                {configLoading
                  ? "Mediatask-gegevens laden…"
                  : folderBusy
                    ? "Dropbox-map klaarzetten…"
                    : "Documenten uploaden"}
              </button>
            </div>
          </div>

          {showMediataskForm && (
          <div className="section" id="mediatask-order-section">
            <div className="section-head">
              <h2>Mediatask-order</h2>
              <button type="button" className="btn-refresh" onClick={() => setShowMediataskForm(false)}>
                Verbergen
              </button>
            </div>
            <div className="section-body">
              {configLoading && <p className="note">Mediatask-configuratie ophalen…</p>}
              {configError && (
                <p className="note" style={{ padding: 0, margin: 0 }}>
                  ⚠ Mediatask nog niet gekoppeld ({configError}) — vul hieronder de gegevens handmatig in, dat werkt
                  al zodra jullie het token en de basis-URL hebben doorgegeven.
                </p>
              )}

              {!result && (
                <>
                  <div className="field is-wide">
                    <label htmlFor="mt-product">Product</label>
                    {config?.products.length ? (
                      <select
                        id="mt-product"
                        className={`control${productId ? " is-filled" : ""}`}
                        value={productId}
                        onChange={(e) => {
                          setProductId(Number(e.target.value));
                          setProductConfig({});
                        }}
                      >
                        <option value="">Kies…</option>
                        {config.products.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.full_name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        id="mt-product"
                        className="control"
                        placeholder="Product-id (bv. 6 voor Floorplanner NEN2580 plans)"
                        inputMode="numeric"
                        value={manualProductId}
                        onChange={(e) => setManualProductId(e.target.value)}
                      />
                    )}
                  </div>

                  {selectedProduct ? (
                    selectedProduct.configuration.map((c) => (
                      <div className="field" key={c.name}>
                        <label htmlFor={`mt-cfg-${c.name}`}>{mediataskFieldLabel(c.name)}</label>
                        {c.type === "select" ? (
                          <select
                            id={`mt-cfg-${c.name}`}
                            className={`control${productConfig[c.name] ? " is-filled" : ""}`}
                            value={productConfig[c.name] ?? ""}
                            onChange={(e) => setProductConfig((v) => ({ ...v, [c.name]: e.target.value }))}
                          >
                            <option value="">Kies…</option>
                            {c.values?.map((v) => (
                              <option key={v} value={v}>
                                {v}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <input
                            id={`mt-cfg-${c.name}`}
                            className={`control${productConfig[c.name] ? " is-filled" : ""}`}
                            type={c.type === "number" ? "number" : c.type === "date" ? "date" : "text"}
                            value={productConfig[c.name] ?? ""}
                            onChange={(e) => setProductConfig((v) => ({ ...v, [c.name]: e.target.value }))}
                          />
                        )}
                      </div>
                    ))
                  ) : (
                    <div className="field is-wide">
                      <label>Productconfiguratie (bv. house_type, style, option)</label>
                      <div className="draft-list">
                        {manualConfigRows.map((row, i) => (
                          <div key={i} className="addr-edit-row" style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 8 }}>
                            <input
                              className="control"
                              placeholder="veldnaam"
                              value={row.key}
                              onChange={(e) =>
                                setManualConfigRows((rows) => rows.map((r, j) => (j === i ? { ...r, key: e.target.value } : r)))
                              }
                            />
                            <input
                              className="control"
                              placeholder="waarde"
                              value={row.value}
                              onChange={(e) =>
                                setManualConfigRows((rows) => rows.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))
                              }
                            />
                            <button
                              type="button"
                              className="btn-text"
                              onClick={() => setManualConfigRows((rows) => rows.filter((_, j) => j !== i))}
                            >
                              ✕
                            </button>
                          </div>
                        ))}
                        <button
                          type="button"
                          className="btn-text"
                          onClick={() => setManualConfigRows((rows) => [...rows, { key: "", value: "" }])}
                        >
                          + Veld toevoegen
                        </button>
                      </div>
                    </div>
                  )}

                  <div className="field">
                    <label htmlFor="mt-agency">
                      Makelaar
                      {klantHint && agencyId && <span className="field-year-tag">via agenda: {klantHint}</span>}
                    </label>
                    {config?.agencies.length ? (
                      config.agencies.length > 1 ? (
                        <select
                          id="mt-agency"
                          className={`control${agencyId ? " is-filled" : ""}`}
                          value={agencyId}
                          onChange={(e) => setAgencyId(e.target.value)}
                        >
                          <option value="">Kies…</option>
                          {config.agencies.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.name}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <p className="note" style={{ padding: 0, margin: 0 }}>{config.agencies[0].name} (automatisch gekozen)</p>
                      )
                    ) : (
                      <input
                        id="mt-agency"
                        className="control"
                        placeholder="Makelaar-id"
                        value={manualAgencyId}
                        onChange={(e) => setManualAgencyId(e.target.value)}
                      />
                    )}
                  </div>

                  <div className="field">
                    <label htmlFor="mt-priority">Prioriteit</label>
                    {config?.priorities.length ? (
                      config.priorities.length > 1 ? (
                        <select
                          id="mt-priority"
                          className={`control${priorityId ? " is-filled" : ""}`}
                          value={priorityId}
                          onChange={(e) => setPriorityId(e.target.value)}
                        >
                          <option value="">Kies…</option>
                          {config.priorities.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <p className="note" style={{ padding: 0, margin: 0 }}>{config.priorities[0].name} (automatisch gekozen)</p>
                      )
                    ) : (
                      <input
                        id="mt-priority"
                        className="control"
                        placeholder="Prioriteit-id"
                        value={manualPriorityId}
                        onChange={(e) => setManualPriorityId(e.target.value)}
                      />
                    )}
                  </div>

                  <div className="field is-wide">
                    <label htmlFor="mt-extra-photos">Extra foto-URL&apos;s (optioneel, één per regel)</label>
                    <textarea
                      id="mt-extra-photos"
                      className="control"
                      rows={2}
                      placeholder="https://…"
                      value={extraPhotoUrls}
                      onChange={(e) => setExtraPhotoUrls(e.target.value)}
                    />
                  </div>
                  <div className="field is-wide">
                    <label htmlFor="mt-extra-drawings">Extra tekening-URL&apos;s (optioneel, één per regel)</label>
                    <textarea
                      id="mt-extra-drawings"
                      className="control"
                      rows={2}
                      placeholder="https://…"
                      value={extraDrawingUrls}
                      onChange={(e) => setExtraDrawingUrls(e.target.value)}
                    />
                  </div>

                  <div className="field is-wide" style={{ gap: 12 }}>
                    {sendError && <p className="conn-err">{sendError}</p>}
                    <button
                      className="btn btn-primary btn-block"
                      disabled={sending || !finalProductId || !finalPriorityId || !finalAgencyId}
                      onClick={send}
                    >
                      {sending ? "Bezig…" : "Versturen naar Mediatask"}
                    </button>
                  </div>
                </>
              )}

              {result && (
                <>
                  <div className="banner is-ok">
                    ✓ Order #{result.orderId} bij Mediatask — status: {result.state}
                  </div>
                  <button className="btn-refresh" onClick={refreshStatus} disabled={statusRefreshing}>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true" className={statusRefreshing ? "spin" : undefined}>
                      <path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    {statusRefreshing ? "Bezig met verversen…" : "Status verversen"}
                  </button>
                </>
              )}
            </div>
          </div>
          )}
        </div>
        </>
      )}

      {showAgencyConfirm && (
        <div
          className="compass-overlay"
          onClick={() => {
            setShowAgencyConfirm(false);
            setAgencyEditMode(false);
          }}
        >
          <div
            className={`compass-modal${!agencyChosen ? " is-invalid" : ""}`}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label="Bevestig makelaar"
          >
            <div className="compass-modal-head">
              <h3>{!agencyChosen ? "Kies een makelaar" : agencyEditMode ? "Makelaar aanpassen" : "Klopt dit?"}</h3>
              <button
                className="compass-close"
                onClick={() => {
                  setShowAgencyConfirm(false);
                  setAgencyEditMode(false);
                }}
                aria-label="Sluiten"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
              </button>
            </div>

            {agencyChosen && !agencyEditMode && renderMediataskSummary()}

            {agencyEditMode || !agencyChosen ? (
              <>
                {!agencyChosen && (
                  <p style={{ margin: "0 0 14px", fontSize: 14.5, fontWeight: 600, color: "var(--bad)" }}>
                    ⚠ Er is nog geen makelaar gekozen — kies er één om verder te kunnen.
                  </p>
                )}
                <div className="field is-wide" style={{ margin: "4px 0 20px" }}>
                  <label htmlFor="mt-agency-modal">Makelaar</label>
                  {config?.agencies.length ? (
                    <select
                      id="mt-agency-modal"
                      className={`control${agencyId ? " is-filled" : ""}`}
                      value={agencyId}
                      onChange={(e) => setAgencyId(e.target.value)}
                    >
                      <option value="">Kies…</option>
                      {config.agencies.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      id="mt-agency-modal"
                      className="control"
                      placeholder="Makelaar-id"
                      value={manualAgencyId}
                      onChange={(e) => setManualAgencyId(e.target.value)}
                    />
                  )}
                </div>
                {agencyChosen ? (
                  <button type="button" className="btn btn-primary btn-block" onClick={() => setAgencyEditMode(false)}>
                    Opslaan
                  </button>
                ) : (
                  // Bewust zichtbaar maar geblokkeerd: zonder makelaar kan er
                  // niet doorgeklikt worden naar de documentenpagina.
                  <button type="button" className="btn btn-primary btn-block" disabled>
                    Ja, klopt
                  </button>
                )}
              </>
            ) : (
              <>
                <p style={{ margin: "16px 0 20px", fontSize: 15, fontWeight: 600 }}>
                  Klopt het dat het gaat om{" "}
                  <span style={{ color: "var(--accent-text)" }}>
                    {config?.agencies.find((a) => a.id === agencyId)?.name || manualAgencyId}
                  </span>
                  ?
                </p>

                {/* Terwijl de concept-order naar Mediatask gaat is er niets te
                    kiezen: dan de knoppen vervangen door wat er gebeurt, zodat
                    zichtbaar is dat de order nu al aangemaakt wordt. */}
                {orderSetup === "bezig" ? (
                  <div className="banner" style={{ background: "var(--inset)" }}>
                    <span className="spinner" />
                    <span>Order aanmaken bij Mediatask…</span>
                  </div>
                ) : (
                  <>
                    {result && (
                      <p className="note" style={{ padding: 0, margin: "0 0 12px" }}>
                        ✓ Order #{result.orderId} staat al klaar bij Mediatask — de scans gaan er tijdens het
                        uploaden direct naartoe.
                      </p>
                    )}
                    <div style={{ display: "flex", gap: 10 }}>
                      <button type="button" className="btn btn-quiet" style={{ flex: 1 }} onClick={() => setAgencyEditMode(true)}>
                        Aanpassen
                      </button>
                      <button type="button" className="btn btn-primary" style={{ flex: 1 }} onClick={bevestigEnDoor}>
                        Ja, klopt
                      </button>
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
