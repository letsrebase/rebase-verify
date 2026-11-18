import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDigest } from "../src/digest.mjs";
import { normalizeCommand, sessionFacts, computeCodePractices, practiceSessions, recordedPracticesTz } from "../src/practices.mjs";

// Events are { tool, path, cmd, err }; each becomes one assistant tool use,
// followed by a user message carrying its result (isError = err === true).
const edit = (path, tool = "Edit") => ({ tool, path });
const bash = (cmd, { err } = {}) => ({ tool: "Bash", cmd, err });
const tool = (name) => ({ tool: name });

function session(source, events, { cwd = "/h/p/x", ts = "2026-05-01T10:00:00.000Z", id = "s" } = {}) {
  const messages = [];
  events.forEach((e, i) => {
    const callId = `${id}-${i}`;
    messages.push({
      role: "assistant", ts, textRedacted: "",
      toolUses: [{ id: callId, name: e.tool, path: e.path ?? "", cmd: e.cmd ?? "", q: "" }],
      toolResults: [],
    });
    messages.push({
      role: "user", ts, textRedacted: "",
      toolUses: [],
      toolResults: [{ forId: callId, isError: e.err === true, bytes: 0 }],
    });
  });
  return { source, sessionId: id, cwdRaw: "", cwdRedacted: cwd, messages };
}

const seenOf = (events, id, source = "claude-code") => sessionFacts(session(source, events)).seen[id];
const denomOf = (events, id, source = "claude-code") => sessionFacts(session(source, events)).denom[id];

test("normalizeCommand keeps the executable words up to the first flag or path", () => {
  assert.equal(normalizeCommand("pytest tests/a.py -q"), "pytest");
  assert.equal(normalizeCommand("pytest"), "pytest");
  assert.equal(normalizeCommand("pytest tests/ -x"), "pytest");
  assert.equal(normalizeCommand("pytest -x tests/"), "pytest");
  assert.equal(normalizeCommand("pytest -q"), "pytest");
  assert.equal(normalizeCommand("uv run pytest"), "pytest");
  assert.equal(normalizeCommand("python -m pytest tests/a.py"), "pytest");
  assert.equal(normalizeCommand("FOO=1  npx   vitest run test/a.test.ts"), "vitest run");
  assert.equal(normalizeCommand("npx vitest run --reporter=dot"), "vitest run");
  assert.equal(normalizeCommand("pnpm exec vitest run"), "vitest run");
  assert.equal(normalizeCommand("cd x && go test ./pkg/..."), "go test");
  assert.equal(normalizeCommand("go test -run X ./..."), "go test");
  assert.equal(normalizeCommand("npm run test -- --watch"), "npm run test");
  assert.equal(normalizeCommand("ls -la"), "");
  assert.equal(normalizeCommand("eslint ."), "eslint");
  assert.equal(normalizeCommand("npx eslint .. --fix"), "eslint");
});

test("checks_before_commit: seen only when the check ran after the last edit", () => {
  const ok = [edit("src/a.ts"), bash("npm test"), bash("git commit -m x")];
  const stale = [bash("npm test"), edit("src/a.ts"), bash("git commit -m x")];
  assert.equal(seenOf(ok, "checks_before_commit"), true);
  assert.equal(seenOf(stale, "checks_before_commit"), false);
  assert.equal(denomOf(stale, "checks_before_commit"), true);
  assert.equal(denomOf([edit("a.ts")], "checks_before_commit"), false);
  // No edit before the commit: a check anywhere before it is enough.
  assert.equal(seenOf([bash("npm test"), bash("git commit -m x")], "checks_before_commit"), true);
  // A check chained before the commit in one command counts; after it does not.
  assert.equal(seenOf([edit("a.ts"), bash("npm test && git commit -m x")], "checks_before_commit"), true);
  assert.equal(seenOf([edit("a.ts"), bash("git commit -m x && npm test")], "checks_before_commit"), false);
  // One commit with a check is enough even when a later commit has none.
  assert.equal(seenOf([edit("a.ts"), bash("npm test"), bash("git commit -m 1"), edit("b.ts"), bash("git commit -m 2")], "checks_before_commit"), true);
});

