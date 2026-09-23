/**
 * Vraagt uploadlinks op in groepjes in plaats van per bestand.
 *
 * Een fotoserie komt in één tik binnen: twintig bestanden die elk eerst een
 * eigen ronde browser → server → Dropbox deden voordat er ook maar één byte
 * omhoog ging. Op een mobiele verbinding is dat twintig keer de volle
 * heen-en-weer-tijd, in serie met het echte werk. Door heel even te wachten
 * (VERZAMEL_MS) gaan ze samen in één aanvraag: één ronde voor de hele serie.
 *
 * Bewust geen cache van links: ze zijn kortlopend en gelden per pad. Wat hier
 * bespaard wordt is het aantal rondes, niet het aantal links.
 */

import { tijdslimiet } from "@/lib/tijdslimiet";

/** Zo lang wachten we op meer bestanden uit dezelfde tik. Kort genoeg om niet
    te voelen, lang genoeg om een serie bij elkaar te krijgen. */
const VERZAMEL_MS = 40;
/** Zelfde grens als de route aanhoudt. */
const MAX_PER_AANVRAAG = 25;
/** De aanvraag zelf is een klein JSON-verzoek; duurt dat langer dan dit, dan
    is er iets mis en gaan we liever via onze server verder. */
const TIMEOUT_MS = 20_000;

interface Wachtend {
  path: string;
  klaar: (link: string | null) => void;
}

let wachtend: Wachtend[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

/**
 * Geeft een uploadlink voor dit pad, of null als die er niet kwam. Null is
 * geen uitzondering maar een antwoord: de aanroeper valt dan terug op de
 * route via onze server.
 */
export function vraagUploadLink(path: string): Promise<string | null> {
  return new Promise((klaar) => {
    wachtend.push({ path, klaar });
    if (wachtend.length >= MAX_PER_AANVRAAG) {
      void verstuur();
      return;
    }
    timer ??= setTimeout(() => void verstuur(), VERZAMEL_MS);
  });
}

async function verstuur(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  const groep = wachtend.slice(0, MAX_PER_AANVRAAG);
  wachtend = wachtend.slice(MAX_PER_AANVRAAG);
  if (groep.length === 0) return;
  // Zat er meer dan één groep klaar, dan gaat de rest meteen achteraan.
  if (wachtend.length > 0) timer ??= setTimeout(() => void verstuur(), 0);

  try {
    const res = await fetch("/api/dropbox/upload-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: groep.map((g) => g.path) }),
      signal: tijdslimiet(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`upload-link gaf ${res.status}`);
    const data = (await res.json()) as { links?: Record<string, string | null> };
    for (const g of groep) g.klaar(data.links?.[g.path] ?? null);
  } catch {
    for (const g of groep) g.klaar(null);
  }
}
