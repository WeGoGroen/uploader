#!/usr/bin/env node
/**
 * Zet een nieuw Bijlage G-sjabloon om naar lib/bijlage-g-sjabloon.ts.
 *
 * Gebruik:
 *   node scripts/bijlage-g-inlezen.mjs <pad-naar-xlsx>
 *
 * Nodig omdat het sjabloon als tekst in de code staat en niet als los bestand:
 * een bestand naast de code overleeft de bundeling naar een serverless-functie
 * niet betrouwbaar. Bij een nieuwe ISSO-versie draai je dit, commit je het
 * resultaat en rol je uit.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const bron = process.argv[2];
if (!bron) {
  console.error("Gebruik: node scripts/bijlage-g-inlezen.mjs <pad-naar-xlsx>");
  process.exit(1);
}

const ruw = readFileSync(bron);
const b64 = ruw.toString("base64");
const regels = b64.match(/.{1,100}/g) ?? [];
const doel = join(ROOT, "lib/bijlage-g-sjabloon.ts");
const oud = readFileSync(doel, "utf8");
const kop = oud.slice(0, oud.indexOf("const INHOUD_BASE64 = [\n") + "const INHOUD_BASE64 = [\n".length);
const staart = oud.slice(oud.indexOf("].join(\"\");"));
writeFileSync(doel, kop + regels.map((r) => `  "${r}",\n`).join("") + staart);
console.log(`${doel} bijgewerkt — ${ruw.length} bytes, ${regels.length} regels.`);
