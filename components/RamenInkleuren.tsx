"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { enqueue } from "@/lib/upload-queue";
import {
  BUITENGEVEL_SUBMAP,
  GEVELS,
  GLAS,
  GRENST_AAN,
  SCHRIJF,
  energielabelMapVoor,
  lijnDikte,
  ramenBestandsnaam,
  type Gevel,
  type PenKleur,
} from "@/lib/ramen-inkleuren";

/** Langste zijde van de foto waarop getekend wordt. Ruim genoeg om elk
    kozijn te kunnen lezen, klein genoeg voor het geheugen van een iPad. */
const MAX_ZIJDE = 2560;
const JPEG_KWALITEIT = 0.9;

interface Adres {
  straatEnNummer: string;
  woonplaats: string;
}

interface Lijn {
  kleur: string;
  dikte: number;
  punten: [number, number][];
}

/** Onthoudt per adres welke energielabelmap de server teruggaf, zodat ook
    zonder internet de juiste map (bijvoorbeeld in het archief) gebruikt wordt. */
const MAP_SLEUTEL = "wgg-ramen-map:";

function bewaardeMap(adres: Adres): string | null {
  try {
    return localStorage.getItem(MAP_SLEUTEL + `${adres.straatEnNummer}, ${adres.woonplaats}`);
  } catch {
    return null;
  }
}

function bewaarMap(adres: Adres, pad: string) {
  try {
    localStorage.setItem(MAP_SLEUTEL + `${adres.straatEnNummer}, ${adres.woonplaats}`, pad);
  } catch {
    // Geen opslag (privévenster): dan valt hij straks terug op de berekende map.
  }
}

/**
 * De energielabelmap van het adres. Met internet vraagt hij de echte map op
 * (die maakt hem zo nodig aan, of vindt hem in het archief); zonder internet
 * de laatst bekende, of anders de map zoals hij zou heten. De upload zelf
 * wacht in de wachtrij tot er weer verbinding is.
 */
