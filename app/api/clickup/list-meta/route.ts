import { NextResponse } from "next/server";
import {
  getAuthorizedUser,
  getListCustomFields,
  getListMembers,
  getListStatuses,
  requireClickUpConfig,
} from "@/lib/clickup";
import { getActiveAccountName } from "@/lib/active-account";

// "Created" is een automatisch systeemveld, geen input. Attachment-velden
// (foto's, documenten) kunnen pas geüpload worden nadat de taak bestaat, dus
// die horen niet in het aanmaakformulier.
const EXCLUDED_TYPES = new Set(["date", "attachment"]);

/**
 * Haalt de actuele structuur van de ClickUp List live op: geen kopie in de
 * code, dus een nieuw veld of een gewijzigde dropdown-optie in ClickUp
 * verschijnt hier vanzelf bij de volgende paginalaad.
 */
export async function GET() {
  let token: string;
  let listId: string;
  let accountName: string;
  try {
    const activeAccount = await getActiveAccountName();
    ({ token, listId, accountName } = await requireClickUpConfig(activeAccount));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "ClickUp niet geconfigureerd" },
      { status: 500 }
    );
  }

  try {
    const [user, allFields, members, statuses] = await Promise.all([
      getAuthorizedUser(token),
      getListCustomFields(token, listId),
      getListMembers(token, listId),
      getListStatuses(token, listId),
    ]);

    const fields = allFields.filter((f) => !EXCLUDED_TYPES.has(f.type));

    return NextResponse.json({
      account: { id: user.id, username: user.username, configName: accountName },
      fields,
      members,
      statuses,
    });
  } catch (err) {
    console.error("Failed to load ClickUp list metadata", err);
    return NextResponse.json(
      { error: "Kon ClickUp niet bereiken. Klopt het token nog?" },
      { status: 502 }
    );
  }
}
