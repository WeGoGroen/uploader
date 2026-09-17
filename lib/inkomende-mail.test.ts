import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { handtekeningKlopt, leesHandtekening, vanRvo } from "@/lib/inkomende-mail";

/**
 * Deze route staat buiten de inlog. De handtekening is het enige wat tussen het
 * open internet en een bestand in de projectmap van een klant staat, dus elke
 * manier om er langs te komen hoort hier vast te liggen.
 */

const GEHEIM = `whsec_${Buffer.from("een-geheim-van-voldoende-lengte").toString("base64")}`;

function onderteken(body: string, opties: { id?: string; timestamp?: string; geheim?: string } = {}) {
  const id = opties.id ?? "msg_1";
  const timestamp = opties.timestamp ?? String(Math.floor(Date.now() / 1000));
  const sleutel = Buffer.from((opties.geheim ?? GEHEIM).replace(/^whsec_/, ""), "base64");
  const sig = crypto.createHmac("sha256", sleutel).update(`${id}.${timestamp}.${body}`).digest("base64");
  return { id, timestamp, signature: `v1,${sig}` };
}

describe("handtekeningKlopt", () => {
  const body = JSON.stringify({ type: "email.received", data: { email_id: "abc" } });

  it("laat een mail van Resend door", () => {
    expect(handtekeningKlopt(GEHEIM, body, onderteken(body))).toBe(true);
  });

  it("weigert een body die onderweg veranderd is", () => {
    const kop = onderteken(body);
    expect(handtekeningKlopt(GEHEIM, `${body} `, kop)).toBe(false);
  });

  it("weigert een handtekening die met een ander geheim is gezet", () => {
    const ander = `whsec_${Buffer.from("een-heel-ander-geheim-hier-dan").toString("base64")}`;
    expect(handtekeningKlopt(GEHEIM, body, onderteken(body, { geheim: ander }))).toBe(false);
  });

  it("weigert een verzoek van een uur oud, ook met een geldige handtekening", () => {
    // Anders kan wie één verzoek onderschept het uren later blijven herhalen.
    const timestamp = String(Math.floor(Date.now() / 1000) - 3600);
    expect(handtekeningKlopt(GEHEIM, body, onderteken(body, { timestamp }))).toBe(false);
  });

  it("weigert een verzoek zonder kopregels", () => {
    expect(handtekeningKlopt(GEHEIM, body, { id: null, timestamp: null, signature: null })).toBe(false);
  });

  it("accepteert één geldige handtekening tussen meerdere", () => {
    // Tijdens het wisselen van geheim ondertekent Resend met allebei.
    const echt = onderteken(body);
    const kop = { ...echt, signature: `v1,rommel ${echt.signature}` };
    expect(handtekeningKlopt(GEHEIM, body, kop)).toBe(true);
  });

  it("doet niets zonder geheim, ook niet met een lege handtekening", () => {
    expect(handtekeningKlopt("", body, onderteken(body))).toBe(false);
  });
});

describe("leesHandtekening", () => {
  it("leest zowel de svix- als de webhook-kopregels", () => {
    const svix = new Headers({ "svix-id": "a", "svix-timestamp": "1", "svix-signature": "v1,x" });
    expect(leesHandtekening(svix)).toEqual({ id: "a", timestamp: "1", signature: "v1,x" });

    const nieuw = new Headers({ "webhook-id": "b", "webhook-timestamp": "2", "webhook-signature": "v1,y" });
    expect(leesHandtekening(nieuw)).toEqual({ id: "b", timestamp: "2", signature: "v1,y" });
  });
});

describe("vanRvo", () => {
  it("herkent de afzender van het afschrift", () => {
    expect(vanRvo("noreply_eponline@rvo.nl")).toBe(true);
    expect(vanRvo("Rijksdienst voor Ondernemend Nederland <noreply_eponline@rvo.nl>")).toBe(true);
  });

  it("laat alles van buiten RVO met rust", () => {
    expect(vanRvo("iemand@gmail.com")).toBe(false);
    expect(vanRvo("nep@rvo.nl.example.com")).toBe(false);
    expect(vanRvo(null)).toBe(false);
  });
});
