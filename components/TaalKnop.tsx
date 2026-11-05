"use client";

import { TALEN } from "@/lib/taal";
import { useTaal } from "@/components/TaalProvider";

/**
 * NL | EN-schakelaar onderin de zijbalk.
 *
 * Een gesegmenteerde knop i.p.v. een vlaggetje of een dropdown: twee talen
 * passen naast elkaar, je ziet meteen welke aan staat, en het is één tik op
 * een iPad met handschoenen of stoffige vingers.
 */
export default function TaalKnop() {
  const { taal, t, zetTaal } = useTaal();
  return (
    <div className="taal-knop" role="group" aria-label={t("taal.label")}>
      <svg className="taal-knop-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.7" />
        <path d="M3.5 12h17M12 3.5c2.4 2.4 3.5 5.2 3.5 8.5s-1.1 6.1-3.5 8.5c-2.4-2.4-3.5-5.2-3.5-8.5S9.6 5.9 12 3.5Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      </svg>
      {TALEN.map((code) => (
        <button
          key={code}
          type="button"
          className="taal-knop-optie"
          aria-pressed={taal === code}
          title={t(`taal.${code}`)}
          onClick={() => taal !== code && zetTaal(code)}
        >
          {code.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
