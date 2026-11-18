// Regenerates the two checked-in technology artifacts from the live source:
//
// - share/tech-lexicon.json, from TECH_LEXICON in src/groundedness.mjs. It is
//   the cross-repo contract the play-new-dashboard intake vendors verbatim so
//   both sides extract identical tech anchors.
// - share/tech-labels.json, from labelVocabulary() in src/digest.mjs: every
//   label the stack detection can emit, which is what a name in techUsage must
//   be. The rebase hub vendors it verbatim and drops a techUsage row whose name
//   is not in its copy.
//
// Run after any change to the digest label maps or the hardcoded
// TECH_NAMES/stoplist: `npm run lexicon`. test/lexicon-artifact.test.mjs keeps
// both honest.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TECH_LEXICON } from "../src/groundedness.mjs";
import { labelVocabulary } from "../src/digest.mjs";

const write = (name, artifact) =>
  writeFileSync(fileURLToPath(new URL(`../share/${name}`, import.meta.url)), JSON.stringify(artifact, null, 2) + "\n");

const lexicon = {
  $comment:
    "GENERATED — do not edit by hand. Source: src/groundedness.mjs TECH_LEXICON (TECH_NAMES + digest labelVocabulary(), splitTech-tokenised, stoplist-filtered). Regenerate with `npm run lexicon`. Vendored verbatim by play-new-dashboard (src/lib/apply-tech-lexicon.json) so the intake recompute extracts the same tech anchors.",
  tokens: [...TECH_LEXICON].sort(),
};
write("tech-lexicon.json", lexicon);
console.log(`share/tech-lexicon.json: ${lexicon.tokens.length} tokens`);

const labels = {
  $comment:
    "GENERATED — do not edit by hand. Source: src/digest.mjs labelVocabulary(), every technology label the stack detection can emit, sorted. Regenerate with `npm run lexicon`. Vendored verbatim by the rebase hub (projects/hub/packages/core/src/rebase_core/work_profiles/tech-labels.json), whose intake keeps a techUsage row only when its name is one of these.",
  labels: sortedLabels(),
};
write("tech-labels.json", labels);
console.log(`share/tech-labels.json: ${labels.labels.length} labels`);

// The test sorts the same way; `localeCompare` with a fixed locale keeps the
// order identical on every machine.
function sortedLabels() {
  return [...labelVocabulary()].sort((a, b) => a.localeCompare(b, "en"));
}
