import Anthropic from "@anthropic-ai/sdk";
import { NextResponse } from "next/server";
import { getOptionalRedis } from "@/lib/redis";
import {
  overallVerdict,
  visualChecklist,
  type CheckResult,
  type CheckStatus,
} from "@/lib/dp-checks";
import { pointCloudVisualChecklist } from "@/lib/pointcloud-checks";

/**
 * Beoordeelt de visuele punten van de scanchecklist: de punten die je alleen
 * ziet door naar het top-downbeeld en de scanfoto's te kijken. De meetbare
 * punten zijn al in de browser gerekend (lib/dp-checks.ts) en komen hier mee
 * als context, zodat het model niet opnieuw gaat rekenen maar wel weet wat er
 * uit de metingen kwam.
 *
 * De zware data blijft buiten deze route: het .dp-bestand van honderden MB's
 * wordt in de browser uitgelezen, hier komt alleen een render van ~200 KB en
 * een handvol verkleinde foto's binnen.
 */

export const maxDuration = 60;

const MODEL = "claude-opus-5";

/**
 * Het model levert zijn oordeel via een tool, zodat de uitkomst gegarandeerd
 * de juiste vorm heeft en we niet op tekst hoeven te parsen.
 */
const BEOORDELING_TOOL: Anthropic.Tool = {
  name: "leg_beoordeling_vast",
  description:
    "Leg per checklistpunt het oordeel vast. Geef voor elk punt uit de checklist precies één resultaat.",
  input_schema: {
    type: "object",
    properties: {
      punten: {
        type: "array",
        description: "Eén item per checklistpunt, in dezelfde volgorde als aangeleverd.",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "Het id van het checklistpunt." },
            status: {
              type: "string",
              enum: ["ok", "twijfel", "afkeuren", "onbekend"],
              description:
                "ok = voldoet; twijfel = een mens moet kijken; afkeuren = zo niet doorsturen; onbekend = op dit beeld niet te beoordelen.",
            },
            toelichting: {
              type: "string",
              description:
                "Eén of twee zinnen, concreet en verwijzend naar wat je in het beeld ziet. Geen algemeenheden.",
            },
          },
          required: ["id", "status", "toelichting"],
          additionalProperties: false,
        },
      },
      aandachtsplekken: {
        type: "array",
        description:
          "Plekken waar mogelijk iets mis is, aangeduid met de rastercel waarin ze liggen. Laat leeg als je niets ziet. Maximaal zes per verdieping; noem alleen wat er echt uitspringt.",
        items: {
          type: "object",
          properties: {
            bouwlaag: { type: "integer", description: "Nummer van de verdieping, 1 is de onderste." },
            cel: { type: "string", description: "Rastercel, bijvoorbeeld \"C4\": kolomletter plus rijnummer." },
            reden: { type: "string", description: "In een halve zin: wat is hier aan de hand." },
          },
          required: ["bouwlaag", "cel", "reden"],
          additionalProperties: false,
        },
      },
    },
    required: ["punten", "aandachtsplekken"],
    additionalProperties: false,
  },
  strict: true,
};

const SYSTEEM_SCANPAD = `Je beoordeelt 3D-scans van woningen die als basis dienen voor een NEN2580-plattegrond. De scans worden met een iPad en Dot3D gemaakt en gaan daarna naar Mediatask, die er de plattegrond van tekent.

Je krijgt twee dingen te zien:
1. Een top-downrender van het scanpad. Dit is géén puntenwolk en géén plattegrond. De gekleurde lijn is de route die de opnemer liep, gekleurd op hoogte (blauw laag, oranje hoog), met start- en eindpunt gemarkeerd. Het lichte groene vlak is het gebied binnen 2,5 m van die route: een ondergrens van wat gescand is, want we weten niet waar de muren staan. Er staat een raster van 1 meter bij en een schaalbalk.
2. Een greep uit de foto's die tijdens de scan zijn gemaakt, verspreid over de opname.

Belangrijk: dit is een RAW-scan, vóór de optimalisatiestap in Dot3D. Juist die stap trekt de opgebouwde drift recht. Lussen die niet precies sluiten en een pad dat langzaam wegdraait zijn in dit stadium dus normaal en géén reden tot afkeuren. Beoordeel op grove zaken: is er een heel gebied waar de opnemer niet is geweest, ligt het eindpunt ver van het startpunt, zijn er sprongen in de route, en wat laten de foto's zien.

Oordeel alleen over wat je daadwerkelijk ziet. Kun je een punt op dit beeld niet beoordelen, kies dan "onbekend" — dat is nuttiger dan een gok, en bij dit type render zal dat regelmatig het geval zijn. Wees streng waar het de bruikbaarheid voor maatvoering raakt en mild waar het cosmetisch is.

Schrijf in het Nederlands, in gewone zinnen, gericht aan de opnemer die de scan gemaakt heeft.`;

