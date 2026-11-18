import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { MAX_SESSIONS, personMessages, sampleSessions, buildPracticesInput, sampleFile } from "../src/practices-sample.mjs";

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

test("bin writes no input file while no model practice is published", () => {
  const home = mkdtempSync(join(tmpdir(), "pr-"));
  const root = join(home, "projects", "-h-p-x");
  const cwd = mkdtempSync(join(tmpdir(), "pr-cwd-"));
  const lines = ["a", "b", "c"].map((t, i) => JSON.stringify({ type: "user", sessionId: "s", cwd: "/h/p/x", timestamp: `2026-05-01T10:0${i}:00.000Z`, message: { role: "user", content: t } }));
  return import("node:fs").then(({ mkdirSync, writeFileSync }) => {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "s.jsonl"), lines.join("\n") + "\n");
    const bin = new URL("../bin/rebase-verify.mjs", import.meta.url).pathname;
    const r = spawnSync(process.execPath, [bin, "prepare", "--root", join(home, "projects"), "--no-opencode"], { cwd, encoding: "utf8", timeout: 120000 });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(existsSync(join(cwd, "out", "narrative-input.json")));
    assert.ok(!existsSync(join(cwd, "out", "practices-input.json")));
    assert.ok(!existsSync(join(cwd, "out", "practices-sample.json")));
    assert.ok(readFileSync(join(cwd, "out", "narrative-input.json"), "utf8").length > 0);
  });
});
