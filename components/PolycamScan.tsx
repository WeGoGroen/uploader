"use client";

import { useEffect, useRef, useState } from "react";
import { useTaal } from "@/components/TaalProvider";
import { enqueue, type UploadTask } from "@/lib/upload-queue";
import { haalPolycamLink, isPuntenwolk, lasBestandsnaam, verdiepingUitVeldnaam } from "@/lib/polycam-velden";

/**
 * Polycam-blok in stap 2 van de energielabel-uploader, direct na D1.
 *
 * De lichte versie, zonder Polycam-API (die zit alleen in Enterprise):
 *  - "Start Polycam-scan" opent de app;
 *  - de opnemer kiest de verdieping, plakt de deellink uit de app en kiest
 *    de geëxporteerde LAS;
 *  - "Volgende" zet de link in het D8-veld van die verdieping en stuurt de
 *    LAS via de gewone uploadwachtrij naar Dropbox › LAZ (D4);
 *  - de pop-up laat zien dat beide gelukt zijn.
 */

/** Een universele link opent de app als die er staat, anders de website. */
const POLYCAM_APP_URL = process.env.NEXT_PUBLIC_POLYCAM_APP_URL || "https://poly.cam/";

/** De Dropbox-submap voor D4 LAZ-bestanden (zie lib/documents.ts). */
const LAZ_MAP = "LAZ";

interface D8Veld {
  id: string;
  name: string;
}

interface Koppeling {
  id: number;
  veldId: string;
  verdieping: string;
  link: string | null;
  /** Naam waaronder de LAS in de wachtrij staat, of null zonder LAS. */
  bestand: string | null;
}

interface Props {
  velden: D8Veld[];
  waarden: Record<string, unknown>;
  dropboxPad: string | null;
  /** Wie er uploadt, voor de wachtrij (zelfde als bij de documenten). */
  account: string | null;
  /** De uploads van deze projectmap, live uit de wachtrij. */
  uploads: UploadTask[];
  onDeellink: (veldId: string, url: string) => void;
}

function eersteLegeVeld(velden: D8Veld[], waarden: Record<string, unknown>, bezet: Set<string>): string {
  const leeg = velden.find((v) => !waarden[v.id] && !bezet.has(v.id));
  return (leeg ?? velden[0])?.id ?? "";
}

