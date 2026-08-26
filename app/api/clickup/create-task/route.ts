import { NextResponse } from "next/server";
import { createTask, requireClickUpConfig } from "@/lib/clickup";
import { getActiveAccountName } from "@/lib/active-account";
import { ensureProjectFolder } from "@/lib/dropbox";
import { getOptionalRedis } from "@/lib/redis";
import type { AddressDetails } from "@/lib/pdok";

// Zelfde labels als in ClickUp's eigen prioriteit-dropdown.
const PRIORITY_BY_LABEL: Record<string, number | null> = {
  Clear: null,
  Urgent: 1,
  High: 2,
  Normal: 3,
  Low: 4,
};

function formatAddressLine(details: AddressDetails): string {
  const houseNumber = [
    details.huisnummer,
    details.huisletter,
    details.huisnummertoevoeging,
  ]
    .filter(Boolean)
    .join(details.huisletter ? "" : "-");
  return `${details.straatnaam} ${houseNumber}`;
}

export async function POST(request: Request) {
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

  const body = (await request.json()) as {
    /** Id van de opname; maakt herhaald versturen veilig. */
    opnameId?: string;
    address?: AddressDetails;
    titel?: string;
    assigneeId?: number | null;
    priority?: string;
    status?: string;
    beschrijving?: string;
    customFields?: { id: string; value: string | number | boolean | string[] }[];
  };

  if (!body.address) {
    return NextResponse.json({ error: "missing_address" }, { status: 400 });
  }
  const address = body.address;

  const addressLine = formatAddressLine(address);
  const taskName =
    body.titel?.trim() || `${addressLine}, ${address.postcode} ${address.woonplaatsnaam}`;

  // Map eerst aanmaken (niet fataal als Dropbox niet is aangesloten), dan de
  // link meteen in de omschrijving zetten — dat scheelt een tweede API-call
  // om de taak achteraf te moeten bijwerken. De bijlages zelf (D2 t/m D5)
  // zet de client hierna per categorie apart over via /attach-document, zo
  // kan de taak snel klaarstaan en toont de app ondertussen voortgang.
  const dropboxFolder = await ensureProjectFolder(
    "energielabel",
    address.woonplaatsnaam,
    addressLine
  ).catch((err) => {
    console.error("Failed to ensure Dropbox folder", err);
    return null;
  });

  const descriptionLines = [
    `${addressLine}, ${address.postcode} ${address.woonplaatsnaam}`,
    address.bouwjaar !== null ? `Bouwjaar: ${address.bouwjaar} (BAG)` : null,
    `BAG-objectnummer: ${address.adresseerbaarobjectId}`,
    dropboxFolder ? `Dropbox-map: ${dropboxFolder.url}` : null,
    body.beschrijving?.trim() ? "" : null,
    body.beschrijving?.trim() ?? null,
  ].filter((line): line is string => line !== null);

  // Al eens verstuurd? Dan diezelfde taak teruggeven i.p.v. een tweede aan te
  // maken. Een dubbele tik, een herhaalde poging na een time-out of een
  // opnemer die op "opnieuw" drukt leverde anders twee taken voor hetzelfde
  // pand op — en dat merk je pas als iemand het dubbele werk doet.
  const redis = getOptionalRedis();
  const slot = body.opnameId ? `clickup:taak:${body.opnameId}` : null;
  if (redis && slot) {
    const eerder = await redis.get(slot).catch(() => null);
    if (eerder) {
      try {
        return NextResponse.json({ ...JSON.parse(eerder), hergebruikt: true });
      } catch {
        // Onleesbaar: gewoon opnieuw aanmaken.
      }
    }
  }

  try {
    const priority =
      body.priority && body.priority in PRIORITY_BY_LABEL
        ? PRIORITY_BY_LABEL[body.priority]
        : null;

    const task = await createTask(token, listId, {
      name: taskName,
      customFields: body.customFields ?? [],
      markdownDescription: descriptionLines.join("\n"),
      assignees: body.assigneeId ? [body.assigneeId] : undefined,
      priority,
      status: body.status,
    });

    const antwoord = {
      task,
      dropboxFolderUrl: dropboxFolder?.url ?? null,
      dropboxFolderPath: dropboxFolder?.path ?? null,
    };
    // Dertig dagen onthouden: ruim langer dan een opname openstaat, kort
    // genoeg om de opslag niet te laten volgroeien.
    if (redis && slot) {
      await redis.set(slot, JSON.stringify(antwoord), "EX", 30 * 24 * 60 * 60).catch(() => {});
    }
    return NextResponse.json(antwoord);
  } catch (err) {
    console.error("Failed to create ClickUp task", err);
    return NextResponse.json({ error: "create_task_failed" }, { status: 502 });
  }
}
