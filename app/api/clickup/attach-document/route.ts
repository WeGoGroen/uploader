import { NextResponse } from "next/server";
import { requireClickUpConfig } from "@/lib/clickup";
import { getActiveAccountName } from "@/lib/active-account";
import { attachOneDocument } from "@/lib/attachments";

// Downloaden uit Dropbox en uploaden naar ClickUp gaat bewust sequentieel
// (parallel gaf 500-fouten bij ClickUp), dus een categorie met veel foto's
// kost tijd. Met de 60s van voorheen paste dat niet in één aanroep en moest
// de client in stukjes hervatten; 300s haalt dat in één keer.
export const maxDuration = 300;

/**
 * Zet de bestanden van één documentcategorie (D2 t/m D5) over van Dropbox
 * naar ClickUp. Bewust apart van /create-task: zo kan de app na het
 * aanmaken van de taak per categorie een vinkje laten verschijnen i.p.v. één
 * lange, stille wachttijd te tonen.
 */
export async function POST(request: Request) {
  const body = (await request.json()) as {
    taskId?: string;
    docKey?: string;
    dropboxFolderPath?: string;
    /** Doorgaan vanaf dit bestand, als een vorige poging op tijd afgekapt is. */
    skip?: number;
    /** Alleen deze bestandsnamen — voor het herkansen van wat eerder mislukte. */
    only?: string[];
  };
  if (!body.taskId || !body.docKey || !body.dropboxFolderPath) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  let token: string;
  let listId: string;
  try {
    const activeAccount = await getActiveAccountName();
    ({ token, listId } = await requireClickUpConfig(activeAccount));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "ClickUp niet geconfigureerd" },
      { status: 500 }
    );
  }

  try {
    const result = await attachOneDocument(
      token,
      listId,
      body.taskId,
      body.dropboxFolderPath,
      body.docKey,
      { skip: body.skip, only: body.only }
    );
    return NextResponse.json(result);
  } catch (err) {
    console.error("Failed to attach document", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Overzetten naar ClickUp mislukt" },
      { status: 502 }
    );
  }
}
