// oh-my-pi adapter: pi's session format under source "omp", omp's tool names
// mapped to canonical ones, advisor/subagent/bookkeeping files left out, and
// rebase-verify's own agent runs dropped in readAllSources for every source
// kind. Every fixture is hand-built under tmpdir(); the real
// ~/.omp/agent/sessions is never read.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readOmp, defaultOmpRoot, isAgentRun, AGENT_RUN_MARKER } from "../src/adapters/omp.mjs";
import { readPi } from "../src/adapters/pi.mjs";
import { readAllSources } from "../src/sources.mjs";
import { computeFingerprint } from "../src/fingerprint.mjs";
import { computeForensics } from "../src/forensics.mjs";

const lines = (cwd, id, tools = []) => [
  { type: "session", version: 3, id, timestamp: "2026-11-01T10:00:00.000Z", cwd },
  { type: "message", id: "m1", parentId: null, timestamp: "2026-11-01T10:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "do it" }] } },
  {
    type: "message", id: "m2", parentId: "m1", timestamp: "2026-11-01T10:00:02.000Z",
    message: { role: "assistant", content: tools.map((name, i) => ({ type: "toolCall", id: `t${i}`, name, arguments: { path: "a.txt", command: "ls", pattern: "x" } })) },
  },
].map((l) => JSON.stringify(l)).join("\n") + "\n";

function put(root, rel, body) {
  const full = join(root, ...rel.split("/"));
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, body);
}

const UUID = "019a0000-0000-7000-8000-000000000001";
const SID = `2026-11-01T10-00-00-000Z_${UUID}`;

test("defaultOmpRoot ends in .omp/agent/sessions", () => {
  assert.match(defaultOmpRoot().replace(/\\/g, "/"), /\/\.omp\/agent\/sessions$/);
});

test("isAgentRun matches the raw cwd marker only", () => {
  assert.equal(AGENT_RUN_MARKER, "rebase-verify-agent-run-");
  assert.equal(isAgentRun("/x/y/rebase-verify-agent-run-abc123"), true);
  assert.equal(isAgentRun("/home/me/proj"), false);
  assert.equal(isAgentRun(""), false);
  assert.equal(isAgentRun(undefined), false);
});

