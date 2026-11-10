"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTaal } from "@/components/TaalProvider";
import type { PolycamScan as Scan } from "@/lib/polycam";
import { verdiepingUitVeldnaam, type KoppelAntwoord } from "@/lib/polycam-velden";

/**
 * Polycam-blok in stap 2 van de energielabel-uploader, direct na D1.
 *
 * Start de Polycam-app, toont daarna de laatste scans, en koppelt de gekozen
 * scan aan een verdieping: de server zet de LAS in Dropbox › LAZ en geeft de
 * deellink terug, die hier in het D8-veld van die verdieping komt.
 */

/** De app openen. Een universele link opent de app als die er staat, en
    anders de website — nooit een foutmelding van Safari. */
const POLYCAM_APP_URL = process.env.NEXT_PUBLIC_POLYCAM_APP_URL || "https://poly.cam/";

const POLL_MS = 4000;
/** Daarna stoppen we met vragen; de opnemer kan het opnieuw starten. */
const MAX_POLL_MS = 30 * 60 * 1000;

interface D8Veld {
  id: string;
  name: string;
}

interface Koppeling {
  captureId: string;
  veldId: string;
  verdieping: string;
  antwoord: KoppelAntwoord | null;
  fout: string | null;
  gestartOp: number;
}

interface Props {
  velden: D8Veld[];
  waarden: Record<string, unknown>;
  dropboxPad: string | null;
  onDeellink: (veldId: string, url: string) => void;
  onBestandOpgeslagen: () => void;
}

const LOPEND = new Set(["wacht-upload", "exporteren", "opslaan"]);

function isLopend(k: Koppeling): boolean {
  if (k.fout) return false;
  if (Date.now() - k.gestartOp > MAX_POLL_MS) return false;
  return !k.antwoord || LOPEND.has(k.antwoord.fase);
}

function eersteLegeVeld(velden: D8Veld[], waarden: Record<string, unknown>, bezet: Set<string>): string {
  const leeg = velden.find((v) => !waarden[v.id] && !bezet.has(v.id));
  return (leeg ?? velden[0])?.id ?? "";
}

