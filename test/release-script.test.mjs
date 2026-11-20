import { test } from "node:test";
import assert from "node:assert/strict";
import { bump, isNewer, parseArgs, repoFromPackage } from "../scripts/release.mjs";

test("bump resets the lower parts of the version", () => {
  assert.equal(bump("0.1.9", "patch"), "0.1.10");
  assert.equal(bump("0.9.4", "minor"), "0.10.0");
  assert.equal(bump("1.4.2", "major"), "2.0.0");
  assert.throws(() => bump("1.0.0-rc.1", "patch"), /plain x\.y\.z/);
});

test("isNewer compares numerically, not as text", () => {
  assert.equal(isNewer("0.1.10", "0.1.9"), true);
  assert.equal(isNewer("0.10.0", "0.9.9"), true);
  assert.equal(isNewer("0.1.2", "0.1.2"), false);
  assert.equal(isNewer("0.1.2", "1.0.0"), false);
});

test("parseArgs takes a level or a version, a card and the two switches", () => {
  assert.deepEqual(parseArgs(["minor", "--card", "REB-7", "--yes"]), { dryRun: false, yes: true, target: "minor", card: "REB-7" });
  assert.deepEqual(parseArgs(["--dry-run", "1.2.3", "--card=REB-12"]), { dryRun: true, yes: false, target: "1.2.3", card: "REB-12" });
  assert.throws(() => parseArgs(["huge"]), /patch, minor, major or x\.y\.z/);
  assert.throws(() => parseArgs(["--card", "1154"]), /REB-123/);
  assert.throws(() => parseArgs(["--force"]), /unknown argument/);
});

test("the repository comes from package.json in any URL form npm accepts", () => {
  assert.equal(repoFromPackage({ repository: { type: "git", url: "git+https://github.com/letsrebase/verify.git" } }), "letsrebase/verify");
  assert.equal(repoFromPackage({ repository: "https://github.com/letsrebase/verify" }), "letsrebase/verify");
  assert.equal(repoFromPackage({ repository: { url: "git@github.com:letsrebase/verify.git" } }), "letsrebase/verify");
  assert.throws(() => repoFromPackage({ repository: { url: "https://gitlab.com/x/y.git" } }), /not a GitHub URL/);
});
