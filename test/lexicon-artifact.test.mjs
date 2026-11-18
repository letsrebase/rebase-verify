// The checked-in technology artifacts are cross-repo contracts.
// share/tech-lexicon.json: play-new-dashboard vendors it verbatim so its intake
// groundedness recompute extracts the same tech anchors this repo's client
// does. A digest label-map change that isn't regenerated into the artifact
// would silently drift the two implementations apart — the exact failure mode
// the intake's claimed-vs-recomputed delta flag then blames on the candidate.
// share/tech-labels.json: the rebase hub vendors it verbatim and keeps a
// techUsage row only when its name is in it, so a label the detection learns
// must reach the artifact before the hub can copy it. These tests turn either
// drift into a red build instead.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TECH_LEXICON } from "../src/groundedness.mjs";
import { labelVocabulary } from "../src/digest.mjs";

const artifact = (name) =>
  JSON.parse(readFileSync(new URL(`../share/${name}`, import.meta.url), "utf8"));

test("share/tech-lexicon.json matches the live TECH_LEXICON (run `npm run lexicon` after changing the label maps)", () => {
  assert.deepEqual(artifact("tech-lexicon.json").tokens, [...TECH_LEXICON].sort());
});

test("share/tech-labels.json matches the live labelVocabulary() (run `npm run lexicon` after changing the label maps)", () => {
  const live = [...labelVocabulary()].sort((a, b) => a.localeCompare(b, "en"));
  assert.deepEqual(artifact("tech-labels.json").labels, live);
});