const SYSTEEM_PUNTENWOLK = `Je beoordeelt de geoptimaliseerde 3D-scan van een woning die als basis dient voor een NEN2580-plattegrond. De scan is met een iPad gemaakt en gaat daarna naar Mediatask, die er de plattegrond van tekent.

Je krijgt de scan van bovenaf te zien: eerst het hele pand, daarna elke verdieping apart van beneden naar boven. Het zijn geen tekeningen maar de puntenwolk zelf, recht van boven bekeken, waarbij per beeldpunt het hoogste punt wint — dezelfde weergave die de opnemer in Dot3D ziet. Je kijkt dus neer op de vloeren en het meubilair, en de muren tekenen zich af als de randen daartussen. Alle beelden staan op dezelfde schaal en positie, met een raster van 1 meter en een schaalbalk.

Hoe je dit leest:
- Een gezond pand toont aaneengesloten vloervlakken per kamer, gescheiden door smalle randen: dat zijn de muren.
- Een kamer die helemaal ontbreekt laat een leeg gat achter binnen de omtrek van het pand.
- Onderbrekingen ter grootte van een deur zijn normaal; een muur die over meters wegvalt niet.
- Losse vlekken bínnen kamers zijn meubels en geen probleem.
- Punten búiten de buitenmuren komen meestal van ramen, spiegels of een buitenruimte die is meegescand.
- Dezelfde ruimte twee keer, verschoven over zichzelf heen: dat is drift, en dat is ernstig.

Over elke plattegrond ligt een raster: kolommen A, B, C… van links naar rechts, rijen 1, 2, 3… van boven naar beneden. Zie je een plek waar mogelijk iets mis is, noem dan de cel waarin die ligt. Wij zetten daar een rode cirkel, zodat de opnemer meteen weet waar hij moet kijken. Wijs alleen aan wat er echt uitspringt — een handvol cirkels helpt, twintig maakt het beeld onleesbaar. Zie je niets bijzonders, laat de lijst dan leeg; dat is een prima uitkomst.

Oordeel alleen over wat je daadwerkelijk ziet. Kun je een punt niet beoordelen, kies dan "onbekend" — dat is nuttiger dan een gok. Wees streng waar het de bruikbaarheid voor maatvoering raakt en mild waar het cosmetisch is.

Schrijf in het Nederlands, in gewone zinnen, gericht aan de opnemer die de scan gemaakt heeft.`;

interface RequestBody {
  fileName?: string;
  address?: string;
  /**
   * Welk soort scan beoordeeld wordt. "pointcloud" is de geoptimaliseerde
   * export met echte plattegronden, "dp" de ruwe Dot3D-scan met alleen het
   * scanpad. Ze hebben elk hun eigen checklist en eigen uitleg aan het model.
   */
  kind?: "dp" | "pointcloud";
  /** Eén of meer renders als data-URL (PNG); bij een puntenwolk één per bouwlaag. */
  render?: string;
  renders?: string[];
  /** Verkleinde scanfoto's als data-URL (JPEG). */
  photos?: string[];
  /** Uitkomsten van de meetbare controles, als context. */
  measurements?: CheckResult[];
  /** Kerncijfers uit de scan, als context. */
  facts?: Record<string, string | number | null>;
}

function toImageBlock(dataUrl: string): Anthropic.ImageBlockParam | null {
  const m = /^data:(image\/(?:png|jpeg));base64,(.+)$/.exec(dataUrl);
  if (!m) return null;
  return {
    type: "image",
    source: { type: "base64", media_type: m[1] as "image/png" | "image/jpeg", data: m[2] },
  };
}