export default function PolycamScan({ velden, waarden, dropboxPad, account, uploads, onDeellink }: Props) {
  const { t } = useTaal();
  const [veldId, setVeldId] = useState("");
  const [linkTekst, setLinkTekst] = useState("");
  const [bestand, setBestand] = useState<File | null>(null);
  const [koppelingen, setKoppelingen] = useState<Koppeling[]>([]);
  const [popupId, setPopupId] = useState<number | null>(null);
  const bestandInput = useRef<HTMLInputElement>(null);
  const linkInput = useRef<HTMLInputElement>(null);
  const volgnummer = useRef(0);

  // Velden komen pas binnen na het laden van ClickUp: tot de opnemer zelf
  // kiest, staat de keuze op de eerste verdieping die nog leeg is.
  const bezet = new Set(koppelingen.map((k) => k.veldId));
  const actiefVeldId = veldId || eersteLegeVeld(velden, waarden, bezet);
  const veldNaam = (id: string) => velden.find((v) => v.id === id)?.name ?? "";

  const link = linkTekst.trim() ? haalPolycamLink(linkTekst) : null;
  const linkOngeldig = linkTekst.trim() !== "" && !link;
  const kanVerder = !!actiefVeldId && !linkOngeldig && (!!link || (!!bestand && !!dropboxPad));

  async function plakken() {
    try {
      const tekst = await navigator.clipboard.readText();
      if (tekst) setLinkTekst(tekst.trim());
    } catch {
      // Geen toestemming voor het klembord: dan zelf plakken in het veld.
      linkInput.current?.focus();
    }
  }

  function kiesBestand(file: File | undefined) {
    setBestand(file && isPuntenwolk(file.name) ? file : null);
  }

  function volgende() {
    if (!kanVerder) return;
    const verdieping = verdiepingUitVeldnaam(veldNaam(actiefVeldId));
    let naam: string | null = null;
    if (bestand && dropboxPad) {
      naam = lasBestandsnaam(verdieping, bestand.name);
      const hernoemd = naam === bestand.name ? bestand : new File([bestand], naam, { type: bestand.type });
      enqueue(dropboxPad, LAZ_MAP, hernoemd, account);
    }
    if (link) onDeellink(actiefVeldId, link);

    const id = ++volgnummer.current;
    setKoppelingen((p) => [
      ...p.filter((k) => k.veldId !== actiefVeldId),
      { id, veldId: actiefVeldId, verdieping, link, bestand: naam },
    ]);
    setPopupId(id);
    setLinkTekst("");
    setBestand(null);
    if (bestandInput.current) bestandInput.current.value = "";
  }

  function nogEenVerdieping() {
    setPopupId(null);
    setVeldId("");
  }

  // Na een herstart van de pagina komt een LAS soms onder een eigen naam
  // terug in de wachtrij; we volgen hem op de naam in de LAZ-map.
  const upload = (naam: string | null) =>
    naam ? uploads.find((u) => u.folder === LAZ_MAP && u.name === naam) ?? null : null;

  const popup = koppelingen.find((k) => k.id === popupId) ?? null;

  // Escape sluit de pop-up, net als "Verder".
  useEffect(() => {
    if (popupId === null) return;
    const toets = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPopupId(null);
    };
    window.addEventListener("keydown", toets);
    return () => window.removeEventListener("keydown", toets);
  }, [popupId]);

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

        <div>
          <span className="eyebrow">{t("energielabel.polycam.koppelTitel")}</span>
          <p className="pc-hint">{t("energielabel.polycam.koppelSub")}</p>
        </div>

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

        <div className={`field${linkOngeldig ? " field-missing" : ""}`}>
          <label htmlFor="pc-link">{t("energielabel.polycam.link")}</label>
          <div className="pc-rij">
            <input
              id="pc-link"
              ref={linkInput}
              type="url"
              inputMode="url"
              className={`control${link ? " is-filled" : ""}`}
              placeholder={t("energielabel.polycam.linkPlaceholder")}
              value={linkTekst}
              onChange={(e) => setLinkTekst(e.target.value)}
            />
            <button type="button" className="btn-pick-file pc-knop" onClick={plakken}>
              {t("energielabel.polycam.plakken")}
            </button>
          </div>
          {linkOngeldig && <span className="pc-fout">{t("energielabel.polycam.linkOngeldig")}</span>}
        </div>

        <div className="field">
          <label htmlFor="pc-las">{t("energielabel.polycam.las")}</label>
          <input
            id="pc-las"
            ref={bestandInput}
            type="file"
            accept=".las,.laz,application/octet-stream"
            hidden
            onChange={(e) => kiesBestand(e.target.files?.[0])}
          />
          <div className="pc-rij">
            <button
              type="button"
              className="btn-pick-file pc-knop"
              onClick={() => bestandInput.current?.click()}
              disabled={!dropboxPad}
            >
              {bestand ? t("energielabel.polycam.lasAnder") : t("energielabel.polycam.lasKiezen")}
            </button>
            <span className={`pc-bestand${bestand ? " is-gekozen" : ""}`}>
              {bestand ? `${bestand.name} · ${formatMb(bestand.size)}` : t("energielabel.polycam.lasHint")}
            </span>
          </div>
          {!dropboxPad && <span className="pc-hint">{t("energielabel.polycam.wachtOpMap")}</span>}
        </div>

        <div className="pc-foot">
          <button type="button" className="btn btn-primary" onClick={volgende} disabled={!kanVerder}>
            {t("energielabel.polycam.volgende")}
          </button>
        </div>

        {koppelingen.length > 0 && (
          <ul className="pc-gekoppeld">
            {koppelingen.map((k) => (
              <li key={k.id}>
                <button type="button" className="btn-text" onClick={() => setPopupId(k.id)}>
                  {k.verdieping}
                </button>
                <span>{samenvatting(k, upload(k.bestand), t)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {popup && (
        <div className="upload-overlay" role="presentation" onClick={(e) => e.target === e.currentTarget && setPopupId(null)}>
          <div className="upload-modal pc-modal" role="dialog" aria-modal="true" aria-labelledby="pc-popup-titel">
            <PopupInhoud k={popup} veldNaam={veldNaam(popup.veldId)} taak={upload(popup.bestand)} />
            <div className="pc-modal-acties">
              <button type="button" className="btn btn-quiet" onClick={nogEenVerdieping}>
                {t("energielabel.polycam.nogEen")}
              </button>
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

function formatMb(bytes: number): string {
  return bytes >= 1024 * 1024 * 1024
    ? `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
    : `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`;
}

type T = ReturnType<typeof useTaal>["t"];

function samenvatting(k: Koppeling, taak: UploadTask | null, t: T): string {
  const delen: string[] = [];
  if (k.link) delen.push(t("energielabel.polycam.kort.link"));
  if (k.bestand) {
    if (!taak || taak.dropbox === "done") delen.push(t("energielabel.polycam.kort.lasKlaar"));
    else if (taak.dropbox === "error") delen.push(t("energielabel.polycam.kort.lasFout"));
    else delen.push(t("energielabel.polycam.kort.lasBezig", { pct: Math.round(taak.pct) }));
  }
  return delen.join(" · ");
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

function Leeg() {
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

function PopupInhoud({ k, veldNaam, taak }: { k: Koppeling; veldNaam: string; taak: UploadTask | null }) {
  const { t } = useTaal();
  // Een LAS die niet (meer) in de wachtrij staat is klaar: de wachtrij ruimt
  // afgeronde uploads op.
  const lasStatus = !k.bestand ? "geen" : !taak || taak.dropbox === "done" ? "klaar" : taak.dropbox === "error" ? "fout" : "bezig";
  const compleet = !!k.link && lasStatus === "klaar";

  return (
    <>
      <h3 id="pc-popup-titel">{compleet ? t("energielabel.polycam.popup.klaar") : t("energielabel.polycam.popup.deels")}</h3>
      <p className="pc-hint">{k.verdieping}</p>

      <ol className="pc-steps">
        <li>
          {lasStatus === "klaar" ? <Vink /> : lasStatus === "bezig" ? <Bezig /> : lasStatus === "fout" ? <Fout /> : <Leeg />}
          <div>
            <b>
              {lasStatus === "klaar"
                ? t("energielabel.polycam.stap.lasKlaar")
                : lasStatus === "bezig"
                  ? t("energielabel.polycam.stap.lasBezig", { pct: Math.round(taak?.pct ?? 0) })
                  : lasStatus === "fout"
                    ? t("energielabel.polycam.stap.lasFout")
                    : t("energielabel.polycam.stap.lasGeen")}
            </b>
            <span>
              {k.bestand ? t("energielabel.polycam.stap.lasPad", { naam: k.bestand }) : t("energielabel.polycam.stap.lasGeenSub")}
            </span>
            {lasStatus === "bezig" && (
              <div className="doc-upload-bar" style={{ marginTop: 6 }}>
                <div className="doc-upload-bar-fill" style={{ width: `${Math.round(taak?.pct ?? 0)}%`, background: "var(--accent)" }} />
              </div>
            )}
            {lasStatus === "fout" && taak?.dropboxError && <span className="pc-fout">{taak.dropboxError}</span>}
          </div>
        </li>
        <li>
          {k.link ? <Vink /> : <Leeg />}
          <div>
            <b>{k.link ? t("energielabel.polycam.stap.linkKlaar") : t("energielabel.polycam.stap.linkGeen")}</b>
            <span>
              {k.link ? t("energielabel.polycam.stap.linkVeld", { veld: veldNaam }) : t("energielabel.polycam.stap.linkGeenSub")}
            </span>
            {k.link && (
              <a href={k.link} target="_blank" rel="noopener noreferrer" className="pc-link">
                {k.link.replace(/^https:\/\//, "")}
              </a>
            )}
          </div>
        </li>
        {k.link && (
          <li>
            <Vink />
            <div>
              <b>{t("energielabel.polycam.stap.ja")}</b>
              <span>{t("energielabel.polycam.stap.jaSub")}</span>
            </div>
          </li>
        )}
      </ol>

      {lasStatus === "bezig" && <div className="pc-note">{t("energielabel.polycam.popup.achtergrond")}</div>}
    </>
  );
}