test("tests_with_changes", () => {
  const both = [edit("src/a.ts"), edit("test/a.test.ts")];
  const srcOnly = [edit("src/a.ts")];
  const testOnly = [edit("test/a.test.ts")];
  assert.deepEqual([seenOf(both, "tests_with_changes"), denomOf(both, "tests_with_changes")], [true, true]);
  assert.deepEqual([seenOf(srcOnly, "tests_with_changes"), denomOf(srcOnly, "tests_with_changes")], [false, true]);
  assert.deepEqual([seenOf(testOnly, "tests_with_changes"), denomOf(testOnly, "tests_with_changes")], [false, false]);
  const f = sessionFacts(session("claude-code", both));
  assert.deepEqual([f.edits, f.sourceEdits, f.testEdits], [2, 1, 1]);
});

test("failure_reproduced_before_fix", () => {
  const s = [bash("pytest tests/a.py", { err: true }), edit("src/a.py"), bash("pytest", { err: false })];
  assert.equal(seenOf(s, "failure_reproduced_before_fix"), true);
  assert.equal(seenOf([bash("pytest", { err: true }), bash("pytest", { err: false })], "failure_reproduced_before_fix"), false);
  // A narrower or wrapped run and the broader form are the same command.
  assert.equal(seenOf([bash("pytest -x tests/a.py", { err: true }), edit("src/a.py"), bash("uv run pytest", { err: false })], "failure_reproduced_before_fix"), true);
  assert.equal(seenOf([bash("go test -run X ./pkg/...", { err: true }), edit("a.go"), bash("go test ./...", { err: false })], "failure_reproduced_before_fix"), true);
  // A different command succeeding after the edit is not the same failure.
  assert.equal(seenOf([bash("pytest", { err: true }), edit("src/a.py"), bash("ruff check .", { err: false })], "failure_reproduced_before_fix"), false);
  // Still failing after the edit is not a reproduction followed by a fix.
  assert.equal(seenOf([bash("pytest", { err: true }), edit("src/a.py"), bash("pytest", { err: true })], "failure_reproduced_before_fix"), false);
  assert.equal(denomOf([edit("a.py"), bash("pytest")], "failure_reproduced_before_fix"), false);
  // The practice is about checks: only non-check failures leave the session out of the denominator.
  for (const cmd of ["ls -la", "grep x src", "git push"]) assert.equal(denomOf([bash(cmd, { err: true })], "failure_reproduced_before_fix"), false, cmd);
  assert.equal(denomOf([bash("grep x src", { err: true }), bash("npm test", { err: true })], "failure_reproduced_before_fix"), true);
  assert.equal(sessionFacts(session("claude-code", s)).failedCommands, 1);
});

test("pi and cursor sessions are not in the failure denominator, claude-code and codex are", () => {
  for (const src of ["pi", "cursor"]) assert.equal(denomOf([bash("pytest", { err: true })], "failure_reproduced_before_fix", src), false);
  for (const src of ["claude-code", "codex", "opencode", "kimi"]) assert.equal(denomOf([bash("pytest", { err: true })], "failure_reproduced_before_fix", src), true);
  // An unknown source keeps every denominator its fields allow.
  const noSource = session("x", [bash("pytest", { err: true })]);
  delete noSource.source;
  assert.equal(sessionFacts(noSource).denom.failure_reproduced_before_fix, true);
});

test("failure rule needs tool results", () => {
  const s = session("claude-code", [bash("pytest", { err: true })]);
  for (const m of s.messages) delete m.toolResults;
  assert.equal(sessionFacts(s).denom.failure_reproduced_before_fix, false);
});

test("plan_before_edit: plan file, ExitPlanMode or TodoWrite before the first edit", () => {
  assert.equal(seenOf([edit("docs/plans/2026-plan.md", "Write"), edit("src/a.ts")], "plan_before_edit"), true);
  assert.equal(seenOf([tool("ExitPlanMode"), edit("src/a.ts")], "plan_before_edit"), true);
  assert.equal(seenOf([tool("TodoWrite"), edit("src/a.ts")], "plan_before_edit"), true);
  assert.equal(seenOf([edit("src/a.ts"), tool("TodoWrite")], "plan_before_edit"), false);
  assert.equal(seenOf([edit("src/a.ts"), edit("docs/plans/p.md")], "plan_before_edit"), false);
  assert.equal(denomOf([edit("src/a.ts")], "plan_before_edit"), true);
  assert.equal(denomOf([tool("TodoWrite")], "plan_before_edit"), false);
});

