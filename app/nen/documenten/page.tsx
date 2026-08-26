"use client";

import { Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import ScanCheck from "@/components/ScanCheck";
import { enqueue, getServerSnapshot, getSnapshot, removeTask, subscribe } from "@/lib/upload-queue";
// Geoptimaliseerde puntenwolk-exports: hierin zitten de werkelijke punten, dus
// hier valt een echte plattegrond uit te snijden.
import { isPointCloudFile } from "@/lib/pointcloud-read";
import { meldAfgerond } from "@/lib/opname-melden";

// Zelfde 4 mappen als op de NEN-pagina. Optimized en RAW staan allebei
// pagina-breed (dat zijn de scan-/verwerkingsmappen), Additionals en Photo's
// delen de resterende breedte.
const WIDE_FOLDERS = ["Optimized", "RAW"] as const;
const SPLIT_FOLDERS = ["Additionals", "Photo's", "Video"] as const;
const ALL_FOLDERS = [...WIDE_FOLDERS, ...SPLIT_FOLDERS] as const;
type FolderName = (typeof ALL_FOLDERS)[number];

/** Mappen waar geen foto's of video's in horen: dan meteen de bestandskiezer
    i.p.v. de camera-keuze van iOS. */
function isDocumentFolder(folder: FolderName): boolean {
  return folder === "Optimized" || folder === "RAW";
}

// Mappen die daadwerkelijk meegaan naar Mediatask. RAW-scans ("_raw.dp")
// worden bewust (nog) niet meegestuurd — Mediatask's "pointclouds"-veld is
// read-only (crasht de order-aanmaak bij input), en er is geen ander
// bevestigd werkend veld voor puntenwolk-scans. RAW blijft dus voorlopig
// alleen in Dropbox staan.
// Mappen die als downloadlink in de opmerking bij de order komen. Alleen
// Optimized gaat daarnaast ook écht als bestand naar Mediatask (als
// puntenwolk); voor de rest is de Dropbox-link de afspraak.
const LINK_FOLDERS = ["Optimized", "RAW", "Additionals", "Photo's", "Video"] as const;

interface ExistingFile {
  name: string;
  size: number;
}

// Eén regel per stap in de "Uploaden naar Mediatask"-pop-up — zelfde
// opzet als de upload-pop-up bij "Upload energielabel" (spinner → vinkje).
type MediataskStepStatus = "pending" | "busy" | "done" | "error" | "skipped";

// RAW-scanbestanden (3D-puntenwolk) zijn altijd te herkennen aan "_raw.dp"
// in de bestandsnaam — die horen in de RAW-map, nooit in Optimized.
/** "45 sec", "2 min 10 sec", "1 uur 5 min" — kort en zonder rekenwerk. */
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

function isRawScanFile(name: string): boolean {
  return /_raw\.dp$/i.test(name.trim());
}

function DocumentenContent() {
  const params = useSearchParams();
  const router = useRouter();
  const folderPath = params.get("path") ?? "";
  const addr = params.get("addr") ?? "";
  const productId = params.get("productId") ?? "";
  const priorityId = params.get("priorityId") ?? "";
  const agencyId = params.get("agencyId") ?? "";
  const productConfiguration = params.get("config") ?? "{}";
  const city = params.get("city") ?? "";
  const street = params.get("street") ?? "";
  const number = params.get("number") ?? "";
  const postcode = params.get("postcode") ?? "";
  const dropboxUrl = params.get("dropboxUrl") ?? "";
  // Het concept waar deze opname bij hoort; nodig om 'm af te sluiten zodra de
  // order er staat.
  const draftId = params.get("draft") ?? "";

  const [existing, setExisting] = useState<Record<string, ExistingFile[]>>({});
  const [loading, setLoading] = useState(true);
  // Wie er ingelogd is, zodat op het dashboard te zien is van wie een lopende
  // upload is. Best-effort: lukt het ophalen niet, dan blijft de tag gewoon weg.
  const [account, setAccount] = useState<string | null>(null);
  useEffect(() => {
    fetch("/api/clickup/list-meta", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setAccount(d?.account?.username ?? null))
      .catch(() => {});
  }, []);
  // Lopende/afgeronde uploads komen uit de wachtrij buiten React, zodat ze
  // doorlopen als je tussendoor wegnavigeert.
  const allTasks = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const tasks = useMemo(() => allTasks.filter((t) => t.folderPath === folderPath), [allTasks, folderPath]);
  const fileInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
  // Aparte keuzeknop voor de export waarop de controle draait. Die gaat
  // bewust niet naar Dropbox: de puntenwolk is puur voor de controle, en de
  // .dp die Mediatask nodig heeft staat al in Optimized.
  const checkInputRef = useRef<HTMLInputElement | null>(null);
  // Pop-up wanneer er een RAW-scan (_raw.dp) in Optimized terecht dreigt te
  // komen of al staat — die hoort bij RAW.
  // `file` is alleen gezet wanneer het bestand nog los in het geheugen zit
  // (net gekozen, nog niet geüpload) — dan kan "Verplaats naar RAW" het
  // automatisch daarheen uploaden zonder opnieuw te laten kiezen. Stond het
  // al (verkeerd) in Dropbox, dan is er geen File-object beschikbaar en toont
  // de pop-up alleen de waarschuwing.
  const [rawWarning, setRawWarning] = useState<{ name: string; file?: File } | null>(null);
  // Verdiepingen per geüpload Optimized-bestand: één scan kan meerdere
  // bouwlagen bevatten en er kunnen meerdere scans per adres zijn. Gaat als
  // opmerking mee naar de Mediatask-order, mét bestandsnaam erbij.
  const [floorsByFile, setFloorsByFile] = useState<Record<string, number[]>>({});
  // Alle unieke bouwlagen over de scans heen — de scancontrole toetst
  // daarmee of er een verdieping ontbreekt.
  const allFloors = [...new Set(Object.values(floorsByFile).flat())];
  // De geoptimaliseerde export van deze opname, zoals die net geüpload is. De
  // scancontrole leest 'm rechtstreeks uit het geheugen; na een herlaadbeurt is
  // hij weg en slaan we de controle over (het bestand staat dan al in Dropbox).
  const [optimizedFile, setOptimizedFile] = useState<File | null>(null);
  // Het .dp-bestand uit dezelfde map. Daar staan de referentiematen en
  // AprilTags in, die in geen enkele export terechtkomen.
  const [optimizedDp, setOptimizedDp] = useState<File | null>(null);
  // Referentiegegevens uit de BAG en 3DBAG, puur om de scan tegen af te zetten.
  // Deze registraties kloppen regelmatig niet, dus een verschil kleurt rood in
  // de checklist maar houdt het versturen nooit tegen.
  const [referentie, setReferentie] = useState<{ oppervlakte: number | null; bouwlagen: number | null } | null>(null);
  // Staat de controle open, en is hij al een keer langsgekomen? Dat laatste
  // voorkomt dat je na "Toch doorsturen" opnieuw de hele molen doorloopt.
  const [scanCheckOpen, setScanCheckOpen] = useState(false);
  // Tekstregel bij de scan-stap in de voortgangspop-up.
  const [scanUploadStap, setScanUploadStap] = useState<string | null>(null);
  // Id van de vastgelegde scancontrole, zodat die aan de order gekoppeld kan
  // worden zodra we een ordernummer hebben.
  const [scanRecordId, setScanRecordId] = useState<string | null>(null);
  const [scanCheckDone, setScanCheckDone] = useState(false);
  // Melding wanneer er een bestand gekozen is dat geen puntenwolk is.
  const [exportFout, setExportFout] = useState<string | null>(null);

  async function refreshFiles() {
    if (!folderPath) return;
    setLoading(true);
    try {
      const results = await Promise.all(
        ALL_FOLDERS.map((name) =>
          fetch("/api/dropbox/files", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: `${folderPath}/${name}` }),
          })
            .then((r) => r.json())
            .catch(() => ({ files: [] }))
        )
      );
      const files: Record<string, ExistingFile[]> = {};
      ALL_FOLDERS.forEach((name, i) => {
        files[name] = results[i].files ?? [];
      });
      setExisting(files);
      void cleanupMisplacedRawFiles(files["Optimized"] ?? []);
    } finally {
      setLoading(false);
    }
  }

  // Vangnet: als er toch al eens een RAW-scan in Optimized is beland (bv. via
  // een oudere versie van deze pagina), leeg dat weer bij elke ververs-beurt.
  async function cleanupMisplacedRawFiles(optimizedFiles: ExistingFile[]) {
    const misplaced = optimizedFiles.filter((f) => isRawScanFile(f.name));
    if (misplaced.length === 0) return;
    setRawWarning({ name: misplaced[0].name });
    for (const f of misplaced) {
      try {
        const accessToken = await fetch("/api/dropbox/delete-file", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: `${folderPath}/Optimized/${f.name}` }),
        });
        if (!accessToken.ok) continue;
      } catch {
        // best-effort — de gebruiker is al gewaarschuwd, een enkele
        // mislukte opruimactie mag de rest van de pagina niet blokkeren.
      }
    }
    setExisting((prev) => ({
      ...prev,
      Optimized: (prev["Optimized"] ?? []).filter((f) => !isRawScanFile(f.name)),
    }));
  }

  useEffect(() => {
    void refreshFiles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderPath]);

  // Eenmalig de BAG-referentie ophalen. Mislukt dat, dan blijft het gewoon leeg
  // en toont de checklist die twee punten als "onbekend".
  useEffect(() => {
    const zoekterm = [postcode, number].filter(Boolean).join(" ") || addr;
    if (!zoekterm) return;
    let afgebroken = false;
    fetch(`/api/address/scan-reference?q=${encodeURIComponent(zoekterm)}`)
      .then((r) => r.json())
      .then((d) => {
        if (!afgebroken) setReferentie({ oppervlakte: d.oppervlakte ?? null, bouwlagen: d.bouwlagen ?? null });
      })
      .catch(() => {});
    return () => {
      afgebroken = true;
    };
  }, [postcode, number, addr]);

  // Zodra er een upload klaar is, de bestandenlijst verversen — de wachtrij
  // zit buiten React, dus dat gebeurt hier op basis van het aantal afgeronde
  // uploads i.p.v. vanuit de upload zelf.
  const doneCount = tasks.filter((t) => t.dropbox === "done").length;
  useEffect(() => {
    if (doneCount > 0) void refreshFiles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doneCount]);

  // Uploaden gebeurt in een wachtrij buiten React (lib/upload-queue.ts):
  // die blijft draaien als je tussendoor naar de order terugloopt, stuurt de
  // bestanden rechtstreeks naar Dropbox en doet er meerdere tegelijk.
  function uploadFile(folder: FolderName, file: File) {
    enqueue(folderPath, folder, file, account);
  }

  function pickFile(folder: FolderName) {
    fileInputRefs.current[folder]?.click();
  }

  // Rood zodra een map nog geen enkel bestand heeft (en er ook niet net één
  // geüpload is) — zo valt in één oogopslag op wat nog moet gebeuren.
  function isMissing(folder: FolderName): boolean {
    if (!folderPath || loading) return false;
    return (existing[folder]?.length ?? 0) === 0;
  }

  // Een voltooide map klapt in tot één groene regel; met een tik klapt hij
  // weer open (bv. om nog een bestand toe te voegen).
  const [reopened, setReopened] = useState<Record<string, boolean>>({});

  // Welk bestand staat op het punt verwijderd te worden. Bewust een tweede
  // tik als bevestiging: verwijderen uit Dropbox is niet terug te draaien,
  // en op een iPad is een misklik zo gebeurd.
  const [teVerwijderen, setTeVerwijderen] = useState<string | null>(null);
  const [verwijderBezig, setVerwijderBezig] = useState<string | null>(null);

  async function verwijderBestand(folder: FolderName, name: string) {
    const key = `${folder}/${name}`;
    setVerwijderBezig(key);
    try {
      const res = await fetch("/api/dropbox/delete-file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: `${folderPath}/${folder}/${name}` }),
      });
      if (!res.ok) throw new Error("mislukt");
      removeTask(folderPath, folder, name);
      setFloorsByFile((prev) => {
        const next = { ...prev };
        delete next[name];
        return next;
      });
      setExisting((prev) => ({ ...prev, [folder]: (prev[folder] ?? []).filter((f) => f.name !== name) }));
      void refreshFiles();
    } catch {
      setRawWarning({ name: `${name} kon niet verwijderd worden — probeer het opnieuw.` });
    } finally {
      setVerwijderBezig(null);
      setTeVerwijderen(null);
    }
  }

  /** Kiesknop + verborgen invoerveld; ook zichtbaar als de map al klaar is,
      zodat je er altijd nog een bestand bij kunt zetten. */
  function renderPicker(folder: FolderName, compact = false) {
    const isDocOnly = isDocumentFolder(folder);
    return (
      <>
        <input
          ref={(el) => {
            fileInputRefs.current[folder] = el;
          }}
          type="file"
          multiple
          accept={
            isDocOnly
              ? ".pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.zip,.laz,.las,.e57,.ply,.pts,.xyz,.dwg,.dxf,.dp,application/octet-stream"
              : undefined
          }
          style={{ display: "none" }}
          onChange={(e) => {
            const chosen = [...(e.target.files ?? [])];
            e.target.value = "";
            if (!chosen.length) return;
            for (const file of chosen) {
              if (folder === "Optimized" && isRawScanFile(file.name)) {
                setRawWarning({ name: file.name, file });
                continue;
              }
              // Een export in Optimized is meteen de bron voor de
              // scancontrole: die opent hier, zodat je de plattegronden ziet
              // terwijl de upload in de wachtrij doorloopt.
              if (folder === "Optimized" && isPointCloudFile(file.name)) {
                setOptimizedFile(file);
                setScanCheckDone(false);
                setScanCheckOpen(true);
              } else if (folder === "Optimized" && /\.dp$/i.test(file.name)) {
                // Hierin staan de referentiematen en AprilTags; die gaan mee
                // zodra de controle draait.
                setOptimizedDp(file);
              }
              uploadFile(folder, file);
            }
          }}
        />
        <button
          type="button"
          className={`btn-pick-file${compact ? " is-compact" : ""}`}
          disabled={!folderPath}
          onClick={() => pickFile(folder)}
        >
          <span className="conn-icon is-dropbox" style={{ width: 16, height: 16 }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M7 3 2 6.3 7 9.6 2 12.9l5 3.3 5-3.3 5 3.3 5-3.3-5-3.3 5-3.3-5-3.3-5 3.3-5-3.3Zm5 15 5-3.3v2.2L12 20l-5-3.1v-2.2l5 3.3Z"
                fill="currentColor"
              />
            </svg>
          </span>
          {compact ? "Nog een bestand" : "Bestand kiezen"}
        </button>
      </>
    );
  }

  /**
   * Verdiepingkiezer voor één scanbestand.
   *
   * Staat zowel onder een geüpload bestand als al tijdens het uploaden: een
   * scan van honderden MB's is minuten bezig, en dat is precies het moment
   * waarop de opnemer nog weet welke bouwlaag hij net heeft gescand. Wachten
   * tot de upload klaar is betekent dat hij dan pas moet gaan terugdenken.
   */
  function renderFloorPicker(naam: string) {
    const chosen = floorsByFile[naam] ?? [];
    return (
      <>
        <span className="floor-label">
          Op welke verdieping(en) is deze scan?{chosen.length === 0 && <em> — verplicht</em>}
        </span>
        <span className="floor-picker">
          {Array.from({ length: 13 }, (_, i) => i - 2).map((n) => {
            const on = chosen.includes(n);
            return (
              <button
                key={n}
                type="button"
                className={`floor-btn${on ? " is-on" : ""}`}
                aria-pressed={on}
                onClick={() =>
                  setFloorsByFile((prev) => {
                    const cur = prev[naam] ?? [];
                    return { ...prev, [naam]: on ? cur.filter((x) => x !== n) : [...cur, n] };
                  })
                }
              >
                {n}
              </button>
            );
          })}
        </span>
      </>
    );
  }

  /** Bestandenlijst; bij Optimized met de verdiepingkiezer onder elk bestand. */
  function renderFileList(folder: FolderName, files: ExistingFile[]) {
    return (
      <ul className="doc-files">
        {files.map((f) => {
          return (
            <li key={f.name} className={folder === "Optimized" ? "has-floors" : "has-actions"}>
              <span className="doc-file-line">
                <span className="doc-file-check" aria-hidden="true">✓</span>
                <span className="doc-file-name" title={f.name}>{f.name}</span>
                <button
                  type="button"
                  className="doc-file-del"
                  title={`${f.name} verwijderen`}
                  aria-label={`${f.name} verwijderen`}
                  onClick={() =>
                    setTeVerwijderen(teVerwijderen === `${folder}/${f.name}` ? null : `${folder}/${f.name}`)
                  }
                >
                  ✕
                </button>
              </span>
              {/* Bevestiging op een eigen regel: in de smalle kolommen paste
                  dit naast de bestandsnaam niet en brak de naam per letter af. */}
              {teVerwijderen === `${folder}/${f.name}` && (
                <span className="doc-file-confirm">
                  <span>Verwijderen?</span>
                  <button
                    type="button"
                    className="doc-file-yes"
                    disabled={verwijderBezig === `${folder}/${f.name}`}
                    onClick={() => verwijderBestand(folder, f.name)}
                  >
                    {verwijderBezig === `${folder}/${f.name}` ? "Bezig…" : "Ja, verwijder"}
                  </button>
                  <button type="button" className="doc-file-no" onClick={() => setTeVerwijderen(null)}>
                    Nee
                  </button>
                </span>
              )}
              {folder === "Optimized" && renderFloorPicker(f.name)}
            </li>
          );
        })}
      </ul>
    );
  }

  function renderFolder(folder: FolderName) {
    const files = existing[folder];
    const rows = tasks.filter((t) => t.folder === folder);
    const missing = isMissing(folder);
    // Groen zodra alles in deze map bij Dropbox staat. Dat is hier ook het
    // hele verhaal: behalve Optimized gaat er niets rechtstreeks naar
    // Mediatask — de rest deelt de verwerker via de Dropbox-links in de
    // opmerking bij de order.
    const allComplete = rows.length > 0 && rows.every((r) => r.dropbox === "done");

    if (allComplete && !reopened[folder]) {
      return (
        <div className="doc-col is-complete" key={folder}>
          <button
            type="button"
            className="doc-col-collapsed"
            onClick={() => setReopened((p) => ({ ...p, [folder]: true }))}
            title="Openen om nog een bestand toe te voegen"
          >
            <span className="doc-title">{folder}</span>
            <span className="doc-complete-checks">
              <span>✓ Dropbox</span>
            </span>
          </button>

          {/* Ook als de map dichtklapt blijft zichtbaar wát erin staat — zo
              zie je per map wat er al geüpload is zonder 'm open te klikken. */}
          {files && files.length > 0 && renderFileList(folder, files)}
          {renderPicker(folder, true)}
        </div>
      );
    }

    return (
      <div className={`doc-col${missing ? " is-missing" : ""}${allComplete ? " is-complete" : ""}`} key={folder}>
        <div className="doc-col-head">
          <span className="doc-title">{folder}</span>
        </div>

        {renderPicker(folder)}

        {rows.map((r) => (
          <div
            key={r.id}
            className={`doc-upload-progress${folder === "Optimized" ? " scan-kaart" : ""}`}
          >
            <span className="scan-kaart-naam">{r.name}</span>
            {r.dropbox === "uploading" && (
              <>
                <div className="doc-upload-bar">
                  <div className="doc-upload-bar-fill" style={{ width: `${r.pct}%` }} />
                </div>
                <span className="note" style={{ padding: 0 }}>
                  Dropbox: {r.pct}%
                  {formatEta(r.etaSeconds) && <span className="upload-eta"> · nog {formatEta(r.etaSeconds)}</span>}
                </span>
              </>
            )}
            {r.dropbox === "done" && (
              <span className="note" style={{ padding: 0, color: "#1c7a41" }}>✓ Dropbox</span>
            )}
            {r.dropbox === "error" && (
              <span className="note" style={{ padding: 0, color: "var(--bad)" }}>⚠ Dropbox: {r.dropboxError}</span>
            )}
            {/* Al tijdens het uploaden invulbaar: dan weet de opnemer nog
                welke bouwlaag hij net gescand heeft. */}
            {folder === "Optimized" && renderFloorPicker(r.name)}
          </div>
        ))}

        {!folderPath ? (
          <p className="note" style={{ padding: 0, margin: 0 }}>Geen Dropbox-map bekend.</p>
        ) : loading && !files ? (
          <p className="note" style={{ padding: 0, margin: 0 }}>Bestanden ophalen…</p>
        ) : files && files.length > 0 ? (
          renderFileList(folder, files)
        ) : (
          <p className="note" style={{ padding: 0, margin: 0, color: missing ? "#c22b2b" : undefined }}>
            Nog niets geüpload naar deze map.
          </p>
        )}
      </div>
    );
  }

  // ---------- "Uploaden naar Mediatask" onderaan de pagina ----------
  const [showMediataskModal, setShowMediataskModal] = useState(false);
  const [mediataskSteps, setMediataskSteps] = useState<Record<string, MediataskStepStatus>>({});
  // Wat Mediatask zélf terugmeldt per scan. Niet "wij hebben het verstuurd"
  // maar "hij hangt er ook echt aan" — dat is het enige wat telt, en het was
  // tot nu toe nergens te zien.
  const [scanBevestigd, setScanBevestigd] = useState<Record<string, number>>({});
  /**
   * Verwerking van de puntenwolken aan de kant van Mediatask.
   *
   * Aankomen en verwerkt worden zijn twee dingen, en daartussen zit bij een
   * grote scan een kwartier waarin je niets ziet. Dat is precies zo lang als
   * een afgekeurde scan er ook uitziet, dus zonder dit blok kan de opnemer
   * niet weten of het goed gaat. Zodra Mediatask voorbeeldbeelden maakt, is de
   * scan echt uitgelezen — dat is het enige signaal dat hun API geeft.
   */
  const [verwerking, setVerwerking] = useState<{ klaar: number; totaal: number } | null>(null);
  const verwerkTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [mediataskError, setMediataskError] = useState<string | null>(null);
  const [mediataskOrderId, setMediataskOrderId] = useState<number | null>(null);
  // Order is aangemaakt maar het indienen zelf faalde — apart van
  // mediataskError, want de order bestaat dan wél en mag niet opnieuw
  // aangemaakt worden.
  const [mediataskSubmitError, setMediataskSubmitError] = useState<string | null>(null);
  const [mediataskState, setMediataskState] = useState<string | null>(null);
  // Voortgangsbalk in de pop-up. Mediatask geeft geen echte tussenstand
  // terug (één aanroep maakt de hele order), dus de balk kruipt tijdens het
  // wachten richting de 90% en springt op 100% zodra de order er staat —
  // beter zichtbaar "er gebeurt iets" dan een draaiend cirkeltje.
  const [mediataskPct, setMediataskPct] = useState(0);
  // Verstreken tijd, zodat zichtbaar is dat er nog iets gebeurt bij een
  // order die lang duurt.
  const [mediataskElapsed, setMediataskElapsed] = useState(0);
  const mediataskTickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const hasMediataskConfig = !!productId && !!priorityId && !!agencyId;
  // Elk scanbestand moet zijn verdiepingen hebben: zonder die informatie kan
  // de verwerker bij Mediatask niet zien wélke bouwlaag hij voor zich heeft.
  const optimizedFiles = existing["Optimized"] ?? [];
  const filesZonderVerdieping = optimizedFiles.filter((f) => (floorsByFile[f.name] ?? []).length === 0);

  // De scans die als puntenwolk meegaan: alles wat in de Optimized-map van
  // Dropbox staat. Het versturen gebeurt vanaf onze server, dus het maakt niet
  // uit of het bestand nog op dit apparaat staat — een scan die gisteren op een
  // andere iPad is geüpload gaat gewoon mee.
  const teVersturenScans = optimizedFiles;
  // Loopt er nog een upload naar Dropbox? Dan mag de order niet weg. De server
  // haalt de scan namelijk uit Dropbox, en Dropbox laat een bestand pas zien
  // als het volledig binnen is — halverwege versturen levert dus een order op
  // zónder scan, zonder dat iemand dat merkt.
  const nogAanHetUploaden = tasks.filter((t) => t.dropbox === "uploading");

  function stopVerwerkTimer() {
    if (verwerkTimerRef.current) {
      clearInterval(verwerkTimerRef.current);
      verwerkTimerRef.current = null;
    }
  }

  /**
   * Vraagt Mediatask elke 20 seconden hoeveel puntenwolken er verwerkt zijn,
   * tot ze allemaal klaar zijn of het geduld op is (20 min).
   *
   * Blokkeert niets: de opnemer mag de pop-up sluiten en wegrijden, dit loopt
   * bij Mediatask toch door. Het is puur om te kunnen zien dat er iets gebeurt.
   */
  function volgVerwerking(orderId: number, aantalScans: number) {
    stopVerwerkTimer();
    setVerwerking({ klaar: 0, totaal: aantalScans });
    let rondes = 0;

    const kijk = async () => {
      rondes++;
      try {
        const res = await fetch(`/api/mediatask/pointclouds?orderId=${orderId}`, { cache: "no-store" });
        const data = await res.json();
        const pcs: { images?: string[] }[] = data.pointclouds ?? [];
        const klaar = pcs.filter((p) => (p.images?.length ?? 0) > 0).length;
        setVerwerking({ klaar, totaal: Math.max(aantalScans, pcs.length) });
        if (pcs.length > 0 && klaar >= pcs.length) stopVerwerkTimer();
      } catch {
        // Een mislukte peiling zegt niets over de verwerking zelf; gewoon de
        // volgende ronde afwachten.
      }
      if (rondes >= 60) stopVerwerkTimer();
    };

    void kijk();
    verwerkTimerRef.current = setInterval(kijk, 20000);
  }

  function stopMediataskTicker() {
    if (mediataskTickRef.current) {
      clearInterval(mediataskTickRef.current);
      mediataskTickRef.current = null;
    }
  }

  // De teruglink is een client-side navigatie (uploads lopen door), dus bij
  // het verlaten van de pagina moet de voortgangs-ticker zelf opgeruimd worden.
  useEffect(() => () => {
    stopMediataskTicker();
    stopVerwerkTimer();
  }, []);

  async function uploadToMediatask() {
    setShowMediataskModal(true);
    setMediataskError(null);
    setMediataskSubmitError(null);
    setMediataskState(null);
    setMediataskOrderId(null);
    setScanBevestigd({});
    setVerwerking(null);
    stopVerwerkTimer();
    setMediataskPct(4);
    setMediataskElapsed(0);
    stopMediataskTicker();
    const startedAt = Date.now();
    mediataskTickRef.current = setInterval(() => {
      setMediataskPct((p) => Math.min(90, p + Math.max(1, (90 - p) * 0.12)));
      setMediataskElapsed(Math.round((Date.now() - startedAt) / 1000));
    }, 250);

    // De mappen zijn al klaar vóór het versturen — die meteen afvinken (of
    // als overgeslagen tonen bij een lege map) i.p.v. een spinner draaien
    // voor werk dat allang gedaan is. Alleen de order zelf is nog bezig.
    const steps: Record<string, MediataskStepStatus> = {};
    steps["order"] = "busy";
    // Elke scan krijgt een eigen stap: bij twee bouwlagen wil je zien wélke
    // scan hangt, niet één regel die "scan" heet.
    for (const s of teVersturenScans) steps[`scan:${s.name}`] = "pending";
    steps["submit"] = "pending";
    setMediataskSteps(steps);

    try {
      let config: Record<string, string> = {};
      try {
        config = JSON.parse(productConfiguration);
      } catch {}

      // Server verzamelt zelf de directe Dropbox-links per map en maakt in
      // één keer de order aan — er is geen granulaire per-map-voortgang vanuit
      // Mediatask zelf, dus alle mappen vinken tegelijk af zodra dat lukt.
      setMediataskSteps((s) => ({ ...s, order: "busy" }));
      const res = await fetch("/api/mediatask/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dropboxFolderPath: folderPath,
          productId: Number(productId),
          priorityId,
          agencyId,
          productConfiguration: config,
          // Zijn er scans, dan wordt er hier nog niet ingediend: die moeten er
          // eerst aan hangen. Het indienen gebeurt dan verderop.
          submitNow: teVersturenScans.length === 0,
          city,
          street,
          number,
          postcode,
          floorsByFile,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Order aanmaken bij Mediatask mislukt");

      const doneSteps: Record<string, MediataskStepStatus> = {};
      doneSteps["order"] = "done";
      for (const s of teVersturenScans) doneSteps[`scan:${s.name}`] = "pending";
      doneSteps["submit"] = data.submitError
        ? "error"
        : teVersturenScans.length > 0
          ? "pending"
          : "done";
      setMediataskSteps(doneSteps);
      setMediataskOrderId(data.order.id);
      setMediataskSubmitError(data.submitError ?? null);

      // De scancontrole aan de order hangen en het oordeel er als comment
      // onder zetten. Lukt dat niet, dan is dat vervelend voor de dataset maar
      // geen reden om de opnemer een fout te tonen: de order staat er.
      if (scanRecordId) {
        void fetch("/api/scan-record", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: scanRecordId, orderId: data.order.id }),
        }).catch(() => {});
      }

      // De geoptimaliseerde scan gaat rechtstreeks van hier naar Amazon en
      // wordt daarna aan de order gekoppeld. De RAW-scan gaat bewust niet mee:
      // Mediatask werkt met de geoptimaliseerde versie.
      // De server heeft de scans zelf al doorgestuurd tijdens het aanmaken van
      // de order — daar hoort het ook, want dat is de enige plek die het altijd
      // doet, ongeacht via welke pagina de order ontstaat. Hier alleen nog
      // tonen hoe het afliep.
      const scanFouten: string[] = [];
      for (const uitkomst of (data.scans ?? []) as { naam: string; ok: boolean; fout?: string }[]) {
        setMediataskSteps((s2) => ({ ...s2, [`scan:${uitkomst.naam}`]: uitkomst.ok ? "done" : "error" }));
        if (uitkomst.ok) setScanBevestigd((b) => ({ ...b, [uitkomst.naam]: 1 }));
        else scanFouten.push(`${uitkomst.naam}: ${uitkomst.fout ?? "versturen mislukt"}`);
      }
      if (scanFouten.length > 0) setMediataskError(scanFouten.join(" · "));

      // Indienen gebeurt op de server bij submitNow; alleen als er scans waren
      // is dat uitgesteld tot ze eraan hingen.
      if (teVersturenScans.length > 0) {
        const ingediend = await fetch(`/api/mediatask/orders/${data.order.id}`, { method: "POST" });
        const uitkomst = await ingediend.json().catch(() => ({}));
        setMediataskSteps((s2) => ({ ...s2, submit: ingediend.ok ? "done" : "error" }));
        if (!ingediend.ok) setMediataskSubmitError(uitkomst.error ?? "Indienen mislukt");
      }

      // Ook het NEN-record afsluiten dat de opnamepagina aanmaakte. Zonder dit
      // blijft de opname als "niet afgemaakt" gelden en krijgt de opnemer er
      // een herinnering over terwijl de order allang bij Mediatask ligt.
      if (addr && city) {
        meldAfgerond({
          id: `nen-${addr}, ${city}`,
          soort: "nen",
          straatnaam: addr,
          postcode,
          woonplaats: city,
          accountName: account,
        });
      }

      // Het concept afsluiten: zonder dit blijft het adres als openstaande
      // opname in de zijbalk en op het dashboard staan, terwijl de order allang
      // bij Mediatask ligt. Best-effort — een mislukte administratie mag nooit
      // een geslaagde order als fout laten overkomen.
      if (draftId) {
        void (async () => {
          try {
            const lijst = await fetch("/api/drafts", { cache: "no-store" }).then((r) => r.json());
            const concept = (lijst.drafts ?? []).find((d: { id: string }) => d.id === draftId);
            if (!concept) return;
            await fetch("/api/drafts", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                ...concept,
                status: "uploaded",
                state: {
                  ...concept.state,
                  mediatask: { orderId: data.order.id, state: data.order.state, submittedAt: Date.now() },
                },
              }),
            });
          } catch {
            // stil: de order is het echte werk, dit is de boekhouding erna
          }
        })();
      }

      // Bij een scan is er ná het aanmaken nog ingediend, dus de status uit het
      // aanmaak-antwoord klopt niet meer; die laten we door de statuspolling
      // ophalen.
      // Vanaf hier is het werk van de opnemer klaar; wat volgt gebeurt bij
      // Mediatask. Wel laten zien, niet op laten wachten.
      const geslaagdeScans = ((data.scans ?? []) as { ok: boolean }[]).filter((x) => x.ok).length;
      if (geslaagdeScans > 0) volgVerwerking(data.order.id, geslaagdeScans);

      setMediataskState(teVersturenScans.length > 0 ? null : (data.order.state ?? null));
      stopMediataskTicker();
      setMediataskPct(100);
      setMediataskElapsed(Math.round((Date.now() - startedAt) / 1000));
    } catch (err) {
      stopMediataskTicker();
      setMediataskError(err instanceof Error ? err.message : "Order aanmaken bij Mediatask mislukt");
      setMediataskSteps((s) => {
        const next = { ...s };
        // Een lege map is geen fout: die was bewust overgeslagen. Alleen de
        // stappen die echt liepen krijgen het waarschuwingsteken.
        for (const k of Object.keys(next)) {
          if (next[k] !== "done" && next[k] !== "skipped") next[k] = "error";
        }
        return next;
      });
    }
  }

  return (
    <>
      <header className="topline">
        {/* Bewust een client-side navigatie (Link, geen <a>): de pagina wordt
            dan niet echt herladen, waardoor lopende Dropbox-uploads gewoon op
            de achtergrond doorlopen als je even teruggaat naar de order. */}
        <Link href={`/nen${addr ? `?addr=${encodeURIComponent(addr)}` : ""}`} className="btn-back">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M10 12.5 5.5 8 10 3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Terug naar order
        </Link>
        <span className="eyebrow">{addr || "Documenten uploaden"}</span>
      </header>

      <div className={`dbx-strip${folderPath ? " is-ready" : ""}`} style={{ marginBottom: 12 }}>
        <div className="dbx-strip-top">
          <span className="conn-icon is-dropbox dbx-strip-icon">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M7 3 2 6.3 7 9.6 2 12.9l5 3.3 5-3.3 5 3.3 5-3.3-5-3.3 5-3.3-5-3.3-5 3.3-5-3.3Zm5 15 5-3.3v2.2L12 20l-5-3.1v-2.2l5 3.3Z"
                fill="currentColor"
              />
            </svg>
          </span>
          {!folderPath && (
            <span className="dbx-strip-text">
              <span className="spinner" /> Dropbox-map klaarzetten…
            </span>
          )}
          {folderPath && (
            <>
              <span className="dbx-strip-text">
                <span className="dbx-strip-check" aria-hidden="true">✓</span>
                Map aangemaakt — <span className="dbx-folder-path">{folderPath}</span>
              </span>
              <button
                type="button"
                className="dbx-strip-refresh"
                onClick={() => refreshFiles()}
                disabled={loading}
                title="Nu verversen"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true" className={loading ? "spin" : undefined}>
                  <path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              {dropboxUrl && (
                <a href={dropboxUrl} target="_blank" rel="noopener noreferrer" className="btn-open-dbx">
                  Openen
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path d="M6 4h6v6M12 4 4 12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </a>
              )}
            </>
          )}
        </div>
      </div>

      <div className="pad" style={{ background: "var(--paper)", border: "1px solid var(--rule)", borderRadius: "var(--r)" }}>
        {WIDE_FOLDERS.map((folder) => (
          <div className="section" key={folder}>
            <div className="section-head">
              <h2>{folder}</h2>
            </div>
            <div className="doc-grid" style={{ gridTemplateColumns: "1fr" }}>
              {renderFolder(folder)}
            </div>
          </div>
        ))}

        <div className="section">
          <div className="section-head">
            <h2>Overige mappen</h2>
          </div>
          <div className="doc-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
            {SPLIT_FOLDERS.map((f) => renderFolder(f))}
          </div>
        </div>

        <div className="section">
          <div className="section-head">
            <h2>Scancontrole <span className="beta-tag">BETA</span></h2>
          </div>
          <div className="section-body" style={{ gridTemplateColumns: "1fr" }}>
            <p className="note" style={{ padding: 0 }}>
              Exporteer de geoptimaliseerde scan in Dot3D via File &gt; Export als <strong>PLY</strong> en kies
              &apos;m hier. Hij gaat mee omhoog naar Optimized, en ondertussen tekenen we de plattegrond per
              bouwlaag uit en lopen we de checklist langs.
            </p>
            <input
              ref={(el) => {
                checkInputRef.current = el;
              }}
              type="file"
              // Bewust geen accept-filter: de Bestanden-app op iPadOS kent
              // .ply niet en maakt het bestand dan onselecteerbaar. We
              // controleren de extensie hieronder zelf, met een nette melding.
              style={{ display: "none" }}
              onChange={(e) => {
                const gekozen = e.target.files?.[0];
                e.target.value = "";
                if (!gekozen) return;
                if (!isPointCloudFile(gekozen.name)) {
                  setExportFout(
                    `"${gekozen.name}" is geen puntenwolk. Exporteer in Dot3D via File > Export als PLY (of PTS, LAS of LAZ).`
                  );
                  return;
                }
                setExportFout(null);
                // Uploaden en controleren tegelijk: de upload loopt in de
                // wachtrij door terwijl de controle het bestand uit het
                // geheugen leest. Twee keer hetzelfde bestand aanwijzen hoeft
                // dus niet.
                setOptimizedFile(gekozen);
                setScanCheckDone(false);
                setScanCheckOpen(true);
                uploadFile("Optimized", gekozen);
              }}
            />
            {exportFout && <p className="scan-error">{exportFout}</p>}
            <div className="scan-pick">
              <button type="button" className="btn btn-quiet" onClick={() => checkInputRef.current?.click()}>
                {optimizedFile ? "Andere export kiezen" : "Export kiezen en uploaden (.ply)"}
              </button>
              {optimizedFile && (
                <>
                  <span className="scan-pick-name">{optimizedFile.name}</span>
                  <button type="button" className="btn btn-quiet" onClick={() => setScanCheckOpen(true)}>
                    Opnieuw controleren
                  </button>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="section">
          <div className="section-body" style={{ gridTemplateColumns: "1fr" }}>
            {!hasMediataskConfig && (
              <p className="note" style={{ padding: 0 }}>
                ⚠ Product, makelaar of prioriteit ontbreekt nog — pas dit eerst aan via &quot;Terug naar order&quot;.
              </p>
            )}
            {filesZonderVerdieping.length > 0 && (
              <p className="note" style={{ padding: 0, color: "var(--bad)", fontWeight: 600 }}>
                ⚠ Geef eerst per scan aan welke verdiepingen erin zitten:{" "}
                {filesZonderVerdieping.map((f) => f.name).join(", ")}
              </p>
            )}
            {teVersturenScans.length > 0 && (
              <p className="note" style={{ padding: 0 }}>
                {teVersturenScans.length === 1
                  ? "1 scan gaat als puntenwolk mee naar Mediatask: "
                  : `${teVersturenScans.length} scans gaan als puntenwolk mee naar Mediatask: `}
                {teVersturenScans.map((s) => s.name).join(", ")}
              </p>
            )}
            <button
              type="button"
              className="btn btn-primary btn-block"
              disabled={
                loading ||
                !hasMediataskConfig ||
                filesZonderVerdieping.length > 0 ||
                nogAanHetUploaden.length > 0
              }
              onClick={() => {
                // Eerst de scan laten zien, daarna pas versturen. Is er geen
                // export in deze sessie geüpload, of is de controle al
                // langsgekomen, dan gaat het rechtstreeks door.
                if (optimizedFile && !scanCheckDone) setScanCheckOpen(true);
                else void uploadToMediatask();
              }}
            >
              {loading
                ? "Dropbox-bestanden laden…"
                : nogAanHetUploaden.length > 0
                  ? `Wachten op Dropbox — nog ${nogAanHetUploaden.length} bestand${nogAanHetUploaden.length === 1 ? "" : "en"} bezig`
                : filesZonderVerdieping.length > 0
                  ? "Verdiepingen ontbreken nog"
                  : optimizedFile && !scanCheckDone
                    ? "Scan controleren en versturen"
                    : "Uploaden naar Mediatask"}
            </button>
          </div>
        </div>
      </div>

      {rawWarning && (
        <div className="compass-overlay" onClick={() => setRawWarning(null)}>
          <div className="compass-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="RAW-bestand hoort niet bij Optimized">
            <div className="compass-modal-head">
              <h3>Dit hoort bij RAW</h3>
              <button className="compass-close" onClick={() => setRawWarning(null)} aria-label="Sluiten">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                </svg>
              </button>
            </div>
            <p style={{ margin: "0 0 20px", fontSize: 15 }}>
              <strong>{rawWarning.name}</strong> is een RAW-scanbestand (herkenbaar aan &quot;_raw.dp&quot;) — dat moet
              je uploaden bij <strong>RAW</strong>, niet bij Optimized. De Optimized-map is leeggehouden.
            </p>
            <div style={{ display: "flex", gap: 10 }}>
              <button type="button" className="btn btn-quiet" style={{ flex: 1 }} onClick={() => setRawWarning(null)}>
                Sluiten
              </button>
              {rawWarning.file ? (
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ flex: 1 }}
                  onClick={() => {
                    const file = rawWarning.file!;
                    setRawWarning(null);
                    uploadFile("RAW", file);
                  }}
                >
                  Verplaats naar RAW
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ flex: 1 }}
                  onClick={() => {
                    setRawWarning(null);
                    pickFile("RAW");
                  }}
                >
                  Ga naar RAW
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {showMediataskModal && (
        <div className="upload-overlay">
          <div className="upload-modal" role="dialog" aria-label="Bezig met uploaden naar Mediatask">
            {(() => {
              const klaar = !!mediataskOrderId && !mediataskError && !mediataskSubmitError;
              const scanSleutels = Object.keys(mediataskSteps).filter((k) => k.startsWith("scan:"));
              const gevuld = LINK_FOLDERS.filter((f) => (existing[f]?.length ?? 0) > 0 && f !== "Optimized");
              const leeg = LINK_FOLDERS.filter((f) => (existing[f]?.length ?? 0) === 0);
              const teken = (st: MediataskStepStatus | undefined) =>
                st === "done" ? (
                  <span className="upload-check" aria-hidden="true">✓</span>
                ) : st === "error" ? (
                  <span className="upload-warn" aria-hidden="true">⚠</span>
                ) : st === "busy" ? (
                  <span className="spinner" aria-hidden="true" />
                ) : (
                  <span className="dbx-strip-doc-empty" aria-hidden="true" />
                );
              const klasse = (st: MediataskStepStatus | undefined) =>
                st === "done" ? "is-done" : st === "error" ? "is-error" : "is-busy";

              return (
                <>
                  {/* De kop vertelt de uitkomst, niet de bezigheid: als het klaar
                      is wil je dat in één blik zien en niet "bezig…" blijven lezen. */}
                  <h3>
                    {mediataskError
                      ? "Uploaden naar Mediatask mislukt"
                      : klaar
                        ? `Klaar — order #${mediataskOrderId} staat bij Mediatask`
                        : "Bezig met uploaden naar Mediatask…"}
                  </h3>

                  {!klaar && !mediataskError && (
                    <>
                      <div className="doc-upload-bar">
                        <div className="doc-upload-bar-fill" style={{ width: `${Math.round(mediataskPct)}%` }} />
                      </div>
                      <p className="note" style={{ padding: 0, margin: "0 0 12px" }}>{Math.round(mediataskPct)}%</p>
                    </>
                  )}

                  {/* Drie blokken, in de volgorde waarin het gebeurt: eerst de
                      order, dan de scans die er echt heen gaan, dan wat er als
                      link bij komt. Eerder liep dat door elkaar. */}
                  <p className="upload-groep">De order</p>
                  <ul className="upload-list">
                    <li className={klasse(mediataskSteps.order)}>
                      {teken(mediataskSteps.order)}
                      Order aanmaken bij Mediatask
                    </li>
                    <li className={klasse(mediataskSteps.submit)}>
                      {teken(mediataskSteps.submit)}
                      Indienen bij Mediatask
                    </li>
                  </ul>

                  {scanSleutels.length > 0 && (
                    <>
                      <p className="upload-groep">Scans — rechtstreeks naar Mediatask</p>
                      <ul className="upload-list">
                        {scanSleutels.map((k) => {
                          const naam = k.slice(5);
                          const st = mediataskSteps[k];
                          return (
                            <li key={k} className={klasse(st)}>
                              {teken(st)}
                              <span className="upload-step-naam">{naam}</span>
                              <span className="upload-step-note">
                                {st === "busy"
                                  ? "doorsturen…"
                                  : st === "done"
                                    ? `staat bij Mediatask${scanBevestigd[naam] ? ` (${scanBevestigd[naam]} aan order)` : ""}`
                                    : st === "error"
                                      ? "niet aangekomen"
                                      : "in de wachtrij"}
                              </span>
                            </li>
                          );
                        })}
                      </ul>

                      {/* Wat er ná het versturen bij Mediatask gebeurt. Zonder
                          deze regel kijk je bij een grote scan een kwartier
                          lang naar niets, en dat ziet er precies zo uit als een
                          scan die is afgekeurd. */}
                      {verwerking && (
                        <div className={`verwerk-blok${verwerking.klaar >= verwerking.totaal ? " is-klaar" : ""}`}>
                          {verwerking.klaar >= verwerking.totaal ? (
                            <span className="upload-check" aria-hidden="true">✓</span>
                          ) : (
                            <span className="spinner" aria-hidden="true" />
                          )}
                          <span>
                            <b>
                              {verwerking.klaar >= verwerking.totaal
                                ? "Scans zijn verwerkt en goedgekeurd"
                                : `Mediatask verwerkt de scans — ${verwerking.klaar} van ${verwerking.totaal} klaar`}
                            </b>
                            <span>
                              {verwerking.klaar >= verwerking.totaal
                                ? "Mediatask heeft de puntenwolken kunnen uitlezen. Er is niets meer te doen."
                                : "Dit duurt bij een grote scan tot een kwartier en loopt bij Mediatask door. Je kunt dit scherm sluiten en weggaan."}
                            </span>
                          </span>
                        </div>
                      )}
                    </>
                  )}

                  {gevuld.length > 0 && (
                    <>
                      <p className="upload-groep">Meegestuurd als Dropbox-link</p>
                      <ul className="upload-list">
                        {gevuld.map((f) => (
                          <li key={f} className="is-done">
                            <span className="upload-check" aria-hidden="true">✓</span>
                            <span className="upload-step-naam">{f}</span>
                            <span className="upload-step-note">
                              {existing[f]?.length} bestand{existing[f]?.length === 1 ? "" : "en"}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}

                  {/* Lege mappen op één regel: vier grijze regels met "leeg"
                      duwden de uitkomst uit beeld. */}
                  {leeg.length > 0 && (
                    <p className="upload-leeg">Leeg gebleven: {leeg.join(", ")}</p>
                  )}
                </>
              );
            })()}
            {!mediataskOrderId && !mediataskError && (
              <p className="upload-timer">Bezig: {mediataskElapsed}s</p>
            )}
            {mediataskOrderId && !mediataskSubmitError && (
              <p className="upload-timer">
                ✓ Order #{mediataskOrderId} ingediend bij Mediatask{mediataskState ? ` — status: ${mediataskState}` : ""}
                {/* Het aantal komt uit Mediatask zelf, ná het koppelen: dit is
                    de bevestiging dat de scans er ook echt aan hangen. */}
                {Object.keys(scanBevestigd).length > 0 &&
                  ` · ${Math.max(...Object.values(scanBevestigd))} puntenwolk(en) aan deze order`}
              </p>
            )}
            {mediataskOrderId && mediataskSubmitError && (
              <p className="upload-timer" style={{ color: "var(--bad)" }}>
                ⚠ Order #{mediataskOrderId} is aangemaakt, maar het indienen mislukte ({mediataskSubmitError}). Dien
                &apos;m handmatig in bij Mediatask — niet opnieuw uploaden, dan ontstaat er een dubbele order.
              </p>
            )}
            {mediataskError && (
              <>
                <p className="upload-timer" style={{ color: "var(--bad)" }}>{mediataskError}</p>
                <button type="button" className="btn btn-quiet" onClick={() => setShowMediataskModal(false)}>
                  Sluiten
                </button>
              </>
            )}
            {mediataskOrderId && (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  setShowMediataskModal(false);
                  // Deze opname is klaar. Terugvallen op de uploadpagina zou
                  // suggereren dat er nog iets moet gebeuren, en nodigt uit tot
                  // een tweede order voor hetzelfde adres.
                  router.push("/");
                }}
              >
                Sluiten en afronden
              </button>
            )}
          </div>
        </div>
      )}

      {scanCheckOpen && optimizedFile && (
        <ScanCheck
          file={optimizedFile}
          dpFile={optimizedDp}
          address={addr || undefined}
          // De verdiepingen die de opnemer hierboven aantikt, zijn precies wat
          // de controle nodig heeft om te toetsen of er een bouwlaag ontbreekt.
          bagAreaM2={referentie?.oppervlakte ?? undefined}
          // De aangevinkte verdiepingen gaan voor: dat is wat de opnemer ter
          // plekke heeft gezien. Staat er niets aangevinkt, dan valt de
          // controle terug op 3DBAG.
          expectedFloors={
            allFloors.length > 0 ? allFloors.length : (referentie?.bouwlagen ?? undefined)
          }
          onRecord={setScanRecordId}
          onClose={() => setScanCheckOpen(false)}
          onApprove={() => {
            setScanCheckDone(true);
            setScanCheckOpen(false);
            void uploadToMediatask();
          }}
        />
      )}

    </>
  );
}

export default function DocumentenPage() {
  return (
    <Suspense fallback={null}>
      <DocumentenContent />
    </Suspense>
  );
}
