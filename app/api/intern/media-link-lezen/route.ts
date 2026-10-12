import { NextResponse } from "next/server";
import { isInternRequest } from "@/lib/intern-auth";
import { DROPBOX_API_BASE, directeDownload, getSharedAccessToken, getTemporaryLink, leesDeellink } from "@/lib/dropbox";

export const maxDuration = 60;

/** Meer bestanden dan dit in één link is geen shoot meer maar een archief. */
const MAX_BESTANDEN = 1500;

/** Alleen voor beeld een tijdelijke link: daar moet het control center in
    kijken om een 360-panorama van een gewone foto te onderscheiden. Een RAW of
    een clip is aan de naam al te herkennen. */
const BEELD = /\.(jpe?g|png|tiff?|webp|heic|heif)$/i;

interface Bestand {
  naam: string;
  /** Pad binnen de gedeelde map, voor het scherm ("360/kamer.jpg"). */
  relatief: string;
  /** Pad in dít account, voor het kopiëren. Null bij een link van buiten. */
  pad: string | null;
  grootte: number | null;
  /** Tijdelijke leeslink (vier uur), alleen voor beeld. */
  link: string | null;
}

/**
 * Wat er in een Dropbox-deellink staat, zodat het control center het kan
 * verdelen over In/Raw/Photo's, In/Raw/Video en In/Raw/360.
 *
 * Waarvoor: Media → Uploaden in het control center. Daar plakt iemand de link
 * van een hele shoot, en die moet net als een gewone upload over drie mappen
 * uiteen. Aan de naam is een clip te herkennen, maar een 360-panorama niet —
 * dat is ook gewoon een JPEG. Het control center leest daarom de kop van elk
 * beeldbestand (afmetingen, GPano) via de tijdelijke link die deze route
 * meegeeft; het kopiëren zelf gaat daarna via media-vanaf-link met per bestand
 * de submap.
 *
 * Recursief: een fotograaf deelt vaak de map van de hele shoot, met submappen
 * per soort. Alleen lezen, niets schrijven, en geen blijvende deellinks — een
 * tijdelijke link verloopt na vier uur vanzelf.
 */
export async function POST(request: Request) {
  if (!isInternRequest(request)) {
    return NextResponse.json({ error: "niet_toegestaan" }, { status: 401 });
  }
  const body = (await request.json().catch(() => null)) as { link?: string } | null;
  const link = body?.link?.trim() ?? "";
  if (!/^https:\/\/(www\.)?dropbox\.com\/(scl\/f[io]|s|sh)\//.test(link)) {
    return NextResponse.json({ error: "dit is geen Dropbox-deellink" }, { status: 400 });
  }

  try {
    const token = await getSharedAccessToken();
    const inhoud = await leesDeellink(token, link);

    if (!inhoud.pad) {
      if (inhoud.soort === "folder") {
        return NextResponse.json(
          {
            error:
              "deze map staat in een ander Dropbox-account; daar kan alleen een zip van. Deel de bestanden los, of zet ze in een map in het WeGoGroen-Dropbox",
          },
          { status: 422 }
        );
      }
      // Een los bestand van buiten: de directe download is ook de leeslink.
      const los: Bestand = {
        naam: inhoud.naam,
        relatief: inhoud.naam,
        pad: null,
        grootte: null,
        link: BEELD.test(inhoud.naam) ? directeDownload(link) : null,
      };
      return NextResponse.json({ ok: true, soort: "extern", bestanden: [los] });
    }

    const bestanden: Bestand[] = [];
    if (inhoud.soort === "file") {
      bestanden.push({ naam: inhoud.naam, relatief: inhoud.naam, pad: inhoud.pad, grootte: null, link: null });
    } else {
      const basis = inhoud.pad.replace(/\/+$/, "");
      let res = await fetch(`${DROPBOX_API_BASE}/files/list_folder`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ path: basis, recursive: true, limit: 2000 }),
      });
      for (;;) {
        if (!res.ok) throw new Error(`Dropbox list_folder gaf ${res.status}: ${(await res.text()).slice(0, 200)}`);
        const data = (await res.json()) as {
          entries: { ".tag": string; name: string; size?: number; path_lower?: string; path_display?: string }[];
          cursor: string;
          has_more: boolean;
        };
        for (const e of data.entries) {
          if (e[".tag"] !== "file" || !e.path_lower) continue;
          const weergave = e.path_display ?? e.path_lower;
          bestanden.push({
            naam: e.name,
            relatief: weergave.slice(basis.length).replace(/^\/+/, ""),
            pad: e.path_lower,
            grootte: e.size ?? null,
            link: null,
          });
        }
        if (bestanden.length > MAX_BESTANDEN) {
          return NextResponse.json(
            { error: `meer dan ${MAX_BESTANDEN} bestanden in deze link — deel de shoot per adres` },
            { status: 422 }
          );
        }
        if (!data.has_more) break;
        res = await fetch(`${DROPBOX_API_BASE}/files/list_folder/continue`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ cursor: data.cursor }),
        });
      }
    }

    // Leeslinks in groepjes van acht: honderd foto's één voor één past niet in de minuut.
    const beeld = bestanden.filter((b) => b.pad && BEELD.test(b.naam));
    let volgende = 0;
    const werker = async () => {
      for (;;) {
        const b = beeld[volgende++];
        if (!b) return;
        b.link = await getTemporaryLink(token, b.pad as string).catch(() => null);
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, beeld.length) }, () => werker()));

    return NextResponse.json({ ok: true, soort: "account", bestanden });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message.slice(0, 300) : "de link kon niet worden gelezen" },
      { status: 502 }
    );
  }
}
