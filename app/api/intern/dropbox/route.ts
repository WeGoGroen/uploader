import { NextResponse } from "next/server";
import { isInternRequest } from "@/lib/intern-auth";
import { getFolderStatuses, statusVeld } from "@/lib/dropbox";
import { haalDropboxStand } from "@/lib/dropbox-stand";

export const maxDuration = 60;

/**
 * Per projectmap hoeveel bestanden erin staan én hoe die over de submappen
 * verdeeld zijn, voor alle drie de hoofdmappen. Het control center gebruikt dit
 * om per opdracht te bepalen of er al iets geupload is, en of de set compleet
 * is: "31 bestanden" zegt niet of de plattegronden erbij zitten.
 *
 * Eén recursieve listing per hoofdmap in plaats van een aanroep per adres:
 * bij 1000 opdrachten per maand zouden dat 1000 Dropbox-verzoeken zijn, en
 * Dropbox knijpt daar hard op af. Nu is het drie verzoeken, ongeacht hoeveel
 * opdrachten er lopen — dat is het verschil tussen een sync die meegroeit en
 * eentje die stukloopt zodra het bedrijf verdubbelt.
 *
 * Die listing duurt inmiddels een halve minuut en wordt daarom bewaard en op
 * de achtergrond ververst; zie lib/dropbox-stand.ts. `gemetenOp` is wanneer
 * de listing gemaakt is, niet wanneer je hem opvroeg. `?vers=1` wacht op een
 * nieuwe.
 */
export async function GET(request: Request) {
  if (!isInternRequest(request)) {
    return NextResponse.json({ error: "niet_toegestaan" }, { status: 401 });
  }

  const vers = new URL(request.url).searchParams.get("vers") === "1";
  // De overdrachtsstatus per projectmap leeft in Redis (kaal pad in kleine
  // letters), niet meer in de mapnaam — zie lib/dropbox.ts. Die lezen we elke
  // keer vers: hij verandert los van de listing en kost een enkele Redis-vraag.
  const [stand, statussen] = await Promise.all([haalDropboxStand({ vers }), getFolderStatuses()]);

  const mappen = stand.mappen.map((m) => ({
    ...m,
    // De statussleutel hangt aan de hoofdmap, niet aan de map waar het
    // project toevallig ligt: een gearchiveerd project houdt zo zijn
    // status. Zie statusVeld() in lib/dropbox.ts.
    projecten: m.projecten.map((f) => ({
      ...f,
      sharepoint: statussen[statusVeld(m.root, f.name)] ?? null,
    })),
  }));

  return NextResponse.json({ gemetenOp: stand.gemetenOp, mappen });
}
