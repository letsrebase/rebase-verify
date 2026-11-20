import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { invocation } from "../src/invocation.mjs";

const root = join("/", "home", "ada", "verify");

test("under npx the hint names the package", () => {
  assert.equal(invocation({ env: { npm_command: "exec" }, script: join(root, "bin", "rebase-verify.mjs"), cwd: root }), "npx @letsrebase/verify");
});

test("an installed package keeps the rebase-verify command", () => {
  assert.equal(invocation({ env: {}, script: "/usr/local/bin/rebase-verify", cwd: "/tmp" }), "rebase-verify");
  // Windows' npm shim runs node on the file inside node_modules.
  assert.equal(invocation({ env: {}, script: "C:\\Users\\ada\\AppData\\Roaming\\npm\\node_modules\\@letsrebase\\verify\\bin\\rebase-verify.mjs", cwd: "C:\\Users\\ada" }), "rebase-verify");
});

test("a clone gets the node command, relative when run from inside it", () => {
  assert.equal(invocation({ env: {}, script: join(root, "bin", "rebase-verify.mjs"), cwd: root }), `node ${join("bin", "rebase-verify.mjs")}`);
  const elsewhere = invocation({ env: {}, script: join(root, "bin", "rebase-verify.mjs"), cwd: join("/", "tmp") });
  assert.equal(elsewhere, `node ${join(root, "bin", "rebase-verify.mjs")}`);
  const spaced = join("/", "home", "ada", "my tools", "bin", "rebase-verify.mjs");
  assert.equal(invocation({ env: {}, script: spaced, cwd: "/tmp" }), `node "${spaced}"`);
});

