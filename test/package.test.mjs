import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const bin = fileURLToPath(new URL("../bin/rebase-verify.mjs", import.meta.url));
const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));

test("package version is 0.1.0 and --version / -v print it", () => {
  assert.equal(pkg.version, "0.1.0");
  for (const f of ["--version", "-v"]) {
    const out = execFileSync(process.execPath, [bin, f], { encoding: "utf8" });
    assert.equal(out.trim(), "0.1.0");
  }
});

test("runtime dependencies are exactly the two pinned packages", () => {
  assert.deepEqual(pkg.dependencies, {
    "@clack/prompts": "1.9.0",
    "@agentclientprotocol/sdk": "2.8.0",
  });
  assert.equal(pkg.engines.node, ">=20.12");
});

test("npm pack ships no test, out, docs or scripts file", () => {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: root,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  const files = JSON.parse(out)[0].files.map((f) => f.path.replace(/\\/g, "/"));
  assert.ok(files.includes("bin/rebase-verify.mjs"));
  assert.ok(files.includes("package.json"));
  for (const f of files) assert.ok(!/^(test|out|docs|scripts)\//.test(f), `unexpected ${f}`);
});