export async function POST(request: Request) {
  const body = (await request.json()) as RequestBody;
  if (!body.render && !body.renders?.length) {
    return NextResponse.json({ error: "Geen render meegestuurd" }, { status: 400 });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json(
      {
        error:
          "Geen ANTHROPIC_API_KEY ingesteld. Zet die in Vercel onder Settings > Environment Variables; tot die tijd blijven alleen de meetbare controles werken.",
      },
      { status: 503 }
    );
  }

  const renders = (body.renders ?? [body.render])
    .filter((r): r is string => typeof r === "string")
    .map(toImageBlock)
    .filter((b): b is Anthropic.ImageBlockParam => b !== null);
  if (renders.length === 0) {
    return NextResponse.json({ error: "Render is geen geldige afbeelding" }, { status: 400 });
  }
  const photos = (body.photos ?? [])
    .map(toImageBlock)
    .filter((b): b is Anthropic.ImageBlockParam => b !== null);

  const isPointCloud = body.kind === "pointcloud";
  const checklist = isPointCloud ? pointCloudVisualChecklist() : visualChecklist();
  const content: Anthropic.ContentBlockParam[] = [
    {
      type: "text",
      text: [
        `Adres: ${body.address ?? "onbekend"}`,
        `Bestand: ${body.fileName ?? "onbekend"}`,
        "",
        "Kerncijfers uit de scan:",
        ...Object.entries(body.facts ?? {}).map(([k, v]) => `- ${k}: ${v ?? "onbekend"}`),
        "",
        "Uitkomsten van de meetbare controles:",
        ...(body.measurements ?? []).map((r) => `- ${r.id}: ${r.status} — ${r.toelichting}`),
      ].join("\n"),
    },
    {
      type: "text",
      text: isPointCloud
        ? `Bovenaanzichten (${renders.length}): eerst de hele scan, daarna elke verdieping apart van beneden naar boven:`
        : "Top-downrender van het scanpad:",
    },
    ...renders,
  ];

  if (photos.length > 0) {
    content.push({ type: "text", text: `Foto's uit de scan (${photos.length} van de opname):` });
    content.push(...photos);
  }


  content.push({
    type: "text",
    text: [
      "Beoordeel deze punten, één resultaat per punt:",
      ...checklist.map((item) => `- ${item.id} — ${item.titel}\n  ${item.vraag}\n  (eis: ${item.bron_gids})`),
    ].join("\n"),
  });

  const client = new Anthropic();
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 8000,
      thinking: { type: "adaptive" },
      system: isPointCloud ? SYSTEEM_PUNTENWOLK : SYSTEEM_SCANPAD,
      tools: [BEOORDELING_TOOL],
      tool_choice: { type: "tool", name: BEOORDELING_TOOL.name },
      messages: [{ role: "user", content }],
    });

    if (response.stop_reason === "refusal") {
      return NextResponse.json({ error: "Beoordeling geweigerd door het model" }, { status: 502 });
    }

    const toolUse = response.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
    );
    if (!toolUse) {
      return NextResponse.json({ error: "Model leverde geen beoordeling" }, { status: 502 });
    }

    const parsed = toolUse.input as {
      punten: CheckResult[];
      aandachtsplekken?: { bouwlaag: number; cel: string; reden: string }[];
    };
    // Alleen punten die echt in de checklist staan; een verzonnen id filteren we weg.
    const geldig = new Set(checklist.map((i) => i.id));
    const visual = parsed.punten.filter((p) => geldig.has(p.id));

    const alles = [...(body.measurements ?? []), ...visual];
    const oordeel: CheckStatus = overallVerdict(alles);

    await bewaarVoorDataset({
      fileName: body.fileName,
      address: body.address,
      facts: body.facts,
      measurements: body.measurements ?? [],
      visual,
      oordeel,
      aandachtsplekken: parsed.aandachtsplekken ?? [],
      tokens: response.usage.input_tokens + response.usage.output_tokens,
    });

    return NextResponse.json({
      visual,
      aandachtsplekken: parsed.aandachtsplekken ?? [],
      oordeel,
    });
  } catch (err) {
    console.error("Scanbeoordeling mislukt", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Beoordeling mislukt" },
      { status: 502 }
    );
  }
}

/**
 * Legt elke beoordeling vast. Dit is de dataset waar het later trainen op
 * afgekeurde scans van moet komen: zonder vanaf de eerste scan mee te schrijven
 * is er over een half jaar niets om op terug te kijken. Correcties van een
 * teamlid komen er later bij via een apart endpoint.
 *
 * Mislukt het wegschrijven, dan blokkeert dat de beoordeling niet — het oordeel
 * is voor de opnemer belangrijker dan de opslag.
 */
async function bewaarVoorDataset(record: Record<string, unknown>) {
  const redis = getOptionalRedis();
  if (!redis) return;
  try {
    const key = `scan-check:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    await redis.set(key, JSON.stringify({ ...record, opgeslagenOp: new Date().toISOString() }));
    await redis.lpush("scan-check:index", key);
    await redis.ltrim("scan-check:index", 0, 4999);
  } catch (err) {
    console.error("Beoordeling niet opgeslagen", err);
  }
}
