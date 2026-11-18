import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENTS, availableAgents, defaultAgent, onPath } from "../src/agents/registry.mjs";

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
  assert.equal(cx.systemPromptVia, "param");
  assert.equal(cx.system, "S");
  assert.ok(!("sessionParams" in cx));
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

test("cleanup refuses names without the run marker", () => {
  const home = tmp();
  const root = join(home, ".omp", "agent", "sessions");
  const keep = join(root, "--tmp-rebase-verify-agent-run-abc--");
  mkdirSync(keep, { recursive: true });
  const dir = join(home, ".codex", "sessions");
  mkdirSync(dir, { recursive: true });
  const f = join(dir, "rollout-9.jsonl");
  writeFileSync(f, JSON.stringify({ payload: { cwd: "/home/x/projects" } }) + "\n");
  for (const bad of ["/tmp", ".", "..", "/home/x/projects", "", "/tmp/rebase-verify-agent-run-"]) {
    assert.deepEqual(get("omp").cleanup(bad, { home }), [], bad);
    assert.deepEqual(get("codex").cleanup(bad, { home, env: {} }), [], bad);
  }
  assert.ok(existsSync(keep) && existsSync(f));
});

test("cleanup matches the whole run name, not a prefix", () => {
  const home = tmp();
  const root = join(home, ".omp", "agent", "sessions");
  const longer = join(root, "--tmp-rebase-verify-agent-run-abc--");
  const exact = join(root, "--tmp-rebase-verify-agent-run-ab--");
  mkdirSync(longer, { recursive: true });
  mkdirSync(exact, { recursive: true });
  const dir = join(home, ".codex", "sessions");
  mkdirSync(dir, { recursive: true });
  const cl = join(dir, "rollout-1.jsonl");
  const ce = join(dir, "rollout-2.jsonl");
  writeFileSync(cl, JSON.stringify({ payload: { cwd: "/tmp/rebase-verify-agent-run-abc" } }) + "\n");
  writeFileSync(ce, JSON.stringify({ payload: { cwd: "/tmp/rebase-verify-agent-run-ab" } }) + "\n");
  const run = "/tmp/rebase-verify-agent-run-ab";
  assert.deepEqual(get("omp").cleanup(run, { home }), [exact]);
  assert.deepEqual(get("codex").cleanup(run, { home, env: {} }), [ce]);
  assert.ok(existsSync(longer) && existsSync(cl));
});

test("codex cleanup handles a 100 KB first line", () => {
  const home = tmp();
  const dir = join(home, ".codex", "sessions");
  mkdirSync(dir, { recursive: true });
  const run = "/tmp/rebase-verify-agent-run-big1";
  const big = join(dir, "rollout-big.jsonl");
  writeFileSync(big, JSON.stringify({ type: "session_meta", payload: { cwd: run, pad: "x".repeat(100000) } }) + "\n");
  const big2 = join(dir, "rollout-big2.jsonl");
  writeFileSync(big2, JSON.stringify({ type: "session_meta", payload: { pad: "x".repeat(100000), cwd: "/home/dev/work" } }) + "\n");
  assert.deepEqual(get("codex").cleanup(run, { home, env: {} }), [big]);
  assert.ok(existsSync(big2));
});

test("empty CODEX_HOME and CLAUDE_CONFIG_DIR count as unset; set ones are honoured", () => {
  const home = tmp();
  const env = { PATH: "", CODEX_HOME: "", CLAUDE_CONFIG_DIR: "" };
  assert.equal(get("codex").detect({ env, home }).installed, false);
  assert.equal(get("claude-code").detect({ env, home }).installed, false);
  const ch = tmp();
  writeFileSync(join(ch, "auth.json"), "{}");
  assert.equal(get("codex").detect({ env: { PATH: "", CODEX_HOME: ch }, home }).installed, true);
  assert.equal(get("claude-code").detect({ env: { PATH: "", CLAUDE_CONFIG_DIR: tmp() }, home }).installed, true);
  // cleanup honours CODEX_HOME
  const run = "/tmp/rebase-verify-agent-run-ch1";
  mkdirSync(join(ch, "sessions"));
  const f = join(ch, "sessions", "rollout-1.jsonl");
  writeFileSync(f, JSON.stringify({ payload: { cwd: run } }) + "\n");
  assert.deepEqual(get("codex").cleanup(run, { home, env: { CODEX_HOME: ch } }), [f]);
});