async function energielabelMap(adres: Adres): Promise<string> {
  try {
    const res = await fetch("/api/dropbox/folder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ woonplaats: adres.woonplaats, straatEnNummer: adres.straatEnNummer, kind: "energielabel" }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = await res.json().catch(() => null);
    if (res.ok && typeof data?.path === "string") {
      bewaarMap(adres, data.path);
      return data.path;
    }
  } catch {
    // Geen verbinding: hieronder terugvallen.
  }
  return bewaardeMap(adres) ?? energielabelMapVoor(adres.woonplaats, adres.straatEnNummer);
}

/** Leest de foto rechtop in (iPad-foto's hebben een EXIF-draaiing). */
async function laadFoto(file: File): Promise<ImageBitmap | HTMLImageElement> {
  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

function tekenLijnen(ctx: CanvasRenderingContext2D, lijnen: Lijn[]) {
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const l of lijnen) {
    if (l.punten.length === 0) continue;
    ctx.strokeStyle = l.kleur;
    ctx.lineWidth = l.dikte;
    ctx.beginPath();
    ctx.moveTo(l.punten[0][0], l.punten[0][1]);
    for (const [x, y] of l.punten) ctx.lineTo(x, y);
    // Eén tik is ook een stip.
    if (l.punten.length === 1) ctx.lineTo(l.punten[0][0] + 0.1, l.punten[0][1]);
    ctx.stroke();
  }
}

/** Het gevel-label linksboven, zoals de vakjes op het kleurenblad. */
function tekenLabel(ctx: CanvasRenderingContext2D, gevel: Gevel, breedte: number) {
  const s = breedte / 1000;
  const codeMaat = Math.round(40 * s);
  const labelMaat = Math.round(14 * s);
  ctx.font = `800 ${codeMaat}px system-ui, sans-serif`;
  const codeBreedte = ctx.measureText(gevel.code).width;
  ctx.font = `700 ${labelMaat}px system-ui, sans-serif`;
  const labelBreedte = ctx.measureText(gevel.label).width;
  const pad = 14 * s;
  const w = Math.max(codeBreedte, labelBreedte, 150 * s) + pad * 2;
  const h = codeMaat + labelMaat + pad * 2 + 6 * s;
  const x = 18 * s;
  const y = 18 * s;
  ctx.fillStyle = "#fdfcf5";
  ctx.fillRect(x, y, w, h);
  ctx.lineWidth = Math.max(2, 4 * s);
  ctx.strokeStyle = "#1a201c";
  ctx.strokeRect(x, y, w, h);
  ctx.fillStyle = "#1a201c";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.font = `800 ${codeMaat}px system-ui, sans-serif`;
  ctx.fillText(gevel.code, x + w / 2, y + pad);
  ctx.font = `700 ${labelMaat}px system-ui, sans-serif`;
  ctx.fillText(gevel.label, x + w / 2, y + pad + codeMaat + 6 * s);
}

/**
 * De grijze knop naast de Dropbox-balk van het energielabel: opent de camera,
 * en na de foto een schermvullend venster om de ramen in te kleuren. "Klaar"
 * zet de foto met de inkleuring erop in de uploadwachtrij — die bewaart hem
 * eerst op de iPad, dus zonder internet gaat er niets verloren.
 *
 * `map` is de projectmap van de opname zodra die klaarstaat; zonder (nog geen
 * verbinding gehad) zoekt hij de map zelf op of valt hij terug op de naam.
 */
export default function RamenInkleuren({
  adres,
  map,
  account,
}: {
  adres: Adres;
  map: string | null;
  account: string | null;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [foto, setFoto] = useState<{
    id: number;
    beeld: ImageBitmap | HTMLImageElement;
    w: number;
    h: number;
  } | null>(null);
  const [fout, setFout] = useState<string | null>(null);

  async function kiesFoto(file: File | undefined) {
    if (!file) return;
    setFout(null);
    try {
      const beeld = await laadFoto(file);
      const schaal = Math.min(1, MAX_ZIJDE / Math.max(beeld.width, beeld.height));
      setFoto({ id: Date.now(), beeld, w: Math.round(beeld.width * schaal), h: Math.round(beeld.height * schaal) });
    } catch {
      setFout("Deze foto kon niet geopend worden. Probeer het nog een keer.");
    }
  }

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          void kiesFoto(file);
        }}
      />
      <button
        type="button"
        className="ramen-knop"
        onClick={() => inputRef.current?.click()}
        aria-label="Foto maken en ramen inkleuren"
      >
        <span className="ramen-knop-icoon" aria-hidden="true">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
            <path
              d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2.2l1.4-2h5.8l1.4 2h2.2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5v-9Z"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinejoin="round"
            />
            <circle cx="12" cy="13" r="3.4" stroke="currentColor" strokeWidth="1.8" />
          </svg>
        </span>
        <span className="ramen-knop-tekst">Ramen</span>
      </button>
      {fout && <div className="banner is-bad ramen-fout">{fout}</div>}
      {foto && (
        <Inkleuren
          key={foto.id}
          foto={foto}
          adres={adres}
          onNieuweFoto={() => inputRef.current?.click()}
          onSluit={() => setFoto(null)}
          onKlaar={async (file) => {
            setFoto(null);
            if (map) bewaarMap(adres, map);
            const doel = map ?? (await energielabelMap(adres));
            enqueue(doel, BUITENGEVEL_SUBMAP, file, account);
          }}
        />
      )}
    </>
  );
}

