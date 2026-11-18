import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENTS, availableAgents, defaultAgent } from "../src/agents/registry.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "reg-"));
const sep = process.platform === "win32" ? ";" : ":";
function binDir(...names) {
  const d = tmp();
  for (const n of names) {
    const f = join(d, process.platform === "win32" ? `${n}.exe` : n);
    writeFileSync(f, "");
    chmodSync(f, 0o755);
  }
  return d;
}
const get = (id) => AGENTS.find((a) => a.id === id);

test("detection by PATH and home markers, without running anything", () => {
  const home = tmp();
  const env = { PATH: binDir("omp") };
  assert.equal(get("omp").detect({ env, home }).installed, true);
  assert.equal(get("claude-code").detect({ env, home }).installed, false);
  mkdirSync(join(home, ".claude"));
  assert.equal(get("claude-code").detect({ env, home }).installed, true);
  assert.equal(get("codex").detect({ env, home }).installed, false);
  mkdirSync(join(home, ".codex"));
  writeFileSync(join(home, ".codex", "auth.json"), "{}");
  assert.equal(get("codex").detect({ env, home }).installed, true);
});

test("cursor: `agent` only counts with ~/.cursor", () => {
  const home = tmp();
  const env = { PATH: binDir("agent") };
  assert.equal(get("cursor").detect({ env, home }).installed, false);
  mkdirSync(join(home, ".cursor"));
  assert.equal(get("cursor").detect({ env, home }).installed, true);
  assert.equal(get("cursor").detect({ env: { PATH: binDir("cursor-agent") }, home: tmp() }).installed, true);
});

test("ordering: tested by sessions, untested next, api last; default is first", () => {
  const home = tmp();
  const env = { PATH: [binDir("omp", "codex", "opencode", "gemini")].join(sep), ANTHROPIC_API_KEY: "k" };
  const list = availableAgents({ sessionsBySource: { omp: 3, codex: 10, opencode: 99 }, env, home });
  assert.deepEqual(list.map((a) => a.id), ["codex", "omp", "opencode", "gemini", "anthropic-api"]);
  assert.equal(defaultAgent(list).id, "codex");
  assert.equal(list.at(-1).kind, "api");
  assert.deepEqual(list.at(-1).models, ["claude-opus-4-7"]);
  assert.equal(availableAgents({ env: { PATH: "" }, home }).length, 0);
});

test("specs", () => {
  const omp = get("omp").spec({ system: "S" });
  assert.deepEqual(omp.args, ["--no-tools", "--no-rules", "--no-skills", "--no-extensions", "acp"]);
  assert.equal(omp.systemPromptVia, "inline");
  assert.deepEqual(omp.env, ["PI_CODING_AGENT_DIR"]);
  const cl = get("claude-code").spec({ system: "S" });
  assert.deepEqual(cl.sessionMeta.claudeCode.options, { tools: [], settingSources: [], persistSession: false });
  assert.ok(!cl.env.includes("ANTHROPIC_API_KEY") && !omp.env.includes("ANTHROPIC_API_KEY"));
  const cx = get("codex").spec({ system: "S" });
  assert.equal(cx.mode, "read-only");
  const sp = cx.sessionParams("S").systemPrompt;
  assert.equal(sp.mode, "append");
  assert.match(sp.content[0].text, /Do not use any tool\. Answer only from the text in this message\.$/);
  assert.deepEqual(get("claude-code").cleanup("/x/y"), []);
  for (const a of AGENTS) assert.ok(a.loginHint && a.installHint, a.id);
});

test("omp cleanup removes only matching dirs and not symlink targets", () => {
  const home = tmp();
  const root = join(home, ".omp", "agent", "sessions");
  const run = "/tmp/rebase-verify-agent-run-abc123";
  const mine = join(root, "--tmp-rebase-verify-agent-run-abc123--");
  const other = join(root, "--home-dev-project--");
  mkdirSync(mine, { recursive: true });
  writeFileSync(join(mine, "a.jsonl"), "x");
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, "b.jsonl"), "x");
  const outside = tmp();
  writeFileSync(join(outside, "keep"), "x");
  try {
    symlinkSync(outside, join(root, "--rebase-verify-agent-run-abc123-link--"), "dir");
  } catch {}
  const removed = get("omp").cleanup(run, { home });
  assert.ok(removed.includes(mine));
  assert.ok(!existsSync(mine));
  assert.ok(existsSync(join(other, "b.jsonl")));
  assert.ok(existsSync(join(outside, "keep")));
});

test("codex cleanup reads the first line cwd only", () => {
  const home = tmp();
  const dir = join(home, ".codex", "sessions", "2026", "11", "18");
  mkdirSync(dir, { recursive: true });
  const run = "/tmp/rebase-verify-agent-run-zzz999";
  const line = (cwd) => JSON.stringify({ type: "session_meta", payload: { cwd } });
  const mine = join(dir, "rollout-1.jsonl");
  const other = join(dir, "rollout-2.jsonl");
  const sneaky = join(dir, "rollout-3.jsonl");
  writeFileSync(mine, line(run) + "\n{}\n");
  writeFileSync(other, line("/home/dev/work") + "\n");
  writeFileSync(sneaky, line("/home/dev/work") + "\n" + line(run) + "\n");
  assert.deepEqual(get("codex").cleanup(run, { home, env: {} }), [mine]);
  assert.ok(!existsSync(mine) && existsSync(other) && existsSync(sneaky));
});