test("onPath: exec bit, PATHEXT, quotes, unreadable and file entries", () => {
  const d = tmp();
  const f = join(d, "tool");
  writeFileSync(f, "");
  chmodSync(f, 0o644);
  if (process.platform !== "win32") {
    assert.equal(onPath("tool", { PATH: d }, "linux"), false);
    chmodSync(f, 0o755);
    assert.equal(onPath("tool", { PATH: d }, "linux"), true);
  }
  assert.equal(onPath("tool", { PATH: join(d, "tool") }, "linux"), false); // entry is a file
  assert.equal(onPath("tool", { PATH: join(d, "missing") + ":" + d }, "linux"), process.platform !== "win32");
  writeFileSync(join(d, "wintool.CMD"), "");
  assert.equal(onPath("wintool", { PATH: d, PATHEXT: ".EXE;.CMD" }, "win32"), true);
  assert.equal(onPath("wintool", { PATH: d, PATHEXT: ".EXE" }, "win32"), false);
  assert.equal(onPath("wintool", { PATH: `"${d}"`, PATHEXT: ".CMD" }, "win32"), true);
});

test("claude cleanup removes the empty project dir of the run, never one with a transcript", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = mkdtempSync(join(tmpdir(), "rv-claude-"));
  try {
    const run = join(tmpdir(), "rebase-verify-agent-run-abc123");
    const projects = join(home, ".claude", "projects");
    const mine = join(projects, run.replace(/[\\/:.]/g, "-"));
    const withTranscript = join(projects, `${run.replace(/[\\/:.]/g, "-")}-more`);
    const other = join(projects, "-home-me-work");
    for (const d of [join(mine, "memory"), join(withTranscript, "memory"), other]) mkdirSync(d, { recursive: true });
    writeFileSync(join(withTranscript, "s.jsonl"), "{}\n");
    const longer = join(projects, `${run.replace(/[\\/:.]/g, "-")}x`);
    mkdirSync(longer, { recursive: true });
    assert.deepEqual(get("claude-code").cleanup(run, { home, env: {} }), [mine]);
    assert.equal(existsSync(mine), false);
    assert.equal(existsSync(other), true);
    assert.equal(existsSync(longer), true, "a longer name is not this run's");
    assert.equal(existsSync(join(withTranscript, "s.jsonl")), true);
    // CLAUDE_CONFIG_DIR is honoured
    const cfg = join(home, "cfg");
    mkdirSync(join(cfg, "projects", run.replace(/[\\/:.]/g, "-"), "memory"), { recursive: true });
    assert.deepEqual(get("claude-code").cleanup(run, { home, env: { CLAUDE_CONFIG_DIR: cfg } }), [join(cfg, "projects", run.replace(/[\\/:.]/g, "-"))]);
    assert.deepEqual(get("claude-code").cleanup("/tmp/not-a-run", { home, env: {} }), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("omp cleanup honours PI_CODING_AGENT_DIR", () => {
  const home = tmp();
  const dir = tmp();
  const mine = join(dir, "sessions", "--tmp-rebase-verify-agent-run-abc123--");
  const decoy = join(home, ".omp", "agent", "sessions", "--tmp-rebase-verify-agent-run-abc123--");
  mkdirSync(mine, { recursive: true });
  mkdirSync(decoy, { recursive: true });
  const removed = get("omp").cleanup("/tmp/rebase-verify-agent-run-abc123", { home, env: { PI_CODING_AGENT_DIR: dir } });
  assert.deepEqual(removed, [mine]);
  assert.ok(existsSync(decoy));
});

test("the download of the npx agents has one source: the spec's package", () => {
  for (const id of ["claude-code", "codex"]) {
    const a = get(id);
    assert.match(a.download, /^@agentclientprotocol\/[a-z-]+@\d+\.\d+\.\d+$/);
    assert.ok(a.spec().args.includes(a.download));
  }
  assert.equal(get("omp").download, undefined);
});

test("cursor starts as cursor-agent when found as cursor-agent, as agent when found as agent", () => {
  const withCursorAgent = process.env.PATH;
  const dir = binDir("cursor-agent");
  const save = process.env.PATH;
  try {
    process.env.PATH = dir;
    assert.equal(get("cursor").spec().command, "cursor-agent");
    process.env.PATH = binDir("agent");
    assert.equal(get("cursor").spec().command, "agent");
  } finally {
    process.env.PATH = save ?? withCursorAgent;
  }
});