function Inkleuren({
  foto,
  adres,
  onNieuweFoto,
  onSluit,
  onKlaar,
}: {
  foto: { beeld: ImageBitmap | HTMLImageElement; w: number; h: number };
  adres: Adres;
  onNieuweFoto: () => void;
  onSluit: () => void;
  onKlaar: (file: File) => Promise<void>;
}) {
  const vlakRef = useRef<HTMLDivElement>(null);
  const fotoRef = useRef<HTMLCanvasElement>(null);
  const penRef = useRef<HTMLCanvasElement>(null);
  const lijnen = useRef<Lijn[]>([]);
  const huidige = useRef<Lijn | null>(null);
  const [gevel, setGevel] = useState<Gevel | null>(null);
  const [pen, setPen] = useState<PenKleur>(GLAS.find((k) => k.naam === "HR++") ?? GLAS[0]);
  const [maat, setMaat] = useState<{ w: number; h: number } | null>(null);
  const [bezig, setBezig] = useState(false);
  const [opslaanFout, setOpslaanFout] = useState(false);
  const [, setAantal] = useState(0);

  // Elke foto krijgt een eigen exemplaar van dit venster (key), dus hier
  // hoeft alleen de foto zelf getekend te worden.
  useEffect(() => {
    fotoRef.current?.getContext("2d")?.drawImage(foto.beeld, 0, 0, foto.w, foto.h);
  }, [foto]);

  // De foto zo groot mogelijk in het vlak, met de juiste verhouding.
  useLayoutEffect(() => {
    const vlak = vlakRef.current;
    if (!vlak) return;
    const pas = () => {
      const schaal = Math.min(vlak.clientWidth / foto.w, vlak.clientHeight / foto.h);
      setMaat({ w: Math.floor(foto.w * schaal), h: Math.floor(foto.h * schaal) });
    };
    pas();
    const obs = new ResizeObserver(pas);
    obs.observe(vlak);
    return () => obs.disconnect();
  }, [foto]);

  // Achter het venster niet meescrollen.
  useEffect(() => {
    const vorige = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = vorige;
    };
  }, []);

  function herteken() {
    const ctx = penRef.current?.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, foto.w, foto.h);
    tekenLijnen(ctx, lijnen.current);
  }

  function punt(e: React.PointerEvent<HTMLCanvasElement>): [number, number] {
    const r = e.currentTarget.getBoundingClientRect();
    return [((e.clientX - r.left) * foto.w) / r.width, ((e.clientY - r.top) * foto.h) / r.height];
  }

  function kiesGevel(g: Gevel) {
    // Nog een keer op dezelfde gevel tikken haalt de keuze weg.
    setGevel((huidig) => (huidig?.naam === g.naam ? null : g));
  }

  async function klaar() {
    if (bezig) return;
    setBezig(true);
    try {
      const uit = document.createElement("canvas");
      uit.width = foto.w;
      uit.height = foto.h;
      const ctx = uit.getContext("2d");
      if (!ctx) throw new Error("geen canvas");
      ctx.drawImage(foto.beeld, 0, 0, foto.w, foto.h);
      tekenLijnen(ctx, lijnen.current);
      if (gevel) tekenLabel(ctx, gevel, foto.w);
      const blob = await new Promise<Blob | null>((r) => uit.toBlob(r, "image/jpeg", JPEG_KWALITEIT));
      if (!blob) throw new Error("geen jpg");
      const file = new File([blob], ramenBestandsnaam(gevel, new Date()), { type: "image/jpeg" });
      await onKlaar(file);
    } catch {
      setBezig(false);
      setOpslaanFout(true);
    }
  }

  const knop = (k: PenKleur) => (
    <button
      key={k.naam}
      type="button"
      className="ramen-kleur"
      aria-pressed={pen.naam === k.naam}
      style={{ background: k.kleur, color: k.tekst }}
      onClick={() => setPen(k)}
    >
      {k.naam}
    </button>
  );

  return (
    <div className="ramen-venster" role="dialog" aria-modal="true" aria-label="Ramen inkleuren">
      <div className="topline ramen-kop">
        <button type="button" className="btn-back" onClick={onSluit}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M10 12.5 5.5 8 10 3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Terug naar de opname
        </button>
        <h2>Ramen inkleuren · {adres.straatEnNummer}</h2>
      </div>

      <div className="ramen-werk">
        <div className="ramen-fotokaart">
          <div className="ramen-vlak" ref={vlakRef}>
            <div className="ramen-foto" style={maat ? { width: maat.w, height: maat.h } : { visibility: "hidden" }}>
              <canvas ref={fotoRef} width={foto.w} height={foto.h} />
              <canvas
                ref={penRef}
                width={foto.w}
                height={foto.h}
                className="ramen-pen"
                onPointerDown={(e) => {
                  e.preventDefault();
                  e.currentTarget.setPointerCapture(e.pointerId);
                  huidige.current = { kleur: pen.kleur, dikte: lijnDikte(pen.soort, foto.w), punten: [punt(e)] };
                  lijnen.current.push(huidige.current);
                  herteken();
                }}
                onPointerMove={(e) => {
                  if (!huidige.current) return;
                  huidige.current.punten.push(punt(e));
                  herteken();
                }}
                onPointerUp={() => {
                  if (huidige.current) setAantal(lijnen.current.length);
                  huidige.current = null;
                }}
                onPointerCancel={() => {
                  huidige.current = null;
                }}
              />
              {gevel && (
                <div className="ramen-label" aria-hidden="true">
                  <b>{gevel.code}</b>
                  <span>{gevel.label}</span>
                </div>
              )}
              <div className="ramen-hint" aria-live="polite">
                <span className="ramen-hint-stip" style={{ background: pen.kleur }} />
                {pen.soort === "schrijf" ? `Schrijven: ${pen.naam.toLowerCase()}` : `Pen: ${pen.naam} — kleur een raam in`}
              </div>
            </div>
          </div>
          <div className="ramen-acties">
            <button
              type="button"
              className="ramen-vorige"
              aria-label="Vorige stap ongedaan maken"
              title="Vorige"
              onClick={() => {
                lijnen.current.pop();
                setAantal(lijnen.current.length);
                herteken();
              }}
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M9 14 4 9l5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <button
              type="button"
              className="btn btn-quiet is-danger"
              onClick={() => {
                lijnen.current = [];
                setAantal(0);
                herteken();
              }}
            >
              Wissen
            </button>
            <button type="button" className="btn btn-quiet" onClick={onNieuweFoto}>
              Nieuwe foto
            </button>
            {opslaanFout && <span className="ramen-opslaan-fout">Opslaan lukte niet — probeer het nog een keer.</span>}
            <button type="button" className="btn btn-primary ramen-klaar" onClick={() => void klaar()} disabled={bezig}>
              {bezig ? "Opslaan…" : "Klaar"}
            </button>
          </div>
        </div>

        <div className="ramen-paneel">
          <section className="ramen-kaart" aria-label="Gevel oriëntatie">
            <div className="ramen-grid is-2">
              {GEVELS.map((g) => (
                <button
                  key={g.code}
                  type="button"
                  className="ramen-gevel"
                  aria-pressed={gevel?.naam === g.naam}
                  onClick={() => kiesGevel(g)}
                >
                  <b>{g.code}</b>
                  <span>{g.label}</span>
                </button>
              ))}
            </div>
          </section>
          <section className="ramen-kaart" aria-label="Glas">
            <div className="ramen-grid is-3">{GLAS.map(knop)}</div>
          </section>
          <section className="ramen-kaart" aria-label="Grenst aan">
            <div className="ramen-grid is-2">{GRENST_AAN.map(knop)}</div>
          </section>
          <section className="ramen-kaart" aria-label="Schrijven">
            <div className="ramen-rondjes">
              {SCHRIJF.map((k) => (
                <button
                  key={k.naam}
                  type="button"
                  className="ramen-rondje"
                  aria-pressed={pen.naam === k.naam}
                  aria-label={`Schrijven in ${k.naam.toLowerCase()}`}
                  style={{ background: k.kleur }}
                  onClick={() => setPen(k)}
                />
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
