"use client";

import { usePathname } from "next/navigation";
import { useRechten } from "@/components/RechtenProvider";
import { useTaal } from "@/components/TaalProvider";
import { useEffect, useState, useSyncExternalStore } from "react";
import {
  forgetTasks,
  getServerSnapshot,
  getSnapshot,
  hervatOpenstaandeUploads,
  probeerOpnieuw,
  subscribe,
  type UploadTask,
} from "@/lib/upload-queue";

/**
 * Pakt bij het openen van de app uploads op die bij een vorige sessie zijn
 * blijven liggen — bijvoorbeeld doordat Safari het tabblad afsloot terwijl er
 * nog foto's omhoog gingen.
 *
 * Toont niet alleen een aantal: eerder stond er acht seconden "2 uploads van
 * een vorige sessie worden hervat…" en daarna niets meer, waardoor er geen
 * enkele manier was om te zien bij welke opname die uploads hoorden of hoe ze
 * afliepen. Nu staat er per bestand bij welk adres en welke submap het gaat,
 * blijft de melding staan zolang er iets loopt of mislukt is, en kan hij
 * weggeklikt worden.
 */

/** "/Automatie NEN2580/Damrak 1, Amsterdam" → "Damrak 1, Amsterdam". */
function addressFromPath(folderPath: string): string {
  const parts = folderPath.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? folderPath;
}

/** Waar de opname bij dit bestand vandaan komt, zodat je erheen kunt klikken. */
function opnameLink(folderPath: string): string {
  const adres = addressFromPath(folderPath);
  const basis = /NEN/i.test(folderPath) ? "/nen" : "/energielabel";
  return `${basis}?addr=${encodeURIComponent(adres)}`;
}

