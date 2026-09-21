import { DROPBOX_API_BASE, DropboxApiError, ARCHIEF_MAP } from "@/lib/dropbox";
import { mapnaamPastBijAdres, parseProjectFolderName } from "@/lib/projectmap-match";

/**
 * Alle mappen die bij een adres zouden kunnen horen — en met opzet niet één.
 *
 * Hetzelfde adres bestaat op meerdere plekken tegelijk: in de automatie-map, in
 * het archief daaronder, en in de oude handmatige indeling per maand. Zelf de
 * "beste" kiezen is precies de fout die al eens gemaakt is: dan wordt een oude
 * map hergebruikt en komen de stukken van één opdracht in twee mappen terecht.
 * Deze zoeker verzamelt dus, en laat kiezen aan wie het weet.
 *
 * De tolerante naamvergelijking uit projectmap-match mag hier wél: dit levert
 * een voorstel op, geen beslissing. Bij het aanvullen van een map telt alleen
 * het id dat een mens heeft aangewezen.
 */

/** Waar projectmappen van energielabels kunnen staan, in volgorde van hoe
    waarschijnlijk het is dat je er moet zijn. Paden zijn relatief aan de
    Dropbox-app (die staat op /Info GoGroen). */
export const ENERGIELABEL_LOCATIES: { pad: string; herkomst: string; perMaand?: boolean }[] = [
  { pad: "/Automatie Energielabels", herkomst: "automatie" },
  { pad: `/Automatie Energielabels/${ARCHIEF_MAP}`, herkomst: "archief" },
  {
    // De oude, handmatige indeling: onder elke maand staan de adressen.
    pad: "/Certificering NL-EPBD/WeGoGroen/Energielabels/Intern (GoGroen)",
    herkomst: "intern",
    perMaand: true,
  },
  {
    pad: "/Certificering NL-EPBD/WeGoGroen/Energielabels/Archief projectdossiers",
    herkomst: "archief-oud",
    perMaand: true,
  },
];

export interface Kandidaat {
  pad: string;
  id: string;
  naam: string;
  herkomst: string;
  /** De nieuwste bestandsdatum in de map; mappen zelf hebben er geen. */
  laatstGewijzigd: string | null;
  /** Aantal bestanden dat bij het peilen gezien is — genoeg om een lege map
      van een gevulde te onderscheiden. */
  bestanden: number;
}

interface Regel {
  ".tag": string;
  id?: string;
  name?: string;
  path_display?: string;
  server_modified?: string;
}

async function lijst(accessToken: string, pad: string): Promise<Regel[]> {
  const uit: Regel[] = [];
  let cursor: string | null = null;
  for (;;) {
    const res: Response = await fetch(
      `${DROPBOX_API_BASE}/files/list_folder${cursor ? "/continue" : ""}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(cursor ? { cursor } : { path: pad, recursive: false }),
      }
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      // Een locatie die niet bestaat is geen storing: niet elke installatie
      // heeft elke map.
      if (res.status === 409 && body.includes("not_found")) return uit;
      throw new DropboxApiError(res.status, `Dropbox list_folder failed: ${res.status} ${body}`);
    }
    const data = (await res.json()) as { entries: Regel[]; cursor: string; has_more: boolean };
    uit.push(...data.entries);
    if (!data.has_more) return uit;
    cursor = data.cursor;
  }
}

/** Wanneer er voor het laatst iets in deze map gebeurd is, en hoeveel erin zit. */
async function peil(
  accessToken: string,
  pad: string
): Promise<{ laatstGewijzigd: string | null; bestanden: number }> {
  const regels = await lijst(accessToken, pad).catch(() => [] as Regel[]);
  const bestanden = regels.filter((r) => r[".tag"] === "file");
  const datums = bestanden.map((b) => b.server_modified).filter((d): d is string => Boolean(d));
  // Ook de submappen tellen mee voor "hier staat iets": een projectmap heeft
  // zijn inhoud meestal één niveau dieper.
  const submappen = regels.filter((r) => r[".tag"] === "folder").length;
  return {
    laatstGewijzigd: datums.sort().pop() ?? null,
    bestanden: bestanden.length + submappen,
  };
}

/**
 * Zoek de mappen die bij dit adres kunnen horen.
 *
 * `adres` is de mapnaam zoals hij eruit zou zien ("Van Eeghenstraat 12-1,
 * Amsterdam"); de vergelijking gebeurt op straat, huisnummer en woonplaats en
 * niet op de letterlijke tekst — de oude indeling schrijft dezelfde woning
 * soms anders op.
 */
export async function zoekKandidaten(
  accessToken: string,
  adres: string,
  maxPeilingen = 8
): Promise<Kandidaat[]> {
  const doel = parseProjectFolderName(adres);
  if (!doel) return [];

  const gevonden: Omit<Kandidaat, "laatstGewijzigd" | "bestanden">[] = [];

  for (const locatie of ENERGIELABEL_LOCATIES) {
    const bovenste = await lijst(accessToken, locatie.pad);

    const tussenmappen = locatie.perMaand
      ? bovenste.filter((r) => r[".tag"] === "folder").map((r) => r.path_display ?? "")
      : [locatie.pad];

    for (const tussen of tussenmappen) {
      if (!tussen) continue;
      // Bij de automatie-map is de bovenste lijst al de lijst met projecten;
      // bij de maandindeling moet er nog een niveau bij.
      const regels = locatie.perMaand ? await lijst(accessToken, tussen) : bovenste;
      for (const r of regels) {
        if (r[".tag"] !== "folder" || !r.name || !r.path_display) continue;
        // Het archief is zelf geen projectmap.
        if (r.name.toLowerCase() === ARCHIEF_MAP.toLowerCase()) continue;
        if (!mapnaamPastBijAdres(r.name, doel)) continue;
        gevonden.push({
          pad: r.path_display,
          id: r.id ?? "",
          naam: r.name,
          herkomst: locatie.herkomst,
        });
      }
    }
  }

  // Peilen kost per kandidaat een aanroep; bij een handvol is dat niets, bij
  // een adres dat overal voorkomt begrenzen we het.
  const uit: Kandidaat[] = [];
  for (const k of gevonden.slice(0, maxPeilingen)) {
    uit.push({ ...k, ...(await peil(accessToken, k.pad)) });
  }
  for (const k of gevonden.slice(maxPeilingen)) {
    uit.push({ ...k, laatstGewijzigd: null, bestanden: 0 });
  }
  return uit;
}
