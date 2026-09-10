import { NextResponse } from "next/server";
import { isInternRequest } from "@/lib/intern-auth";
import { archiveerProjectmappen, getSharedAccessToken } from "@/lib/dropbox";

export const maxDuration = 300;

/** De hoofdmappen die een archief mogen krijgen. Een pad dat hier niet onder
    valt wordt geweigerd: verplaatsen is niet iets om op goed vertrouwen te doen. */
const TOEGESTANE_ROOTS = [
  "/Automatie Energielabels",
  "/Automatie NEN2580",
  "/Automatie Media",
];

/**
 * Zet afgeronde projectmappen in "Afgerond" onder dezelfde hoofdmap.
 *
 * De hoofdmap hoort te laten zien waar nog aan gewerkt wordt; met een paar
 * honderd afgeronde adressen ertussen is dat niet meer te lezen. Welke mappen
 * afgerond zijn weet het control center (fase "geleverd"), dus dat stuurt de
 * lijst mee — deze app weet alleen hoe Dropbox werkt.
 */
export async function POST(request: Request) {
  if (!isInternRequest(request)) {
    return NextResponse.json({ error: "niet_toegestaan" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as
    | { root?: string; mappen?: string[]; droog?: boolean }
    | null;

  const root = body?.root?.replace(/\/+$/, "") ?? "";
  if (!TOEGESTANE_ROOTS.includes(root)) {
    return NextResponse.json(
      { error: `root moet een van ${TOEGESTANE_ROOTS.join(", ")} zijn` },
      { status: 400 }
    );
  }

  const mappen = (body?.mappen ?? []).filter((m) => typeof m === "string" && m.startsWith(`${root}/`));
  if (mappen.length === 0) {
    return NextResponse.json({ error: "geen mappen onder deze hoofdmap meegestuurd" }, { status: 400 });
  }

  try {
    const token = await getSharedAccessToken();
    const uitkomst = await archiveerProjectmappen(token, root, mappen, { droog: body?.droog === true });
    return NextResponse.json({ ok: uitkomst.mislukt.length === 0, ...uitkomst });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message.slice(0, 300) : "onbekende fout" },
      { status: 502 }
    );
  }
}
