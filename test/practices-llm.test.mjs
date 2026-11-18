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

test("candidates are the six, none published yet", () => {
  assert.equal(PRACTICES_BATCH, 10);
  assert.deepEqual(ids, ["asks_for_alternatives", "pushes_back_with_reason", "states_done_criteria", "gives_context_and_constraints", "raises_risks", "limits_scope"]);
  for (const p of MODEL_PRACTICE_CANDIDATES) assert.equal(p.positive.length + p.negative.length, 4);
  assert.deepEqual(PUBLISHED_MODEL_IDS, []);
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
