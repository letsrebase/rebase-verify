// Regenerates share/practices.json from src/practices-rules.mjs: the published
// list of code-counted work practices and the path and command rules behind it.
// Run after any rule change: `npm run practices`. test/practices-artifact.test.mjs
// keeps it honest.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { practicesArtifact } from "../src/practices-rules.mjs";

const sortKeys = (v) =>
  Array.isArray(v)
    ? v.map(sortKeys)
    : v && typeof v === "object"
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]))
      : v;

const artifact = practicesArtifact();
writeFileSync(
  fileURLToPath(new URL("../share/practices.json", import.meta.url)),
  JSON.stringify(sortKeys(artifact), null, 2) + "\n",
);
console.log(`share/practices.json: ${artifact.practices.length} practices`);
