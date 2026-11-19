"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { readAnyPointCloud, type PointCloud } from "@/lib/pointcloud-read";
import {
  detectFloors,
  drawFloorPlan,
  floorRange,
  type Aandachtsplek,
  type Overlay,
} from "@/lib/floorplan";
import {
  POINTCLOUD_CHECKLIST,
  runPointCloudChecks,
  type CheckResult,
  type CheckStatus,
  type ScanAnalysis,
} from "@/lib/pointcloud-checks";
import { axisSpreadDeg, buildingOutline, findNoise, wallAlignment } from "@/lib/scan-analysis";
import { overallVerdict, referenceChecklist, runReferenceChecks } from "@/lib/dp-checks";
import { CHECK_VERSION, computeScanFeatures } from "@/lib/scan-features";
import { blobReader, readDpScan } from "@/lib/dp-scan";
import { useTaal } from "@/components/TaalProvider";
import { vertaal, type TaalSleutel } from "@/lib/taal";

/**
 * Controleert de geoptimaliseerde scan vlak vóór het versturen naar Mediatask.
 *
 * Links de scan van bovenaf — de puntenwolk zelf, recht van boven, per
 * verdieping en als geheel, met zoom. Rechts de checklist, die vanaf het eerste
 * moment volledig zichtbaar is: elk punt begint als "bezig" en vult zich in
 * zodra het antwoord er is.
 *
 * De checklist stuurt de kaart aan. Klik je op een punt met een eigen weergave
 * — ruis, muurrichting, uitlijning tussen verdiepingen — dan verschijnt die laag
 * over het beeld. Zo hoef je niet te raden waar een melding over gaat.
 */

const RENDER_PX = 1400;
/** Meer verdiepingen dan dit sturen we niet mee; anders wordt de aanvraag te groot. */
const MAX_FLOOR_PLANS = 5;

type Fase = "lezen" | "meten" | "tekenen" | "beoordelen" | "klaar" | "fout";

type Vertaler = (sleutel: TaalSleutel, waarden?: Record<string, string | number>) => string;

/**
 * Een fout die de client zelf schrijft: de sleutel gaat mee, zodat de melding
 * in de taal van het scherm verschijnt. De message blijft Nederlands.
 */
class SchermFout extends Error {
  constructor(public sleutel: TaalSleutel) {
    super(vertaal("nl", sleutel));
  }
}

interface Beoordeling {
  visual: CheckResult[];
  aandachtsplekken: { bouwlaag: number; cel: string; reden: string }[];
}

interface Weergave {
  /** Nederlandse naam; gaat ook als titel mee in de render naar de server. */
  naam: string;
  /** 0 = hele scan, anders het laagnummer (voor het label op het scherm). */
  nr: number;
  range: { low: number; high: number };
  marks: Aandachtsplek[];
}

export interface ScanCheckProps {
  file: File;
  dpFile?: File | null;
  address?: string;
  bagAreaM2?: number;
  expectedFloors?: number;
  onClose: () => void;
  onApprove?: () => void;
  /**
   * Aangeroepen zodra de controle is vastgelegd. De pagina bewaart het id om
   * de scan straks aan de Mediatask-order te kunnen koppelen.
   */
  onRecord?: (id: string) => void;
}

const STATUS_LABEL: Record<CheckStatus | "onvolledig", TaalSleutel> = {
  ok: "nen.scan.status.ok",
  twijfel: "nen.scan.status.twijfel",
  afwijking: "nen.scan.status.afwijking",
  afkeuren: "nen.scan.status.afkeuren",
  onbekend: "nen.scan.status.onbekend",
  onvolledig: "nen.scan.status.onvolledig",
};

/** Label van een weergave op het scherm. */
function weergaveLabel(w: Weergave, t: Vertaler): string {
  return w.nr === 0 ? t("nen.scan.heleScan") : t("nen.scan.laag", { n: w.nr });
}

/** Checklistpunten met een eigen weergave op de kaart. */
const MET_KAARTLAAG = new Set(["pc-ruis", "pc-rechte-muren", "pc-uitlijning"]);

/**
 * Icoon per uitkomst.
 *
 * Getekend als vector en niet als teken uit een lettertype: het
 * waarschuwingsteken wordt op macOS en iOS anders als emoji weergegeven, in
 * kleur en scheef in het rondje. Vier verschillende vórmen, niet alleen vier
 * kleuren, zodat de lijst ook te scannen is zonder op kleur te letten.
 */