test("reviews_changes: git diff, git show or gh pr diff before commit or gh pr create", () => {
  assert.equal(seenOf([edit("a.ts"), bash("git diff"), bash("git commit -m x")], "reviews_changes"), true);
  assert.equal(seenOf([bash("git show HEAD"), bash("gh pr create --fill")], "reviews_changes"), true);
  assert.equal(seenOf([bash("gh pr diff 4"), bash("git commit -m x")], "reviews_changes"), true);
  assert.equal(seenOf([bash("git commit -m x"), bash("git diff")], "reviews_changes"), false);
  assert.equal(seenOf([bash("git diff --stat"), bash("git commit -m x")], "reviews_changes"), false);
  assert.equal(denomOf([bash("gh pr create --fill")], "reviews_changes"), true);
  assert.equal(denomOf([bash("git diff")], "reviews_changes"), false);
  const f = sessionFacts(session("claude-code", [bash("git commit -m a"), bash("git commit -m b"), bash("gh pr create")]));
  assert.deepEqual([f.commits, f.prs], [2, 1]);
});

test("design_documents and security_checks: denominator is sessions with an edit", () => {
  assert.deepEqual([seenOf([edit("docs/adr/1.md", "Write")], "design_documents"), denomOf([edit("docs/adr/1.md", "Write")], "design_documents")], [true, true]);
  assert.equal(seenOf([edit("src/a.ts")], "design_documents"), false);
  assert.equal(seenOf([edit("src/a.ts"), bash("npm audit")], "security_checks"), true);
  assert.equal(seenOf([edit("src/a.ts")], "security_checks"), false);
  assert.equal(denomOf([bash("npm audit")], "security_checks"), false);
  assert.equal(denomOf([bash("npm audit")], "design_documents"), false);
});

test("edit tools: the names the adapters map to all count as an edit", () => {
  for (const name of ["Edit", "Write", "NotebookEdit", "MultiEdit"]) {
    assert.equal(denomOf([edit("src/a.ts", name)], "design_documents"), true, name);
  }
  assert.equal(denomOf([tool("Read")], "design_documents"), false);
});

test("a practice whose field is missing is not in its denominator", () => {
  const noPath = session("claude-code", [edit("src/a.ts")]);
  for (const m of noPath.messages) for (const u of m.toolUses) delete u.path;
  const f = sessionFacts(noPath);
  assert.equal(f.denom.tests_with_changes, false);
  assert.equal(f.denom.plan_before_edit, false);
  assert.equal(f.denom.design_documents, false);
  assert.equal(f.denom.security_checks, false);
  const noCmd = session("claude-code", [edit("src/a.ts"), bash("git commit -m x")]);
  for (const m of noCmd.messages) for (const u of m.toolUses) delete u.cmd;
  const g = sessionFacts(noCmd);
  assert.equal(g.denom.checks_before_commit, false);
  assert.equal(g.denom.reviews_changes, false);
  assert.equal(g.denom.security_checks, false);
  assert.equal(g.denom.tests_with_changes, true);
});

test("an edit with an empty path (codex apply_patch it could not parse) counts as a missing path", () => {
  const f = sessionFacts(session("codex", [edit(""), bash("npm audit")]));
  assert.equal(f.edits, 1);
  for (const id of ["tests_with_changes", "plan_before_edit", "design_documents", "security_checks", "checks_before_commit"]) assert.equal(f.denom[id], false, id);
});

test("computeCodePractices counts seen, of, products and months in the tz and omits denominator 0", () => {
  const ok = [edit("src/a.ts"), bash("npm test"), bash("git commit -m x")];
  const stale = [bash("npm test"), edit("src/a.ts"), bash("git commit -m x")];
  const parsed = {
    sessions: [
      // 2026-04-30T23:30Z is already May in Rome, so Rome sees one month where UTC sees two.
      session("claude-code", ok, { cwd: "/Users/⟨user⟩/dev/alpha", ts: "2026-04-30T23:30:00.000Z", id: "a" }),
      session("claude-code", ok, { cwd: "/Users/⟨user⟩/dev/beta", ts: "2026-05-10T10:00:00.000Z", id: "b" }),
      session("codex", stale, { cwd: "/Users/⟨user⟩/dev/beta", ts: "2026-06-03T10:00:00.000Z", id: "c" }),
    ],
  };
  const pick = (r) => r.items.find((i) => i.id === "checks_before_commit");
  const rome = computeCodePractices(parsed, { tz: "Europe/Rome" });
  assert.deepEqual(pick(rome), { id: "checks_before_commit", method: "code", seen: 2, of: 3, products: 2, months: 1 });
  assert.deepEqual(pick(computeCodePractices(parsed)), { id: "checks_before_commit", method: "code", seen: 2, of: 3, products: 2, months: 2 });
  assert.deepEqual(practiceSessions(parsed, { tz: "Europe/Rome" }).map((p) => p.month), ["2026-05", "2026-05", "2026-06"]);
  assert.deepEqual(practiceSessions(parsed, { tz: "UTC" }).map((p) => p.month), ["2026-04", "2026-05", "2026-06"]);
  assert.deepEqual(rome.items.map((i) => i.id), ["checks_before_commit", "tests_with_changes", "plan_before_edit", "reviews_changes", "design_documents", "security_checks"]);
  assert.equal(rome.items.some((i) => i.id === "failure_reproduced_before_fix"), false);
  assert.equal(computeCodePractices({ sessions: [] }), null);
});

