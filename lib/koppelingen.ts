import { getOptionalRedis, requireRedis } from "@/lib/redis";

/**
 * Welke koppelingen bewust uitstaan.
 *
 * Zonder dit onderscheid meldt de statuscontrole een dienst die je helemaal
 * niet gebruikt als storing: ClickUp hoort bij energielabels, en wie alleen
 * NEN2580 en media doet heeft er geen token voor. Dat leverde elke ronde
 * dezelfde rode melding op — en een storingslijst die altijd rood staat leert
 * iedereen om er niet meer naar te kijken. Precies het tegenovergestelde van
 * wat een storingslijst hoort te doen.
 *
 * Uitgezet is dus iets anders dan kapot: er wordt niet meer gemeten, en in het
 * statusmenu staat een gedoofd streepje in plaats van een rode driehoek.
 */

const KEY = "koppelingen:uit";

/** Wat er uitgezet kan worden. Voorlopig alleen ClickUp — dat is de koppeling
    die aan één dienst hangt (energielabels) en dus bij het ene team wel en bij
    het andere niet nodig is. Komt er een tweede bij, dan hoort hij hier. */
export const UITZETBAAR = ["clickup"] as const;
export type Koppeling = (typeof UITZETBAAR)[number];

export function isKoppeling(waarde: string): waarde is Koppeling {
  return (UITZETBAAR as readonly string[]).includes(waarde);
}

/**
 * Zonder Redis staat alles gewoon aan. Dat is de veilige kant: een ontbrekende
 * opslag hoort niet stilletjes je koppelingen uit te zetten.
 */
export async function haalUitgezet(): Promise<Koppeling[]> {
  const redis = getOptionalRedis();
  if (!redis) return [];
  try {
    const ruw = await redis.get(KEY);
    if (!ruw) return [];
    const lijst = JSON.parse(ruw) as unknown;
    if (!Array.isArray(lijst)) return [];
    return lijst.filter((d): d is Koppeling => typeof d === "string" && isKoppeling(d));
  } catch {
    return [];
  }
}

export async function staatUit(dienst: Koppeling): Promise<boolean> {
  return (await haalUitgezet()).includes(dienst);
}

export async function zetKoppeling(dienst: Koppeling, uit: boolean): Promise<Koppeling[]> {
  const redis = requireRedis();
  const huidig = await haalUitgezet();
  const nieuw = uit
    ? [...new Set([...huidig, dienst])]
    : huidig.filter((d) => d !== dienst);
  await redis.set(KEY, JSON.stringify(nieuw));
  return nieuw;
}
