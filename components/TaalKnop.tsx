"use client";

import { useId } from "react";
import { TALEN, type Taal } from "@/lib/taal";
import { useTaal } from "@/components/TaalProvider";

/**
 * Vlaggetjes als SVG en niet als emoji: Windows tekent 🇳🇱 en 🇬🇧 als losse
 * letters "NL" en "GB", dan valt het hele idee weg.
 */
function Vlag({ taal }: { taal: Taal }) {
  // Unieke id's per keer dat de vlag op het scherm staat; clipPath-id's zijn
  // documentbreed en botsen anders.
  const id = useId();
  if (taal === "nl") {
    return (
      <svg className="taal-vlag" viewBox="0 0 9 6" preserveAspectRatio="none" aria-hidden="true">
        <rect width="9" height="2" fill="#AE1C28" />
        <rect y="2" width="9" height="2" fill="#FFFFFF" />
        <rect y="4" width="9" height="2" fill="#21468B" />
      </svg>
    );
  }
  // Union Jack. Engels krijgt de Britse vlag: dat herkent iedereen als "Engels".
  const s = `${id}-s`;
  const t = `${id}-t`;
  return (
    <svg className="taal-vlag" viewBox="0 0 60 30" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs>
        <clipPath id={s}>
          <path d="M0,0 v30 h60 v-30 z" />
        </clipPath>
        <clipPath id={t}>
          <path d="M30,15 h30 v15 z v15 h-30 z h-30 v-15 z v-15 h30 z" />
        </clipPath>
      </defs>
      <g clipPath={`url(#${s})`}>
        <path d="M0,0 v30 h60 v-30 z" fill="#012169" />
        <path d="M0,0 L60,30 M60,0 L0,30" stroke="#FFFFFF" strokeWidth="6" />
        <path d="M0,0 L60,30 M60,0 L0,30" clipPath={`url(#${t})`} stroke="#C8102E" strokeWidth="4" />
        <path d="M30,0 v30 M0,15 h60" stroke="#FFFFFF" strokeWidth="10" />
        <path d="M30,0 v30 M0,15 h60" stroke="#C8102E" strokeWidth="6" />
      </g>
    </svg>
  );
}

/**
 * NL | EN-schakelaar onderin de zijbalk, met vlaggetje.
 *
 * Een gesegmenteerde knop i.p.v. een dropdown: twee talen passen naast
 * elkaar, je ziet meteen welke aan staat, en het is één tik op een iPad met
 * handschoenen of stoffige vingers. De vlag maakt hem herkenbaar zonder te
 * lezen; de code ernaast houdt hem duidelijk voor wie kleuren slecht ziet.
 */
export default function TaalKnop() {
  const { taal, t, zetTaal } = useTaal();
  return (
    <div className="taal-knop" role="group" aria-label={t("taal.label")}>
      {TALEN.map((code) => (
        <button
          key={code}
          type="button"
          className="taal-knop-optie"
          aria-pressed={taal === code}
          title={t(`taal.${code}`)}
          onClick={() => taal !== code && zetTaal(code)}
        >
          <Vlag taal={code} />
          {code.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
