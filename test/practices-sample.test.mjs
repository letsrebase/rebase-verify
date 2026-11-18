import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { MAX_SESSIONS, personMessages, sampleSessions, buildPracticesInput, sampleFile, practicesFiles } from "../src/practices-sample.mjs";

const msgs = (n, text = (i) => `message ${i}`, ts = "2026-05-01T10:00:00.000Z") =>
  Array.from({ length: n }, (_, i) => ({ role: "user", ts, textRedacted: text(i) }));
const sess = (id, product, month, n = 2, extra = {}) => ({
  source: "claude-code", sessionId: id, cwdRaw: "", cwdRedacted: `/h/p/${product}`,
  messages: msgs(n, (i) => `m${i}`, `${month}-05T10:00:00.000Z`), ...extra,
});
const many = (product, n, month = "2026-05") => Array.from({ length: n }, (_, i) => sess(`${product}${i}`, product, month));

test("at most 60 sessions, only sessions with >= 2 user messages, never the agent's text or tool output", () => {
  const parsed = { sessions: [
    ...many("a", 80),
    sess("one", "b", "2026-05", 1),
    { ...sess("agent", "c", "2026-05", 1), messages: [...msgs(1), { role: "assistant", ts: "2026-05-01T10:00:00.000Z", textRedacted: "SECRET agent text" }] },
  ] };
  const out = sampleSessions(parsed, { tz: "UTC" });
  assert.equal(out.length, MAX_SESSIONS);
  assert.ok(!out.some((s) => ["one", "agent"].includes(s.session)));
  assert.ok(!JSON.stringify(out).includes("SECRET"));
});

test("round-robin: product a never fills the sample first", () => {
  const parsed = { sessions: [...many("a", 70), ...many("b", 10), ...many("c", 1)] };
  const out = sampleSessions(parsed, { tz: "UTC" });
  const by = (p) => out.filter((s) => s.product === p).length;
  assert.equal(out.length, 60);
  assert.equal(by("c"), 1);
  assert.equal(by("b"), 10);
  assert.equal(by("a"), 49);
});

test("months rotate inside a product", () => {
  const parsed = { sessions: [
    sess("x1", "a", "2026-03"), sess("x2", "a", "2026-03"), sess("y1", "a", "2026-04"), sess("z1", "a", "2026-05"),
  ] };
  const out = sampleSessions(parsed, { tz: "UTC" });
  assert.deepEqual(out.map((s) => s.month), ["2026-03", "2026-04", "2026-05", "2026-03"]);
  assert.deepEqual(out.map((s) => s.id), ["s01", "s02", "s03", "s04"]);
  assert.equal(out[0].date, "2026-03-05");
});

test("a session with 30 user messages keeps 12: the first and evenly spaced ones", () => {
  const out = personMessages({ messages: msgs(30) });
  assert.equal(out.length, 12);
  assert.equal(out[0], "message 0");
  assert.equal(out[11], "message 29");
  assert.equal(out[1], `message ${Math.round(29 / 11)}`);
});

test("each message is at most 600 chars, redacted and proper nouns scrubbed", () => {
  const long = "x".repeat(2000);
  const [a, b] = personMessages({ messages: [
    { role: "user", textRedacted: "Mail me at a@b.io. Ask Marco about Stripe" },
    { role: "user", textRedacted: long },
  ] });
  assert.ok(!a.includes("a@b.io"));
  assert.ok(!a.includes("Marco") && a.includes("⟨name⟩"));
  assert.equal(b.length, 600);
});

test("the input file holds neither product labels nor months, and ids are opaque", () => {
  const parsed = { sessions: [sess("real-id-1", "secretprod", "2026-05"), sess("real-id-2", "secretprod", "2026-06")] };
  const input = buildPracticesInput(parsed, { tz: "UTC", practices: [{ id: "p", definition: "d", method: "model" }] });
  const text = JSON.stringify(input);
  assert.ok(!text.includes("secretprod") && !text.includes("2026-0") && !text.includes("real-id"));
  assert.deepEqual(input.sessions.map((s) => s.id), ["s01", "s02"]);
  assert.deepEqual(input.practices, [{ id: "p", definition: "d" }]);
  const file = sampleFile(sampleSessions(parsed, { tz: "UTC" }));
  assert.deepEqual(Object.keys(file[0]), ["id", "session", "date", "product", "month"]);
  assert.equal(file[0].session, "real-id-1");
});

test("an empty or all-ineligible log gives an empty sessions list", () => {
  assert.deepEqual(sampleSessions({ sessions: [] }, { tz: "UTC" }), []);
  assert.deepEqual(buildPracticesInput({ sessions: [sess("a", "p", "2026-05", 1)] }, { tz: "UTC" }).sessions, []);
});

test("sessions with no timestamp are left out", () => {
  const undated = { source: "claude-code", sessionId: "u", cwdRaw: "", cwdRedacted: "/h/p/a", messages: [{ role: "user", textRedacted: "a" }, { role: "user", textRedacted: "b" }] };
  assert.deepEqual(sampleSessions({ sessions: [undated] }, { tz: "UTC" }), []);
});

test("practicesFiles: null with no model practice or no sampled session, else input and sample", () => {
  const parsed = { sessions: [sess("r1", "p", "2026-05")] };
  const practices = [{ id: "p", definition: "d" }];
  assert.equal(practicesFiles(parsed, { tz: "UTC", practices: [] }), null);
  assert.equal(practicesFiles({ sessions: [] }, { tz: "UTC", practices }), null);
  const f = practicesFiles(parsed, { tz: "UTC", practices });
  assert.deepEqual(f.input.sessions.map((s) => s.id), ["s01"]);
  assert.equal(f.sample[0].session, "r1");
});