export default function UploadResume() {
  // Op het dashboard staat dezelfde lijst al als vaste kolom ("Nog af te
  // maken"), inclusief voortgang en dezelfde knop. Twee keer hetzelfde tonen
  // levert alleen de vraag op welke van de twee je moet gebruiken — en de
  // zwevende melding dekt daar bovendien de pagina af.
  // Op het dashboard én op de mediapagina staat dezelfde lijst al ín de
  // pagina, mét voortgang en dezelfde knop. Twee keer hetzelfde tonen levert
  // alleen de vraag op welke van de twee je moet gebruiken — en de zwevende
  // melding legt zich daar bovenop de knoppen.
  const pad = usePathname();
  const opDashboard = pad === "/" || pad.startsWith("/media");
  const rechten = useRechten();
  const { t } = useTaal();
  const [ids, setIds] = useState<string[]>([]);
  const [dismissed, setDismissed] = useState(false);
  const allTasks = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  useEffect(() => {
    let weg = false;
    void hervatOpenstaandeUploads().then((hervat) => {
      if (!weg && hervat.length > 0) setIds(hervat);
    });
    return () => {
      weg = true;
    };
  }, []);

  const [herstart, setHerstart] = useState<string[]>([]);
  const [kwijt, setKwijt] = useState(false);

  /*
    Alleen hervatten wat deze persoon ook mag doen.

    De uploadwachtrij hoort bij het apparaat, niet bij het account - op een
    gedeelde iPad staat dus ook het werk van een collega erin. Zonder deze
    filter kreeg iemand zonder energielabelrecht een "hervat"-knop naar een
    formulier waar hij niet mag komen: klikken eindigt dan op de omleiding
    terug naar het dashboard.
  */
  const magHervatten = (folderPath: string) =>
    /NEN/i.test(folderPath) ? rechten.nen : /Media/i.test(folderPath) ? rechten.media : rechten.energielabel;
  const tasks = allTasks.filter((taak) => ids.includes(taak.id) && magHervatten(taak.folderPath));
  const busy = tasks.some((taak) => taak.dropbox === "uploading");
  const failed = tasks.filter((taak) => taak.dropbox === "error");

  async function opnieuw(teDoen: string[]) {
    setHerstart((v) => [...v, ...teDoen]);
    const gestart = await probeerOpnieuw(teDoen);
    setHerstart((v) => v.filter((id) => !teDoen.includes(id)));
    // Nul betekent: het bestand is niet meer op dit apparaat te vinden. Dat
    // eerlijk zeggen is beter dan een knop die stil niets doet.
    if (gestart === 0) setKwijt(true);
  }

  // Alles goed afgelopen: de melding mag weg. Bij een fout blijft hij staan —
  // dat is precies het geval waarin je moet weten dat er iets niet omhoog is
  // gegaan. useEffect en geen setTimeout in de render, zodat het opruimen ook
  // klopt als er tussendoor nog een upload bij komt.
  useEffect(() => {
    if (tasks.length === 0 || busy || failed.length > 0) return;
    const timer = setTimeout(() => setDismissed(true), 8000);
    return () => clearTimeout(timer);
  }, [tasks.length, busy, failed.length]);

  if (opDashboard || dismissed || tasks.length === 0) return null;

  const n = tasks.length;
  const heading = busy
    ? t(n === 1 ? "media.hervat.bezig.een" : "media.hervat.bezig.meer", { n })
    : failed.length > 0
      ? t(n === 1 ? "media.hervat.mislukt.een" : "media.hervat.mislukt.meer", { f: failed.length, n })
      : t(n === 1 ? "media.hervat.afgerond.een" : "media.hervat.afgerond.meer", { n });

  return (
    <div className={`resume-panel${failed.length > 0 && !busy ? " is-bad" : ""}`} role="status">
      <div className="resume-panel-head">
        {busy && <span className="spinner" />}
        {!busy && failed.length === 0 && <span aria-hidden="true">✓</span>}
        {!busy && failed.length > 0 && <span aria-hidden="true">⚠</span>}
        <strong>{heading}</strong>
        <button
          type="button"
          className="resume-panel-close"
          aria-label={t("media.hervat.sluiten")}
          title={busy ? t("media.hervat.verbergenBezig") : t("media.hervat.verbergen")}
          onClick={() => {
            // Mislukte uploads ook echt uit de wachtrij halen, anders komt
            // dezelfde melding bij elke paginaopening terug tot ze verlopen.
            if (!busy && failed.length > 0) forgetTasks(failed.map((taak) => taak.id));
            setDismissed(true);
          }}
        >
          ✕
        </button>
      </div>
      <ul className="resume-panel-list">
        {tasks.map((taak: UploadTask) => (
          <li key={taak.id}>
            {/* Het adres brengt je naar de opname zelf — eerder was er geen
                enkele weg terug vanuit deze melding. */}
            <a className="resume-panel-addr" href={opnameLink(taak.folderPath)}>
              {addressFromPath(taak.folderPath)}
            </a>
            <span className="resume-panel-file">
              {taak.folder} · {taak.name}
            </span>
            {taak.dropbox === "error" ? (
              <button
                type="button"
                className="resume-panel-retry"
                onClick={() => opnieuw([taak.id])}
                disabled={herstart.includes(taak.id)}
                title={taak.dropboxError ?? t("media.hervat.mislukt")}
              >
                {herstart.includes(taak.id) ? t("media.hervat.bezigKnop") : t("media.hervat.opnieuw")}
              </button>
            ) : (
              <span className="resume-panel-state">
                {taak.dropbox === "uploading" ? `${taak.pct}%` : "✓"}
              </span>
            )}
          </li>
        ))}
      </ul>
      {!busy && failed.length > 0 && !kwijt && (
        <div className="resume-panel-hint">
          <button
            type="button"
            className="btn btn-primary resume-panel-all"
            onClick={() => opnieuw(failed.map((taak) => taak.id))}
          >
            {failed.length === 1 ? t("media.hervat.afmaken.een") : t("media.hervat.afmaken.meer", { n: failed.length })}
          </button>
          <span>{t("media.hervat.nogOpApparaat")}</span>
        </div>
      )}
      {kwijt && (
        <p className="resume-panel-hint is-plain">
          {t("media.hervat.kwijt")}{" "}
          <a href="/opnames">{t("media.hervat.naarOpnames")}</a>
        </p>
      )}
    </div>
  );
}