export default function PolycamScan({ velden, waarden, dropboxPad, onDeellink, onBestandOpgeslagen }: Props) {
  const { t, taal } = useTaal();
  const [scans, setScans] = useState<Scan[] | null>(null);
  const [laden, setLaden] = useState(false);
  const [lijstFout, setLijstFout] = useState<string | null>(null);
  const [gekozenId, setGekozenId] = useState<string | null>(null);
  const [veldId, setVeldId] = useState<string>(() => eersteLegeVeld(velden, waarden, new Set()));
  const [koppelingen, setKoppelingen] = useState<Record<string, Koppeling>>({});
  const [popupId, setPopupId] = useState<string | null>(null);

  // De ref is de bron: de poll-timer leest hem buiten React om, en elke
  // wijziging gaat via zetKoppeling zodat ref en state gelijk blijven.
  const koppelingenRef = useRef<Record<string, Koppeling>>({});
  const bezig = useRef(new Set<string>());
  const linkGemeld = useRef(new Set<string>());
  const bestandGemeld = useRef(new Set<string>());
  const callbacks = useRef({ onDeellink, onBestandOpgeslagen });
  useEffect(() => {
    callbacks.current = { onDeellink, onBestandOpgeslagen };
  }, [onDeellink, onBestandOpgeslagen]);

  const zetKoppeling = useCallback((id: string, wijzig: (k: Koppeling) => Koppeling) => {
    const huidig = koppelingenRef.current[id];
    if (!huidig) return;
    koppelingenRef.current = { ...koppelingenRef.current, [id]: wijzig(huidig) };
    setKoppelingen(koppelingenRef.current);
  }, []);

  // Velden kunnen later binnenkomen (ClickUp-gegevens); kies dan alsnog een.
  const actiefVeldId = veldId || eersteLegeVeld(velden, waarden, new Set());

  const foutTekst = useCallback(
    (code: string | undefined) => {
      if (code === "niet_ingesteld") return t("energielabel.polycam.fout.nietIngesteld");
      if (code === "geen_toegang") return t("energielabel.polycam.fout.geenToegang");
      return t("energielabel.polycam.fout.algemeen");
    },
    [t]
  );

  const laadScans = useCallback(async () => {
    setLaden(true);
    try {
      const res = await fetch("/api/polycam/scans", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setLijstFout(foutTekst(data.error));
        return;
      }
      setLijstFout(null);
      setScans(data.scans as Scan[]);
    } catch {
      setLijstFout(t("energielabel.polycam.fout.algemeen"));
    } finally {
      setLaden(false);
    }
  }, [foutTekst, t]);

  // Eerste keer, en elke keer dat de opnemer terugkomt uit de Polycam-app.
  useEffect(() => {
    const eerste = setTimeout(laadScans, 0);
    const opZicht = () => {
      if (document.visibilityState === "visible") laadScans();
    };
    document.addEventListener("visibilitychange", opZicht);
    return () => {
      clearTimeout(eerste);
      document.removeEventListener("visibilitychange", opZicht);
    };
  }, [laadScans]);

  const stap = useCallback(
    async (captureId: string) => {
      const k = koppelingenRef.current[captureId];
      if (!k || !dropboxPad || bezig.current.has(captureId)) return;
      bezig.current.add(captureId);
      try {
        const res = await fetch("/api/polycam/koppel", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            captureId,
            dropboxPad,
            verdieping: k.verdieping,
            exportGestart: k.antwoord?.exportGestart ?? false,
            saveJobId: k.antwoord?.saveJobId ?? null,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          zetKoppeling(captureId, (x) => ({ ...x, fout: foutTekst(data.error) }));
          return;
        }
        const antwoord = data as KoppelAntwoord;
        zetKoppeling(captureId, (x) => ({ ...x, antwoord, fout: null }));
        if (antwoord.deellink && !linkGemeld.current.has(captureId)) {
          linkGemeld.current.add(captureId);
          callbacks.current.onDeellink(k.veldId, antwoord.deellink);
        }
        if (antwoord.fase === "klaar" && !bestandGemeld.current.has(captureId)) {
          bestandGemeld.current.add(captureId);
          callbacks.current.onBestandOpgeslagen();
        }
      } catch {
        // Even geen verbinding in de kelder: de volgende ronde probeert het weer.
      } finally {
        bezig.current.delete(captureId);
      }
    },
    [dropboxPad, foutTekst, zetKoppeling]
  );

  // Alles wat nog loopt om de paar seconden een stap verder brengen.
  useEffect(() => {
    const timer = setInterval(() => {
      for (const k of Object.values(koppelingenRef.current)) {
        if (isLopend(k)) stap(k.captureId);
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [stap]);

  function volgende() {
    if (!gekozenId || !dropboxPad || !actiefVeldId) return;
    const veldId = actiefVeldId;
    const veld = velden.find((v) => v.id === veldId);
    const verdieping = veld ? verdiepingUitVeldnaam(veld.name) : "";
    linkGemeld.current.delete(gekozenId);
    bestandGemeld.current.delete(gekozenId);
    const nieuw: Koppeling = {
      captureId: gekozenId,
      veldId,
      verdieping,
      antwoord: null,
      fout: null,
      gestartOp: Date.now(),
    };
    koppelingenRef.current = { ...koppelingenRef.current, [gekozenId]: nieuw };
    setKoppelingen(koppelingenRef.current);
    setPopupId(gekozenId);
    stap(gekozenId);
  }

  function nogEenVerdieping() {
    setPopupId(null);
    setGekozenId(null);
    const bezet = new Set(Object.values(koppelingenRef.current).map((k) => k.veldId));
    setVeldId(eersteLegeVeld(velden, waarden, bezet));
  }

  function opnieuw(captureId: string) {
    linkGemeld.current.delete(captureId);
    zetKoppeling(captureId, (x) => ({ ...x, antwoord: null, fout: null, gestartOp: Date.now() }));
    stap(captureId);
  }

  const tijd = (iso: string | null) =>
    iso
      ? new Date(iso).toLocaleString(taal === "en" ? "en-GB" : "nl-NL", {
          day: "numeric",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
        })
      : "";

  const veldNaam = (id: string) => {
    const v = velden.find((x) => x.id === id);
    return v ? v.name : "";
  };

  const popup = popupId ? koppelingen[popupId] : null;
  const lijst = Object.values(koppelingen);

  return (
    <div className="section pc-section">
      <div className="section-head">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M12 3 3 7.5v9L12 21l9-4.5v-9L12 3Z M3 7.5 12 12l9-4.5 M12 12v9" stroke="var(--accent-text)" strokeWidth="1.7" strokeLinejoin="round" />
        </svg>
        <h2>{t("energielabel.polycam.titel")}</h2>
        <span className="section-count">{t("energielabel.polycam.uitleg")}</span>
      </div>
      <div className="section-body is-single-wide pc-body">
        <a className="pc-start" href={POLYCAM_APP_URL} target="_blank" rel="noopener noreferrer">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
            <path d="M12 7.5 7.5 10v4.5L12 17l4.5-2.5V10L12 7.5Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
          </svg>
          <span>
            {t("energielabel.polycam.start")}
            <small>{t("energielabel.polycam.startSub")}</small>
          </span>
        </a>

        <div className="pc-list-head">
          <div>
            <span className="eyebrow">{t("energielabel.polycam.laatste")}</span>
            <p className="pc-hint">{t("energielabel.polycam.laatsteSub")}</p>
          </div>
          <button type="button" className="btn-refresh" onClick={laadScans} disabled={laden}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true" className={laden ? "spin" : undefined}>
              <path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {laden ? t("energielabel.verversenBezig") : t("energielabel.verversen")}
          </button>
        </div>

        {lijstFout && <div className="banner is-bad">{lijstFout}</div>}
        {!lijstFout && scans && scans.length === 0 && <p className="pc-hint">{t("energielabel.polycam.geenScans")}</p>}

        {scans && scans.length > 0 && (
          <div className="pc-list" role="radiogroup" aria-label={t("energielabel.polycam.kiesAria")}>
            {scans.map((s) => {
              const gekozen = s.id === gekozenId;
              const gekoppeld = koppelingen[s.id];
              return (
                <button
                  key={s.id}
                  type="button"
                  role="radio"
                  aria-checked={gekozen}
                  className={`pc-scan${gekozen ? " is-selected" : ""}${s.status !== "klaar" ? " is-busy" : ""}`}
                  onClick={() => setGekozenId(s.id)}
                >
                  <span className="pc-thumb">
                    {s.voorbeeld && (
                      // eslint-disable-next-line @next/next/no-img-element -- extern voorbeeldplaatje van Polycam
                      <img src={s.voorbeeld} alt="" referrerPolicy="no-referrer" />
                    )}
                  </span>
                  <span className="pc-main">
                    <span className="pc-name">{s.naam}</span>
                    <span className="pc-meta">
                      {tijd(s.gemaaktOp)}
                      {gekoppeld ? ` · ${verdiepingUitVeldnaam(veldNaam(gekoppeld.veldId))}` : ""}
                    </span>
                  </span>
                  <span className={`pc-chip ${s.status === "klaar" ? "is-ok" : s.status === "mislukt" ? "is-bad" : "is-warn"}`}>
                    {s.status === "klaar"
                      ? t("energielabel.polycam.status.klaar")
                      : s.status === "mislukt"
                        ? t("energielabel.polycam.status.mislukt")
                        : t("energielabel.polycam.status.bezig")}
                  </span>
                  <span className="pc-radio" aria-hidden="true">
                    {gekozen && (
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                        <path d="M3.5 8.5 6.5 11.5 12.5 4.5" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        <div className="pc-foot">
          <div className="field">
            <label htmlFor="pc-verdieping">{t("energielabel.polycam.verdieping")}</label>
            <select id="pc-verdieping" className="control" value={actiefVeldId} onChange={(e) => setVeldId(e.target.value)}>
              {velden.map((v) => (
                <option key={v.id} value={v.id}>
                  {verdiepingUitVeldnaam(v.name)}
                  {waarden[v.id] ? ` — ${t("energielabel.polycam.alIngevuld")}` : ""}
                </option>
              ))}
            </select>
          </div>
          <button type="button" className="btn btn-primary" onClick={volgende} disabled={!gekozenId || !dropboxPad || !actiefVeldId}>
            {t("energielabel.polycam.volgende")}
          </button>
        </div>
        {!dropboxPad && <p className="pc-hint">{t("energielabel.polycam.wachtOpMap")}</p>}

        {lijst.length > 0 && (
          <ul className="pc-gekoppeld">
            {lijst.map((k) => (
              <li key={k.captureId}>
                <button type="button" className="btn-text" onClick={() => setPopupId(k.captureId)}>
                  {verdiepingUitVeldnaam(veldNaam(k.veldId))}
                </button>
                <span>{samenvatting(k, t)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {popup && (
        <div className="upload-overlay" role="presentation">
          <div className="upload-modal pc-modal" role="dialog" aria-modal="true" aria-labelledby="pc-popup-titel">
            <PopupInhoud
              k={popup}
              veldNaam={veldNaam(popup.veldId)}
              scanNaam={scans?.find((s) => s.id === popup.captureId)?.naam ?? popup.antwoord?.scan.naam ?? ""}
            />
            <div className="pc-modal-acties">
              {popup.fout || popup.antwoord?.fase === "fout" ? (
                <button type="button" className="btn btn-quiet" onClick={() => opnieuw(popup.captureId)}>
                  {t("energielabel.polycam.opnieuw")}
                </button>
              ) : (
                <button type="button" className="btn btn-quiet" onClick={nogEenVerdieping}>
                  {popup.antwoord?.fase === "wacht-upload" ? t("energielabel.polycam.andereScan") : t("energielabel.polycam.nogEen")}
                </button>
              )}
              <button type="button" className="btn btn-primary" onClick={() => setPopupId(null)}>
                {t("energielabel.polycam.verder")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

type T = ReturnType<typeof useTaal>["t"];

function samenvatting(k: Koppeling, t: T): string {
  if (k.fout || k.antwoord?.fase === "fout") return t("energielabel.polycam.kort.fout");
  switch (k.antwoord?.fase) {
    case "klaar":
      return t("energielabel.polycam.kort.klaar");
    case "exporteren":
    case "opslaan":
      return t("energielabel.polycam.kort.las");
    default:
      return t("energielabel.polycam.kort.wacht");
  }
}

function Vink() {
  return (
    <span className="pc-step-icon is-ok" aria-hidden="true">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
        <path d="M3.5 8.5 6.5 11.5 12.5 4.5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

function Bezig() {
  return (
    <span className="pc-step-icon" aria-hidden="true">
      <span className="spinner" />
    </span>
  );
}

function Wacht() {
  return (
    <span className="pc-step-icon" aria-hidden="true">
      <span className="pc-step-dot" />
    </span>
  );
}

function Fout() {
  return (
    <span className="pc-step-icon is-bad" aria-hidden="true">
      !
    </span>
  );
}

function PopupInhoud({ k, veldNaam, scanNaam }: { k: Koppeling; veldNaam: string; scanNaam: string }) {
  const { t } = useTaal();
  const a = k.antwoord;
  const fase = k.fout ? "fout" : (a?.fase ?? "laden");
  const inPolycam = !!a && a.fase !== "wacht-upload";
  const bestandNaam = a?.bestand ? a.bestand.split("/").slice(-2).join("/") : "";
  const titel =
    fase === "klaar"
      ? t("energielabel.polycam.popup.klaar")
      : fase === "wacht-upload"
        ? t("energielabel.polycam.popup.wacht")
        : fase === "fout"
          ? t("energielabel.polycam.popup.fout")
          : t("energielabel.polycam.popup.bezig");

  return (
    <>
      <h3 id="pc-popup-titel">{titel}</h3>
      <p className="pc-hint">
        {scanNaam}
        {k.verdieping ? ` · ${k.verdieping}` : ""}
      </p>

      <ol className="pc-steps">
        <li>
          {inPolycam ? <Vink /> : fase === "fout" ? <Fout /> : <Bezig />}
          <div>
            <b>{inPolycam ? t("energielabel.polycam.stap.scanKlaar") : t("energielabel.polycam.stap.scanWacht")}</b>
            {!inPolycam && fase !== "fout" && <span>{t("energielabel.polycam.stap.scanWachtSub")}</span>}
          </div>
        </li>
        <li>
          {fase === "klaar" ? <Vink /> : fase === "exporteren" || fase === "opslaan" ? <Bezig /> : fase === "fout" ? <Fout /> : <Wacht />}
          <div>
            <b>
              {fase === "klaar"
                ? t("energielabel.polycam.stap.lasKlaar")
                : fase === "exporteren"
                  ? t("energielabel.polycam.stap.lasExport")
                  : fase === "opslaan"
                    ? t("energielabel.polycam.stap.lasOpslaan")
                    : t("energielabel.polycam.stap.las")}
            </b>
            <span>
              {fase === "klaar" && bestandNaam
                ? t("energielabel.polycam.stap.lasPad", { pad: bestandNaam })
                : t("energielabel.polycam.stap.lasSub")}
            </span>
          </div>
        </li>
        <li>
          {a?.deellink ? <Vink /> : <Wacht />}
          <div>
            <b>{a?.deellink ? t("energielabel.polycam.stap.linkKlaar") : t("energielabel.polycam.stap.link")}</b>
            <span>{t("energielabel.polycam.stap.linkVeld", { veld: veldNaam })}</span>
            {a?.deellink && (
              <a href={a.deellink} target="_blank" rel="noopener noreferrer" className="pc-link">
                {a.deellink.replace(/^https:\/\//, "")}
              </a>
            )}
            {a?.deellink && a.scan.openbaar === false && (
              <span className="pc-waarschuwing">{t("energielabel.polycam.stap.prive")}</span>
            )}
          </div>
        </li>
      </ol>

      {(k.fout || a?.fout) && <div className="banner is-bad">{k.fout ?? a?.fout}</div>}
      {fase === "wacht-upload" && <div className="pc-note">{t("energielabel.polycam.popup.achtergrond")}</div>}
    </>
  );
}