test("months use the first timestamped message and sessions without one add no month", () => {
  const s = session("claude-code", [edit("src/a.ts"), bash("npm audit")], { cwd: "/Users/⟨user⟩/dev/alpha", ts: "2026-02-10T10:00:00.000Z" });
  const none = session("claude-code", [edit("src/a.ts"), bash("npm audit")], { cwd: "/Users/⟨user⟩/dev/alpha", id: "n" });
  for (const m of none.messages) delete m.ts;
  const item = computeCodePractices({ sessions: [s, none] }).items.find((i) => i.id === "security_checks");
  assert.deepEqual(item, { id: "security_checks", method: "code", seen: 2, of: 2, products: 1, months: 1 });
  assert.deepEqual(practiceSessions({ sessions: [s, none] }, { tz: "UTC" }).map((p) => [p.id, p.product, p.month, p.source]), [["s", "alpha", "2026-02", "claude-code"], ["n", "alpha", null, "claude-code"]]);
});

test("a session without toolUses, timestamps or messages never throws and leaves every denominator", () => {
  const parsed = { sessions: [{ source: "pi", cwdRedacted: "/h/p/x", messages: [{ role: "user", textRedacted: "hi" }] }, { source: "cursor", messages: [] }, { source: "codex" }] };
  assert.doesNotThrow(() => computeCodePractices(parsed));
  assert.equal(computeCodePractices(parsed), null);
  const f = sessionFacts(parsed.sessions[0]);
  assert.deepEqual(Object.values(f.denom).filter(Boolean), []);
});

test("ephemeral sandboxes are not counted: the practice sessions are exactly the digest's", () => {
  const ev = [edit("src/a.ts"), bash("npm audit")];
  const raw = session("claude-code", ev, { cwd: "", id: "raw" });
  raw.cwdRaw = "/Users/lorenzo/dev/gamma";
  const parsed = {
    sessions: [
      session("claude-code", ev, { cwd: "/tmp/sandbox/x", id: "e1" }),
      session("claude-code", ev, { cwd: "/private/tmp/sandbox/y", id: "e2" }),
      session("claude-code", ev, { cwd: "/var/folders/ab/T/z", id: "e3" }),
      session("claude-code", ev, { cwd: "/Users/⟨user⟩/dev/alpha", id: "r1" }),
      session("claude-code", ev, { cwd: "/Users/⟨user⟩/dev/alpha", id: "r2" }),
      session("claude-code", ev, { cwd: "/Users/⟨user⟩/tmp/scratchpad-app", id: "r3" }),
      raw,
      session("claude-code", ev, { cwd: "", id: "empty" }),
    ],
  };
  const ps = practiceSessions(parsed, { tz: "UTC" });
  assert.deepEqual(ps.map((p) => p.id), ["r1", "r2", "r3", "raw", "empty"]);
  const digest = buildDigest(parsed);
  assert.equal(computeCodePractices(parsed).items.find((i) => i.id === "security_checks").of, digest.projects.reduce((n, p) => n + p.sessions, 0));
  const byProduct = (xs) => Object.fromEntries(xs.sort().map(([k, n]) => [k, n]));
  const counted = {};
  for (const p of ps) counted[p.product] = (counted[p.product] || 0) + 1;
  assert.deepEqual(byProduct(Object.entries(counted)), byProduct(digest.projects.map((p) => [p.repo, p.sessions])));
});

test("recordedPracticesTz reads the profile's recorded zone, falling back to UTC", () => {
  assert.equal(recordedPracticesTz({ practices: { timezone: "Europe/Rome" } }), "Europe/Rome");
  assert.equal(recordedPracticesTz({ practices: { timezone: "Not/AZone" } }), "UTC");
  assert.equal(recordedPracticesTz({}), "UTC");
  assert.equal(recordedPracticesTz(null), "UTC");
});
