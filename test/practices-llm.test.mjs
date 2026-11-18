import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRACTICES_BATCH, classifyPractices, practicesPrompt, runPracticesStep } from "../src/practices-llm.mjs";
import { MODEL_PRACTICE_CANDIDATES, PUBLISHED_MODEL_IDS, TONE_RULE } from "../src/practices-rules.mjs";
import { mergeModelPractices } from "../src/practices.mjs";

const ids = MODEL_PRACTICE_CANDIDATES.map((p) => p.id);
const mkInput = (n) => ({
  practices: MODEL_PRACTICE_CANDIDATES,
  sessions: Array.from({ length: n }, (_, i) => ({ id: `s${String(i + 1).padStart(2, "0")}`, messages: ["a", "b"] })),
});
const yes = ({ user }) => Promise.resolve(JSON.stringify(Object.fromEntries(JSON.parse(user).sessions.map((s) => [s.id, Object.fromEntries(ids.map((i) => [i, true]))]))));

test("candidates are the six, four published", () => {
  assert.equal(PRACTICES_BATCH, 10);
  assert.deepEqual(ids, ["asks_for_alternatives", "pushes_back_with_reason", "states_done_criteria", "gives_context_and_constraints", "raises_risks", "limits_scope"]);
  for (const p of MODEL_PRACTICE_CANDIDATES) assert.equal(p.positive.length + p.negative.length, 4);
  assert.deepEqual(PUBLISHED_MODEL_IDS, ids.filter((i) => !["gives_context_and_constraints", "raises_risks"].includes(i)));
});

test("25 sessions give 3 calls and a merged answer", async () => {
  let calls = 0;
  const a = await classifyPractices(mkInput(25), { call: (x) => { calls++; return yes(x); } });
  assert.equal(calls, 3);
  assert.equal(Object.keys(a).length, 25);
});

test("the prompt holds every definition and the tone sentence; a fenced block is tolerated", async () => {
  const p = practicesPrompt(MODEL_PRACTICE_CANDIDATES);
  for (const c of MODEL_PRACTICE_CANDIDATES) assert.ok(p.includes(c.definition));
  assert.ok(p.includes(TONE_RULE));
  assert.equal(p, practicesPrompt(MODEL_PRACTICE_CANDIDATES));
  const a = await classifyPractices(mkInput(2), { call: async (x) => "```json\n" + (await yes(x)) + "\n```" });
  assert.equal(a.s02.raises_risks, true);
});

test("an invalid answer throws naming the batch", async () => {
  await assert.rejects(classifyPractices(mkInput(12), { call: async () => "{}" }), /batch 1 of 2/);
  await assert.rejects(classifyPractices(mkInput(2), { call: async () => "nope" }), /batch 1 of 1/);
});

test("no key writes nothing and prints the hint; a key classifies, warns and merges", async () => {
  const out = mkdtempSync(join(tmpdir(), "pl-"));
  assert.equal(await runPracticesStep(out, { key: "k", call: yes }), "none");
  writeFileSync(join(out, "practices-input.json"), JSON.stringify(mkInput(3)));
  const lines = [];
  assert.equal(await runPracticesStep(out, { key: "", call: yes, log: (l) => lines.push(l) }), "hint");
  assert.ok(!existsSync(join(out, "practices.json")));
  assert.ok(lines.some((l) => l.includes("/rebase-verify")));
  let warned = 0;
  assert.equal(await runPracticesStep(out, { key: "k", call: yes, warn: () => warned++ }), "written");
  assert.equal(warned, 1);
  const answers = JSON.parse(readFileSync(join(out, "practices.json"), "utf8"));
  const sample = Object.keys(answers).map((id) => ({ id, session: id, date: "2026-01-01", product: "p", month: "2026-01" }));
  const { block } = mergeModelPractices({ items: [] }, answers, sample, ids, { tz: "UTC" });
  const item = block.items.find((i) => i.id === "limits_scope");
  assert.equal(item.method, "model");
  assert.equal(item.seen, 3);
  assert.equal(item.of, 3);
});

import { buildPracticesInput } from "../src/practices-sample.mjs";

test("examples reach the prompt from the input file; the batch payload is minimal", async () => {
  const msgs = (n) => Array.from({ length: n }, (_, i) => ({ role: "user", textRedacted: `message ${i}` }));
  const t0 = Date.parse("2026-01-05T10:00:00Z");
  const parsed = { sessions: [{ id: "REAL-SESSION-ID", source: "claude-code", cwdRedacted: "/w/a", messages: msgs(3).map((m, i) => ({ ...m, ts: new Date(t0 + i * 1000).toISOString() })) }] };
  const practices = [{ id: "asks_for_alternatives", method: "model", definition: "d1", positive: ["EXAMPLE-YES"], negative: ["EXAMPLE-NO"] }];
  const input = buildPracticesInput(parsed, { tz: "UTC", practices, sample: [{ id: "s01", messages: ["hi", "there"] }] });
  const prompt = practicesPrompt(input.practices);
  assert.ok(prompt.includes("EXAMPLE-YES") && prompt.includes("EXAMPLE-NO"));
  const users = [];
  await classifyPractices(input, { call: ({ user }) => { users.push(user); return Promise.resolve('{"s01":{"asks_for_alternatives":true}}'); } });
  const u = JSON.parse(users[0]);
  assert.deepEqual(Object.keys(u).sort(), ["practices", "sessions"]);
  assert.deepEqual(u.practices, ["asks_for_alternatives"]);
  assert.deepEqual(u.sessions, [{ id: "s01", messages: ["hi", "there"] }]);
  assert.ok(!users[0].includes("REAL-SESSION-ID"));
});