test("bin writes a fresh input and sample file and removes stale answers", () => {
  const home = mkdtempSync(join(tmpdir(), "pr-"));
  const cwd = mkdtempSync(join(tmpdir(), "pr-cwd-"));
  try {
    const root = join(home, "projects", "-h-p-x");
    mkdirSync(root, { recursive: true });
    const lines = ["a", "b", "c"].map((t, i) => JSON.stringify({ type: "user", sessionId: "s", cwd: "/h/p/x", timestamp: `2026-05-01T10:0${i}:00.000Z`, message: { role: "user", content: t } }));
    writeFileSync(join(root, "s.jsonl"), lines.join("\n") + "\n");
    mkdirSync(join(cwd, "out"));
    writeFileSync(join(cwd, "out", "practices-sample.json"), "[]");
    writeFileSync(join(cwd, "out", "practices-input.json"), "{}");
    writeFileSync(join(cwd, "out", "practices.json"), "{}");
    const bin = fileURLToPath(new URL("../bin/rebase-verify.mjs", import.meta.url));
    const r = spawnSync(process.execPath, [bin, "prepare", "--root", join(home, "projects"), "--no-opencode", "--no-codex", "--no-pi", "--no-cursor", "--no-kimi"], { cwd, encoding: "utf8", timeout: 120000, env: { ...process.env, HOME: home, USERPROFILE: home, XDG_DATA_HOME: join(home, "x") } });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(existsSync(join(cwd, "out", "narrative-input.json")));
    assert.deepEqual(JSON.parse(readFileSync(join(cwd, "out", "practices-input.json"), "utf8")).sessions.map((x) => x.id), ["s01"]);
    assert.deepEqual(JSON.parse(readFileSync(join(cwd, "out", "practices-sample.json"), "utf8")).map((x) => x.id), ["s01"]);
    assert.ok(!existsSync(join(cwd, "out", "practices.json")));
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

// What the Claude Code adapter hands over for records the person did not type.
const tagged = (text, extra = {}) => ({ role: "user", ts: "2026-05-01T10:00:00.000Z", textRedacted: text, ...extra });
const withMsgs = (messages) => ({ sessions: [{ source: "claude-code", sessionId: "x", cwdRaw: "", cwdRedacted: "/h/p/a", messages }] });

test("a sub-agent brief, meta and compaction records are not the person's messages", () => {
  const session = { messages: [
    tagged("real message"),
    tagged("SIDECHAIN agent brief", { isSidechain: true }),
    tagged("injected context", { isMeta: true }),
    tagged("compaction summary text", { isCompactSummary: true }),
  ] };
  assert.deepEqual(personMessages(session), ["real message"]);
  assert.deepEqual(sampleSessions(withMsgs(session.messages), { tz: "UTC" }), []); // one left: under the minimum
  const two = withMsgs([...session.messages, tagged("second real message")]);
  const out = sampleSessions(two, { tz: "UTC" });
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].messages, ["real message", "second real message"]);
});

test("task notifications and compaction continuation turns are not the person's messages", () => {
  const session = { messages: [
    tagged("real message"),
    tagged("<task-notification>agent finished</task-notification>"),
    tagged("Your task is to create a detailed summary of the conversation so far"),
    tagged("This session is being continued from a previous conversation that ran out of context."),
  ] };
  assert.deepEqual(personMessages(session), ["real message"]);
  assert.deepEqual(sampleSessions(withMsgs(session.messages), { tz: "UTC" }), []);
});

test("through the Claude Code adapter: the sub-agent brief never reaches the sample", async () => {
  const { readClaudeCode } = await import("../src/adapters/claude-code.mjs");
  const root = mkdtempSync(join(tmpdir(), "rv-sidechain-"));
  try {
    mkdirSync(join(root, "proj", "sess1", "subagents"), { recursive: true });
    const rec = (type, text, extra = {}) => JSON.stringify({
      type, sessionId: "sess1", cwd: "/h/p/a", uuid: `u${Math.random()}`, timestamp: "2026-05-01T10:00:00.000Z",
      message: { role: type, content: [{ type: "text", text }] }, ...extra,
    });
    writeFileSync(join(root, "proj", "sess1.jsonl"), [rec("user", "real message")].join("\n") + "\n");
    writeFileSync(join(root, "proj", "sess1", "subagents", "agent-1.jsonl"), [rec("user", "SIDECHAIN agent brief", { isSidechain: true })].join("\n") + "\n");
    const parsed = readClaudeCode(root);
    const msgs = parsed.sessions[0].messages.filter((m) => m.role === "user");
    assert.equal(msgs.length, 2);
    assert.ok(msgs.some((m) => m.isSidechain === true));
    assert.deepEqual(sampleSessions(parsed, { tz: "UTC" }), []); // one real message: under the minimum
    assert.ok(!JSON.stringify(personMessages(parsed.sessions[0])).includes("SIDECHAIN"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an opencode child session (parentId) is never sampled, whatever its messages", () => {
  const parsed = { sessions: [
    sess("parent", "a", "2026-05", 2),
    sess("child", "a", "2026-05", 5, { parentId: "parent" }),
  ] };
  const out = sampleSessions(parsed, { tz: "UTC" });
  assert.deepEqual(out.map((s) => s.session), ["parent"]);
});
