import { NextResponse } from "next/server";
import { isInternRequest } from "@/lib/intern-auth";
import { detailProjectFolders, getSharedAccessToken } from "@/lib/dropbox";

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
 */
const HOOFDMAPPEN = ["/Automatie Energielabels", "/Automatie NEN2580", "/Automatie Media"];

export async function GET(request: Request) {
  if (!isInternRequest(request)) {
    return NextResponse.json({ error: "niet_toegestaan" }, { status: 401 });
  }

  const token = await getSharedAccessToken();
  const mappen = await Promise.all(
    HOOFDMAPPEN.map(async (root) => {
      try {
        const { folders, volledig } = await detailProjectFolders(token, root);
        return { root, volledig, projecten: folders, fout: null as string | null };
      } catch (err) {
        return {
          root,
          volledig: false,
          projecten: [],
          fout: err instanceof Error ? err.message.slice(0, 200) : "onbekende fout",
        };
      }
    })
  );

  return NextResponse.json({ gemetenOp: new Date().toISOString(), mappen });
}
