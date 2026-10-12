"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Het ⋯-knopje met een uitklapmenu.
 *
 * Voor handelingen die je zelden nodig hebt en die daarom niet als volle knop
 * naast de hoofdactie horen te staan: een melding verbergen, of een afspraak
 * met de hand als gedaan markeren. Zo blijft de rij rustig, en tik je er
 * niet per ongeluk op.
 */
export interface MeerMenuItem {
  label: string;
  /** Korte uitleg onder het label: wat er gebeurt als je erop tikt. */
  uitleg?: string;
  onClick: () => void;
}

export default function MeerMenu({
  label,
  items,
  bezig = false,
}: {
  /** Voor schermlezers: "Meer opties voor <adres>". */
  label: string;
  items: MeerMenuItem[];
  /** Toont een spinner in plaats van de puntjes zolang een handeling loopt. */
  bezig?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  // Sluiten bij een tik ernaast of Escape, zoals elk uitklapmenu.
  useEffect(() => {
    if (!open) return;
    function weg(e: PointerEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function esc(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", weg);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", weg);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  return (
    <div className="meer" ref={ref}>
      <button
        type="button"
        className="meer-knop"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={bezig}
        onClick={() => setOpen((o) => !o)}
      >
        {bezig ? (
          <span className="spinner" aria-hidden="true" />
        ) : (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <circle cx="3" cy="8" r="1.5" />
            <circle cx="8" cy="8" r="1.5" />
            <circle cx="13" cy="8" r="1.5" />
          </svg>
        )}
      </button>
      {open && (
        <div className="meer-menu" role="menu">
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className="user-menu-item"
              onClick={() => {
                setOpen(false);
                item.onClick();
              }}
            >
              <span className="meer-menu-tekst">
                <b>{item.label}</b>
                {item.uitleg && <span>{item.uitleg}</span>}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
