import Anthropic from "@anthropic-ai/sdk";

/**
 * Vertaalt de opmerking van de opnemer naar het Engels voor de verwerker bij
 * Mediatask; die leest geen Nederlands. Engelse tekst komt ongewijzigd terug.
 *
 * Lukt het vertalen niet (geen sleutel, model onbereikbaar, weigering), dan
 * gaat de oorspronkelijke tekst mee: een Nederlandse opmerking is beter dan
 * geen opmerking, en de order mag hier nooit op vastlopen.
 */

// Hetzelfde model als de scancontrole: daarvan weten we dat het met onze
// sleutel werkt.
const MODEL = "claude-opus-5";

const SYSTEEM = `You translate short notes written by a Dutch building surveyor into English, for the draughtsman who turns the 3D scan into a floor plan.

Rules:
- If the note is already in English, return it exactly as written.
- Otherwise translate it into clear, plain English. Keep the meaning, keep it short, keep line breaks.
- Keep room names, floor numbers, measurements, addresses and names exactly as they are.
- Return only the note itself: no quotes, no explanation, no preface.`;

export async function vertaalOpmerking(tekst: string): Promise<string> {
  const schoon = tekst.trim();
  if (!schoon) return "";
  if (!process.env.ANTHROPIC_API_KEY) return schoon;

  try {
    const client = new Anthropic();
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 2000,
      system: SYSTEEM,
      messages: [{ role: "user", content: schoon }],
    });
    if (response.stop_reason === "refusal") return schoon;
    const vertaald = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();
    return vertaald || schoon;
  } catch (err) {
    console.error("Opmerking vertalen mislukt; de oorspronkelijke tekst gaat mee", err);
    return schoon;
  }
}