function StatusIcon({ status }: { status: CheckStatus | null }) {
  const { t } = useTaal();
  if (status === null) return <span className="scan-icon is-bezig" aria-label={t("nen.scan.icoon.bezig")} />;

  const label =
    status === "ok"
      ? t("nen.scan.status.ok")
      : status === "afkeuren"
        ? t("nen.scan.status.afkeuren")
        : status === "onbekend"
          ? t("nen.scan.icoon.nietBeoordeeld")
          : t("nen.scan.icoon.letOp");

  return (
    <span className={`scan-icon is-${status}`} title={label} role="img" aria-label={label}>
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        {status === "ok" && (
          <path
            d="M3.5 8.5 6.5 11.5 12.5 4.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
        {status === "afkeuren" && (
          <path
            d="M4 4l8 8M12 4l-8 8"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        )}
        {(status === "twijfel" || status === "afwijking") && (
          <>
            <path d="M8 3.5v5.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            <circle cx="8" cy="12" r="1.2" fill="currentColor" />
          </>
        )}
        {status === "onbekend" && (
          <path d="M4.5 8h7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        )}
      </svg>
    </span>
  );
}

export default function ScanCheck({
  file,
  dpFile,
  address,
  bagAreaM2,
  expectedFloors,
  onClose,
  onApprove,
  onRecord,
}: ScanCheckProps) {
  const { t } = useTaal();
  const [fase, setFase] = useState<Fase>("lezen");
  const [fout, setFout] = useState<{ tekst: string } | { sleutel: TaalSleutel } | null>(null);
  const [weergaven, setWeergaven] = useState<Weergave[]>([]);
  const [actieveLaag, setActieveLaag] = useState(0);
  const [gekozenCheck, setGekozenCheck] = useState<string | null>(null);
  const [metingen, setMetingen] = useState<CheckResult[]>([]);
  const [beoordeling, setBeoordeling] = useState<Beoordeling | null>(null);
  const [kerncijfers, setKerncijfers] = useState<{ label: TaalSleutel; waarde: string | null }[]>([]);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });

  const gestart = useRef(false);
  // Puntenwolk en meetresultaten zijn invoer voor het tekenen, dus horen in
  // state en niet in een ref: het beeld moet opnieuw getekend worden zodra ze
  // binnen zijn.
  const [wolk, setWolk] = useState<PointCloud | null>(null);
  const [analyse, setAnalyse] = useState<ScanAnalysis | null>(null);
  const sleep = useRef<{ x: number; y: number } | null>(null);

  const analyseer = useCallback(async () => {
    setFase("lezen");
    const pc = await readAnyPointCloud(file, file.name);
    setWolk(pc);
    const floors = detectFloors(pc);

    setFase("meten");
    const zichtbaar = floors.slice(0, MAX_FLOOR_PLANS);
    // Muurrichting meten op ooghoogte: daar staan de muren, niet de vloer.
    const walls = zichtbaar.map((f) =>
      wallAlignment(pc, { low: f.floorZ + 1.0, high: f.floorZ + 1.6 })
    );
    // Per hoogtelaag de omtrek van het pand, met per zijde de afwijking. Zo is
    // aan te wijzen wélk muurdeel wegdraait in plaats van alleen te melden dat
    // er iets scheef staat.
    const outlines = zichtbaar.map((f, i) =>
      buildingOutline(pc, { low: f.floorZ - 0.2, high: f.floorZ + 2.2 }, walls[i]?.axisDeg ?? 0)
    );
    const gemeten: ScanAnalysis = {
      walls,
      outlines,
      axisSpreadDeg: axisSpreadDeg(
        walls.filter((w) => w !== null).map((w) => (w as { axisDeg: number }).axisDeg)
      ),
      noiseShare: findNoise(pc, { low: pc.bounds.minZ, high: pc.bounds.maxZ }).share,
    };
    setAnalyse(gemeten);

    let maatvoering: CheckResult[] = [];
    if (dpFile) {
      try {
        const dp = await readDpScan(blobReader(dpFile));
        maatvoering = runReferenceChecks({
          fileName: dpFile.name,
          address,
          referenceDistances: dp.referenceDistances,
        });
      } catch {
        maatvoering = [];
      }
    }
    const meetResultaten = [
      ...runPointCloudChecks(
        pc,
        floors,
        { fileName: file.name, address, bagAreaM2, expectedFloors },
        gemeten
      ),
      ...maatvoering,
    ];
    setMetingen(meetResultaten);

    // De meetwaarden als platte vector — dit is wat er straks bewaard wordt en
    // waar een gefit model op draait. Zelfde functie als de checklist gebruikt,
    // dus per definitie dezelfde getallen als op het scherm staan.
    const features = computeScanFeatures(pc, floors, gemeten, {
      fileName: file.name,
      address,
      bagAreaM2,
      expectedFloors,
    });

    const breedte = pc.bounds.maxX - pc.bounds.minX;
    const diepte = pc.bounds.maxY - pc.bounds.minY;
    // Het grondvlak zegt op zichzelf weinig — pas naast de BAG-oppervlakte
    // wordt het een getal waar je iets mee kunt.
    const grondvlak = breedte * diepte * Math.max(floors.length, 1);
    const verschil = bagAreaM2 !== undefined ? grondvlak - bagAreaM2 : null;
    setKerncijfers([
      { label: "nen.scan.kern.hoogtelagen", waarde: String(floors.length) },
      { label: "nen.scan.kern.grondvlak", waarde: `${(breedte * diepte).toFixed(0)} m²` },
      { label: "nen.scan.kern.totaal", waarde: `${grondvlak.toFixed(0)} m²` },
      {
        label: "nen.scan.kern.bag",
        // null = onbekend; vertaald bij het tekenen.
        waarde:
          bagAreaM2 === undefined
            ? null
            : `${bagAreaM2.toFixed(0)} m² · ${verschil! >= 0 ? "+" : "−"}${Math.abs(verschil!).toFixed(0)} m²`,
      },
    ]);

    setFase("tekenen");
    const lagen: Weergave[] = [
      { naam: "Hele scan", nr: 0, range: { low: pc.bounds.minZ, high: pc.bounds.maxZ }, marks: [] },
      ...zichtbaar.map((_, i) => ({
        naam: `Laag ${i + 1}`,
        nr: i + 1,
        range: floorRange(floors, i, pc.bounds.maxZ),
        marks: [],
      })),
    ];
    setWeergaven(lagen);

    setFase("beoordelen");
    const renders = lagen.map((l) => tekenNaarDataUrl(pc, l, [], null));
    const response = await fetch("/api/scan-check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fileName: file.name,
        address,
        kind: "pointcloud",
        renders,
        measurements: meetResultaten,
        facts: {
          "gescande verdiepingen": floors.length,
          "vloerhoogtes (m)": floors.map((f) => f.floorZ.toFixed(2)).join(", "),
          "afmetingen (m)": `${breedte.toFixed(1)} x ${diepte.toFixed(1)} x ${(pc.bounds.maxZ - pc.bounds.minZ).toFixed(1)}`,
          "muurrichting per verdieping": walls.map((w) => (w ? `${w.axisDeg}°` : "?")).join(", "),
        },
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      if (data.error != null) throw new Error(data.error);
      throw new SchermFout("nen.scan.fout.beoordeling");
    }
    const oordeel = data as Beoordeling;
    setBeoordeling(oordeel);

    const perLaag = new Map<number, Aandachtsplek[]>();
    for (const plek of oordeel.aandachtsplekken ?? []) {
      const lijst = perLaag.get(plek.bouwlaag) ?? [];
      lijst.push({ cel: plek.cel, reden: plek.reden });
      perLaag.set(plek.bouwlaag, lijst);
    }
    if (perLaag.size > 0) {
      setWeergaven(
        lagen.map((laag, i) => ({
          ...laag,
          // De eerste weergave is de hele scan en toont alles bij elkaar.
          marks: i === 0 ? [...perLaag.values()].flat() : (perLaag.get(i) ?? []),
        }))
      );
    }
    // Vastleggen gebeurt als laatste en mag niets blokkeren: de opnemer staat
    // op locatie te wachten om te kunnen uploaden, en een haperende opslag mag
    // dat nooit in de weg zitten.
    try {
      const bewaren = await fetch("/api/scan-record", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          version: CHECK_VERSION,
          fileName: file.name,
          fileSize: file.size,
          address,
          features,
          results: meetResultaten.map((r) => ({
            id: r.id,
            status: r.status,
            toelichting: r.toelichting,
          })),
          verdict: overallVerdict(meetResultaten),
          llmVerdict: oordeel.visual?.length ? overallVerdict(oordeel.visual) : undefined,
        }),
      });
      const opgeslagen = await bewaren.json();
      if (opgeslagen.id) onRecord?.(opgeslagen.id);
    } catch (err) {
      console.error("Scancontrole vastleggen mislukt", err);
    }

    setFase("klaar");
  }, [file, dpFile, address, bagAreaM2, expectedFloors, onRecord]);

  useEffect(() => {
    if (gestart.current) return;
    gestart.current = true;
    analyseer().catch((err: unknown) => {
      setFout(
        err instanceof SchermFout
          ? { sleutel: err.sleutel }
          : err instanceof Error
            ? { tekst: err.message }
            : { sleutel: "nen.scan.fout.onbekend" }
      );
      setFase("fout");
    });
  }, [analyseer]);

  // Welke kaartlaag hoort bij het aangeklikte checklistpunt.
  const overlay: Overlay = useMemo(() => {
    const pc = wolk;
    const laag = weergaven[actieveLaag];
    if (!pc || !laag || !gekozenCheck) return null;
    if (gekozenCheck === "pc-ruis") {
      return { soort: "ruis", indices: findNoise(pc, laag.range).indices };
    }
    if (gekozenCheck === "pc-rechte-muren") {
      // De eerste weergave is de hele scan; dan tonen we alle omtrekken samen.
      const laagIndex = actieveLaag - 1;
      const zijden =
        laagIndex >= 0
          ? (analyse?.outlines[laagIndex]?.edges ?? [])
          : (analyse?.outlines.flatMap((o) => o?.edges ?? []) ?? []);
      const w = analyse?.walls[Math.max(laagIndex, 0)] ?? analyse?.walls.find((x) => x !== null);
      if (!w || zijden.length === 0) return null;
      return { soort: "muurrichting", graden: w.axisDeg, zijden, drempel: 8 };
    }
    if (gekozenCheck === "pc-uitlijning") {
      return { soort: "uitlijning", ranges: weergaven.slice(1).map((l) => l.range) };
    }
    return null;
  }, [gekozenCheck, actieveLaag, weergaven, wolk, analyse]);

  // Het beeld is een afgeleide van de wolk, de gekozen verdieping en de laag —
  // dus rechtstreeks berekend en niet via een omweg in state gezet.
  const beeld = useMemo(() => {
    const laag = weergaven[actieveLaag];
    if (!wolk || !laag) return null;
    const hoek = analyse?.walls[Math.max(actieveLaag - 1, 0)]?.axisDeg ?? 0;
    // Op het scherm de titel in de gekozen taal; de renders naar de server
    // houden de Nederlandse titel.
    const titel = t("nen.scan.kaartTitel", {
      naam: weergaveLabel(laag, t),
      laag: laag.range.low.toFixed(1),
      hoog: laag.range.high.toFixed(1),
    });
    return tekenNaarDataUrl(wolk, laag, laag.marks, overlay, hoek, titel);
  }, [weergaven, actieveLaag, overlay, wolk, analyse, t]);

  const uitkomsten = new Map<string, CheckResult>();
  for (const r of [...metingen, ...(beoordeling?.visual ?? [])]) uitkomsten.set(r.id, r);
  const beeldMislukt = fase === "fout" && metingen.length > 0;
  const alleResultaten = [...uitkomsten.values()];
  const eindoordeel =
    alleResultaten.length === 0 ? null : beoordeling ? overallVerdict(alleResultaten) : "onvolledig";

  const checklist = [...POINTCLOUD_CHECKLIST, ...(dpFile ? referenceChecklist() : [])];
  const laag = weergaven[actieveLaag];

  return (
    <div className="upload-overlay">
      <div className="scan-modal is-wide" role="dialog" aria-label={t("nen.scan.titel")}>
        <div className="scan-modal-head">
          <h3>{t("nen.scan.kop", { bestand: file.name })}</h3>
          {eindoordeel && (
            <span className={`scan-verdict is-${eindoordeel}`}>
              {t("nen.scan.oordeel", { oordeel: t(STATUS_LABEL[eindoordeel]) })}
            </span>
          )}
        </div>

        <div className="scan-split">
          <div className="scan-view">
            {beeld && laag ? (
              <>
                <div
                  className="scan-canvas"
                  onWheel={(e) =>
                    setZoom((z) => Math.max(1, Math.min(8, z * (e.deltaY < 0 ? 1.15 : 0.87))))
                  }
                  onPointerDown={(e) => {
                    sleep.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
                    e.currentTarget.setPointerCapture(e.pointerId);
                  }}
                  onPointerMove={(e) => {
                    if (!sleep.current) return;
                    setPan({ x: e.clientX - sleep.current.x, y: e.clientY - sleep.current.y });
                  }}
                  onPointerUp={() => {
                    sleep.current = null;
                  }}
                  onDoubleClick={() => {
                    setZoom(1);
                    setPan({ x: 0, y: 0 });
                  }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={beeld}
                    alt={t("nen.scan.bovenaanzicht", { naam: weergaveLabel(laag, t) })}
                    className="scan-render"
                    style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
                    draggable={false}
                  />
                </div>

                <div className="scan-viewbar">
                  <div className="scan-tabs">
                    {weergaven.map((w, i) => (
                      <button
                        key={w.naam}
                        type="button"
                        className={`scan-tab${i === actieveLaag ? " is-active" : ""}`}
                        onClick={() => setActieveLaag(i)}
                      >
                        {weergaveLabel(w, t)}
                      </button>
                    ))}
                  </div>
                  <div className="scan-zoom">
                    <button
                      type="button"
                      onClick={() => setZoom((z) => Math.max(1, z / 1.4))}
                      aria-label={t("nen.scan.uitzoomen")}
                    >
                      −
                    </button>
                    <span>{Math.round(zoom * 100)}%</span>
                    <button
                      type="button"
                      onClick={() => setZoom((z) => Math.min(8, z * 1.4))}
                      aria-label={t("nen.scan.inzoomen")}
                    >
                      +
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setZoom(1);
                        setPan({ x: 0, y: 0 });
                      }}
                    >
                      {t("nen.scan.passend")}
                    </button>
                  </div>
                </div>

                {laag.marks.length > 0 && (
                  <ul className="scan-spots">
                    {laag.marks.map((m, i) => (
                      <li key={i}>
                        <span className="scan-spot-nr">{i + 1}</span>
                        <span>
                          {m.reden} <em>({m.cel})</em>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ) : (
              <p className="note scan-progress">
                {fase === "lezen" && t("nen.scan.voortgang.lezen")}
                {fase === "meten" && t("nen.scan.voortgang.meten")}
                {fase === "tekenen" && t("nen.scan.voortgang.tekenen")}
                {(fase === "fout" || fase === "beoordelen" || fase === "klaar") &&
                  weergaven.length === 0 &&
                  t("nen.scan.geenVerdiepingen")}
              </p>
            )}
          </div>

          <div className="scan-side">
            {kerncijfers.length > 0 && (
              <dl className="scan-facts">
                {kerncijfers.map((k) => (
                  <div key={k.label}>
                    <dt>{t(k.label)}</dt>
                    <dd>{k.waarde ?? t("nen.scan.kern.onbekend")}</dd>
                  </div>
                ))}
              </dl>
            )}

            {fase === "fout" && (
              <p className="scan-error">
                {fout && ("sleutel" in fout ? t(fout.sleutel) : fout.tekst)}
                {beeldMislukt && ` ${t("nen.scan.fout.deelsGedaan")}`}
              </p>
            )}

            <ul className="scan-list">
              {checklist.map((item) => {
                const r = uitkomsten.get(item.id);
                const status = r?.status ?? null;
                const kaart = MET_KAARTLAAG.has(item.id);
                const gekozen = gekozenCheck === item.id;
                return (
                  <li
                    key={item.id}
                    className={`is-${status ?? "bezig"}${gekozen ? " is-gekozen" : ""}`}
                  >
                    <StatusIcon status={beeldMislukt && !r ? "onbekend" : status} />
                    <button
                      type="button"
                      className="scan-list-btn"
                      onClick={() => setGekozenCheck(gekozen ? null : item.id)}
                    >
                      <strong>
                        {item.titel}
                        {kaart && (
                          <span className="scan-kaart-tag">{gekozen ? t("nen.scan.opDeKaart") : t("nen.scan.toon")}</span>
                        )}
                      </strong>
                      <span>
                        {r?.toelichting ?? (beeldMislukt ? t("nen.scan.nietBeoordeeld") : t("nen.scan.wordtGecontroleerd"))}
                      </span>
                      {gekozen && <em>{item.bron_gids}</em>}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>

        <div className="scan-actions">
          <button type="button" className="btn btn-quiet" onClick={onClose}>
            {t("nen.scan.terug")}
          </button>
          {onApprove && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={onApprove}
              disabled={fase === "lezen" || fase === "meten" || fase === "tekenen"}
            >
              {eindoordeel === "ok" ? t("nen.scan.doorsturen") : t("nen.scan.tochDoorsturen")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function tekenNaarDataUrl(
  pc: PointCloud,
  laag: Weergave,
  marks: Aandachtsplek[],
  overlay: Overlay,
  rasterHoek = 0,
  titel = `${laag.naam} — ${laag.range.low.toFixed(1)} tot ${laag.range.high.toFixed(1)} m`
): string {
  const canvas = document.createElement("canvas");
  canvas.width = RENDER_PX;
  canvas.height = RENDER_PX;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new SchermFout("nen.scan.fout.canvas");
  drawFloorPlan(
    ctx,
    pc,
    laag.range,
    RENDER_PX,
    RENDER_PX,
    titel,
    marks,
    overlay,
    rasterHoek
  );
  return canvas.toDataURL("image/png");
}
