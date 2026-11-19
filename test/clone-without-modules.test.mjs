// A clone that never ran `npm ci` must still run prepare, finalize, submit and generate
// without --agent: the wizard and the agent runner load their dependencies only when used.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const FLAGS = ["--no-opencode", "--no-codex", "--no-pi", "--no-omp", "--no-cursor", "--no-kimi"];

function clone(tmp) {
  const dest = join(tmp, "clone");
  const files = execFileSync("git", ["ls-files"], { cwd: REPO, encoding: "utf8" }).split("\n").filter(Boolean);
  for (const f of files) {
    if (!existsSync(join(REPO, f))) continue;
    mkdirSync(dirname(join(dest, f)), { recursive: true });
    cpSync(join(REPO, f), join(dest, f));
  }
  assert.ok(!existsSync(join(dest, "node_modules")));
  return dest;
}

function logs(tmp) {
  const root = join(tmp, "projects");
  const proj = join(root, "-tmp-demo");
  mkdirSync(proj, { recursive: true });
  const cwd = join(tmp, "demo");
  const lines = [
    { type: "user", sessionId: "s1", cwd, timestamp: "2026-05-01T10:00:00.000Z", uuid: "u1", version: "1.0.0", message: { role: "user", content: "let's build the agent route and the api" } },
    { type: "assistant", sessionId: "s1", cwd, timestamp: "2026-05-01T10:01:00.000Z", uuid: "u2", parentUuid: "u1", version: "1.0.0", message: { role: "assistant", model: "claude-x", content: [{ type: "text", text: "ok" }] } },
  ];
  writeFileSync(join(proj, "s1.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return root;
}

const exec = (bin, work, home, args, extraEnv = {}) =>
  spawnSync(process.execPath, [bin, ...args], { cwd: work, encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home, ANTHROPIC_API_KEY: "", ...extraEnv }, timeout: 60000 });

test("prepare and finalize work in a clone without node_modules; out/ gets its .gitignore", () => {
  const tmp = mkdtempSync(join(tmpdir(), "clone-nm-"));
  try {
    const home = join(tmp, "home");
    const work = join(tmp, "work");
    mkdirSync(home);
    mkdirSync(work);
    const bin = join(clone(tmp), "bin", "rebase-verify.mjs");
    const root = logs(tmp);
    const r = exec(bin, work, home, ["prepare", "--root", root, ...FLAGS]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(work, "out", "narrative-input.json")));
    assert.equal(readFileSync(join(work, "out", ".gitignore"), "utf8"), "*\n");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("generate without --agent and submit reach their own checks without node_modules", () => {
  const tmp = mkdtempSync(join(tmpdir(), "clone-nm-"));
  try {
    const home = join(tmp, "home");
    const work = join(tmp, "work");
    mkdirSync(home);
    mkdirSync(work);
    const bin = join(clone(tmp), "bin", "rebase-verify.mjs");
    const root = logs(tmp);
    const g = exec(bin, work, home, ["generate", "--root", root, ...FLAGS]);
    assert.equal(g.status, 0, g.stderr);
    assert.match(g.stdout, /no narrative yet/);
    const s = exec(bin, work, home, ["submit"]);
    assert.equal(s.status, 2);
    assert.match(s.stderr + s.stdout, /No out\/candidate\.json yet/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("--agent without node_modules prints one line and exits 2", () => {
  const tmp = mkdtempSync(join(tmpdir(), "clone-nm-"));
  try {
    const home = join(tmp, "home");
    const work = join(tmp, "work");
    mkdirSync(home);
    mkdirSync(work);
    const bin = join(clone(tmp), "bin", "rebase-verify.mjs");
    const r = exec(bin, work, home, ["generate", "--agent", "omp", "--root", logs(tmp), ...FLAGS], { PATH: process.env.PATH });
    assert.equal(r.status, 2);
    assert.equal(r.stderr.trim(), "Run it with npx rebase-verify, or run npm ci in this folder first.");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("no out/ is created when there are no logs", () => {
  const tmp = mkdtempSync(join(tmpdir(), "no-logs-"));
  try {
    const home = join(tmp, "home");
    const work = join(tmp, "work");
    mkdirSync(home);
    mkdirSync(work);
    const r = exec(join(REPO, "bin", "rebase-verify.mjs"), work, home, ["prepare", "--root", join(tmp, "nowhere"), ...FLAGS]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /No logs at/);
    assert.ok(!existsSync(join(work, "out")));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