test("readOmp: source omp, canonical tool names", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-"));
  try {
    const tools = ["bash", "read", "edit", "write", "grep", "find", "glob", "task", "todo", "ast_edit", "web_search", "eval", "browser", "browser_snapshot", "translate_catalog", "xd_mcp__linear_personal_get_issue", " read", "mcp__linear_rebase_list_issues"];
    put(root, `--home-me-proj--/${SID}.jsonl`, lines("/home/me/proj", UUID, tools));
    const b = readOmp(root);
    assert.equal(b.source, "omp");
    assert.equal(b.sessions.length, 1);
    assert.equal(b.sessions[0].source, "omp");
    const names = b.sessions[0].messages.flatMap((m) => m.toolUses.map((u) => u.name));
    assert.deepEqual(names, ["Bash", "Read", "Edit", "Write", "Grep", "Glob", "Glob", "Task", "TodoWrite", "Edit", "WebSearch", "eval", "browser", "browser_snapshot", "translate_catalog", "mcp__linear_personal_get_issue", "Read", "mcp__linear_rebase_list_issues"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readOmp: advisor, subagent and bookkeeping files are not sessions", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-"));
  try {
    const d = "--home-me-proj--";
    put(root, `${d}/${SID}.jsonl`, lines("/home/me/proj", UUID));
    put(root, `${d}/${SID}/__advisor.reviewer.jsonl`, lines("/home/me/proj", "adv"));
    put(root, `${d}/${SID}/Shell.jsonl`, lines("/home/me/proj", "sub"));
    put(root, `${d}/${SID}/Shell/Nested.jsonl`, lines("/home/me/proj", "nested"));
    put(root, `${d}/${SID}/changes.jsonl`, lines("/home/me/proj", "chg"));
    put(root, `${d}/${SID.replace("10-00", "11-00")}__advisor.reviewer.jsonl`, lines("/home/me/proj", "adv2"));
    const b = readOmp(root);
    assert.deepEqual(b.sessions.map((s) => s.sessionId), [UUID]);
    assert.equal(b.files.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readPi is unchanged: still source pi, pi tool names only", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-"));
  try {
    put(root, `--home-me-proj--/${SID}.jsonl`, lines("/home/me/proj", UUID, ["bash", "find", "todo"]));
    const b = readPi(root);
    assert.equal(b.source, "pi");
    assert.equal(b.sessions[0].source, "pi");
    assert.deepEqual(b.sessions[0].messages.flatMap((m) => m.toolUses.map((u) => u.name)), ["Bash", "find", "todo"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- readAllSources drops agent runs for every source kind -----------------

const NONE = { opencode: { disabled: true }, codex: { disabled: true }, pi: { disabled: true }, omp: { disabled: true }, cursor: { disabled: true }, kimi: { disabled: true } };
const RUN_CWD = "/var/x/rebase-verify-agent-run-q1w2e3";

function claudeRoot(cwd) {
  const root = mkdtempSync(join(tmpdir(), "cc-"));
  const rec = (o) => JSON.stringify(o);
  put(root, "-p/s1.jsonl", [
    rec({ type: "user", uuid: "u1", parentUuid: null, sessionId: "s1", cwd, timestamp: "2026-11-01T10:00:00.000Z", message: { role: "user", content: "hi" } }),
    rec({ type: "assistant", uuid: "a1", parentUuid: "u1", sessionId: "s1", cwd, timestamp: "2026-11-01T10:00:01.000Z", message: { role: "assistant", model: "m", content: [{ type: "text", text: "yo" }] } }),
  ].join("\n") + "\n");
  return root;
}

function codexRoot(cwd) {
  const root = mkdtempSync(join(tmpdir(), "cx-"));
  const l = [
    { timestamp: "2026-01-02T03:04:05.000Z", type: "session_meta", payload: { id: "cx-one", cwd, originator: "codex-tui", cli_version: "0.60.0", model_provider: "openai" } },
    { timestamp: "2026-01-02T03:04:06.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] } },
    { timestamp: "2026-01-02T03:04:07.000Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "hi" }] } },
  ];
  put(root, "2026/01/02/rollout-2026-01-02T03-04-05-11111111-1111-1111-1111-111111111111.jsonl", l.map((x) => JSON.stringify(x)).join("\n") + "\n");
  return root;
}

test("readAllSources drops claude-code, codex, pi and omp sessions from agent runs", () => {
  const roots = [];
  try {
    const mk = (f) => { const r = f(); roots.push(r); return r; };
    // claude-code
    let cc = mk(() => claudeRoot(RUN_CWD));
    assert.equal(readAllSources({ claudeRoot: cc, sources: NONE }).sessions.length, 0);
    cc = mk(() => claudeRoot("/home/me/proj"));
    assert.equal(readAllSources({ claudeRoot: cc, sources: NONE }).sessions.length, 1);

    const empty = mk(() => mkdtempSync(join(tmpdir(), "cc-empty-")));
    // codex
    const cxRun = mk(() => codexRoot(RUN_CWD));
    assert.equal(readAllSources({ claudeRoot: empty, sources: { ...NONE, codex: { root: cxRun } } }).sessions.length, 0);
    const cxOk = mk(() => codexRoot("/home/me/proj"));
    assert.equal(readAllSources({ claudeRoot: empty, sources: { ...NONE, codex: { root: cxOk } } }).sessions.length, 1);

    // pi and omp share the format
    for (const kind of ["pi", "omp"]) {
      const run = mk(() => mkdtempSync(join(tmpdir(), `${kind}-run-`)));
      put(run, `--x--/${SID}.jsonl`, lines(RUN_CWD, UUID));
      assert.equal(readAllSources({ claudeRoot: empty, sources: { ...NONE, [kind]: { root: run } } }).sessions.length, 0, kind);
      const ok = mk(() => mkdtempSync(join(tmpdir(), `${kind}-ok-`)));
      put(ok, `--x--/${SID}.jsonl`, lines("/home/me/proj", UUID));
      const got = readAllSources({ claudeRoot: empty, sources: { ...NONE, [kind]: { root: ok } } });
      assert.equal(got.sessions.length, 1, kind);
      assert.equal(got.sessions[0].source, kind);
    }
  } finally {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  }
});

test("readOmp: a header-less transcript in an agent-run directory is recognised", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-"));
  try {
    const body = lines("/x", UUID).split("\n").slice(1).join("\n"); // no session header
    put(root, `--var-x-${AGENT_RUN_MARKER}q1w2e3--/${SID}.jsonl`, body);
    const b = readOmp(root);
    assert.equal(b.sessions.length, 1);
    assert.equal(isAgentRun(b.sessions[0].cwdRaw), true);
    const got = readAllSources({ claudeRoot: mkdtempSync(join(tmpdir(), "cc-empty-")), sources: { ...NONE, omp: { root } } });
    assert.equal(got.sessions.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readAllSources drops the files of agent runs: no malformed count, no manifest entry", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-"));
  const empty = mkdtempSync(join(tmpdir(), "cc-empty-"));
  try {
    put(root, `--home-me-proj--/${SID}.jsonl`, lines("/home/me/proj", UUID));
    // A run killed by Ctrl-C: header names the run cwd, last line truncated.
    put(root, `--x--/2026-11-02T10-00-00-000Z_019a0000-0000-7000-8000-000000000002.jsonl`, lines(RUN_CWD, "run1") + '{"type":"mess');
    const got = readAllSources({ claudeRoot: empty, sources: { ...NONE, omp: { root } } });
    assert.equal(got.sessions.length, 1);
    assert.equal(got.files.length, 1);
    assert.equal(got.files.reduce((n, f) => n + f.malformed, 0), 0);
    assert.equal(computeForensics(got).checks.find((c) => c.id === "malformed_lines").status, "pass");
    assert.deepEqual(computeFingerprint(got).manifest.files.map((f) => f.file), got.files.map((f) => f.relPath));
    assert.equal(got.files.some((f) => f.relPath.includes("--x--")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(empty, { recursive: true, force: true });
  }
});
