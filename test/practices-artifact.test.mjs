// share/practices.json is the list a freelancer consents to and the hub vendors.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  practicesArtifact, CHECK_PATTERNS, SECURITY_PATTERNS, DIFF_PATTERNS,
  TEST_PATH_PATTERNS, SOURCE_EXCLUSION_PATTERNS, DESIGN_PATH_PATTERNS, PLAN_PATH_PATTERNS,
} from "../src/practices-rules.mjs";

const artifact = JSON.parse(readFileSync(new URL("../share/practices.json", import.meta.url), "utf8"));

test("share/practices.json matches practicesArtifact() (run `npm run practices`)", () => {
  assert.deepEqual(artifact, practicesArtifact(), "run `npm run practices`");
});
test("lists exactly the seven code practices, in order, each defined", () => {
  assert.deepEqual(artifact.practices.map((p) => p.id), [
    "checks_before_commit", "tests_with_changes", "failure_reproduced_before_fix",
    "plan_before_edit", "reviews_changes", "design_documents", "security_checks",
  ]);
  for (const p of artifact.practices) {
    assert.equal(p.method, "code");
    assert.ok(p.definition.trim().length > 0, p.id);
    assert.ok(p.denominator.trim().length > 0, p.id);
  }
});
test("reviews_changes says the diff appeared in the session", () => {
  const p = artifact.practices.find((x) => x.id === "reviews_changes");
  assert.match(p.definition, /appeared in the session/);
});
test("the rules lists equal the exported patterns' sources", () => {
  const src = (l) => l.map((x) => x.re.source);
  assert.deepEqual(artifact.rules, {
    testPaths: src(TEST_PATH_PATTERNS), sourceExclusions: src(SOURCE_EXCLUSION_PATTERNS), designPaths: src(DESIGN_PATH_PATTERNS), planPaths: src(PLAN_PATH_PATTERNS),
    checks: src(CHECK_PATTERNS), security: src(SECURITY_PATTERNS), diff: src(DIFF_PATTERNS),
  });
});
test("notes publish the 240-character cap on commands", () => {
  assert.ok(artifact.notes.some((n) => /240 characters/.test(n)));
});
