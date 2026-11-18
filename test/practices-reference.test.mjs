// The written reference set behind the quality gate: its shape is always
// checked; the classification runs only with RUN_PRACTICES_GATE=1 (it needs a model).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { MODEL_PRACTICE_CANDIDATES } from "../src/practices-rules.mjs";
import { AGREEMENT_MIN, claudeCliCall, runAgreement } from "../scripts/practices-gate.mjs";
import { anthropicCall } from "../src/profile-llm.mjs";

const dir = fileURLToPath(new URL("./fixtures/practices-reference/", import.meta.url));
const IDS = MODEL_PRACTICE_CANDIDATES.map((p) => p.id);

if (!existsSync(dir)) {
  test("reference set", { skip: "test/fixtures/practices-reference/ does not exist yet" }, () => {});
} else {
  const docs = readdirSync(dir)
    .filter((f) => /^[a-z_]+\.(it|en)\.json$/.test(f))
    .sort()
    .map((f) => ({ f, doc: JSON.parse(readFileSync(join(dir, f), "utf8")) }));

  test("every file is <practice>.<it|en>.json and matches its name", () => {
    assert.ok(docs.length > 0, "no reference files");
    for (const { f, doc } of docs) {
      const [practice, lang] = f.split(".");
      assert.equal(doc.practice, practice, f);
      assert.equal(doc.lang, lang, f);
      assert.ok(IDS.includes(practice), `${f}: unknown practice`);
    }
  });

  test("per practice and language: at least 8 positive and 8 near-miss sessions", () => {
    for (const id of IDS) {
      for (const lang of ["it", "en"]) {
        const doc = docs.find((d) => d.doc.practice === id && d.doc.lang === lang)?.doc;
        assert.ok(doc, `missing ${id}.${lang}.json`);
        const n = (kind) => doc.sessions.filter((s) => s.kind === kind).length;
        assert.ok(n("positive") >= 8, `${id}.${lang}: ${n("positive")} positive`);
        assert.ok(n("near_miss") >= 8, `${id}.${lang}: ${n("near_miss")} near-miss`);
      }
    }
  });

  test("every session: six booleans, a consistent kind, 2 to 6 short messages, unique ids", () => {
    const seen = new Set();
    for (const { f, doc } of docs) {
      for (const s of doc.sessions) {
        assert.ok(!seen.has(s.id), `duplicate id ${s.id}`);
        seen.add(s.id);
        assert.deepEqual(Object.keys(s.expected).sort(), [...IDS].sort(), `${f} ${s.id}`);
        for (const id of IDS) assert.equal(typeof s.expected[id], "boolean", `${f} ${s.id} ${id}`);
        assert.ok(["positive", "near_miss"].includes(s.kind), `${f} ${s.id}: kind`);
        assert.equal(s.expected[doc.practice], s.kind === "positive", `${f} ${s.id}: kind vs expected`);
        assert.ok(Array.isArray(s.messages) && s.messages.length >= 2 && s.messages.length <= 6, `${f} ${s.id}: message count`);
        for (const m of s.messages) {
          assert.equal(typeof m, "string");
          assert.ok(m.length > 0 && m.length <= 600, `${f} ${s.id}: message length`);
        }
      }
    }
  });

  test("agreement with the reference set (RUN_PRACTICES_GATE=1)", { skip: process.env.RUN_PRACTICES_GATE !== "1" && "set RUN_PRACTICES_GATE=1 (needs a model)" }, async () => {
    const key = process.env.ANTHROPIC_API_KEY;
    const call = key ? anthropicCall(key) : claudeCliCall();
    const r = await runAgreement({ dir, call });
    for (const id of IDS) assert.ok(r.perPractice[id].rate >= AGREEMENT_MIN, `${id}: ${r.perPractice[id].matched}/${r.perPractice[id].of}`);
  });
}
