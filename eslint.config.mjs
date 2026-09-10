import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Het bouwresultaat van `vercel build`. Staat er alleen na een lokale
    // uitrol, maar dan wel met duizenden meldingen over gebundelde code die
    // niemand schrijft - en daaronder verdwijnen de twintig die over onze
    // eigen bestanden gaan.
    ".vercel/**",
  ]),
]);

export default eslintConfig;
